import type { WineCandidate } from "@wine-rec/contracts";
import { parseWineCandidates } from "./parser.js";

/**
 * Flags rows whose price was read differently by another OCR pass of the same
 * image. It compares only rows whose full structured identity and context
 * (producer, label, vintage, varietal, region, colour, menu tab/section and
 * continuation notes) match exactly and uniquely in both readings. It never
 * changes the selected price, filtering or ranking; it only records evidence.
 */
function fold(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  return String(value).normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

const MIN_PLAUSIBLE_ALTERNATIVE = 5;

export function candidateIdentityKey(candidate: WineCandidate): string {
  return JSON.stringify([
    fold(candidate.producer),
    fold(candidate.label),
    fold(candidate.vintage),
    fold(candidate.varietal),
    fold(candidate.region),
    fold(candidate.color),
    fold(candidate.menuTab),
    fold(candidate.menuSection),
    fold(candidate.notes),
  ]);
}

export function priceAmount(price: string | null | undefined): number | null {
  if (!price) return null;
  const match = price.replace(/,/g, "").match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function uniqueByIdentity(candidates: WineCandidate[]): Map<string, WineCandidate> {
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    const key = candidateIdentityKey(candidate);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const unique = new Map<string, WineCandidate>();
  for (const candidate of candidates) {
    const key = candidateIdentityKey(candidate);
    if (counts.get(key) === 1) unique.set(key, candidate);
  }
  return unique;
}

export function annotatePriceConflicts(
  selected: WineCandidate[],
  alternateTexts: string[],
): WineCandidate[] {
  if (alternateTexts.length === 0 || selected.length === 0) return selected;
  const selectedUnique = uniqueByIdentity(selected);
  const alternativesByKey = new Map<string, Set<string>>();

  const seenTexts = new Set<string>();
  for (const text of alternateTexts) {
    const trimmed = text.trim();
    if (!trimmed || seenTexts.has(trimmed)) continue;
    seenTexts.add(trimmed);
    for (const [key, row] of uniqueByIdentity(parseWineCandidates(trimmed))) {
      const chosen = selectedUnique.get(key);
      if (!chosen) continue;
      const chosenAmount = priceAmount(chosen.price);
      const rowAmount = priceAmount(row.price);
      if (chosenAmount === null || rowAmount === null || chosenAmount === rowAmount) continue;
      // Same floor the parser uses for trailing OCR prices: "$1" is a dropped digit, not evidence.
      if (rowAmount < MIN_PLAUSIBLE_ALTERNATIVE) continue;
      const set = alternativesByKey.get(key) ?? new Set<string>();
      set.add(row.price!);
      alternativesByKey.set(key, set);
    }
  }

  if (alternativesByKey.size === 0) return selected;
  return selected.map((candidate) => {
    const alternatives = alternativesByKey.get(candidateIdentityKey(candidate));
    if (!alternatives || !selectedUnique.has(candidateIdentityKey(candidate))) return candidate;
    return { ...candidate, priceAlternatives: [...alternatives].sort((a, b) => (priceAmount(a) ?? 0) - (priceAmount(b) ?? 0)) };
  });
}

export function hasPriceConflict(candidate: Pick<WineCandidate, "priceAlternatives">): boolean {
  return (candidate.priceAlternatives?.length ?? 0) > 0;
}
