import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { prepareImageVariantsForOcr } from "./image-preprocessing.js";

describe("image preprocessing", () => {
  it("creates document-focused OCR variants when a bright menu page is detected", async () => {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200">
        <rect width="900" height="1200" fill="#8f1f2c" />
        <g opacity="0.28">
          <rect x="0" y="0" width="900" height="1200" fill="url(#grid)" />
        </g>
        <rect x="150" y="160" width="520" height="820" rx="16" fill="#f6f0ea" />
        <text x="230" y="280" font-size="48" font-family="Georgia" fill="#222">mo's general</text>
        <text x="210" y="420" font-size="34" font-family="Georgia" fill="#222">karatta 'griffin' sparkling shiraz</text>
        <text x="620" y="420" font-size="34" font-family="Georgia" fill="#222">75</text>
        <text x="210" y="500" font-size="34" font-family="Georgia" fill="#222">heinrich 'naked white'</text>
        <text x="620" y="500" font-size="34" font-family="Georgia" fill="#222">72</text>
        <defs>
          <pattern id="grid" width="80" height="80" patternUnits="userSpaceOnUse">
            <rect width="40" height="40" fill="#c94a57" />
            <rect x="40" y="40" width="40" height="40" fill="#c94a57" />
            <rect x="40" width="40" height="40" fill="#f1d9d9" />
            <rect y="40" width="40" height="40" fill="#f1d9d9" />
          </pattern>
        </defs>
      </svg>
    `;
    const image = await sharp(Buffer.from(svg)).jpeg().toBuffer();

    const variants = await prepareImageVariantsForOcr(image);

    expect(variants.map((variant) => variant.label)).toContain("document-normalized");
    expect(variants.map((variant) => variant.label)).toContain("document-thresholded");
    expect(variants.some((variant) => variant.cropped)).toBe(true);
    expect(variants.every((variant) => variant.buffer.length > 0)).toBe(true);
  });
});
