import type {
  TasteVector,
  UserTastePreference,
  WineCandidate,
  WineProfile,
} from "@wine-rec/contracts";

type MatchParts = Pick<
  WineCandidate,
  "producer" | "label" | "vintage" | "varietal" | "region"
> &
  Partial<Pick<WineCandidate, "rawText" | "color">>;

// Common grape varietal tokens that appear in many different wines and therefore
// carry little identity signal on their own. Excluding them prevents two unrelated
// wines that happen to share a varietal (e.g. "Slope Syrah Viognier" vs
// "Ravasqueira Syrah-Viognier") from scoring a false match via the pooled scorer.
// Note: "pinot" and "noir" are intentionally omitted — they are load-bearing
// identity tokens for the Paul Mas / Pinot Noir regression test.
const varietalTokens = new Set([
  "cabernet", "chardonnay", "grenache", "grigio",
  "gruner", "malbec", "merlot", "mourvedre",
  "noir", "pinot",
  "riesling", "sangiovese", "sauvignon", "shiraz",
  "syrah", "tempranillo", "veltliner", "viognier", "zinfandel",
]);

const identityStopwords = new Set([
  "a",
  "an",
  "and",
  "contact",  // winemaking technique ("skin contact")
  "czech",    // country descriptor
  "da",
  "de",
  "del",
  "della",
  "di",
  "do",
  "dos",
  "du",
  "la",
  "le",
  "nat",      // pétillant naturel style
  "of",
  "pet",      // pétillant naturel style
  "regional",
  "republic", // political/country term
  "skin",     // winemaking technique ("skin contact")
  "terre",
  "the",
  "valley",
  "verde",    // Vinho Verde appellation descriptor ("vinho" already stripped)
  "vin",
  "vino",
  "vinho",
  "wine",
  "wines",
]);

const countryTokens = new Set([
  "argentina",
  "australia",
  "france",
  "germany",
  "italy",
  "japan",
  "portugal",
  "spain",
  "states",
  "united",
]);

const conceptAliases = new Map<string, string>([
  ["bianco", "white"],
  ["blanc", "white"],
  ["blanco", "white"],
  ["branco", "white"],
  ["frizzante", "sparkling"],
  ["red", "red"],
  ["reserve", "reserve"],
  ["reserva", "reserve"],
  ["ros", "rose"],
  ["rose", "rose"],
  ["rosado", "rose"],
  ["rosato", "rose"],
  ["rosé", "rose"],
  ["rosso", "red"],
  ["rouge", "red"],
  ["sparkling", "sparkling"],
  ["spumante", "sparkling"],
  ["superior", "superior"],
  ["tinto", "red"],
  ["white", "white"],
]);

const exactConceptBonusTokens = new Set([
  "bianco",
  "blanc",
  "blanco",
  "branco",
  "frizzante",
  "reserve",
  "reserva",
  "ros",
  "rose",
  "rosado",
  "rosato",
  "rosé",
  "rosso",
  "rouge",
  "spumante",
  "superior",
  "tinto",
]);

const conceptPenaltyWeights = new Map<string, number>([
  ["red", 0.12],
  ["reserve", 0.14],
  ["rose", 0.2],
  ["sparkling", 0.16],
  ["superior", 0.12],
  ["white", 0.16],
]);

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
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
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

function tokenize(value: string | null | undefined): string[] {
  const normalized = normalizeField(value);
  return normalized ? normalized.split(" ") : [];
}

function isYearToken(token: string): boolean {
  return /^(19|20)\d{2}$/.test(token);
}

function isVolumeToken(token: string): boolean {
  return /^\d+(?:l|ml)$/.test(token);
}

function extractIdentityTokens(value: string | null | undefined): string[] {
  return tokenize(value).filter((token) => {
    return (
      token.length > 1 &&
      !identityStopwords.has(token) &&
      !countryTokens.has(token) &&
      !conceptAliases.has(token) &&
      !varietalTokens.has(token) &&
      !isYearToken(token) &&
      !isVolumeToken(token)
    );
  });
}

function buildTokenSet(values: Array<string | null | undefined>): Set<string> {
  return new Set(values.flatMap((value) => extractIdentityTokens(value)));
}

function overlapRatio(candidateTokens: string[], targetTokens: Set<string>): number {
  if (candidateTokens.length === 0 || targetTokens.size === 0) return 0;
  const overlap = candidateTokens.filter((token) => targetTokens.has(token)).length;
  return overlap / candidateTokens.length;
}

