import type { WineCandidate } from "@wine-rec/contracts";

/*
 * Wine-level identity scoring and search queries for Vivino hits.
 *
 * Menu rows are messy: parser fields are often misassigned ("GREYWACKE
 * SAUVIGNON BLANC" as producer, "85 €" as label), rows can carry a
 * neighbour's text, and the vintage on the list is often not the vintage
 * Vivino's shop results show. So this scores tokens across the whole row
 * against the hit's winery and wine name, and treats vintage separately.
 * Taste structure and flavour notes on Vivino are per wine, not per vintage.
 */

const STOPWORDS = new Set([
  "a", "al", "and", "da", "dal", "dalla", "das", "de", "dei", "del", "della", "der", "des", "di", "do", "dos", "du",
  "e", "el", "en", "et", "il", "la", "las", "le", "les", "lo", "los", "of", "the", "und", "vom", "von", "y", "zu",
  "by", "from", "with", "cuvee", "vino", "vin", "vinho", "wein",
]);

// Words that name a kind of business, not a particular producer.
const GENERIC_PRODUCER = new Set([
  "azienda", "agricola", "bodega", "bodegas", "cantina", "cantine", "castello", "cave", "caves", "cellar", "cellars",
  "chateau", "company", "domaine", "domaines", "estate", "estates", "famiglia", "famille", "family", "fattoria",
  "maison", "podere", "quinta", "tenuta", "tenute", "vigneti", "vignobles", "vina", "vinedos", "vineyard",
  "vineyards", "weingut", "winery", "wines", "wine", "co", "sons", "fils", "freres", "herederos",
]);

// Style and classification words: real evidence, but weaker than names.
const STYLE_WORDS = new Set([
  "aoc", "aop", "ava", "doc", "docg", "doca", "dop", "igp", "igt", "vdp", "qualitatswein", "pradikatswein",
  "brut", "extra", "nature", "zero", "dosage", "sec", "demi", "dry", "trocken", "feinherb", "halbtrocken", "dolce",
  "reserve", "reserva", "riserva", "gran", "grand", "grande", "cru", "premier", "1er", "classico", "superiore",
  "crianza", "joven", "roble", "selection", "selezione", "vieilles", "vignes", "old", "vine", "vines",
  "red", "white", "rose", "rosado", "rosato", "rosso", "bianco", "blanc", "blanco", "blanca", "rouge", "tinto",
  "tinta", "branco", "orange", "sparkling", "spumante", "cremant", "cava", "frizzante", "sweet", "dessert",
  "blend", "estate", "single", "vineyard", "lieu", "dit", "nv", "mv", "blancs", "noirs", "millesime", "vintage",
]);

const ROSE_WORDS = new Set(["rose", "rosado", "rosato", "rosat"]);

// Place names that menus add after the wine; they rarely appear in a
// Vivino wine name and must not cost the candidate coverage.
const PLACE_WORDS = new Set([
  "france", "italy", "italia", "spain", "espana", "portugal", "germany", "deutschland", "austria", "osterreich",
  "usa", "us", "california", "ca", "oregon", "washington", "new", "zealand", "nz", "australia", "sa", "vic",
  "nsw", "wa", "argentina", "chile", "south", "africa", "greece", "hungary", "mexico", "uruguay", "lebanon",
  "england", "uk", "valley", "county", "coast", "hills", "mountains", "mountain", "region",
]);

const NOISE = new Set(["ml", "cl", "l", "magnum", "half", "bottle", "glass", "btl", "gls", "carafe", "price"]);

