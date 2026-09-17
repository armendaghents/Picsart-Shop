# Atlas Search

A search-driven inventory and storefront platform, built with a React frontend, an
Express + PostgreSQL backend, and a hybrid full-text search engine.

The platform has two applications:

- **Storefront** (`/`) — the customer-facing product catalog. Visitors search or
  browse everything for sale and see live availability (**In Stock / Low Stock / Out
  of Stock**), price, condition (**New / Used**), photos, and descriptions. No cost
  price, warehouse, or internal location data is ever exposed here. Buying requires
  a customer account and goes through a basket.
- **Admin console** (`/admin`) — inventory management for staff: add, edit, and
  delete products, upload photos, track stock levels and reorder points, and view
  dashboard metrics. It is password-protected and not linked from the storefront.

Both are backed by the same PostgreSQL database and the same search engine.

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
- Customer accounts — a two-step sign-in form (email, then password) that
  branches to registration for a new address, email verification by code,
  password reset, optional two-step verification, and an account area with order
  history and a list of signed-in devices.
- A basket that accumulates across devices: clicking Buy on the same product adds
  to its line, quantities are adjustable, and totals are computed server-side in
  whole cents. Checkout turns the basket into orders and moves stock.

**Admin**
- Dashboard metrics: inventory value, stock levels, low-stock alerts, search volume.
- Full CRUD on inventory — add, edit, and delete products directly from the results
  list.
- Multi-photo upload per product, with the ability to choose which photo is primary.
- Search and filter by category, warehouse, status, and price.
- Session-based login, protected by a password you set yourself.

**Search engine**
- PostgreSQL full-text index (`tsvector` + GIN) across name, brand, model, SKU,
  barcode, serial number, tags, description, and category.
- Synonym expansion (e.g. `pc` ↔ `computer`/`desktop`/`mac`, `wifi` ↔ `router`).
- Typo tolerance via Damerau-Levenshtein distance.
- Exact identifier matching for SKU, barcode, and serial number.
- Weighted relevance scoring, with sorting by price, stock, or recency.

## Requirements

Node.js 18 or newer, and a PostgreSQL server (14 or newer) you can connect to —
local, in a container, or hosted.

## Setup

```bash
npm install
```

Create the database:

```bash
createdb atlas
```

Copy the environment example and fill it in:

```bash
cp .env.example .env
```

```
DATABASE_URL=postgres://localhost:5432/atlas
ADMIN_PASSWORD=pick-something-only-you-know
AUTH_SECRET=a-long-random-string
```

`DATABASE_URL` accepts any libpq-style connection string, including hosted ones
(`postgres://user:password@host:5432/atlas?sslmode=require`). If it is left
unset, the app connects to `postgres://localhost:5432/atlas`. If
`ADMIN_PASSWORD` is left unset, the app falls back to a default password and
prints a warning on startup. Set a real one before deploying.

`AUTH_SECRET` signs customer access tokens. Leave it unset and a random key is
generated at each startup, which signs every customer out when the server
restarts — fine locally, not in production. Generate one with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Running it

```bash
npm run dev
```

- Storefront: <http://localhost:3000/>
- Admin console: <http://localhost:3000/admin>

Tables are created automatically on first run and seeded with demo inventory if
the catalog is empty. To drop everything and start over:

```bash
npm run db:reset
```

### Coming from the old SQLite build

If you have an existing `data/atlas.db` from before the PostgreSQL switch, copy
it across once — ids, orders, and search history are preserved:

```bash
npm run db:import-sqlite            # or: npm run db:import-sqlite -- path/to/atlas.db
```

The import replaces whatever is currently in the PostgreSQL tables (including
the demo seed), so run it before entering new data. Uploaded photos live in
`public/uploads/` and are untouched by the switch.

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

**Customer accounts**: `POST /api/auth/lookup` (does this address have an
account?), `POST /api/auth/register`, `POST /api/auth/verify-email`, `POST
/api/auth/resend-code`, `POST /api/auth/login`, `POST /api/auth/two-factor`,
`POST /api/auth/forgot-password`, `POST /api/auth/reset-password`, `POST
/api/auth/refresh`, `POST /api/auth/logout`, `GET /api/auth/me`, `GET
/api/auth/csrf`.

**Account management** (signed in): `PATCH /api/auth/profile`, `POST
/api/auth/change-password`, `GET /api/auth/sessions`, `DELETE
/api/auth/sessions` (sign out everywhere else), `POST /api/auth/totp/setup` /
`/enable` / `/disable`, `GET /api/shop/orders` (own order history).

