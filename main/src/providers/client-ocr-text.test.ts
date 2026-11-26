import { describe, expect, it } from "vitest";

import type { ClientOcrLayout } from "@wine-rec/contracts";
import { parseWineCandidates } from "../services/parser.js";
import { chooseClientOcrText } from "./client-ocr-text.js";
import { buildLayoutAwareTextFromWordLines, type LayoutWord } from "./tesseract-layout.js";

/** One Vision observation: words left to right, 12 px per character. */
function observation(text: string, left: number, top: number, height = 24): LayoutWord[] {
  let cursor = left;
  return text.split(" ").map((word) => {
    const width = word.length * 12;
    const box = { text: word, left: cursor, top, width, height };
    cursor += width + 10;
    return box;
  });
}

function layout(lines: LayoutWord[][], imageWidth = 1300, imageHeight = 1800): ClientOcrLayout {
  return { imageWidth, imageHeight, lines: lines.map((words) => ({ words })) };
}

const white = [["Domaine Vacheron Sancerre 2022", "68"], ["Trimbach Riesling 2020", "58"], ["Pieropan Soave Classico 2022", "52"]];
const whiteLong = [...white, ["Christian Moreau Chablis 2021", "72"], ["Hirsch Gruner Veltliner 2021", "55"], ["Forjas del Salnes Albarino 2022", "49"], ["Domaine Huet Vouvray 2020", "78"], ["Ridge Lytton Springs 2021", "92"]];
const red = [["Vietti Barolo Castiglione 2019", "140"], ["Jean Foillard Morgon 2022", "70"], ["Domaine Tempier Bandol 2020", "98"], ["Benanti Etna Rosso 2021", "75"], ["Bernard Baudry Chinon 2021", "66"], ["Vajra Barbera Alba 2022", "57"], ["Lopez de Heredia Tondonia 2012", "95"], ["Burlotto Verduno Pelaverga 2022", "61"]];

describe("client OCR word layout", () => {
  it("joins a name and its price that Vision returned as separate observations", () => {
    const lines = white.flatMap(([name, price], index) => [
      observation(name!, 60, 200 + index * 60),
      observation(price!, 560, 202 + index * 60),
    ]);
    expect(buildLayoutAwareTextFromWordLines(lines).split("\n")).toEqual(white.map(([name, price]) => `${name} ${price}`));
  });

  it("reads a two-column list one column at a time", () => {
    // Vision returns the two halves of a row as separate observations, the right one slightly lower.
    const lines = whiteLong.flatMap(([name, price], index) => [
      observation(`${name} ${price}`, 60, 200 + index * 60),
      observation(`${red[index]![0]} ${red[index]![1]}`, 700, 203 + index * 60),
    ]);
    const text = buildLayoutAwareTextFromWordLines(lines);
    const prices = parseWineCandidates(text).map((candidate) => candidate.price);
    expect(prices).toEqual([...whiteLong, ...red].map(([, price]) => `$${price}`));
  });

  it("uses the word boxes when they parse better than the app's own line order", () => {
    // The app's text puts each price on its own line after all the names.
    const recognizedText = [...white.map(([name]) => name), ...white.map(([, price]) => price)].join("\n");
    const lines = white.flatMap(([name, price], index) => [
      observation(name!, 60, 200 + index * 60),
      observation(price!, 560, 202 + index * 60),
    ]);
    const choice = chooseClientOcrText(recognizedText, layout(lines));
    expect(choice.source).toBe("layout");
    expect(parseWineCandidates(choice.text).map((candidate) => candidate.price)).toEqual(["$68", "$58", "$52"]);
  });

  it("scales a full-resolution photo to the server's OCR size", () => {
    const lines = white.map(([name, price], index) => observation(`${name} ${price}`, 240, 800 + index * 240, 96));
    const choice = chooseClientOcrText(lines.map((words) => words.map((word) => word.text).join(" ")).join("\n"), layout(lines, 4032, 5376));
    expect(parseWineCandidates(choice.text).map((candidate) => candidate.price)).toEqual(["$68", "$58", "$52"]);
  });

  it("keeps the app's text when there are no word boxes", () => {
    expect(chooseClientOcrText("  Trimbach Riesling 2020 58 \n", undefined)).toEqual({ text: "Trimbach Riesling 2020 58", source: "client-text" });
    expect(chooseClientOcrText("Trimbach Riesling 2020 58", layout([]))).toEqual({ text: "Trimbach Riesling 2020 58", source: "client-text" });
  });
});
