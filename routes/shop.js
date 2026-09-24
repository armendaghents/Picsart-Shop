// ---------------------------------------------------------------------------
// Storefront (buyer) API — customer-safe fields only
//
// No cost price, no reserved-quantity breakdown, no internal notes: just
// enough to search, browse, and see whether something is currently in stock.
// Deliberately a separate file from the admin inventory API so a field can
// only reach a customer by being added here on purpose.
// ---------------------------------------------------------------------------

import { asyncRouter } from "../lib/async-routes.js";
import { db } from "../db/connection.js";
import {
  baseSelect,
  parseNumber,
  recordSearchEvent,
  safeJsonArray,
  search,
  toDomainItem,
} from "../lib/catalog.js";

const router = asyncRouter();

// ---------------------------------------------------------------------------
// Storefront (buyer) API — customer-safe fields only. No cost price, no
// reserved-quantity breakdown, no internal notes: just enough to search,
// browse, and see whether something is currently in stock.
// ---------------------------------------------------------------------------
export function toShopItem(item) {
  return {
    id: item.id,
    sku: item.sku,
    name: item.name,
    brand: item.brand,
    model: item.model,
    category: item.category,
    price: item.price,
    currency: item.currency,
    description: item.description,
    icon: item.icon,
    images: item.images,
    image: item.image,
    colors: item.colors,
    tags: item.tags,
    availability: item.availability,
    condition: item.condition,
    inStock: item.availableQuantity > 0 && item.availability !== "Out of Stock",
    availableQuantity: item.availableQuantity,
    score: item.score,
  };
}

router.get("/api/shop/products", async (request, response) => {
  const { q = "", category = "All", sort = "relevance" } = request.query;
  const minPrice = parseNumber(request.query.minPrice, 0);
  const maxPrice = parseNumber(request.query.maxPrice, 100000);
  const page = Math.max(1, Math.trunc(parseNumber(request.query.page, 1)));
  const pageSize = Math.min(Math.max(1, Math.trunc(parseNumber(request.query.pageSize, 24))), 100);
  const inStockOnly = request.query.inStockOnly === "true";

  const sellableStatuses = new Set(["Available", "Low Stock", "Reserved", "Out of Stock"]);

  try {
    let items = (await search({ q, category, warehouse: "All", status: "All", minPrice, maxPrice, sort, limit: 100000 })).filter(
      (item) => sellableStatuses.has(item.status)
    );
    if (inStockOnly) items = items.filter((item) => item.availableQuantity > 0);

    const total = items.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const currentPage = Math.min(page, totalPages);
    const start = (currentPage - 1) * pageSize;
    const pageItems = items.slice(start, start + pageSize);

    await recordSearchEvent(q, "shop", total);
    response.json({ items: pageItems.map(toShopItem), total, page: currentPage, pageSize, totalPages });
  } catch (error) {
    console.error("[shop] search failed:", error);
    response.status(500).json({ error: "shop_search_failed", message: error.message });
  }
});

router.get("/api/shop/suggest", async (request, response) => {
  const { q = "" } = request.query;
  const limit = Math.min(parseNumber(request.query.limit, 6), 10);

  if (!q.trim()) return response.json({ items: [] });

  const sellableStatuses = new Set(["Available", "Low Stock", "Reserved", "Out of Stock"]);
  try {
    const items = (await search({ q, warehouse: "All", status: "All", sort: "relevance", limit: 30 }))
      .filter((item) => sellableStatuses.has(item.status))
      .slice(0, limit)
      .map((item) => ({
        id: item.id,
        name: item.name,
        icon: item.icon,
        category: item.category ? item.category.split(">").map((part) => part.trim()).at(-1) : "",
      }));
    response.json({ items });
  } catch (error) {
    console.error("[shop] suggest failed:", error);
    response.status(500).json({ error: "suggest_failed", message: error.message });
  }
});

router.get("/api/shop/products/:id", async (request, response) => {
  try {
    const row = await db.prepare(`${baseSelect()} AND i.external_id = ?`).get(request.params.id);
    if (!row) {
      return response.status(404).json({ error: "not_found", message: "Product not found." });
    }
    row.tagsText = safeJsonArray(row.tags).join(" ");
    const item = toDomainItem(row);
    item.score = 50;
    response.json(toShopItem(item));
  } catch (error) {
    console.error(`[shop] product lookup failed for ${request.params.id}:`, error);
    response.status(500).json({ error: "product_lookup_failed", message: error.message });
  }
});

// ---------------------------------------------------------------------------
// Recommendations — "there is a better version of this, and these also exist".
//
// Relatedness is scored the way the search ranker thinks about relevance:
// category first, then brand, then overlapping tags. A candidate has to clear
// MIN_RELATED_SCORE — which takes at least a category or a brand match — so a
// thin catalogue recommends nothing rather than something arbitrary.
// ---------------------------------------------------------------------------
const MIN_RELATED_SCORE = 3;

// Price is the only "better" signal this catalogue has (no ratings, no spec
// comparison), so an upgrade is a dearer neighbour. The multiple keeps that
// honest: a $2,000 workstation is not the upgrade path for a $40 keyboard.
const MAX_UPGRADE_MULTIPLE = 3;

function categoryLeaf(path) {
  return path ? path.split(">").map((part) => part.trim()).at(-1).toLowerCase() : "";
}

