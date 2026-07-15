# Atlas Search

A search-driven inventory and storefront platform, built with a React frontend, an
Express + SQLite backend, and a hybrid full-text search engine.

The platform has two applications:

- **Storefront** (`/`) — the customer-facing product catalog. Visitors search or
  browse everything for sale and see live availability (**In Stock / Low Stock / Out
  of Stock**), price, condition (**New / Used**), photos, and descriptions. No cost
  price, warehouse, or internal location data is ever exposed here.
- **Admin console** (`/admin`) — inventory management for staff: add, edit, and
  delete products, upload photos, track stock levels and reorder points, and view
  dashboard metrics. It is password-protected and not linked from the storefront.

Both are backed by the same SQLite database and the same search engine.

## Features

**Storefront**
- Live search suggestions as you type, with keyboard navigation.
- Combined filters panel: category, sort, a two-handle price range slider, and an
  in-stock toggle.
- Product photo galleries — browse multiple photos per product on the card and in
  the detail view.
- Condition badges (New / Used) and stock-status badges, color-coded for quick
  scanning.
- English, Russian, and Armenian language support, plus USD / AMD / RUB currency
  display.
- Dark and light themes.

**Admin**
- Dashboard metrics: inventory value, stock levels, low-stock alerts, search volume.
- Full CRUD on inventory — add, edit, and delete products directly from the results
  list.
- Multi-photo upload per product, with the ability to choose which photo is primary.
- Search and filter by category, warehouse, status, and price.
- Session-based login, protected by a password you set yourself.

**Search engine**
- SQLite FTS5 full-text index across name, brand, model, SKU, barcode, serial
  number, tags, description, and category.
- Synonym expansion (e.g. `pc` ↔ `computer`/`desktop`/`mac`, `wifi` ↔ `router`).
- Typo tolerance via Damerau-Levenshtein distance.
- Exact identifier matching for SKU, barcode, and serial number.
- Weighted relevance scoring, with sorting by price, stock, or recency.

## Requirements

Node.js 18 or newer. The database driver (`better-sqlite3`) installs a small
platform-specific binary automatically — no separate database server or manual
compiler setup is typically needed.

## Setup

```bash
npm install
```

Copy the environment example and set an admin password:

```bash
cp .env.example .env
```

```
ADMIN_PASSWORD=pick-something-only-you-know
```

If this is left unset, the app falls back to a default password and prints a
warning on startup. Set a real one before deploying.

## Running it

```bash
npm run dev
```

- Storefront: <http://localhost:3000/>
- Admin console: <http://localhost:3000/admin>

The SQLite database is created automatically on first run at `data/atlas.db`,
seeded with demo inventory. To reset it:

```bash
npm run db:reset
```

### Developing the frontend with live reload

`npm run dev` serves the frontend's last **built** version. While actively changing
the React code, run the API server and the Vite dev server side by side:

```bash
# terminal 1
npm run dev

# terminal 2
npm run dev:web
```

`dev:web` starts Vite with hot reload, proxying API requests to the Express server.
Run `npm run build` when you're done to compile changes into the version `npm run
dev` serves.

## API overview

**Admin** (session-protected): `GET/POST /api/inventory`, `GET/PUT/DELETE
/api/inventory/:id`, `GET /api/facets`, `GET /api/dashboard`, `POST
/api/admin/upload` and `/api/admin/upload-multiple` (product photos), `POST
/api/admin/login` / `/api/admin/logout`.

**Storefront** (public, customer-safe fields only): `GET /api/shop/products`, `GET
/api/shop/products/:id`, `GET /api/shop/suggest` (search autocomplete), `GET
/api/shop/facets`.

## Project structure

```
server.js                Express app + all API routes
lib/search.js              Search/ranking/typo-tolerance logic
db/schema.sql                SQLite schema
db/init.js                    Database setup, migrations, demo data seeding
web/                        React source (Vite, builds both apps)
  index.html                  Storefront entry
  admin.html                   Admin entry
  src/App.jsx                    Storefront: state + layout
  src/components/                  Header, SearchBar, FilterPopover, ProductGrid,
                                     ProductCard, ProductModal, Footer
  src/admin/AdminApp.jsx           Admin: state + layout
  src/admin/components/              Sidebar, Dashboard, SearchConsole,
                                       FiltersSidebar, InventoryResults,
                                       ItemFormModal, ConfirmDialog
  src/i18n.js                      Translations (storefront)
  src/currency.js                    Currency conversion
  src/api.js / src/admin/api.js        API clients
public/styles.css          Shared stylesheet
public/uploads/              Uploaded product photos (created automatically)
data/atlas.db                SQLite database (created on first run)
```

`public/index.html`, `public/admin.html`, and `public/assets/` are build output —
edit the source in `web/` and run `npm run build`, don't hand-edit them.

## Roadmap

Natural next steps, not yet built:

- Shopping cart, checkout, and payment processing.
- Role-based access (multiple staff accounts, not just one shared password).
- Bulk import/export for inventory.
- Swapping SQLite for PostgreSQL and a dedicated search engine (OpenSearch /
  Elasticsearch) if the catalog outgrows a single SQLite file.