function scoreIdentityCoverage(
  candidateValue: string | null | undefined,
  targetValues: Array<string | null | undefined>,
  singleTokenMultiplier = 1,
): number {
  const candidateTokens = extractIdentityTokens(candidateValue);
  const score = fuzzyOverlapRatio(candidateTokens, buildTokenSet(targetValues));
  return candidateTokens.length === 1 ? score * singleTokenMultiplier : score;
}

function scoreIdentityRecovery(
  candidateValue: string | null | undefined,
  alreadyMatchedValues: Array<string | null | undefined>,
  recoveryValues: Array<string | null | undefined>,
): number {
  const candidateTokens = extractIdentityTokens(candidateValue);
  if (candidateTokens.length === 0) return 0;

  const matchedTokens = buildTokenSet(alreadyMatchedValues);
  const remainingTokens = candidateTokens.filter((token) => !matchedTokens.has(token));
  if (remainingTokens.length === 0) return 0;

  return overlapRatio(remainingTokens, buildTokenSet(recoveryValues));
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j]!;
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j - 1]!, dp[j]!);
      prev = temp;
    }
  }
  return dp[n]!;
}

/** Weight for a candidate token against a set of profile tokens.
 *  Returns 1.0 for exact match, 0.8 for edit-distance-1 on tokens ≥4 chars, 0 otherwise. */
function fuzzyTokenWeight(token: string, targetTokens: Set<string>): number {
  if (targetTokens.has(token)) return 1.0;
  if (token.length >= 4) {
    for (const target of targetTokens) {
      if (target.length >= 4 && levenshtein(token, target) <= 1) return 0.8;
    }
  }
  return 0;
}

function fuzzyOverlapRatio(candidateTokens: string[], targetTokens: Set<string>): number {
  if (candidateTokens.length === 0 || targetTokens.size === 0) return 0;
  const overlap = candidateTokens.reduce((sum, token) => sum + fuzzyTokenWeight(token, targetTokens), 0);
  return overlap / candidateTokens.length;
}

/** Bidirectional F1-style overlap across ALL fields of candidate vs ALL fields of profile.
 *  Uses fuzzy token matching (edit-distance ≤1) for tokens ≥4 chars. */
function scorePooledMatch(candidate: MatchParts, profile: Partial<MatchParts>): number {
  const candidateTokens = buildTokenSet([
    candidate.producer,
    candidate.label,
    candidate.varietal,
    candidate.region,
    candidate.rawText,
  ]);
  const profileTokens = buildTokenSet([
    profile.producer,
    profile.label,
    profile.varietal,
    profile.region,
  ]);

  if (candidateTokens.size === 0 || profileTokens.size === 0) return 0;

  // recall: how much of the profile is covered by the candidate
  let profileCoverage = 0;
  for (const pt of profileTokens) {
    profileCoverage += fuzzyTokenWeight(pt, candidateTokens);
  }
  const recall = profileCoverage / profileTokens.size;

  // precision: how many candidate tokens are found in the profile
  let candidateCoverage = 0;
  for (const ct of candidateTokens) {
    candidateCoverage += fuzzyTokenWeight(ct, profileTokens);
  }
  const precision = candidateCoverage / candidateTokens.size;

  if (recall + precision === 0) return 0;
  return (2 * recall * precision) / (recall + precision);
}

function scoreNovelRegionCoverage(
  candidateRegion: string | null | undefined,
  candidateLabel: string | null | undefined,
  profileRegion: string | null | undefined,
): number {
  const labelTokens = new Set(extractIdentityTokens(candidateLabel));
  const regionTokens = extractIdentityTokens(candidateRegion).filter(
    (token) => !labelTokens.has(token),
  );
  return overlapRatio(regionTokens, buildTokenSet([profileRegion]));
}

function extractConcepts(values: Array<string | null | undefined>): Set<string> {
  const concepts = new Set<string>();
  for (const token of values.flatMap((value) => tokenize(value))) {
    const concept = conceptAliases.get(token);
    if (concept) concepts.add(concept);
  }
  return concepts;
}

function extractExactConceptTokens(values: Array<string | null | undefined>): Set<string> {
  return new Set(
    values.flatMap((value) => tokenize(value)).filter((token) => exactConceptBonusTokens.has(token)),
  );
}

function scoreExactConceptTokenBonus(candidate: MatchParts, profile: Partial<MatchParts>): number {
  const candidateConceptTokens = extractExactConceptTokens([
    candidate.label,
    candidate.varietal,
    candidate.region,
  ]);
  if (candidateConceptTokens.size === 0) return 0;

  const profileConceptTokens = extractExactConceptTokens([
    profile.label,
    profile.varietal,
    profile.region,
  ]);
  const matched = [...candidateConceptTokens].filter((token) => profileConceptTokens.has(token));
  return matched.length > 0 ? 1 : 0;
}

