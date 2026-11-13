/**
 * Conservative, literal inline-region extraction.
 *
 * Only fills a region when the candidate text ends with an explicit
 * "<place>, <known country or US state>" field that starts after a comma
 * field boundary or a closing quote. It never guesses spellings, never
 * rewrites producer/label, and never changes admission or confidence.
 */
const KNOWN_PARENTS = [
  "france", "italy", "spain", "germany", "austria", "portugal", "greece", "hungary",
  "slovenia", "croatia", "switzerland", "georgia", "lebanon", "israel", "england",
  "japan", "australia", "new zealand", "argentina", "chile", "uruguay", "south africa",
  "canada", "mexico", "usa", "us", "united states",
  "california", "oregon", "washington", "new york", "virginia",
];

const VARIETAL_WORDS = new Set([
  "chardonnay", "pinot", "noir", "gris", "grigio", "blanc", "sauvignon", "cabernet", "franc",
  "merlot", "malbec", "syrah", "shiraz", "grenache", "garnacha", "tempranillo", "riesling",
  "nebbiolo", "sangiovese", "barbera", "dolcetto", "zinfandel", "gamay", "chenin", "viognier",
  "gewurztraminer", "gruner", "veltliner", "albarino", "carignan", "mourvedre", "cinsault",
  "trousseau", "poulsard", "savagnin", "aligote", "melon", "muscadet", "rose", "orange",
]);

const QUOTE_CHARS = /[‘’“”'"`]/;

function fold(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

function stripVarietalWords(field: string): string {
  return field
    .split(/\s+/)
    .filter((word) => !VARIETAL_WORDS.has(fold(word).replace(/[^a-z]/g, "")))
    .join(" ")
    .trim();
}

function isPlausiblePlace(field: string): boolean {
  if (!field || field.length > 40) return false;
  if (QUOTE_CHARS.test(field) || /\d/.test(field)) return false;
  // Words must look like proper-noun place words (allow "Sta.", hyphens, accents).
  return field.split(/\s+/).every((word) => /^[A-ZÀ-Ý][\p{L}.'-]*$/u.test(word) || /^(de|del|di|du|la|le|des|en|am|an|der)$/i.test(word));
}

export function extractInlineRegion(text: string | null | undefined): string | null {
  if (!text) return null;
  let tail = text
    .replace(/\b(19|20)\d{2}\b/g, " ")
    .replace(/\s*\/\s*\$?\d+(?:\.\d{2})?\s*$/, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[,\s]+$/, "");

  // Prefer the text after the last quote character (closing label quote).
  let afterQuote = false;
  const quoteMatch = [...tail.matchAll(/[‘’“”'"`]/g)].pop();
  if (quoteMatch && quoteMatch.index !== undefined) {
    const rest = tail.slice(quoteMatch.index + 1).trim();
    if (rest.includes(",")) {
      tail = rest;
      afterQuote = true;
    }
  }

  const fields = tail.split(",").map((field) => field.trim()).filter(Boolean);
  if (fields.length < 2) return null;
  const parent = fields[fields.length - 1]!;
  const parentFolded = fold(parent).replace(/\.$/, "");
  if (!KNOWN_PARENTS.includes(parentFolded)) return null;
  // Without a closing quote we need an explicit comma field before the place
  // (producer, ..., place, parent); a bare "Producer Words, Country" is ambiguous.
  if (!afterQuote && fields.length < 3) return null;

  const placeField = stripVarietalWords(fields[fields.length - 2]!);
  if (!isPlausiblePlace(placeField)) return null;
  if (fold(placeField) === parentFolded) return null;
  return `${placeField}, ${parent}`;
}
