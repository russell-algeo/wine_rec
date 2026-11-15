import type { WineCandidate } from "@wine-rec/contracts";
import { styleKeyFromText } from "@wine-rec/core";

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
  "vineyards", "weingut", "winery", "wines", "wine", "co", "sons", "fils", "freres", "herederos", "casa", "clos",
  "bodegas", "cantina", "company", "and",
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
  // Regions menus append after the wine; Vivino's search needs every word.
  "napa", "sonoma", "carneros", "willamette", "paso", "robles", "santa", "barbara", "cruz", "lucia", "monterey",
  "mendocino", "lodi", "edna", "russian", "river", "dundee", "columbia", "texas", "barossa", "eden", "mclaren",
  "vale", "clare", "adelaide", "yarra", "margaret", "hunter", "heathcote", "marlborough", "hawkes", "otago",
  "central", "mendoza", "uco", "colchagua", "maipo", "casablanca", "toscana", "tuscany", "piedmont", "piemonte",
  "veneto", "sicilia", "sicily", "puglia", "campania", "umbria", "lombardia", "friuli", "langhe", "alto", "adige",
  "bordeaux", "burgundy", "bourgogne", "rhone", "loire", "alsace", "champagne", "provence", "languedoc",
  "roussillon", "beaujolais", "rioja", "ribera", "duero", "priorat", "rias", "baixas", "jerez", "douro", "mosel",
  "rheingau", "pfalz", "wachau", "kamptal", "burgenland", "stellenbosch", "swartland", "zone", "northern",
  "southern", "cote", "cotes", "or", "nuits", "beaune",
]);

// Grape names: on their own they don't name a particular wine.
const GRAPE_WORDS = new Set([
  "cabernet", "sauvignon", "merlot", "pinot", "noir", "gris", "grigio", "blanc", "chardonnay", "syrah", "shiraz",
  "grenache", "garnacha", "tempranillo", "sangiovese", "nebbiolo", "barbera", "dolcetto", "malbec", "zinfandel",
  "primitivo", "riesling", "gewurztraminer", "viognier", "chenin", "semillon", "muscat", "moscato", "malvasia",
  "vermentino", "verdejo", "albarino", "godello", "gruner", "veltliner", "carmenere", "mourvedre", "monastrell",
  "petite", "sirah", "franc", "gamay", "aglianico", "nero", "avola", "montepulciano", "corvina", "trebbiano",
  "fiano", "greco", "falanghina", "refosco", "teroldego", "lagrein", "glera", "touriga", "nacional", "carignan",
  "cinsault", "marsanne", "roussanne", "torrontes", "tannat", "pinotage", "furmint", "assyrtiko", "xinomavro",
  "palomino", "pedro", "ximenez", "mencia", "bobal", "graciano", "macabeo", "xarello", "arneis", "cortese", "rebula", "ribolla",
  "loureira", "viura", "tibouren", "rolle", "nerello", "mascalese", "friulano", "sagrantino", "cannonau",
]);

// Second words of grape names; on their own they don't tell grapes apart.
const GRAPE_MODIFIERS = new Set(["blanc", "noir", "gris", "grigio", "franc", "petite", "sirah", "nero", "avola", "nacional",
  "pedro", "ximenez", "sauvignon", "veltliner"]);