function scoreConceptPenalty(candidate: MatchParts, profile: Partial<MatchParts>): number {
  const candidateConcepts = extractConcepts([
    candidate.label,
    candidate.varietal,
    candidate.region,
    candidate.rawText,
    candidate.color,
  ]);
  const profileConcepts = extractConcepts([profile.label, profile.varietal, profile.region]);

  let penalty = 0;
  for (const concept of profileConcepts) {
    if (candidateConcepts.has(concept)) continue;
    penalty += conceptPenaltyWeights.get(concept) ?? 0;
  }

  return Math.min(0.3, penalty);
}

/** Penalises matches where the producer aligns well but the label tokens share
 *  zero overlap.  This catches cases like "Fanny Sabre Bourgogne Rouge" falsely
 *  matching "Fanny Sabre Cuvée Anatole Pinot Noir" — same winery, wrong wine.
 *  The penalty only fires when both the candidate and profile labels carry
 *  non-trivial identity content with no fuzzy intersection. */
/** Penalises matches where the producer aligns well but none of the profile's
 *  specific label tokens (e.g. "Cuvée Anatole") appear anywhere in the candidate.
 *  Grape-variety tokens are already stripped from identity tokens so this check
 *  focuses on the wine's proper name/appellation rather than shared varietals.
 *
 *  We check profile label tokens against the candidate's FULL identity pool
 *  (all fields) to be robust to field-alignment mismatches. */
function scoreSameProducerWrongLabelPenalty(
  candidate: MatchParts,
  profile: Partial<MatchParts>,
): number {
  if (scoreToken(candidate.producer, profile.producer) < 0.5) return 0;
  const profileLabelTokens = extractIdentityTokens(profile.label);
  if (profileLabelTokens.length === 0) return 0;
  // Build the candidate's full identity token pool across all fields.
  const candidateAllTokens = buildTokenSet([
    candidate.producer,
    candidate.label,
    candidate.region,
    candidate.rawText,
  ]);
  if (candidateAllTokens.size === 0) return 0;
  const hasOverlap = profileLabelTokens.some((t) => fuzzyTokenWeight(t, candidateAllTokens) > 0);
  return hasOverlap ? 0 : 0.30;
}

export function scoreWineMatch(candidate: MatchParts, profile: Partial<MatchParts>): number {
  // Primary signal: bidirectional pooled token overlap across all fields.
  // This is robust to field-alignment mismatches that are common in menu parsing.
  const pooledScore = scorePooledMatch(candidate, profile) * 0.50;

  // Secondary signals: field-aligned bonuses when fields do happen to align.
  const producerScore = scoreToken(candidate.producer, profile.producer) * 0.18;
  const labelScore = scoreIdentityCoverage(candidate.label, [profile.label], 0.6) * 0.18;
  const producerRecoveryBonus =
    scoreIdentityRecovery(candidate.label, [profile.label], [profile.producer]) * 0.03;
  const regionRecoveryBonus =
    scoreIdentityRecovery(candidate.label, [profile.label, profile.producer], [profile.region]) *
    0.03;
  const varietalScore = scoreIdentityCoverage(candidate.varietal, [profile.varietal]) * 0.06;
  const regionScore = scoreNovelRegionCoverage(candidate.region, candidate.label, profile.region) * 0.03;
  const rawTextBonus =
    scoreIdentityCoverage(candidate.rawText, [profile.producer, profile.label, profile.region]) *
    0.02;
  const exactConceptBonus = scoreExactConceptTokenBonus(candidate, profile) * 0.03;
  const contradictionPenalty = scoreConceptPenalty(candidate, profile);
  const sameProducerWrongLabelPenalty = scoreSameProducerWrongLabelPenalty(candidate, profile);
  const vintageScore =
    candidate.vintage && profile.vintage
      ? candidate.vintage === profile.vintage
        ? 0.10
        : 0
      : 0;

  return Math.max(
    0,
    Math.min(
      1,
      pooledScore +
        producerScore +
        labelScore +
        producerRecoveryBonus +
        regionRecoveryBonus +
        varietalScore +
        regionScore +
        vintageScore +
        rawTextBonus +
        exactConceptBonus -
        contradictionPenalty -
        sameProducerWrongLabelPenalty,
    ),
  );
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
