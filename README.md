# Picsart Search

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
- Recommendations on the product detail view: **Upgrade options** (related
  products that cost more, with the price difference shown) and **You might
  also like** (comparable ones). Clicking one opens it in place.
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
- Dashboard metrics: inventory value, stock levels, low-stock alerts, search
  volume — each tile showing how it has moved over the past week.
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

### How recommendations are picked

`GET /api/shop/products/:id/recommendations` scores every other sellable product
against the one being viewed — exact category match counts most, then brand,
then overlapping tags, with a nudge towards what is in stock. Anything that
doesn't clear at least a category or brand match is left out, so a sparse
catalogue shows nothing rather than something arbitrary.

The results are then split in two:

- **Upgrade options** — related products that cost *more*, nearest step up
  first. Two rules keep the shelf honest: an upgrade must sit in the *same
  category* (a dearer keyboard is not a better mouse, however close the two sit
  in the tree), and it is capped at three times the current price, so a
  workstation is never suggested as the upgrade for a keyboard. Price is the
  only "better" signal the catalogue carries; there are no ratings or spec
  comparisons to rank on.
- **You might also like** — everything else related, closest in price first.

Products need a category (or brand) and a non-zero price to take part. Items
priced in another currency can only ever appear as alternatives, since nothing
converts prices server-side.

A catalogue where every product sits in its own one-word category shows empty
shelves — correctly, since nothing in it is related to anything else. To see the
feature working without reorganising real inventory, add the demo catalogue:

```bash
npm run db:demo              # 15 related products across three brands
npm run db:demo -- --remove  # take them away again
```

