import type {
  TasteVector,
  UserTastePreference,
  WineCandidate,
  WineProfile,
} from "@wine-rec/contracts";

type MatchParts = Pick<WineCandidate, "producer" | "label" | "vintage" | "varietal" | "region">;

export const TASTE_SCALE_MIN = 1;
export const TASTE_SCALE_MAX = 5;

const styleRubric: Record<string, Omit<TasteVector, "confidence" | "sourceMode">> = {
  sauvignon_blanc: { body: 2, acidity: 5, tannin: 1, sweetness: 1 },
  riesling_dry: { body: 2, acidity: 4, tannin: 1, sweetness: 1 },
  chardonnay: { body: 3, acidity: 3, tannin: 1, sweetness: 1 },
  pinot_noir: { body: 3, acidity: 4, tannin: 2, sweetness: 1 },
  cabernet_sauvignon: { body: 4, acidity: 3, tannin: 4, sweetness: 1 },
  syrah: { body: 4, acidity: 3, tannin: 4, sweetness: 1 },
  champagne: { body: 3, acidity: 5, tannin: 1, sweetness: 1 },
  prosecco: { body: 2, acidity: 4, tannin: 1, sweetness: 2 },
  rose_dry: { body: 2, acidity: 4, tannin: 1, sweetness: 1 },
  default_white: { body: 2, acidity: 4, tannin: 1, sweetness: 1 },
  default_red: { body: 4, acidity: 3, tannin: 3, sweetness: 1 },
  default_sparkling: { body: 2, acidity: 4, tannin: 1, sweetness: 1 },
};

export function normalizeField(input: string | null | undefined): string {
  return (input ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreToken(left: string | null | undefined, right: string | null | undefined): number {
  const a = normalizeField(left);
  const b = normalizeField(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.8;
  const aParts = new Set(a.split(" "));
  const bParts = new Set(b.split(" "));
  const overlap = [...aParts].filter((part) => bParts.has(part)).length;
  const union = new Set([...aParts, ...bParts]).size;
  return union === 0 ? 0 : overlap / union;
}

export function scoreWineMatch(candidate: MatchParts, profile: Partial<MatchParts>): number {
  const producerScore = scoreToken(candidate.producer, profile.producer) * 0.35;
  const labelScore = scoreToken(candidate.label, profile.label) * 0.35;
  const varietalScore = scoreToken(candidate.varietal, profile.varietal) * 0.1;
  const regionScore = scoreToken(candidate.region, profile.region) * 0.05;
  const vintageScore =
    candidate.vintage && profile.vintage
      ? candidate.vintage === profile.vintage
        ? 0.15
        : 0
      : 0;

  return producerScore + labelScore + varietalScore + regionScore + vintageScore;
}

export function rankMatch(score: number): "matched" | "low-confidence" | "unmatched" {
  if (score >= 0.82) return "matched";
  if (score >= 0.65) return "low-confidence";
  return "unmatched";
}

export function clampTaste(value: number): number {
  return Math.max(TASTE_SCALE_MIN, Math.min(TASTE_SCALE_MAX, Math.round(value)));
}

export function normalizeTasteValue(value: number): number {
  if (value > TASTE_SCALE_MAX && Number.isInteger(value)) {
    return clampTaste(Math.round(value / 2));
  }

  return clampTaste(value);
}

export function inferTasteVector(candidate: Partial<WineCandidate>, profile?: Partial<WineProfile>): TasteVector {
  const varietal = normalizeField(candidate.varietal ?? profile?.varietal);
  const label = normalizeField(candidate.label ?? profile?.label);
  const color = normalizeField(candidate.color);
  const region = normalizeField(candidate.region ?? profile?.region);
  const notes = normalizeField(candidate.notes);

  let key = "default_white";
  if (varietal.includes("sauvignon")) key = "sauvignon_blanc";
  else if (varietal.includes("riesling")) key = "riesling_dry";
  else if (varietal.includes("chardonnay")) key = "chardonnay";
  else if (varietal.includes("pinot noir")) key = "pinot_noir";
  else if (varietal.includes("cabernet")) key = "cabernet_sauvignon";
  else if (varietal.includes("syrah") || varietal.includes("shiraz")) key = "syrah";
  else if (label.includes("champagne") || region.includes("champagne")) key = "champagne";
  else if (label.includes("prosecco") || region.includes("prosecco")) key = "prosecco";
  else if (label.includes("rose") || color.includes("rose")) key = "rose_dry";
  else if (color.includes("red")) key = "default_red";
  else if (color.includes("sparkling")) key = "default_sparkling";

  const inferred = styleRubric[key] ?? {
    body: 2,
    acidity: 4,
    tannin: 1,
    sweetness: 1,
  };

  let body = inferred.body;
  let acidity = inferred.acidity;
  let tannin = inferred.tannin;
  let sweetness = inferred.sweetness;

  if (notes.includes("dry") || notes.includes("quinine") || notes.includes("sea kelp")) {
    sweetness = 1;
  }

  if (
    notes.includes("sour cherry") ||
    notes.includes("cranberry") ||
    notes.includes("tangerine") ||
    notes.includes("hibiscus") ||
    notes.includes("quinine") ||
    notes.includes("sea kelp")
  ) {
    acidity += 1;
  }

  if (notes.includes("chilled")) {
    body -= 1;
    tannin = Math.max(1, tannin - 1);
  }

  if (notes.includes("smoked blackberry") || notes.includes("blackberry")) {
    body += 1;
    tannin += 1;
  }

  return {
    ...inferred,
    body: clampTaste(body),
    acidity: clampTaste(acidity),
    tannin: clampTaste(tannin),
    sweetness: clampTaste(sweetness),
    confidence: 0.45,
    sourceMode: "inferred",
  };
}

export function mapExternalTasteVector(
  input: Partial<Record<"body" | "acidity" | "tannin" | "sweetness", number | undefined>>,
  sourceMode: TasteVector["sourceMode"],
  confidence: number,
): TasteVector {
  return {
    body: normalizeTasteValue(input.body ?? 3),
    acidity: normalizeTasteValue(input.acidity ?? 3),
    tannin: normalizeTasteValue(input.tannin ?? 3),
    sweetness: normalizeTasteValue(input.sweetness ?? 3),
    sourceMode,
    confidence,
  };
}

export function scoreRecommendation(
  preference: UserTastePreference,
  taste: TasteVector,
): number {
  const weightedDistance =
    Math.abs(preference.body - taste.body) * preference.weights.body +
    Math.abs(preference.acidity - taste.acidity) * preference.weights.acidity +
    Math.abs(preference.tannin - taste.tannin) * preference.weights.tannin +
    Math.abs(preference.sweetness - taste.sweetness) * preference.weights.sweetness;

  const maxDistance =
    4 * preference.weights.body +
    4 * preference.weights.acidity +
    4 * preference.weights.tannin +
    4 * preference.weights.sweetness;

  if (maxDistance === 0) return 100;
  const normalized = 1 - weightedDistance / maxDistance;
  return Math.max(0, Math.min(100, Math.round(normalized * 100)));
}

export function defaultPreference(): UserTastePreference {
  return {
    body: 3,
    acidity: 5,
    tannin: 3,
    sweetness: 1,
    weights: {
      body: 0.1,
      acidity: 0.4,
      tannin: 0.1,
      sweetness: 0.4,
    },
  };
}