**Basket** (signed-in customers): `GET /api/shop/cart`, `POST /api/shop/cart`
(add), `PATCH /api/shop/cart/:id` (set quantity), `DELETE /api/shop/cart/:id`,
`DELETE /api/shop/cart` (empty it), `POST /api/shop/cart/checkout`.

### How customer sessions work

Two HttpOnly, `SameSite=Strict` cookies, so neither injected script nor another
site can read or send them:

| Cookie | Lifetime | Scope | Purpose |
|---|---|---|---|
| `atlas_access` | 15 minutes | `/` | Signed token proving identity on each request. Verified without a database round trip. |
| `atlas_refresh` | 30 days | `/api/auth/refresh` | Random value; only its SHA-256 is stored, so a database dump can't be replayed as a login. |

A third cookie, `atlas_csrf`, is deliberately readable by the page so it can be
echoed back in an `X-CSRF-Token` header — every state-changing request carries
it, and the origin is checked too.

Refresh tokens are single-use. Each refresh issues a new one and retires the old
one; all tokens from one login share a family, so presenting an already-spent
token (which means it leaked) revokes the whole family and forces a fresh login.
Passwords are stored as scrypt hashes with per-user salts. Sign-in attempts are
rate limited per address and per client, and a wrong password and an unknown
address return exactly the same message so accounts can't be enumerated.

Admin console sessions are separate and unchanged — still one shared password.

### The account lifecycle

1. **Identify.** The form asks for an email and looks it up, then branches to a
   password prompt or to registration. This does reveal whether an address is
   registered — the same trade Amazon makes, and unavoidable once registration
   rejects duplicates — so the endpoint is rate limited.
2. **Register.** Creates an inert account and emails a six-digit code. No
   session exists yet, so an unverified address can't be used to buy anything.
3. **Verify.** The code is stored only as a hash, expires in 15 minutes, is
   single use, and stops accepting guesses after five wrong attempts.
4. **Sign in.** Password, then a TOTP code if the account has two-step
   verification. "Keep me signed in" decides whether the session survives
   closing the browser.
5. **Recover.** A reset code sets a new password and signs out every device.
6. **Manage.** Name, password, two-step verification, signed-in devices, and
   order history, all under the account button.

Security-relevant events (new sign-in, password changed, two-step turned on or
off) send a notification email.

**Revocation is immediate.** Access tokens are stateless and last 15 minutes, so
revoking refresh tokens alone would leave a signed-out device working until its
token happened to expire. Each account carries a `sessions_valid_from` stamp;
any access token minted before it is rejected, which is what makes "sign out
everywhere" and "change password" take effect at once.

### Email

Verification codes, reset codes, and security notices are sent through SMTP when
`SMTP_HOST` is configured. When it isn't — the normal case in development — the
message is printed to the server log instead, so every flow can be walked
end to end without a mail account. Nothing else changes between the two modes.

## Project structure

```
server.js                Express app + all API routes
lib/search.js              Search/ranking/typo-tolerance logic
db/schema.sql                PostgreSQL schema
db/client.js                  Connection pool + statement helpers
db/init.js                    Database setup, migrations, demo data seeding
db/import-sqlite.js            One-time importer for the old SQLite database
lib/auth.js                Password hashing, access/refresh tokens, CSRF helpers
lib/totp.js                  Two-step verification, recovery codes, one-time codes
lib/mailer.js                 Outbound email (SMTP, or the log in development)
web/                        React source (Vite, builds both apps)
  index.html                  Storefront entry
  admin.html                   Admin entry
  src/App.jsx                    Storefront: state + layout
  src/components/                  Header, SearchBar, FilterPopover, ProductGrid,
                                     ProductCard, ProductModal, AuthModal,
                                     AccountPanel, CartPanel, Footer
  src/admin/AdminApp.jsx           Admin: state + layout
  src/admin/components/              Sidebar, Dashboard, SearchConsole,
                                       FiltersSidebar, InventoryResults,
                                       ItemFormModal, ConfirmDialog
  src/i18n.js                      Translations (storefront)
  src/currency.js                    Currency conversion
  src/api.js / src/admin/api.js        API clients
public/styles.css          Shared stylesheet
public/uploads/              Uploaded product photos (created automatically)
```

`public/index.html`, `public/admin.html`, and `public/assets/` are build output —
edit the source in `web/` and run `npm run build`, don't hand-edit them.

## Roadmap

Natural next steps, not yet built:

- Payment processing (checkout records the order and moves stock, but takes no
  money).
- Passkeys (WebAuthn) alongside the password.
- Customer-visible order status and shipping.
- Role-based access (multiple staff accounts, not just one shared password).
- Bulk import/export for inventory.
- A dedicated search engine (OpenSearch / Elasticsearch) if the catalog outgrows
  PostgreSQL full-text search.
