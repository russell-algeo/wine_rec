import type { ClientOcrLayout } from "@wine-rec/contracts";
import { scoreExtractedTextQuality } from "./ocr-text-quality.js";
import { buildLayoutAwareTextFromWordLines } from "./tesseract-layout.js";

// Server OCR bounds images to this box before Tesseract runs, and the layout
// pass uses pixel distances tuned at that scale, so client boxes are scaled the same way.
const MAX_OCR_WIDTH = 2200;
const MAX_OCR_HEIGHT = 3200;

export type ClientOcrTextChoice = {
  text: string;
  source: "layout" | "client-text";
};

/**
 * Turns the iPhone app's on-device OCR into the text the parser reads.
 *
 * Older app builds send only their own line order. Newer builds also send
 * word boxes, which go through the same layout pass as server OCR (product
 * grids, two-column lists, detached price artifacts). As with server OCR
 * passes, the version the parser can read best wins.
 */
export function chooseClientOcrText(recognizedText: string, layout?: ClientOcrLayout): ClientOcrTextChoice {
  const clientText = recognizedText.trim();
  if (!layout || layout.lines.length === 0) return { text: clientText, source: "client-text" };

  const scale = Math.min(1, MAX_OCR_WIDTH / layout.imageWidth, MAX_OCR_HEIGHT / layout.imageHeight);
  const layoutText = buildLayoutAwareTextFromWordLines(layout.lines.map((line) => line.words.map((word) => ({
    text: word.text,
    left: word.left * scale,
    top: word.top * scale,
    width: word.width * scale,
    height: word.height * scale,
  })))).trim();
  if (!layoutText) return { text: clientText, source: "client-text" };

  // Ties go to the layout pass, which is what server OCR would have produced.
  return scoreExtractedTextQuality(layoutText) >= scoreExtractedTextQuality(clientText)
    ? { text: layoutText, source: "layout" }
    : { text: clientText, source: "client-text" };
}