These use `ITM-DEMO-*` ids and are inserted alongside whatever is already there,
so removing them can never touch real stock.

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
prints a warning on startup — which is fine locally, but the server refuses to
start that way once `NODE_ENV=production`. See
[Locking down the admin console](#1a-locking-down-the-admin-console) for what to
set instead before you deploy.

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

`npm run db:demo` adds a small set of related demo products (laptops, monitors,
and accessories with real categories, brands, and prices) on top of whatever is
already in the catalogue — useful for trying out search and recommendations.
`npm run db:demo -- --remove` takes them out again.

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
/api/shop/products/:id`, `GET /api/shop/products/:id/recommendations` (related
products), `GET /api/shop/suggest` (search autocomplete), `GET
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

### Product photos

Uploads are normalised as they arrive (`lib/images.js`): rotated per EXIF,
capped at **1600px** on the longest edge, re-encoded to WebP at quality 85, and
stripped of metadata. A 2.4MB camera original becomes roughly 64KB without any
visible difference at the sizes the storefront actually draws.

Two deliberate limits:

- **Photos are never enlarged.** Upscaling a small original would bake the blur
  into the stored file and hide how small it really was.
- **The re-encode is kept only if it helped.** An already-optimised photo can
  come out of a WebP pass larger than it went in, in which case the original
  is left alone.

A product tile is about 300 CSS px, which needs **600 real pixels** on a 2x
display. Anything below that is stretched and looks soft however it is encoded —
so an upload under 600px is logged with a warning and reported back to the admin
console as `undersized`, while the admin still has the better original to hand.
Aim for 1000px or more on the longest edge.

Nothing here can make an already-small photo sharp; detail that was never
captured cannot be restored. Animated GIFs are passed through untouched, and a
file sharp cannot read is stored exactly as it arrived rather than failing the
upload.

### Sign in with Google

Optional, and off unless `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are both
set — the storefront asks `GET /api/auth/providers` and only draws the button
where it will work.

Create an OAuth client (type: *Web application*) in the
[Google Cloud console](https://console.cloud.google.com/apis/credentials) and
register the callback as an **Authorised redirect URI**, matched exactly:

```
http://localhost:3000/api/auth/google/callback
```

In production use your real origin and set `PUBLIC_URL` to it, so the redirect
URI is built from that rather than from a proxied request host.

It is the redirect-based authorization code flow: no Google script runs in the
page, so the Content-Security-Policy is untouched and no third-party code is
ever positioned to read the session cookies. `state` is held in a short-lived
`SameSite=Lax` cookie and must come back unchanged — Lax rather than Strict
because a Strict cookie is deliberately withheld on the cross-site navigation
back from Google, which would break every sign-in.

An account created this way is **verified on creation** — Google has already
proved the address — and has **no password**, so it never needs a verification
code or a reset email. Signing in with Google using an address that already has
a password links the two rather than failing, and two-step verification still
applies if the customer turned it on. An account that has only ever used Google
is told to use the button rather than being asked for a password it never set.

Because this removes both flows that require outbound mail, a deployment that
offers Google sign-in can run with no mail server at all.

### Email

Verification codes, reset codes, and security notices are sent through SMTP when
`SMTP_HOST` is configured. When it isn't — the normal case in development — the
message is printed to the server log instead, so every flow can be walked
end to end without a mail account. Nothing else changes between the two modes.

That fallback is development-only. The app refuses to start when
`NODE_ENV=production` and `SMTP_HOST` is unset, because printing verification
and reset codes into a production log would let anyone with log access take over
any account. If the process exits at boot with a `FATAL: SMTP_HOST is not set`
message, that is this check — configure SMTP rather than working around it.

## Deploying to production

### 1. Environment

Set these as secrets on the host, not in a file in the repo:

| Variable | Notes |
| --- | --- |
| `NODE_ENV` | `production`. Enables the mail guard above. |
| `DATABASE_URL` | Managed Postgres. Append `?sslmode=require`. |
| `AUTH_SECRET` | 32+ random bytes. **If unset, a new key is generated at every startup, signing out every customer on each restart or deploy.** |
| `ADMIN_USERS` | Comma-separated admin usernames. Set this when more than one person signs in — see below. |
| `ADMIN_<NAME>_PASSWORD_HASH` | Per-admin scrypt hash, one per name in `ADMIN_USERS`. |
| `ADMIN_<NAME>_TOTP_SECRET` | Per-admin authenticator secret. Strongly recommended. |
| `ADMIN_PASSWORD_HASH` | Single shared login, used only when `ADMIN_USERS` is empty. The server will not start in production without this or a real `ADMIN_PASSWORD`. |
| `ADMIN_TOTP_SECRET` | Authenticator secret for the shared login. |
| `ADMIN_IP_ALLOWLIST` | Addresses or IPv4 CIDR ranges allowed to reach `/admin`. Optional, and the single biggest win if you can use it. |
| `TRUST_PROXY` | Number of proxies in front of the app. **Required behind nginx/Cloudflare**, or the rate limits and the allowlist see the proxy's address instead of the client's. |
| `SMTP_HOST` | e.g. `smtp.resend.com` |
| `SMTP_PORT` | `587` |
| `SMTP_USER` / `SMTP_PASSWORD` | Provider credentials. |
| `MAIL_FROM` | Must use a domain verified with the provider (below). |

Generate a secret with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 1a. Locking down the admin console

The console can rewrite the catalogue and read every order, so it is guarded
more tightly than a customer account. Generate its two secrets:

```bash
npm run admin:credentials
```

That asks for a password (never echoed) and prints an `ADMIN_PASSWORD_HASH`
plus an `ADMIN_TOTP_SECRET` with a QR code to scan into Google Authenticator,
1Password or Authy. Put both in the environment and drop `ADMIN_PASSWORD`
entirely — with the hash set, the clear password exists nowhere on the server,
so a leaked `.env` or a stray backup does not hand over the console.

With `ADMIN_TOTP_SECRET` set, login asks for a six-digit code as well as the
password. This is the layer that matters most: it means a guessed, phished or
reused password is not enough on its own.

#### More than one admin

Two people sharing one password works, but it costs you four things: the
authenticator secret has to be copied to both phones, offboarding one person
means rotating everything and re-enrolling the other, the log cannot say which
of you did what, and — if you sit behind the same office IP — one person's
typos lock the other out.

Give each admin their own login instead. No database involved: run the
generator once per person,

```bash
node scripts/admin-credentials.mjs --user anna
node scripts/admin-credentials.mjs --user bob
```

and put the result in the environment:

```
ADMIN_USERS=anna,bob
ADMIN_ANNA_PASSWORD_HASH=scrypt$16384$8$1$...
ADMIN_ANNA_TOTP_SECRET=...
ADMIN_BOB_PASSWORD_HASH=scrypt$16384$8$1$...
ADMIN_BOB_TOTP_SECRET=...
```

The login form then asks for a username, the console header shows who is signed
in, and every admin request is logged with the account behind it:

```
[auth] admin 'anna' signed in from 10.8.0.4
PUT /api/inventory/ITM-2041 200 14ms [admin anna]
```

Offboarding is deleting that person's three lines and restarting. Nobody else
re-enrols, and no secret is shared.

The failure lockout is scoped to the account *and* the address, so anna
fat-fingering her password five times locks only anna-from-that-address —
not bob sitting next to her, and not anna from anywhere else. The same scoping
means an outsider guessing `anna` from the internet cannot lock her out of the
office.

Setting `ADMIN_USERS` turns off the shared `ADMIN_PASSWORD_HASH` login
entirely; the two modes are exclusive. Leave it empty and everything behaves
exactly as it did with one password.

If your staff reach the console from a fixed place — an office, a VPN — add it:

```
ADMIN_IP_ALLOWLIST=203.0.113.4,10.8.0.0/24
```

Everything else gets a 404 before authentication runs at all, which takes
remote password guessing off the table rather than merely slowing it down.

What is already on without any configuration:

| | |
| --- | --- |
| Password storage | scrypt, never compared in clear |
| Online guessing | 20 attempts per account, 40 per address and 60 process-wide per 15 min, then a lockout that doubles from 1 minute up to an hour |
| Timing | Both factors are always checked, so a near miss and a wild guess take the same time |
| Session cookie | HttpOnly, SameSite=Strict, Secure off localhost, and gone when the browser closes |
| Session storage | Only a SHA-256 of the token is kept server-side, alongside the account that owns it |
| Stolen cookies | Each session is pinned to the network (IPv4 /24, IPv6 /64, loopback as one) and the user agent that created it; a mismatch destroys the session rather than just refusing the request. Set `ADMIN_PIN_SESSION_NETWORK=off` to pin on the user agent alone |
| Session lifetime | 30 minutes idle, 8 hours absolute |
| CSRF | Double-submit token plus an origin check on every admin write |
| Fixation | Signing in always mints a new session and retires the old one |

**If you lock yourself out**, the login returns `429` with the seconds
remaining — and while it is counting down, *even the correct password is
refused*. Either wait it out, or restart the server: the lockout counters live
in memory, so a restart clears them (it also signs out any open admin session).

Behind a proxy, set `TRUST_PROXY` to the number of hops. Without it every
request looks like it came from the proxy, which makes the per-address limits
and the allowlist both useless and spoofable through `X-Forwarded-For`.

### 2. Email domain

This is what decides whether codes reach inboxes rather than spam folders. Any
SMTP provider works — the app speaks plain SMTP, so switching later is an
environment change, not a code change.

- Verify a sending domain with the provider, ideally a subdomain such as
  `mail.example.com`, so transactional mail keeps its own reputation separate
  from anything else sent from the root domain.
- Add the **SPF** and **DKIM** records the provider issues. Without DKIM, Gmail
  and Outlook will junk the mail.
- Add a **DMARC** record, starting at `p=none` and tightening to `p=reject` once
  its reports look clean.
- Point `MAIL_FROM` at that verified domain, and set a real monitored
  `Reply-To` rather than leaving `no-reply@` as the only contact.

Sending from an unverified domain is rejected or spam-filed, which silently
breaks signup — registration depends on the code arriving.

### 3. Database

`db/init.js` creates the schema and is safe to run against an existing database.
To migrate rows from an old SQLite build, see *Coming from the old SQLite build*
above.

**Orders are migrated automatically on first start.** A database created
before orders had a parent row holds the old flat shape — one row per product
line, with no order to belong to. On startup that table is renamed to
`orders_v1`, the new `orders` and `order_items` tables are created, and the old
rows are reassembled into the orders they came from (lines sharing a buyer and
an exact timestamp were one checkout). Nothing is deleted: `orders_v1` stays as
a backup, and the log tells you the line and order counts so you can reconcile
them. Once the history looks right:

```sql
DROP TABLE orders_v1;
```

Every migrated order gets status `pending`, because none of them was ever paid
for — checkout does not take money yet.

Migrated orders also have no delivery address, because the old checkout never
asked for one. They are the only orders in the system that can be missing it:
every new order must carry a destination before it is accepted.

### 3a. What checkout collects

Checkout requires delivery details, validated server-side in
`normaliseDelivery()` (`lib/orders.js`) and rejected with a per-field list
before any stock is touched:

| Method | Required |
| --- | --- |
| `delivery` | recipient name, phone, country, city, street address |
| `pickup` | recipient name, phone |

Optional on both: second address line, postal code, and per-order delivery
notes. The address is snapshotted onto the order, so a customer who later moves
house does not retroactively change where last month's parcel was sent.

`GET /api/shop/delivery/latest` returns the address from the customer's most
recent order so the form arrives prefilled — the notes deliberately do not
carry over, being instructions for one delivery rather than part of an address.

### 3b. Running the orders

`/admin` → **Orders** is the screen staff work from: one row per order,
filtered by where it is in its life, searchable by order number, buyer email or
recipient name. Opening a row shows the items and the address to send them to.

An order moves `pending → paid → shipped`, and can be `cancelled` or
`refunded`. The legal moves live in one table (`TRANSITIONS` in
`lib/orders.js`), which both the buttons and the server read — so the console
can only offer a move the server will accept, and an order can never ship
before it is paid for. The payment webhook will consult the same table when it
advances an order to `paid`.

**Cancelling puts the stock back**; refunding does not. A cancelled order never
left the building, so its units return to the shelf automatically. A refunded
one may be damaged, kept, or still in transit — restocking something nobody has
inspected would sell a customer a unit that does not exist, so staff put those
back by hand from the inventory screen once they arrive.

Every status change is logged with the admin who made it:

```
[orders] #41 paid -> shipped by admin anna
```

### 3c. What the customer is told

| When | Message |
| --- | --- |
| Order placed | Receipt: order number, the items, the total, and the address it is going to |
| Marked shipped | "…is on its way" |
| Cancelled | Order cancelled, nothing will be sent |
| Refunded | Refunded, money takes a few days to appear |

Marking an order **paid sends nothing**. Until a payment provider confirms it,
that transition is internal bookkeeping, and an email saying money was taken is
a claim the shop cannot back up. For the same reason the receipt says nothing
about payment at all — when payments land, either move that send to the `paid`
transition or add a second message for it (`orderConfirmationEmail` in
`lib/mailer.js` carries a note to this effect).

All of these are sent **after** the database transaction commits and are
fire-and-forget: the order is already placed, so a slow or broken SMTP host
must never turn a successful checkout into an error the customer sees. A
failure is logged as `[mail] failed to send` — alert on it, per *After launch*
below.

### 3d. Currencies

**The shop prices and charges in USD.** AMD, RUB and anything else are a
conversion shown for the customer's convenience — the storefront marks those
figures as approximate and states the USD amount before checkout, so nobody
discovers the real currency on their card statement. Orders are always recorded
in USD.

The rates live in the `exchange_rates` table and are edited at **/admin →
Currencies**, with the admin who changed each one recorded beside it. They used
to be a constant in the frontend bundle, which meant correcting a wrong rate
took a code change, a rebuild and a deploy; now it takes a minute, and the
storefront picks it up on the next page load.

USD is the base: its rate is always 1, and the server refuses to change or
remove it, because every other rate is measured against it.

If the rates cannot be loaded the storefront offers USD only. That is
deliberate — prices are in USD, so nothing shown is wrong; there is simply no
conversion on offer until the server answers. It never falls back to a guessed
rate.

**If Picsart ever wants to bill in dram**, this is not enough on its own: the
order would need to record the currency, the rate used and the converted total,
checkout would have to reject a quote whose rate had moved, and the payment
provider would need to settle in AMD. Converting for display and charging in
another currency are different problems.

**Still missing, and the reason this is not yet a shop:** none of this is
charged for. Checkout records an order and moves stock without taking payment.
See the payment work before opening it to customers.

**The demo catalogue is skipped when `NODE_ENV=production`.** On a development
machine an empty items table is filled with sample stock (ApexForge
workstations, Northstar laptops) so there is something to search; a real shop
starts empty instead, because those products do not exist and would otherwise
go live priced and orderable. This holds for both doors into seeding — starting
the server, and running `node db/init.js` by hand.

So a first production boot shows an empty storefront. That is correct: sign in
to `/admin` and add the real catalogue. If you see invented products, the app
is not running with `NODE_ENV=production` — check that first, because the same
variable is what refuses a placeholder admin password and requires a mail
server.

### 4. Verify before opening signups

- Register a real account end to end and confirm the code arrives **in the
  inbox, not spam**. Test Gmail and Outlook separately — they score differently.
- Walk through password reset the same way.
- Confirm `/admin` rejects a wrong password.
- Restart the app and confirm you are still signed in — proves `AUTH_SECRET` is
  set and stable.
- `npm test` runs the full suite against a throwaway `atlas_test` database.

### 5. After launch

- Wire up the provider's **bounce and complaint webhooks**. Repeatedly mailing
  dead addresses degrades sender reputation for everyone, including the reset
  codes real users depend on.
- Alert on `502 email_failed` responses and on `[mail] failed to send` in the
  logs. Those mean customers are being blocked at signup or password reset.

### How the dashboard trends work

The three tiles are live aggregates over `inventory_items`, recomputed on every
load. The movement underneath them comes from `inventory_snapshots`, one row per
day, written when the server starts and hourly after that (the row is keyed by
UTC date and upserted, so a day holds its most recent reading however many times
the process restarts).

This has to be recorded as it happens. `inventory_items` keeps only `added_at`,
`updated_at` and `deleted_at`, and quantity and price are overwritten in place —
so what stock was worth last Tuesday is not recoverable after the fact. **Trends
therefore start from the first day the server runs this code**, not from the
history of the catalogue.

Until there is an earlier day on record, `GET /api/dashboard` returns
`trend: null` and the tiles show no movement at all, rather than a 0% change
that would read as "flat" when it means "unknown". The comparison is against the
most recent snapshot at least seven days old, falling back to the oldest one on
record while the history is still shorter than that.

## Project structure

```
server.js                  Assembles the app: middleware, route mounts, listen

routes/                  One file per area of the API
  admin-auth.js            Console sign-in, and serving the console
  admin-inventory.js       Catalogue CRUD, photo upload, facets, dashboard
  admin-orders.js          Fulfilment: list, search, change status
  analytics.js             Order calendar
  auth.js                  Customer accounts, sessions, 2FA, Google sign-in
  cart.js                  Basket, checkout, a customer's own orders
  shop.js                  Storefront catalogue and recommendations

lib/                     The machinery the routes use
  config.js                Settings read from the environment
  async-routes.js          Router factory that catches async errors
  admin-session.js         Admin accounts, lockout, IP allowlist, sessions
  customer-session.js      Customer tokens, cookies, revocation, throttling
  csrf.js                  Double-submit check, shared by both of the above
  auth.js                  Password hashing, tokens, cookie helpers
  totp.js                  Two-step verification, recovery codes
  oauth.js                 Sign in with Google
  mailer.js                Outbound email (SMTP, or the log in development)
  catalog.js               Reading items, ranking, search
  search.js                Scoring and typo tolerance
  orders.js                Order numbers, money, statuses, delivery rules
  snapshots.js             Daily inventory readings behind the trend tiles
  images.js                Normalises uploaded product photos

db/
  connection.js            The one open pool, shared by every module
  schema.sql               PostgreSQL schema
  client.js                Statement helpers over node-postgres
  init.js                  Schema setup, migrations, demo data
  seed-demo.js             Optional related-products demo catalogue
  import-sqlite.js         One-time importer for the old SQLite database

scripts/admin-credentials.mjs  Generates the admin password hash + 2FA secret

web/                     React source (Vite, builds both apps)
  index.html               Storefront entry
  admin.html               Admin entry
  src/App.jsx              Storefront: state + layout
  src/components/          Header, SearchBar, FilterPopover, ProductGrid,
                             ProductCard, ProductModal, AuthModal,
                             AccountPanel, CartPanel, Footer
  src/admin/AdminApp.jsx   Admin: state + layout
  src/admin/components/    Sidebar, Dashboard, SearchConsole, FiltersSidebar,
                             InventoryResults, ItemFormModal, OrdersPanel,
                             AnalyticsPanel, ConfirmDialog
  src/i18n.js              Translations (storefront)
  src/currency.js          Currency conversion
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
