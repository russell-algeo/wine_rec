import sharp from "sharp";

export type OcrImageVariant = {
  label: string;
  buffer: Buffer;
  cropped: boolean;
  thresholded: boolean;
};

type Bounds = {
  left: number;
  top: number;
  width: number;
  height: number;
};

const MAX_DETECTION_WIDTH = 280;
const MAX_OCR_WIDTH = 2200;
const MAX_OCR_HEIGHT = 3200;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function pixelOffset(x: number, y: number, width: number): number {
  return (y * width + x) * 3;
}

function computeLuma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function computeChannelSpread(r: number, g: number, b: number): number {
  return Math.max(r, g, b) - Math.min(r, g, b);
}

function expandBounds(bounds: Bounds, width: number, height: number): Bounds {
  const padX = Math.round(bounds.width * 0.08);
  const padY = Math.round(bounds.height * 0.08);
  const left = clamp(bounds.left - padX, 0, width - 1);
  const top = clamp(bounds.top - padY, 0, height - 1);
  const right = clamp(bounds.left + bounds.width + padX, left + 1, width);
  const bottom = clamp(bounds.top + bounds.height + padY, top + 1, height);
  return {
    left,
    top,
    width: right - left,
    height: bottom - top,
  };
}

function shouldTreatAsPaperLike(
  r: number,
  g: number,
  b: number,
  brightnessThreshold: number,
): boolean {
  const luma = computeLuma(r, g, b);
  const spread = computeChannelSpread(r, g, b);
  return luma >= brightnessThreshold && spread <= 105;
}

async function detectDocumentBounds(input: Buffer): Promise<Bounds | null> {
  const resized = sharp(input)
    .resize({ width: MAX_DETECTION_WIDTH, fit: "inside", withoutEnlargement: true })
    .removeAlpha();
  const { data, info } = await resized.raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  if (!width || !height) return null;

  const totalPixels = width * height;
  let totalLuma = 0;
  for (let index = 0; index < data.length; index += 3) {
    totalLuma += computeLuma(data[index] ?? 0, data[index + 1] ?? 0, data[index + 2] ?? 0);
  }
  const averageLuma = totalLuma / Math.max(1, totalPixels);
  const brightnessThreshold = Math.max(140, averageLuma + 18);

  const mask = new Uint8Array(totalPixels);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = pixelOffset(x, y, width);
      if (
        shouldTreatAsPaperLike(
          data[offset] ?? 0,
          data[offset + 1] ?? 0,
          data[offset + 2] ?? 0,
          brightnessThreshold,
        )
      ) {
        mask[y * width + x] = 1;
      }
    }
  }

  const visited = new Uint8Array(totalPixels);
  let best:
    | {
        bounds: Bounds;
        score: number;
      }
    | null = null;

  for (let index = 0; index < totalPixels; index += 1) {
    if (!mask[index] || visited[index]) continue;

    const queue = [index];
    visited[index] = 1;
    let head = 0;
    let area = 0;
    let left = width;
    let right = 0;
    let top = height;
    let bottom = 0;
    let touchesEdge = false;

    while (head < queue.length) {
      const current = queue[head++]!;
      const x = current % width;
      const y = Math.floor(current / width);
      area += 1;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
        touchesEdge = true;
      }

      const neighbors = [
        current - 1,
        current + 1,
        current - width,
        current + width,
      ];
      for (const neighbor of neighbors) {
        if (neighbor < 0 || neighbor >= totalPixels) continue;
        const nx = neighbor % width;
        const ny = Math.floor(neighbor / width);
        if (Math.abs(nx - x) + Math.abs(ny - y) !== 1) continue;
        if (!mask[neighbor] || visited[neighbor]) continue;
        visited[neighbor] = 1;
        queue.push(neighbor);
      }
    }

    const componentWidth = right - left + 1;
    const componentHeight = bottom - top + 1;
    const boxArea = componentWidth * componentHeight;
    if (boxArea <= 0) continue;

    const areaRatio = area / totalPixels;
    const density = area / boxArea;
    const boxCoverage = boxArea / totalPixels;
    if (areaRatio < 0.06 || boxCoverage < 0.12) continue;

    const centerX = left + componentWidth / 2;
    const centerY = top + componentHeight / 2;
    const dx = centerX - width / 2;
    const dy = centerY - height / 2;
    const centerDistance = Math.sqrt(dx * dx + dy * dy);
    const maxCenterDistance = Math.sqrt((width / 2) ** 2 + (height / 2) ** 2);
    const centerBonus = 1 - centerDistance / Math.max(1, maxCenterDistance);
    const edgePenalty = touchesEdge ? 0.2 : 0;
    const score = areaRatio * 4 + density * 1.4 + centerBonus * 0.8 - edgePenalty;

    if (!best || score > best.score) {
      best = {
        bounds: {
          left,
          top,
          width: componentWidth,
          height: componentHeight,
        },
        score,
      };
    }
  }

  if (!best) return null;

  const metadata = await sharp(input).metadata();
  const originalWidth = metadata.width ?? 0;
  const originalHeight = metadata.height ?? 0;
  if (!originalWidth || !originalHeight) return null;

  const scaleX = originalWidth / width;
  const scaleY = originalHeight / height;
  const scaled = {
    left: Math.round(best.bounds.left * scaleX),
    top: Math.round(best.bounds.top * scaleY),
    width: Math.round(best.bounds.width * scaleX),
    height: Math.round(best.bounds.height * scaleY),
  };
  const expanded = expandBounds(scaled, originalWidth, originalHeight);
  const expandedArea = expanded.width * expanded.height;
  const fullArea = originalWidth * originalHeight;
  if (expandedArea >= fullArea * 0.96 || expandedArea <= fullArea * 0.16) {
    return null;
  }

  return expanded;
}

async function renderOcrVariant(input: Buffer, bounds: Bounds | null, thresholded: boolean): Promise<Buffer> {
  let pipeline = sharp(input)
    .rotate()
    .removeAlpha();

  if (bounds) {
    pipeline = pipeline.extract(bounds);
  }

  pipeline = pipeline
    .resize({
      width: MAX_OCR_WIDTH,
      height: MAX_OCR_HEIGHT,
      fit: "inside",
      withoutEnlargement: true,
    })
    .normalize()
    .grayscale()
    .median(1)
    .sharpen({ sigma: 1.1, m1: 0.3, m2: 0.6 });

  if (thresholded) {
    pipeline = pipeline.threshold(158, { grayscale: true });
  } else {
    pipeline = pipeline.linear(1.08, -8);
  }

  return pipeline.png().toBuffer();
}

export async function prepareImageVariantsForOcr(input: Buffer): Promise<OcrImageVariant[]> {
  const orientedBuffer = await sharp(input).rotate().removeAlpha().png().toBuffer();
  const documentBounds = await detectDocumentBounds(orientedBuffer);

  const variants: OcrImageVariant[] = [];
  const seen = new Set<string>();

  const addVariant = async (label: string, bounds: Bounds | null, thresholded: boolean) => {
    const key = `${label}:${thresholded ? "thresholded" : "normalized"}:${bounds ? "cropped" : "full"}`;
    if (seen.has(key)) return;
    seen.add(key);
    variants.push({
      label,
      buffer: await renderOcrVariant(orientedBuffer, bounds, thresholded),
      cropped: Boolean(bounds),
      thresholded,
    });
  };

  if (documentBounds) {
    await addVariant("document-normalized", documentBounds, false);
    await addVariant("document-thresholded", documentBounds, true);
  }

  await addVariant("full-normalized", null, false);
  await addVariant("full-thresholded", null, true);

  return variants;
}