// Tasting-note words some menus print after the wine. They are not part of
// any wine's name and make Vivino's every-word search come back empty.
const NOTE_WORDS = new Set([
  "cherry", "cherries", "plum", "plums", "compote", "chocolate", "vanilla", "bean", "pineapple", "lemon", "verbena",
  "silky", "curd", "nutmeg", "rich", "lime", "peel", "almond", "flinty", "cassis", "currant", "currants", "toast",
  "tart", "mint", "sour", "dried", "herb", "herbs", "toasty", "spice", "spicy", "balsamic", "ripe", "fruit", "fruits",
  "crushed", "rind", "tar", "walnut", "shell", "apricot", "kiwi", "herbaceous", "milk", "berry", "berries",
  "blackberry", "raspberry", "strawberry", "citrus", "grapefruit", "peach", "pear", "apple", "honey", "floral",
  "violet", "leather", "tobacco", "earthy", "mineral", "minerality", "oak", "oaky", "smoky", "pepper", "jammy",
  "crisp", "bright", "fresh", "juicy", "bold", "smooth", "elegant", "velvety", "licorice", "cedar", "mocha", "coffee",
  "cocoa", "caramel", "butter", "buttery", "creamy", "zesty", "tropical", "melon", "saline", "notes", "hints",
  "aromas", "palate", "finish", "tannins", "acidity", "structured", "lush", "savory", "savoury", "zest", "blossom",
  "brioche", "baked", "stone", "fig", "figs", "olive", "graphite", "clove", "cinnamon", "ginger", "jasmine",
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
    if (STOPWORDS.has(token) || NOISE.has(token) || NOTE_WORDS.has(token)) return false;
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
  // A grape name is matched exactly: "Tempranello" (a winery) is not Tempranillo.
  if (GRAPE_WORDS.has(a) || GRAPE_WORDS.has(b)) return false;
  // Tolerate one OCR or spelling slip on longer words (Grenoilles/Grenouilles).
  // The first two letters must agree: Joillot is not Boillot.
  if (a.length >= 7 && b.length >= 7 && a.slice(0, 2) === b.slice(0, 2) && editDistanceAtMostOne(a, b)) return true;
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
  return scoreVivinoIdentityDetail(candidate, hit).score;
}

export interface VivinoIdentityDetail {
  score: number;
  /** Matched on the cuvée name alone because the menu row names no producer. */
  withoutProducer: boolean;
  /** The hit's cuvée words that matched the row (set when withoutProducer). */
  cuveeTokens: string[];
}

export function scoreVivinoIdentityDetail(candidate: WineCandidate, hit: VivinoHitIdentity): VivinoIdentityDetail {
  const candidateTokens = candidateIdentityTokens(candidate);
  if (!candidateTokens.length) return { score: 0, withoutProducer: false, cuveeTokens: [] };

  const wineryTokens = identityTokens(hit.wineryName);
  // Vivino often repeats the winery inside the wine name; don't count it twice.
  const nameTokens = identityTokens(hit.wineName).filter(token => !wineryTokens.includes(token));
  const regionTokens = identityTokens(hit.regionAndCountry);

  // Appellation words in a wine name ("Alión Ribera del Duero") repeat the
  // hit's region; menus often leave them out, so they count for little.
  const nameWeights = (token: string) => regionTokens.includes(token) || PLACE_WORDS.has(token) ? 0.1 : tokenWeight(token, "name");
  const producer = weightedCoverage(wineryTokens, candidateTokens, "producer") ?? 0;
  // Menus often leave the grape out, or give it only in the section heading
  // ("PINOT NOIR" above the row). A grape the row doesn't name is weak
  // evidence against a hit; a grape it names elsewhere is a conflict and is
  // handled by the grape check before scoring.
  const contextGrapes = identityTokens([candidate.menuSection, candidate.varietal].filter(Boolean).join(" "))
    .filter(token => GRAPE_WORDS.has(token));
  const rowNamesGrape = candidateTokens.some(token => GRAPE_WORDS.has(token)) || contextGrapes.length > 0;
  const rowPool = [...candidateTokens, ...contextGrapes];
  let nameTotal = 0;
  let nameFound = 0;
  let nameMissing = 0;
  let cuveeTotal = 0;
  let cuveeFound = 0;
  for (const token of new Set(nameTokens)) {
    const grape = GRAPE_WORDS.has(token);
    const weight = grape && !rowNamesGrape ? 0.3 : nameWeights(token);
    nameTotal += weight;
    const found = hasToken(rowPool, token);
    if (found) nameFound += weight;
    else if (weight === 1 && !grape) nameMissing += 1;
    if (weight >= 0.3 && !STYLE_WORDS.has(token) && weight !== 0.1) {
      cuveeTotal += 1;
      if (found) cuveeFound += 1;
    }
  }
  // A name made only of place words names no particular cuvée.
  const onlyPlaces = [...new Set(nameTokens)].every(token => nameWeights(token) <= 0.1);
  const name = nameTotal > 0 && !onlyPlaces ? nameFound / nameTotal : 1;
  const coverage = weightedCoverage(candidateTokens, [...wineryTokens, ...nameTokens, ...regionTokens], "candidate") ?? 0;

  // A hit whose distinctive winery words are absent from the row is another
  // producer's wine, however well the appellation matches.
  const distinctiveWinery = wineryTokens.filter(token => tokenWeight(token, "producer") === 1);
  const producerSeen = distinctiveWinery.length === 0 || distinctiveWinery.some(token => hasToken(candidateTokens, token));

  // Some lists give only the appellation and the cuvée ("Greco di Tufo -
  // Giallo d'Arles"). When nearly every word of the row is in the hit and a
  // real cuvée word (not a grape or place) matches, the missing producer is
  // the list's omission, not another producer's wine.
  const cuveeMatched = [...new Set(nameTokens)].filter(token =>
    nameWeights(token) === 1 && !GRAPE_WORDS.has(token) && hasToken(candidateTokens, token));
  const withoutProducer = !producerSeen && coverage >= 0.85 && nameMissing === 0 && cuveeMatched.length >= 1
    // One shared word ("Stout") isn't enough when the hit's wine has more to its name.
    && (cuveeFound === cuveeTotal || cuveeMatched.length >= 2);

  let score = 0.4 * producer + 0.35 * name + 0.25 * coverage;
  if (withoutProducer) score = Math.min(0.8, 0.5 * name + 0.5 * coverage);
  else if (!producerSeen) score *= 0.45;
  // Another cuvée of the right producer (Mâcon-Lugny for Mâcon-Uchizy,
  // "Edizione Limitata" for plain Tancredi): its own name words are missing.
  if (nameMissing >= 2) score = Math.min(score, 0.55);
  else if (nameMissing === 1 && name < 0.5) score = Math.min(score, 0.62);
  // The row names only the producer and the hit is one of its varietal
  // wines ("Van Duzer" vs "Van Duzer Riesling"): no word of the hit's wine
  // name is on the row, so we can't tell which of the producer's wines it is.
  if (cuveeTotal > 0 && cuveeFound === 0) score = Math.min(score, 0.58);
  // The row names a grape the hit's wine name leaves out while naming others
  // ("Tempranillo Grenache" against the producer's straight "Grenache").
  const mainGrape = (token: string) => GRAPE_WORDS.has(token) && !GRAPE_MODIFIERS.has(token);
  const hitGrapes = [...wineryTokens, ...nameTokens].filter(mainGrape);
  if (hitGrapes.length && candidateTokens.filter(mainGrape).some(token => !hitGrapes.includes(token))) score = Math.min(score, 0.58);
  // A quoted cuvée on the menu ("Chollet", « Les Combettes ») must be in the hit.
  const quoted = quotedCuveeTokens(candidate.rawText);
  if (quoted.length && !quoted.some(token => hasToken([...wineryTokens, ...nameTokens], token))) score = Math.min(score, 0.55);
  // Part of the producer name missing (Henri Boillot for J.M. Boillot).
  if (!withoutProducer) {
    if (producer < 0.6) score = Math.min(score, 0.58);
    else if (producer < 0.75) score = Math.min(score, 0.7);
  }
  // Rosé is a different wine from the same producer's white or red.
  const hitRose = [...wineryTokens, ...nameTokens].some(token => ROSE_WORDS.has(token));
  const rowRose = candidateTokens.some(token => ROSE_WORDS.has(token));
  if (hitRose && !rowRose) score *= 0.6;
  else if (rowRose && !hitRose) score *= 0.75;
  if (process.env.VIVINO_MATCH_DEBUG) console.log(`[vivino-match] ${hit.wineryName} | ${hit.wineName} producer=${producer.toFixed(2)} name=${name.toFixed(2)} coverage=${coverage.toFixed(2)} missing=${nameMissing}${withoutProducer ? " no-producer" : ""} -> ${score.toFixed(2)}`);
  return { score: Math.max(0, Math.min(1, score)), withoutProducer, cuveeTokens: withoutProducer ? cuveeMatched : [] };
}

/** Distinctive words inside quotes on the menu row: the cuvée's own name. */
export function quotedCuveeTokens(rawText: string | null | undefined): string[] {
  const text = rawText ?? "";
  const segments: string[] = [];
  for (const match of text.matchAll(/[‘“«„]\s*([^’”»“]{2,48}?)\s*[’”»“]|"([^"]{2,48})"|(?:^|[\s,(])'([^']{2,48})'(?=[\s,).]|$)/g)) {
    segments.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return identityTokens(segments.join(" ")).filter(token =>
    !GRAPE_WORDS.has(token) && !PLACE_WORDS.has(token) && !STYLE_WORDS.has(token) && !GENERIC_PRODUCER.has(token));
}

const RED_STYLES = new Set(["light_red", "pinot_noir", "medium_red", "cabernet_sauvignon", "merlot", "syrah", "grenache",
  "tempranillo", "malbec", "nebbiolo", "sangiovese", "barbera", "zinfandel", "big_tannic_red", "amarone", "default_red"]);
const WHITE_STYLES = new Set(["sauvignon_blanc", "crisp_white", "light_white", "riesling_dry", "chardonnay",
  "chardonnay_unoaked", "chenin_blanc", "pinot_grigio", "aromatic_white", "full_white", "medium_white", "default_white"]);

function styleColour(text: string): "red" | "white" | null {
  const key = styleKeyFromText(text);
  return key && RED_STYLES.has(key) ? "red" : key && WHITE_STYLES.has(key) ? "white" : null;
}

/**
 * Red against white from the row's own words and the hit's name and region
 * ("Chardonnay, Lucien Le Moine" is not Lucien Le Moine Fleurie).
 */
export function hasColourConflict(candidate: WineCandidate, hit: VivinoHitIdentity): boolean {
  const row = styleColour(candidate.rawText || [candidate.producer, candidate.label].filter(Boolean).join(" "));
  if (!row) return false;
  // The hit's own name only: a region's usual grape (Rutherford, Cabernet)
  // says nothing about a white wine made there.
  const found = styleColour(hit.wineName);
  return Boolean(found && found !== row);
}

/**
 * Producers among search hits whose wine name carries every cuvée word.
 * A cuvée-only match is safe only when one producer makes that cuvée
 * (Giallo d'Arles), not for a shared vineyard name (Les Amoureuses).
 */
export function producersWithCuvee(hits: VivinoHitIdentity[], cuveeTokens: string[]): Set<string> {
  const producers = new Set<string>();
  for (const hit of hits) {
    const nameTokens = identityTokens(hit.wineName);
    if (cuveeTokens.every(token => hasToken(nameTokens, token))) producers.add(normalizeIdentityText(hit.wineryName).trim());
  }
  return producers;
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
    identityTokens(value, { synonyms: false }).filter(token => !PLACE_WORDS.has(token) && !STYLE_WORDS.has(token)
      && !GENERIC_PRODUCER.has(token) && token !== "years");
  const producerTokens = searchable(candidate.producer);
  const labelTokens = searchable(candidate.label);
  const rawTokens = searchable(candidate.rawText);
  const regionTokens = new Set(identityTokens(candidate.region));
  const withoutRegion = (tokens: string[]) => tokens.filter(token => !regionTokens.has(token));

  const identity = withoutRegion([...producerTokens, ...labelTokens]);
  const tokens = identity.length ? identity : withoutRegion(rawTokens);
  // Names first: Vivino's search needs every word, and a grape the menu
  // adds ("Cabernet" before "Casa Lapostolle Cuvée Alexander") is often not
  // in Vivino's wine name. A row of grapes alone names no wine.
  const names = [...new Set(tokens.filter(token => !GRAPE_WORDS.has(token)))];
  const grapes = [...new Set(tokens.filter(token => GRAPE_WORDS.has(token)))];
  if (!names.length) return [];
  const producerOnly = withoutRegion(producerTokens.filter(token => !GRAPE_WORDS.has(token)));
  const quoted = quotedCuveeTokens(candidate.rawText);
  const producerNames = producerOnly.filter(token => !quoted.includes(token)).slice(0, 2);
  const queries = [
    compactQuery(names, 4),
    quoted.length && producerNames.length ? compactQuery([...producerNames, ...quoted], 4) : null,
    compactQuery(names, 2),
    names.length <= 2 && grapes.length ? compactQuery([...names, grapes[0]!], 3) : null,
    compactQuery(producerOnly, 3),
  ].filter((query): query is string => Boolean(query));
  return [...new Set(queries)].slice(0, 3);
}