export function normalizeIdentityText(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[‘’'`´"“”«»]/g, " ")
    .replace(/&/g, " and ");
}

// Same grape, different name on the menu and on Vivino.
const GRAPE_SYNONYMS: Record<string, string> = {
  shiraz: "syrah", garnacha: "grenache", cannonau: "grenache", grigio: "gris", monastrell: "mourvedre",
  mataro: "mourvedre", primitivo: "zinfandel", tribidrag: "zinfandel", spatburgunder: "pinot", blauburgunder: "pinot",
};

export function identityTokens(value: string | null | undefined, options: { synonyms?: boolean } = {}): string[] {
  const raw = normalizeIdentityText(value).match(/[a-z0-9]+/g) ?? [];
  const tokens = options.synonyms === false ? raw : raw.map(token => GRAPE_SYNONYMS[token] ?? token);
  return tokens.filter(token => {
    if (token.length <= 1) return false;
    if (STOPWORDS.has(token) || NOISE.has(token)) return false;
    if (/^\d+$/.test(token)) return false; // prices, years, bin numbers
    if (/^\d+(?:ml|cl|l|oz)$/.test(token)) return false;
    return true;
  });
}

function tokenWeight(token: string, role: "producer" | "name" | "candidate"): number {
  if (role === "producer" && GENERIC_PRODUCER.has(token)) return 0.15;
  if (role === "producer" && PLACE_WORDS.has(token)) return 0.15;
  if (GENERIC_PRODUCER.has(token)) return 0.2;
  if (STYLE_WORDS.has(token)) return 0.45;
  if (role === "candidate" && PLACE_WORDS.has(token)) return 0.1;
  return 1;
}

function editDistanceAtMostOne(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

function tokensMatch(a: string, b: string): boolean {
  if (a === b) return true;
  // Tolerate one OCR or spelling slip on longer words (Grenoilles/Grenouilles).
  // The first two letters must agree: Joillot is not Boillot.
  if (a.length >= 5 && b.length >= 5 && a.slice(0, 2) === b.slice(0, 2) && editDistanceAtMostOne(a, b)) return true;
  // Joined forms: "dalba" vs "d alba" is handled by stopword removal; also
  // accept a long token that is a prefix of the other (Schloss/Schlossgut).
  return a.length >= 6 && b.length >= 6 && (a.startsWith(b) || b.startsWith(a));
}

function hasToken(pool: string[], token: string): boolean {
  return pool.some(candidate => tokensMatch(candidate, token));
}

function weightedCoverage(tokens: string[], pool: string[], role: "producer" | "name" | "candidate"): number | null {
  const unique = [...new Set(tokens)];
  let total = 0;
  let found = 0;
  for (const token of unique) {
    const weight = tokenWeight(token, role);
    total += weight;
    if (hasToken(pool, token)) found += weight;
  }
  return total > 0 ? found / total : null;
}

export interface VivinoHitIdentity {
  wineryName: string;
  wineName: string;
  regionAndCountry?: string | null;
}

/** Tokens of the menu row that identify the wine (not price, size or neighbour notes). */
export function candidateIdentityTokens(candidate: WineCandidate): string[] {
  const text = candidate.rawText || [candidate.producer, candidate.label].filter(Boolean).join(" ");
  return identityTokens(text);
}

/**
 * Wine-level identity in [0, 1]. Vintage is ignored on purpose; callers
 * compare it separately to pick the right vintage of the same wine.
 */
export function scoreVivinoIdentity(candidate: WineCandidate, hit: VivinoHitIdentity): number {
  const candidateTokens = candidateIdentityTokens(candidate);
  if (!candidateTokens.length) return 0;

  const wineryTokens = identityTokens(hit.wineryName);
  // Vivino often repeats the winery inside the wine name; don't count it twice.
  const nameTokens = identityTokens(hit.wineName).filter(token => !wineryTokens.includes(token));
  const regionTokens = identityTokens(hit.regionAndCountry);

  // Appellation words in a wine name ("Alión Ribera del Duero") repeat the
  // hit's region; menus often leave them out, so they count for little.
  const nameWeights = (token: string) => regionTokens.includes(token) || PLACE_WORDS.has(token) ? 0.1 : tokenWeight(token, "name");
  const producer = weightedCoverage(wineryTokens, candidateTokens, "producer") ?? 0;
  let nameTotal = 0;
  let nameFound = 0;
  let nameMissing = 0;
  for (const token of new Set(nameTokens)) {
    const weight = nameWeights(token);
    nameTotal += weight;
    if (hasToken(candidateTokens, token)) nameFound += weight;
    else if (weight === 1) nameMissing += 1;
  }
  // A name made only of place words names no particular cuvée.
  const onlyPlaces = [...new Set(nameTokens)].every(token => nameWeights(token) <= 0.1);
  const name = nameTotal > 0 && !onlyPlaces ? nameFound / nameTotal : 1;
  const coverage = weightedCoverage(candidateTokens, [...wineryTokens, ...nameTokens, ...regionTokens], "candidate") ?? 0;

  // A hit whose distinctive winery words are absent from the row is another
  // producer's wine, however well the appellation matches.
  const distinctiveWinery = wineryTokens.filter(token => tokenWeight(token, "producer") === 1);
  const producerSeen = distinctiveWinery.length === 0 || distinctiveWinery.some(token => hasToken(candidateTokens, token));

  let score = 0.4 * producer + 0.35 * name + 0.25 * coverage;
  if (!producerSeen) score *= 0.45;
  // Another cuvée of the right producer (Mâcon-Lugny for Mâcon-Uchizy,
  // "Edizione Limitata" for plain Tancredi): its own name words are missing.
  if (nameMissing >= 2) score = Math.min(score, 0.55);
  else if (nameMissing === 1 && name < 0.5) score = Math.min(score, 0.62);
  // Part of the producer name missing (Henri Boillot for J.M. Boillot).
  if (producer < 0.6) score = Math.min(score, 0.58);
  else if (producer < 0.75) score = Math.min(score, 0.7);
  // Rosé is a different wine from the same producer's white or red.
  const hitRose = [...wineryTokens, ...nameTokens].some(token => ROSE_WORDS.has(token));
  const rowRose = candidateTokens.some(token => ROSE_WORDS.has(token));
  if (hitRose && !rowRose) score *= 0.6;
  else if (rowRose && !hitRose) score *= 0.75;
  if (process.env.VIVINO_MATCH_DEBUG) console.log(`[vivino-match] ${hit.wineryName} | ${hit.wineName} producer=${producer.toFixed(2)} name=${name.toFixed(2)} coverage=${coverage.toFixed(2)} missing=${nameMissing} -> ${score.toFixed(2)}`);
  return Math.max(0, Math.min(1, score));
}

function compactQuery(tokens: string[], max: number): string | null {
  const unique = [...new Set(tokens)].slice(0, max);
  return unique.length >= 1 && unique.join("").length >= 4 ? unique.join(" ") : null;
}

/**
 * Short search queries, most specific first. Vivino's search matches every
 * word, so place names, vintages and classification words only lose results.
 */
export function buildVivinoIdentityQueries(candidate: WineCandidate): string[] {
  const searchable = (value: string | null | undefined) =>
    identityTokens(value, { synonyms: false }).filter(token => !PLACE_WORDS.has(token) && !STYLE_WORDS.has(token) && token !== "years");
  const producerTokens = searchable(candidate.producer);
  const labelTokens = searchable(candidate.label);
  const rawTokens = searchable(candidate.rawText);
  const regionTokens = new Set(identityTokens(candidate.region));
  const withoutRegion = (tokens: string[]) => tokens.filter(token => !regionTokens.has(token));

  const identity = withoutRegion([...producerTokens, ...labelTokens]);
  const fallback = identity.length ? identity : withoutRegion(rawTokens);
  const producerOnly = withoutRegion(producerTokens.filter(token => !GENERIC_PRODUCER.has(token)));
  const queries = [
    compactQuery(fallback, 4),
    compactQuery(fallback, 2),
    compactQuery(producerOnly, 3),
  ].filter((query): query is string => Boolean(query));
  return [...new Set(queries)].slice(0, 3);
}
