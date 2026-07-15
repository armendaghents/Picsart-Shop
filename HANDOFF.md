# Atlas Search — build handoff

## Stack (unchanged from before, confirmed still accurate)
Express + better-sqlite3 (SQLite w/ FTS5) backend at repo root. React (Vite) frontend
in web/, multi-page build (main = storefront, admin = admin console), both build into
public/ via `npm run build` (outDir ../public, emptyOutDir false so nothing gets
wiped). Shared stylesheet public/styles.css linked directly by both built HTMLs, not
bundled by Vite.

## This session's changes (all tested and working)

1. **`/admin` is now the canonical URL, no redirect.** `serveAdmin()` in server.js
   handles both `/admin` and `/admin.html` identically (checks auth, sends
   public/admin.html via sendFile if authed, else the inline login HTML). Internal
   links in Sidebar.jsx/AdminHeader.jsx now point to `/` instead of `/index.html`.
   logout() in admin/api.js redirects to `/admin` not `/admin.html`.

2. **Product photo uploads — multi-photo, not just one.** Schema: `inventory_items`
   now has `images TEXT` (JSON array of URLs, first = main/primary photo) — this
   REPLACED the old single `image_url TEXT` column from last session. Migration in
   db/init.js's `runMigrations()` adds the new column and backfills any existing
   `image_url` value into `images` as a single-element array if upgrading an old DB.
   Backend: `POST /api/admin/upload` (single file, still exists) and `POST
   /api/admin/upload-multiple` (multer `.array("images", 10)`, up to 10 files/request)
   both save into public/uploads/ (created via fs.mkdirSync at server startup) and are
   served statically. `toDomainItem`/`toShopItem` expose both `images` (full array)
   and `image` (= images[0], kept for anywhere that only wants one). Create/update
   routes accept `body.images` (array) and persist as JSON.
   Admin UI (ItemFormModal.jsx): multi-select file input, thumbnail grid, star button to
   set any photo as main (reorders array, moves clicked photo to index 0), x to
   remove. Storefront: ProductCard.jsx and ProductModal.jsx both have prev/next arrow
   browsing (ProductCard also has dot indicators) when a product has more than 1 photo — local
   `photoIndex` state per component, resets on product change in ProductModal via
   useEffect keyed on `product?.id`.

3. **Condition field (New/Used).** Schema: `condition TEXT NOT NULL DEFAULT 'New'`,
   added via the same migration pass. Exposed on both domain/shop item shapes,
   accepted on create/update. Admin form has a Condition select. Storefront shows a
   `.condition-pill` badge (condition-new / condition-used classes) next to the
   availability badge on both the card and the modal, wrapped together in a
   `.shop-card-badges` flex row.

4. **Fixed a real color bug**: `--warn` and `--accent` were nearly identical amber
   tones (literally IDENTICAL in dark mode), so "In Stock" and "Low Stock" pills
   looked the same non-green color. Added a proper `--success` CSS variable (green,
   distinct per theme) and repointed `.status-in-stock`/`.status-available` and the
   new `.condition-new` to use it. `.status-low-stock`/`.condition-used` still use
   `--warn` (now genuinely distinct from `--accent` in both themes too).

5. **Mac products added to seed catalog** (db/init.js SEED_ITEMS): MacBook Air
   15-inch, MacBook Pro 14-inch, iMac 24-inch, Mac Mini — all brand "Apple", under
   `Computers > Laptops > Mac` or `Computers > Desktops > Mac`, so they show up under
   the existing "Computers" top-level category filter alongside gaming PCs etc.
   Synonym map in lib/search.js extended: `mac` maps to `apple`/`macbook`/`imac`/
   `computer`/`laptop`/`desktop`, and `computer(s)` now also links to `mac`. Added
   "Mac" as a quick-search chip in web/src/i18n.js QUICK_SEARCHES.

6. **Price filter bounds fixed.** Was starting at the cheapest item's actual price
   (looked wrong, e.g. showed "31,200" when currency=AMD because 80 USD times 390 =
   31,200 — user's cheapest item converted to AMD, not actually starting at 0). Now
   always starts at 0. Upper bound is a round 2,000,000 AMD converted to the internal
   USD unit prices are stored in (`Math.ceil(2000000 / EXCHANGE_RATES.AMD / 100) *
   100`), or the catalog's actual max rounded up if that's ever higher — see App.jsx's
   facets-loaded useEffect. EXCHANGE_RATES imported from ./currency.js (was missing
   this import before, would have been a build error — fixed).

7. **README.md fully rewritten**, professional tone, no file.txt references (file.txt
   isn't even in the project anymore — was dropped in an earlier packaging pass, not
   this session), all admin.html mentions changed to /admin.

## Design constraints established across sessions (do not violate)
- Shop-facing API/UI must NEVER show: cost/purchase price, reserved quantity, exact
  warehouse, exact location. Safe shop fields now include: sku, name, brand, model,
  category, price, currency, description, icon, images, image, colors, tags,
  availability, condition, inStock, availableQuantity.
- Admin is password-gated (ADMIN_PASSWORD env, session cookie, 8hr expiry,
  server-side gate — the React admin app itself has no client-side auth check
  because the server never serves it to an unauthenticated request).
- Test end-to-end in sandbox using the node:sqlite swap trick on a TEMP COPY only —
  sed replace `import Database from "better-sqlite3"` with `import { DatabaseSync as
  Database } from "node:sqlite"` — never edit the shipped db/init.js itself (must
  stay on better-sqlite3 for the user's real Mac/Windows install).
- Background `node server.js` test processes sometimes die between tool-call turns
  in this sandbox (observed again this session) — if a curl comes back empty, check
  `ps aux | grep node` and just restart before assuming something's actually broken.
- Always ship a fresh `npm run build` done in the source tree before zipping, and
  verify `unzip -l atlas-search.zip | grep -i lock` returns nothing (stale lockfiles
  caused a real EBADPLATFORM bug for the user once — do not skip this check).
- User is Armenian, non-technical-leaning, writes broken/garbled English, prefers
  simple copy-pasteable terminal commands. User's machine has moved between Mac
  (Node v20.20.2) and Windows during this project — always give OS-appropriate
  commands when troubleshooting, ask if unsure which OS the current terminal is on.
- Currency: storefront defaults price displays through `formatMoney(amount,
  targetCurrency, originalCurrency)` in web/src/currency.js — all catalog prices are
  stored/entered in USD internally (item.currency is almost always "USD" in seed
  data); AMD/RUB are display-only conversions via EXCHANGE_RATES, not separate stored
  values. Keep this in mind before assuming a raw number is already in the displayed
  currency.

## Not yet done (nothing blocking, known gaps)
- No cart/checkout/payment flow.
- No bulk import/export, no role-based multi-user admin accounts (still one shared
  password).
- Footer links (web/src/components/Footer.jsx) are still href="#" placeholders.
