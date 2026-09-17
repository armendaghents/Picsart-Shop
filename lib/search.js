// Shared hybrid search helpers: PostgreSQL full-text candidate retrieval +
// JS-side weighted scoring, typo tolerance, and synonym expansion.

export const SYNONYMS = {
  pc: ["computer", "desktop", "workstation"],
  computer: ["pc", "desktop", "laptop", "workstation", "mac"],
  computers: ["pc", "computer", "desktop", "laptop", "workstation", "mac"],
  desktop: ["pc", "computer", "workstation"],
  laptop: ["notebook", "ultrabook", "computer", "macbook"],
  notebook: ["laptop", "computer"],
  mac: ["apple", "macbook", "imac", "computer", "laptop", "desktop"],
  macbook: ["mac", "apple", "laptop"],
  imac: ["mac", "apple", "desktop"],
  apple: ["mac", "macbook", "imac"],
  qr: ["barcode", "scanner", "2d"],
  scanner: ["barcode", "qr", "reader"],
  gpu: ["graphics", "rtx", "rendering"],
  wifi: ["router", "network", "mesh"],
  router: ["wifi", "network", "mesh"],
  battery: ["ups", "power", "backup"],
  ups: ["battery", "power", "backup"],
  monitor: ["display", "screen"],
  display: ["monitor", "screen"],
  headset: ["headphones", "audio", "headphone"],
  chair: ["seating", "furniture"],
  switch: ["network switch", "ethernet"],
  cart: ["trolley", "material handling"],
  finder: ["search", "lookup", "query"],
};

export function normalize(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function unique(values) {
  return [...new Set(values)].sort();
}

// Damerau-Levenshtein distance (insert/delete/substitute/transpose), computed
// with a full DP table. Catalog terms are short, so the O(n*m) table is
// negligible cost and — unlike a rolling single-row optimization — it's easy
// to verify correct, including adjacent-transposition typos ("gamign" -> "gaming").
export function levenshtein(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 9;
  const m = a.length;
  const n = b.length;
  const d = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i += 1) d[i][0] = i;
  for (let j = 0; j <= n; j += 1) d[0][j] = j;

  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1, // deletion
        d[i][j - 1] + 1, // insertion
        d[i - 1][j - 1] + cost // substitution
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1); // transposition
      }
    }
  }
  return d[m][n];
}

export function expandTerms(query) {
  const base = normalize(query).split(" ").filter(Boolean);
  return unique(base.flatMap((term) => [term, ...(SYNONYMS[term] || [])]));
}

// Turn a raw term into a to_tsquery() prefix token, e.g.  gaming -> gaming:*
// Everything but letters and digits is stripped, so no user input can reach
// to_tsquery as syntax. A multi-word synonym ("network switch") becomes an
// adjacency match — the tsquery equivalent of FTS5's quoted phrase prefix.
export function ftsPrefixToken(term) {
  const words = String(term ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  if (!words.length) return null;
  return words.map((word) => `${word}:*`).join(" <-> ");
}

// OR-joined, matching the old FTS5 behaviour: any term may match, and the JS
// scorer decides how much each hit is actually worth.
export function buildFtsQuery(terms) {
  const tokens = terms.map(ftsPrefixToken).filter(Boolean);
  return tokens.length ? tokens.map((token) => `(${token})`).join(" | ") : null;
}

// Score a denormalized inventory row against a free-text query. Mirrors the
// original client-side ranking: exact/prefix hits on identifiers score
// highest, then name/tag/category hits, then fuzzy (typo-tolerant) matches.
export function scoreRow(row, query) {
  if (!query) return 50;
  const terms = expandTerms(query);
  const normalizedQuery = normalize(query);

  const name = normalize(row.name);
  const sku = normalize(row.sku);
  const barcode = normalize(row.barcode);
  const serial = normalize(row.serial_number);
  const tags = normalize(row.tagsText || "");
  const category = normalize(row.category_path || "");
  const ocr = normalize(row.ocr_text || "");
  const fullText = normalize(
    [row.name, row.sku, row.barcode, row.serial_number, row.brand, row.model, row.category_path, row.tagsText, row.ocr_text, row.description].join(" ")
  );
  const words = fullText.split(" ");

  let score = 0;
  if (name.includes(normalizedQuery)) score += 48;

  for (const term of terms) {
    if (sku.includes(term)) score += 32;
    if (barcode.includes(term) || serial.includes(term)) score += 32;
    if (name.includes(term)) score += 24;
    if (tags.includes(term)) score += 18;
    if (category.includes(term)) score += 12;
    if (ocr.includes(term)) score += 9;
    if (fullText.includes(term)) score += 6;
    if (words.some((word) => word.length > 3 && levenshtein(word, term) <= 1)) score += 5;
  }

  if (fullText.includes(normalizedQuery)) score += 30;
  return score;
}

export const SORTERS = {
  relevance: (a, b) => b.score - a.score || b.availableQuantity - a.availableQuantity,
  priceDesc: (a, b) => b.sellingPrice - a.sellingPrice || b.score - a.score,
  priceAsc: (a, b) => a.sellingPrice - b.sellingPrice || b.score - a.score,
  stock: (a, b) => b.availableQuantity - a.availableQuantity || b.score - a.score,
  recent: (a, b) => new Date(b.addedAt) - new Date(a.addedAt) || b.score - a.score,
};

export function availabilityStatus(availableQuantity, reorderPoint, rawStatus) {
  if (["Sold", "Broken", "Returned", "In Repair", "Archived", "Deleted", "Lost", "Disposed", "Inactive"].includes(rawStatus)) {
    return rawStatus;
  }
  if (availableQuantity <= 0) return "Out of Stock";
  if (availableQuantity <= reorderPoint) return "Low Stock";
  return "In Stock";
}
