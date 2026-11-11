import { afterAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import sharp from "sharp";
vi.mock("../config.js", () => ({appConfig:{ocrProvider:"tesseract-js"}}));
import {createOcrProvider,shutdownTesseractJsWorkers} from "./ocr.js";
import {findFixturePath,canonicalizeText} from "../test-support/ocr-fixtures.js";
import {parseWineCandidates} from "../services/parser.js";

afterAll(async()=>{await shutdownTesseractJsWorkers()},30_000);
const fixtures=[
 {prefix:"Screenshot 2026-03-08 at 10.11.31",prices:["$21.99","$16.99","$14.99","$15.99","$20.99","$23.99","$9.99","$24.99"],names:["Domaine de la Mongestine Bob Singlar","Le Babbler Bordeaux","Jelu Estate Patagonia Pinot Noir","Stel + Mar Cabernet","Flavia Taille Terre Sicilia Red","Cardedu","Casa Santos Lima","Bellande Pinot Noir"]},
 {prefix:"Screenshot 2026-03-08 at 10.48.03",prices:["$19","$31","$14","$19","$28","$38","$44","$16","$22","$26","$18","$16","$17","$19","$18","$26"],names:["Martin Texier","Stéphane Coquillette","Bonnet Huteau","Naturweiss","Cameron","Franz Strohmeier","Tissot","Emmanuel Haget","Stefano Occhetti","Melville","Bodegas Tradición","Asahara Shuzo","Kidoizumi Shuzo","Kirei Shuzo","Ota Shuzo","La Stoppa"]},
 {prefix:"Screenshot 2026-03-08 at 9.47.34",prices:["$17","$15","$17"],names:["Les Salicaires","Toby Bainbridge","United Cellars of Tekov"]},
];
describe("real local Tesseract.js engine",()=>{
 for(const fixture of fixtures) it(`preserves menu identities and prices: ${fixture.prefix}`,async()=>{
  const file=await findFixturePath(fixture.prefix);
  const text=await createOcrProvider().extractText({storagePath:"",filename:"fixture.png",mimeType:"image/png",buffer:await fs.readFile(file)});
  const candidates=parseWineCandidates(text);
  expect(candidates.map(c=>c.price)).toEqual(fixture.prices);
  candidates.forEach((c,i)=>expect(canonicalizeText(c.rawText)).toContain(canonicalizeText(fixture.names[i]!)));
  if(fixture.prices.length===3) expect(candidates.map(c=>c.menuSection)).toEqual(["RED","RED","RED"]);
  if(fixture.prices.length===8) expect(candidates.every(c=>c.menuSection===null)).toBe(true);
  if(fixture.prices.length===16) expect(candidates.map(c=>c.menuSection)).toEqual(["Sparkling","Sparkling",...Array(5).fill("White"),...Array(3).fill("Red"),"Sherry",...Array(3).fill("Sake"),"Sweet","Sweet"]);
 },60_000);
});


describe("offline fixture robustness controls", () => {
  const red = fixtures[2]!;
  async function extract(buffer: Buffer) {
    // Deliberately content-neutral filename; section labels must come from pixels.
    return parseWineCandidates(await createOcrProvider().extractText({storagePath:"",filename:"input.jpg",mimeType:"image/jpeg",buffer}));
  }
  it("does not invent RED when its heading is cropped away", async () => {
    const bytes = await fs.readFile(await findFixturePath(red.prefix));
    const buffer = await sharp(bytes).extract({left:0,top:180,width:932,height:744}).jpeg({quality:85}).toBuffer();
    const candidates = await extract(buffer);
    expect(candidates.map(c=>c.price)).toEqual(red.prices);
    expect(candidates.every(c=>c.menuSection===null)).toBe(true);
    candidates.forEach((c,i)=>expect(canonicalizeText(c.rawText)).toContain(canonicalizeText(red.names[i]!)));
  },60_000);
  it("preserves colored heading after JPEG compression and EXIF rotation", async () => {
    const bytes = await fs.readFile(await findFixturePath(red.prefix));
    const buffer = await sharp(bytes).rotate(180).jpeg({quality:85}).withMetadata({orientation:3}).toBuffer();
    const candidates = await extract(buffer);
    expect(candidates.map(c=>c.price)).toEqual(red.prices);
    expect(candidates.map(c=>c.menuSection)).toEqual(["RED","RED","RED"]);
    candidates.forEach((c,i)=>expect(canonicalizeText(c.rawText)).toContain(canonicalizeText(red.names[i]!)));
  },60_000);

});