function relatednessScore(candidate, base) {
  let score = 0;

  if (base.category && candidate.category === base.category) score += 5;
  else if (base.category && categoryLeaf(candidate.category) === categoryLeaf(base.category)) score += 3;

  if (base.brand && candidate.brand && candidate.brand.toLowerCase() === base.brand.toLowerCase()) score += 3;

  const baseTags = new Set(base.tags.map((tag) => tag.toLowerCase()));
  const sharedTags = candidate.tags.filter((tag) => baseTags.has(tag.toLowerCase())).length;
  score += Math.min(sharedTags, 3) * 1.5;

  if (candidate.condition === base.condition) score += 0.5;
  if (candidate.availableQuantity > 0) score += 1; // what can ship today wins ties

  return score;
}

router.get("/api/shop/products/:id/recommendations", async (request, response) => {
  const limit = Math.min(Math.max(1, Math.trunc(parseNumber(request.query.limit, 4))), 12);
  const sellableStatuses = new Set(["Available", "Low Stock", "Reserved", "Out of Stock"]);

  try {
    const baseRow = await db.prepare(`${baseSelect()} AND i.external_id = ?`).get(request.params.id);
    if (!baseRow) {
      return response.status(404).json({ error: "not_found", message: "Product not found." });
    }
    const base = toDomainItem(baseRow);

    // Narrow the pool in SQL to the same top-level branch ("Computers >
    // Laptops" pulls all of Computers, so a sibling category can still be
    // offered), the same leaf anywhere in the tree, or the same brand. The
    // score below decides how close each one actually is.
    const segments = base.category ? base.category.split(">").map((part) => part.trim()) : null;
    const branch = segments ? `${segments[0]}%` : null;
    const leaf = segments ? `%${segments.at(-1)}` : null;
    const rows = await db
      .prepare(
        `${baseSelect()} AND i.external_id <> ? AND (c.path ILIKE ? OR c.path ILIKE ? OR i.brand = ?) ORDER BY i.id`
      )
      .all(base.id, branch, leaf, base.brand);

    const related = rows
      .filter((row) => sellableStatuses.has(row.status))
      .map((row) => {
        row.tagsText = safeJsonArray(row.tags).join(" ");
        const item = toDomainItem(row);
        item.score = relatednessScore(item, base);
        return item;
      })
      .filter((item) => item.score >= MIN_RELATED_SCORE);

    // A better version has to be the same *kind* of thing: a dearer keyboard is
    // not the upgrade path for a mouse, however close the two sit in the tree.
    // An exact category match carries that; for an uncategorised product the
    // brand is the only stand-in there is. Alternatives stay deliberately
    // looser — "this also exists" is allowed to cross the aisle.
    const sameKind = (item) =>
      base.category
        ? item.category === base.category
        : Boolean(base.brand) && (item.brand || "").toLowerCase() === base.brand.toLowerCase();

    // Nothing converts prices server-side, so only same-currency items are
    // comparable; one priced differently can still be offered as an alternative.
    const isUpgrade = (item) =>
      base.price > 0 &&
      sameKind(item) &&
      item.currency === base.currency &&
      item.price > base.price &&
      item.price <= base.price * MAX_UPGRADE_MULTIPLE;

    const upgrades = related
      .filter(isUpgrade)
      .sort((a, b) => b.score - a.score || a.price - b.price) // the nearest step up first
      .slice(0, limit);

    const promoted = new Set(upgrades.map((item) => item.id));
    const alternatives = related
      .filter((item) => !promoted.has(item.id))
      .sort((a, b) => b.score - a.score || Math.abs(a.price - base.price) - Math.abs(b.price - base.price))
      .slice(0, limit);

    response.json({
      upgrades: upgrades.map((item) => ({
        ...toShopItem(item),
        priceDelta: Math.round((item.price - base.price) * 100) / 100,
      })),
      alternatives: alternatives.map(toShopItem),
    });
  } catch (error) {
    console.error(`[shop] recommendations failed for ${request.params.id}:`, error);
    response.status(500).json({ error: "recommendations_failed", message: error.message });
  }
});

// Direct single-item order, bypassing the basket. The storefront buys through
// the basket now, but this stays for API callers — signed in, like any purchase.

// ---------------------------------------------------------------------------
// Display exchange rates
//
// Public, because the storefront needs them before anyone signs in. Read-only:
// the only way to change a rate is through the admin console.
//
// The shop charges in USD. These convert the shelf price into something a
// customer can recognise; they are not prices, and `base` says so explicitly
// so the client cannot quietly forget which currency the money is really in.
// ---------------------------------------------------------------------------
router.get("/api/shop/rates", async (_request, response) => {
  try {
    const rows = await db.prepare("SELECT code, rate, updated_at FROM exchange_rates ORDER BY code").all();
    response.json({
      base: "USD",
      rates: Object.fromEntries(rows.map((row) => [row.code, Number(row.rate)])),
      // The storefront shows this next to a converted figure, so "approximate"
      // is a claim the customer can check rather than a disclaimer.
      updatedAt: rows.reduce((latest, row) => (row.updated_at > latest ? row.updated_at : latest), ""),
    });
  } catch (error) {
    console.error("[shop] rates failed:", error);
    response.status(500).json({ error: "rates_failed", message: error.message });
  }
});

export default router;
