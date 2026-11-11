import type { WineCandidate } from "@wine-rec/contracts";
import type { SearchHit } from "./vivino-browser.js";

type VintageEvidence = { kind: "year"; year: number } | { kind: "non-vintage" } | { kind: "unknown" };
export type VintageComparison = "exact" | "unconstrained" | "unknown" | "conflict";

// Only an explicit identity marker establishes NV. Missing values, year 0,
// tasting notes, and location fields do not establish non-vintage identity.
const nonVintageMarker = /(?:^|[\s,(\[;])(?:n\.?\s*(?:\/\s*)?v\.?|non[\s-]?vintage)(?=$|[\s,).\];])/i;
function evidence(year: number | null, text: string): VintageEvidence {
  if (year != null) return { kind: "year", year };
  return nonVintageMarker.test(text) ? { kind: "non-vintage" } : { kind: "unknown" };
}

function normalizedText(text: string): string {
  return text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function menuIdentityText(candidate: WineCandidate, rawOnly = false): string {
  let text = normalizedText(rawOnly ? candidate.rawText || candidate.label || ""
    : [candidate.label, candidate.rawText].filter(Boolean).join(" "));
  // Exclude parsed geographic metadata even when punctuation, spacing, case,
  // or a trailing price differs from the raw title. Do not scan notes.
  const regionTokens = normalizedText(candidate.region ?? "").match(/[a-z0-9]+/g);
  if (regionTokens?.length) {
    const regionPattern = new RegExp(`\\b${regionTokens.join("[^a-z0-9]+")}\\b`, "g");
    text = text.replace(regionPattern, " ");
  }
  return text;
}

export function compareVintageEvidence(candidate: WineCandidate, hit: SearchHit): VintageComparison {
  const requested = evidence(candidate.vintage, menuIdentityText(candidate));
  const supplied = evidence(hit.year, [hit.vintageText, hit.wineName].filter(Boolean).join(" "));
  if (requested.kind === "unknown") return "unconstrained";
  if (supplied.kind === "unknown") return "unknown";
  if (requested.kind !== supplied.kind) return "conflict";
  return requested.kind === "year" && supplied.kind === "year" && requested.year !== supplied.year
    ? "conflict" : "exact";
}

const grapeNames: Array<[string, RegExp]> = [
  ["chardonnay", /\bchardonnay\b/],
  ["riesling", /\briesling\b/],
  ["syrah", /\b(?:syrah|shiraz)\b/],
  ["pinot-gris", /\bpinot\s+(?:gris|grigio)\b/],
  ["pinot-noir", /\bpinot\s+noir\b/],
  ["pinot-blanc", /\bpinot\s+blanc\b/],
  ["cabernet-sauvignon", /\bcab(?:ernet)?\s+sauv(?:ignon)?\b/],
  ["cabernet-franc", /\bcab(?:ernet)?\s+franc\b/],
  ["sauvignon-blanc", /\bsauvignon\s+blanc\b/],
  ["chenin-blanc", /\bchenin\s+blanc\b/],
  ["merlot", /\bmerlot\b/],
  ["grenache", /\b(?:grenache|garnacha)\b/],
  ["mourvedre", /\b(?:mourvedre|monastrell)\b/],
  ["viognier", /\bviognier\b/],
  ["malbec", /\bmalbec\b/],
  ["sangiovese", /\bsangiovese\b/],
  ["tempranillo", /\btempranillo\b/],
  ["zinfandel", /\b(?:zinfandel|primitivo)\b/],
];
function grapes(text: string): Set<string> {
  const normalized = normalizedText(text);
  return new Set(grapeNames.filter(([, pattern]) => pattern.test(normalized)).map(([name]) => name));
}

function withoutKnownGrapes(text: string): string {
  return grapeNames.reduce((value, [, pattern]) => value.replace(new RegExp(pattern.source, "g"), " "), normalizedText(text));
}

function hasIncompleteDelimitedGrapes(text: string): boolean {
  return normalizedText(text).split(/[,|]/).some(part => {
    const starts = grapeNames.flatMap(([, pattern]) => {
      const match = pattern.exec(part);
      return match ? [match.index] : [];
    });
    if (!starts.length) return false;
    return [...part.matchAll(/[/+&]/g)].some(separator => {
      const index = separator.index!;
      const before = part.slice(0, index).trim();
      const after = part.slice(index + 1).trim();
      // A producer's ampersand (Hook & Ladder, Charles & Charles) is not a
      // grape-list delimiter. At least one side must touch a recognized grape.
      const touchesGrape = grapeNames.some(([, pattern]) =>
        new RegExp(`${pattern.source}$`).test(before) || new RegExp(`^${pattern.source}`).test(after));
      if (!touchesGrape) return false;
      const beforeSeparator = part.slice(0, index).match(/\b[a-z]+\s*$/);
      const start = Math.min(...starts, beforeSeparator?.index ?? Infinity);
      const residue = withoutKnownGrapes(part.slice(start)).replace(/\b(?:and|with)\b/g, "")
        .replace(/\d+(?:\.\d+)?%?/g, "").replace(/[^a-z]/g, "");
      return Boolean(residue);
    });
  });
}

export type GrapeComparison = "compatible" | "unconstrained" | "unknown" | "conflict";
export function compareGrapeEvidence(candidate: WineCandidate, hit: SearchHit): GrapeComparison {
  const requested = grapes([candidate.label, candidate.varietal].filter(Boolean).join(" "));
  // The parser can put a grape-first list into its producer field and retain
  // only the first grape as varietal. Recover only a pure grape declaration,
  // never a producer name such as "Riesling Estate" or a geographic phrase.
  for (const part of [candidate.producer ?? "", ...candidate.rawText.split(/[,|]/)]) {
    const named = grapes(part);
    const residue = withoutKnownGrapes(part).replace(/\b(?:and|with)\b/g, "")
      .replace(/\d+(?:\.\d+)?%?/g, "").replace(/[\s/+&()\[\]-]/g, "");
    if (named.size > 0 && !residue) for (const grape of named) requested.add(grape);
  }
  const supplied = grapes(hit.wineName);
  // Cabernet/Pinot fragments and unspecified blends are incomplete evidence,
  // not closed grape inventories. Keep them possible, never reject or certify
  // a bottle merely because the provider expands the abbreviation or blend.
  const identity = menuIdentityText(candidate, true);
  const residue = withoutKnownGrapes(identity);
  if (/\b(?:cabernet|cab|sauvignon|sauv|pinot|blend|blends)\b/.test(residue)
      || hasIncompleteDelimitedGrapes(identity)) return "unknown";
  if (!requested.size) return "unconstrained";
  if (!supplied.size) return "unknown";
  return [...supplied].some(grape => !requested.has(grape)) ? "conflict" : "compatible";
}

export function hasContradictoryGrapeIdentity(candidate: WineCandidate, hit: SearchHit): boolean {
  return compareGrapeEvidence(candidate, hit) === "conflict";
}
