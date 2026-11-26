import type { ClientOcrLayout } from "@wine-rec/contracts";
import { parseWineCandidates } from "../services/parser.js";
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
 * grids, two-column lists, tilted photos). The layout text is used unless
 * it yields fewer priced wines than the app's own text.
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

  return layoutTextIsBetter(layoutText, clientText)
    ? { text: layoutText, source: "layout" }
    : { text: clientText, source: "client-text" };
}

/**
 * The server's own pass scorer counts every parsed row, so the app's text,
 * where a price often sits on its own line away from its wine, can outscore
 * a correct layout by producing extra rows with no price. Priced wines are
 * what the rest of the pipeline uses, so they decide first.
 */
function layoutTextIsBetter(layoutText: string, clientText: string): boolean {
  const count = (text: string) => {
    const candidates = parseWineCandidates(text);
    const priced = candidates.filter((candidate) => candidate.price).length;
    return { priced, unpriced: candidates.length - priced };
  };
  const layout = count(layoutText);
  const client = count(clientText);
  if (layout.priced !== client.priced) return layout.priced > client.priced;
  if (layout.unpriced !== client.unpriced) return layout.unpriced < client.unpriced;
  // Ties go to the layout pass, which is what server OCR would have produced.
  return scoreExtractedTextQuality(layoutText) >= scoreExtractedTextQuality(clientText);
}
