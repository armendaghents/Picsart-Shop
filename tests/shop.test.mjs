// The storefront and admin surface: catalogue search, inventory CRUD, the
// basket, checkout, and the CSRF/session protections around them.

import { makeJar, makeRecorder } from "./helpers.mjs";
import sharp from "sharp";

export default async function run(client, { adminPassword }) {
  const { call } = client;
  const t = makeRecorder("shop + admin");

  const admin = makeJar();
  await call(admin, "GET", "/api/auth/csrf");
  await call(admin, "POST", "/api/admin/login", { password: adminPassword });

  t.section("admin access control");
  let r;
  const outsider = makeJar();
  await call(outsider, "GET", "/api/auth/csrf");

  r = await call(outsider, "GET", "/api/inventory");
  t.check("the inventory API is closed without a session", r.status === 401, `${r.status}`);

  // An empty header still counts as supplied, so the jar leaves it alone.
  r = await call(outsider, "POST", "/api/admin/login", { password: adminPassword }, { "x-csrf-token": "" });
  t.check("logging in without a CSRF token is refused", r.status === 403, `${r.status}`);

  r = await call(outsider, "POST", "/api/admin/login", { password: `${adminPassword}-wrong` });
  t.check("a wrong password is refused", r.status === 401, `${r.status}`);
  t.check("...without saying which factor was wrong", /password or code/i.test(r.data.message || ""), r.data.message);

  const login = await call(outsider, "POST", "/api/admin/login", { password: adminPassword }, { "user-agent": "same-browser/1.0" });
  const sessionCookie = login.setCookies.find((cookie) => cookie.startsWith("atlas_session="));
  t.check("the session cookie is HttpOnly", /HttpOnly/i.test(sessionCookie || ""), sessionCookie);
  t.check("...and SameSite=Strict", /SameSite=Strict/i.test(sessionCookie || ""), sessionCookie);
  t.check("...and expires with the browser", !/Max-Age/i.test(sessionCookie || ""), sessionCookie);

  r = await call(outsider, "POST", "/api/inventory", { externalId: "ITM-TEST-CSRF" }, { "x-csrf-token": "", "user-agent": "same-browser/1.0" });
  t.check("an admin write without a CSRF token is refused", r.status === 403, `${r.status}`);

  // `localhost` resolves to both 127.0.0.1 and ::1, and a browser uses either
  // from one connection to the next. Pinning a session to the exact address
  // therefore drops it halfway through loading the console — so the pin is to
  // the surrounding network, and loopback counts as one network.
  const ipv6Base = client.base.replace("127.0.0.1", "[::1]");
  r = await fetch(`${ipv6Base}/api/dashboard`, {
    headers: { cookie: outsider.header(), "user-agent": "same-browser/1.0" },
  });
  t.check("a session survives the same browser switching to IPv6 loopback", r.status === 200, `${r.status}`);

  // A stolen cookie replayed from another browser fails the pin — and the
  // session is destroyed rather than merely refused this once.
  r = await call(outsider, "GET", "/api/inventory", undefined, { "user-agent": "some-other-browser/1.0" });
  t.check("the session cookie is useless from another browser", r.status === 401, `${r.status}`);
  r = await call(outsider, "GET", "/api/inventory");
  t.check("...and replaying it kills the session outright", r.status === 401, `${r.status}`);

  t.section("admin inventory");
  r = await call(admin, "GET", "/api/facets");
  t.check("facets load", r.status === 200 && Array.isArray(r.data.categories), JSON.stringify(r.data).slice(0, 120));
  r = await call(admin, "GET", "/api/dashboard");
  t.check("dashboard totals are numbers", typeof r.data.item_count === "number" && typeof r.data.inventory_value === "number", JSON.stringify(r.data));

  const fixtures = [
    { externalId: "ITM-TEST-A", sku: "TEST-A", name: "Test Widget A", category: "Testing > Fixtures", price: 12.5, quantity: 40, status: "Available" },
    { externalId: "ITM-TEST-B", sku: "TEST-B", name: "Test Widget B", category: "Testing > Fixtures", price: 3.33, quantity: 40, status: "Available" },
  ];
  for (const fixture of fixtures) {
    await call(admin, "DELETE", `/api/inventory/${fixture.externalId}`);
    r = await call(admin, "POST", "/api/inventory", fixture);
    t.check(`created ${fixture.sku}`, r.status === 201, JSON.stringify(r.data));
  }
  r = await call(admin, "POST", "/api/inventory", { ...fixtures[0], externalId: "ITM-TEST-DUP" });
  t.check("a duplicate SKU is rejected", r.status === 400 && /already exists/.test(r.data.message), JSON.stringify(r.data));
  // Every field is optional, so a completely empty item must still save.
  r = await call(admin, "POST", "/api/inventory", { externalId: "ITM-TEST-EMPTY" });
  t.check("an item with no fields at all can be saved", r.status === 201, JSON.stringify(r.data));
  r = await call(admin, "GET", "/api/inventory/ITM-TEST-EMPTY");
  t.check("...and reads back with nulls, not errors", r.status === 200 && r.data.name === null && r.data.category === null, JSON.stringify(r.data).slice(0, 160));
  await call(admin, "DELETE", "/api/inventory/ITM-TEST-EMPTY");

  t.section("search");
  r = await call(admin, "GET", "/api/inventory?q=Test%20Widget%20A");
  t.check("finds an item by name", r.data.items?.some((item) => item.sku === "TEST-A"), JSON.stringify(r.data.total));
  r = await call(admin, "GET", "/api/inventory?q=TEST-A");
  t.check("finds an item by SKU", r.data.items?.some((item) => item.sku === "TEST-A"));
  r = await call(admin, "GET", "/api/inventory?q=test-a");
  t.check("SKU search is case-insensitive", r.data.items?.some((item) => item.sku === "TEST-A"));
  r = await call(admin, "GET", "/api/inventory?q=Widgte");
  t.check("tolerates a typo", r.data.items?.some((item) => item.sku === "TEST-A"), JSON.stringify(r.data.total));
  r = await call(admin, "GET", "/api/shop/products?q=%27%3B--");
  t.check("SQL metacharacters are harmless", r.status === 200);

  t.section("the basket needs an account");
  const anon = makeJar();
  await call(anon, "GET", "/api/auth/csrf");
  r = await call(anon, "GET", "/api/shop/cart");
  t.check("reading a basket signed out is 401", r.status === 401);
  r = await call(anon, "POST", "/api/shop/cart", { itemId: "ITM-TEST-A" });
  t.check("adding to a basket signed out is 401", r.status === 401);

  t.section("the basket");
  const shopper = makeJar();
  await call(shopper, "GET", "/api/auth/csrf");
  const email = `shopper${Date.now()}@example.com`;
  await call(shopper, "POST", "/api/auth/register", { email, password: "Something1234567" });
  await call(shopper, "POST", "/api/auth/verify-email", { email, code: client.latestCodeFor(email) });

  r = await call(shopper, "GET", "/api/shop/cart");
  t.check("the basket starts empty", r.data.itemCount === 0 && r.data.lines.length === 0);
  r = await call(shopper, "POST", "/api/shop/cart", { itemId: "ITM-TEST-A" });
  t.check("an item can be added", r.status === 201 && r.data.itemCount === 1, JSON.stringify(r.data).slice(0, 160));
  r = await call(shopper, "POST", "/api/shop/cart", { itemId: "ITM-TEST-A" });
  t.check("buying the same thing again adds to that line", r.data.lines.length === 1 && r.data.lines[0].quantity === 2);
  r = await call(shopper, "POST", "/api/shop/cart", { itemId: "ITM-TEST-B", quantity: 3 });
  t.check("a second line is added", r.data.lines.length === 2 && r.data.itemCount === 5, JSON.stringify(r.data.lines.map((l) => l.quantity)));

  // 12.50 x 2 + 3.33 x 3 = 34.99. In plain floating point this lands on
  // 34.989999999999995, which is the whole reason totals are summed in cents.
  t.check("the subtotal is exact to the cent", r.data.totals[0].subtotal === 34.99, JSON.stringify(r.data.totals));
  t.check("line totals are exact", r.data.lines.every((line) => line.lineTotal === Math.round(line.unitPrice * 100) * line.quantity / 100));

  r = await call(shopper, "POST", "/api/shop/cart", { itemId: "ITM-TEST-A" }, { "x-csrf-token": "forged" });
  t.check("a forged CSRF token is rejected", r.status === 403);
  r = await call(shopper, "POST", "/api/shop/cart", { itemId: "ITM-TEST-A" }, { origin: "https://evil.example" });
  t.check("a cross-origin change is rejected", r.status === 403);
  r = await call(shopper, "POST", "/api/shop/cart", { itemId: "ITM-TEST-A", quantity: 99 });
  t.check("cannot exceed available stock", r.status === 409 || r.data.lines.every((line) => line.quantity <= line.availableQuantity), JSON.stringify(r.data).slice(0, 160));
  r = await call(shopper, "PATCH", "/api/shop/cart/ITM-TEST-B", { quantity: 1 });
  t.check("a quantity can be set directly", r.data.lines.find((line) => line.itemId === "ITM-TEST-B")?.quantity === 1);
  r = await call(shopper, "DELETE", "/api/shop/cart/ITM-TEST-B");
  t.check("a line can be removed", !r.data.lines.some((line) => line.itemId === "ITM-TEST-B"));

  t.section("checkout");
  const address = {
    method: "delivery",
    name: "Ani Grigoryan",
    phone: "+374 91 234567",
    country: "Armenia",
    city: "Yerevan",
    line1: "12 Abovyan Street",
    line2: "Flat 4",
    postalCode: "0001",
  };
  const before = (await call(shopper, "GET", "/api/shop/products/ITM-TEST-A")).data;
  const basket = (await call(shopper, "GET", "/api/shop/cart")).data;

  // Nothing can be shipped without somewhere to ship it, so this must fail
  // before any stock moves.
  const stockBeforeBadAddress = before.availableQuantity;
  r = await call(shopper, "POST", "/api/shop/cart/checkout", { delivery: { name: "", phone: "" } });
  t.check("checkout without delivery details is refused", r.status === 400 && r.data.error === "delivery_invalid", JSON.stringify(r.data).slice(0, 160));
  t.check("...naming every missing field at once",
    ["name", "phone", "country", "city", "line1"].every((field) => (r.data.fields || []).some((problem) => problem.field === field)),
    JSON.stringify(r.data.fields));
  const stockAfterBadAddress = (await call(shopper, "GET", "/api/shop/products/ITM-TEST-A")).data.availableQuantity;
  t.check("...without taking any stock", stockBeforeBadAddress === stockAfterBadAddress, `${stockBeforeBadAddress} -> ${stockAfterBadAddress}`);
  r = await call(shopper, "POST", "/api/shop/cart/checkout", { delivery: { ...address, phone: "abc" } });
  t.check("an unreachable phone number is refused", r.status === 400 && (r.data.fields || []).some((problem) => problem.field === "phone"), JSON.stringify(r.data).slice(0, 160));

  r = await call(shopper, "POST", "/api/shop/cart/checkout", { delivery: address });
  t.check("checkout succeeds", r.status === 201 && r.data.ok === true, JSON.stringify(r.data));
  t.check("...and records where it goes", r.data.delivery?.city === "Yerevan" && r.data.delivery?.line1 === "12 Abovyan Street", JSON.stringify(r.data.delivery));
  t.check("the charged total matches the basket", r.data.total === basket.totals[0].subtotal, `${r.data.total} vs ${basket.totals[0].subtotal}`);
  const after = (await call(shopper, "GET", "/api/shop/products/ITM-TEST-A")).data;
  t.check("stock moved by exactly the quantity bought",
    before.availableQuantity - after.availableQuantity === basket.lines.find((line) => line.itemId === "ITM-TEST-A").quantity);
  r = await call(shopper, "GET", "/api/shop/cart");
  t.check("the basket is empty afterwards", r.data.itemCount === 0);
  r = await call(shopper, "POST", "/api/shop/cart/checkout", { delivery: address });
  t.check("checking out an empty basket is rejected", r.status === 400);
  r = await call(shopper, "GET", "/api/shop/orders");
  t.check("the order appears in the customer's history", (r.data.orders || []).length === 1, JSON.stringify(r.data).slice(0, 160));

  t.section("an order is one order, not one row per product");
  const placed = r.data.orders[0];
  t.check("it has an order number the customer can quote", /^PS-[0-9A-Z]{5}-[0-9A-Z]{5}$/.test(placed.orderNumber || ""), placed.orderNumber);
  // No money has been taken — checkout does not charge yet — so anything other
  // than 'pending' here would be the shop claiming it had been paid.
  t.check("it starts unpaid", placed.status === "pending", placed.status);
  t.check("its total is the sum of its lines",
    placed.total === placed.lines.reduce((sum, line) => sum + line.lineTotal, 0),
    `${placed.total} vs lines ${JSON.stringify(placed.lines.map((line) => line.lineTotal))}`);
  t.check("the lines bought together are held under that one order", placed.lines.length >= 1 && placed.itemCount >= placed.lines.length,
    JSON.stringify({ lines: placed.lines.length, items: placed.itemCount }));

  // Their own stock: the checkout section above empties the shared fixtures,
  // so reusing them here would fail on availability rather than on anything
  // these checks are about.
  for (const fixture of [
    { externalId: "ITM-ORD-A", sku: "ORD-A", name: "Order Widget A", category: "Testing > Orders", price: 10, quantity: 50, status: "Available" },
    { externalId: "ITM-ORD-B", sku: "ORD-B", name: "Order Widget B", category: "Testing > Orders", price: 2.5, quantity: 50, status: "Available" },
  ]) {
    await call(admin, "DELETE", `/api/inventory/${fixture.externalId}`);
    await call(admin, "POST", "/api/inventory", fixture);
  }

  // The whole point of the parent row: a multi-line basket used to become N
  // separate order rows, indistinguishable from N separate purchases.
  await call(shopper, "POST", "/api/shop/cart", { itemId: "ITM-ORD-A", quantity: 1 });
  await call(shopper, "POST", "/api/shop/cart", { itemId: "ITM-ORD-B", quantity: 2 });
  r = await call(shopper, "POST", "/api/shop/cart/checkout", { delivery: address });
  t.check("a two-product basket checks out", r.status === 201, JSON.stringify(r.data).slice(0, 160));
  const multi = (await call(shopper, "GET", "/api/shop/orders")).data.orders[0];
  t.check("...and becomes a single order", multi.lines.length === 2, `${multi.lines.length} lines`);
  t.check("...holding three items", multi.itemCount === 3, `${multi.itemCount}`);
  t.check("...with its own distinct number", multi.orderNumber !== placed.orderNumber);
  t.check("...and a total covering both lines",
    multi.total === multi.lines.reduce((sum, line) => sum + line.lineTotal, 0), `${multi.total}`);

  t.section("the customer hears about it");
  // Fire-and-forget, so give the send a moment to reach the log.
  await new Promise((resolve) => setTimeout(resolve, 150));
  let mail = client.latestEmailFor(email);
  t.check("checkout sends a confirmation", /Thanks for your order/.test(mail), mail.slice(0, 120));
  t.check("...with the order number in the subject", mail.includes(`Subject: Your Picsart Shop order ${multi.orderNumber}`),
    (mail.match(/Subject:.*/) || [])[0]);
  t.check("...itemising what was bought", /2 × Order Widget B/.test(mail), mail.slice(0, 400));
  t.check("...with the total", mail.includes("Total:"), mail.slice(0, 400));
  t.check("...and where it is going", mail.includes("12 Abovyan Street") && mail.includes("Yerevan"), mail.slice(0, 500));
  // Checkout takes no money, so the receipt must not imply any was taken.
  t.check("...saying nothing about payment", !/paid|payment received|charged/i.test(mail), mail.slice(0, 500));

  t.section("a retried checkout does not buy twice");
  const stockBefore = (await call(shopper, "GET", "/api/shop/products/ITM-ORD-A")).data.availableQuantity;
  await call(shopper, "POST", "/api/shop/cart", { itemId: "ITM-ORD-A", quantity: 1 });
  const key = "test-idempotency-key-0001";
  const first = await call(shopper, "POST", "/api/shop/cart/checkout", { delivery: address }, { "idempotency-key": key });
  t.check("the first attempt places the order", first.status === 201, JSON.stringify(first.data).slice(0, 160));
  const retry = await call(shopper, "POST", "/api/shop/cart/checkout", { delivery: address }, { "idempotency-key": key });
  t.check("the retry is recognised, not refused", retry.status === 200 && retry.data.replayed === true, JSON.stringify(retry.data).slice(0, 160));
  t.check("...and returns the same order", retry.data.orderNumber === first.data.orderNumber,
    `${retry.data.orderNumber} vs ${first.data.orderNumber}`);
  const stockAfter = (await call(shopper, "GET", "/api/shop/products/ITM-ORD-A")).data.availableQuantity;
  t.check("...having taken stock only once", stockBefore - stockAfter === 1, `${stockBefore} -> ${stockAfter}`);

  t.section("collecting it, and not asking twice");
  r = await call(shopper, "GET", "/api/shop/delivery/latest");
  t.check("the last address is offered back for the next order", r.data.delivery?.line1 === "12 Abovyan Street", JSON.stringify(r.data).slice(0, 160));
  t.check("...but not the previous order's one-off notes", r.data.delivery?.notes === null, JSON.stringify(r.data.delivery));
  const stranger = makeJar();
  await call(stranger, "GET", "/api/auth/csrf");
  r = await call(stranger, "GET", "/api/shop/delivery/latest");
  t.check("...and never to someone not signed in", r.status === 401, `${r.status}`);

  // A pickup order has nowhere to ship to, so demanding an address would be
  // asking the customer to invent one.
  await call(shopper, "POST", "/api/shop/cart", { itemId: "ITM-ORD-B", quantity: 1 });
  r = await call(shopper, "POST", "/api/shop/cart/checkout", {
    delivery: { method: "pickup", name: "Ani Grigoryan", phone: "+374 91 234567" },
  });
  t.check("a pickup order needs no address", r.status === 201, JSON.stringify(r.data).slice(0, 160));
  t.check("...and is recorded as a pickup", r.data.delivery?.method === "pickup", JSON.stringify(r.data.delivery));
  r = await call(shopper, "POST", "/api/shop/cart", { itemId: "ITM-ORD-B", quantity: 1 });
  r = await call(shopper, "POST", "/api/shop/cart/checkout", { delivery: { method: "teleport", name: "Ani", phone: "+37491234567" } });
  t.check("an unknown delivery method is refused", r.status === 400 && (r.data.fields || []).some((problem) => problem.field === "method"), JSON.stringify(r.data).slice(0, 160));

  t.section("display currencies");
  r = await call(anon, "GET", "/api/shop/rates");
  t.check("the storefront can read the rates without signing in", r.status === 200, `${r.status}`);
  t.check("...and they are quoted against USD", r.data.base === "USD" && r.data.rates?.USD === 1, JSON.stringify(r.data).slice(0, 140));
  t.check("...including the seeded ones", r.data.rates?.AMD > 0 && r.data.rates?.RUB > 0, JSON.stringify(r.data.rates));

  r = await call(anon, "PUT", "/api/admin/rates/AMD", { rate: 400 });
  t.check("a customer cannot set a rate", r.status === 401, `${r.status}`);
  r = await call(admin, "PUT", "/api/admin/rates/AMD", { rate: 405 });
  t.check("an admin can", r.status === 200, JSON.stringify(r.data));
  r = await call(anon, "GET", "/api/shop/rates");
  t.check("...and the storefront sees the new rate straight away", r.data.rates.AMD === 405, JSON.stringify(r.data.rates));
  r = await call(admin, "GET", "/api/admin/rates");
  t.check("...recorded against the admin who set it", r.data.rates.find((row) => row.code === "AMD")?.updated_by === "admin",
    JSON.stringify(r.data.rates));

  // USD is the unit every other rate is measured against, so letting it be
  // anything but 1 would silently reprice the entire shop.
  r = await call(admin, "PUT", "/api/admin/rates/USD", { rate: 2 });
  t.check("the base currency cannot be repriced", r.status === 400, JSON.stringify(r.data).slice(0, 140));
  r = await call(admin, "DELETE", "/api/admin/rates/USD");
  t.check("...nor removed", r.status === 400, `${r.status}`);
  for (const bad of [0, -5, "abc"]) {
    r = await call(admin, "PUT", "/api/admin/rates/AMD", { rate: bad });
    t.check(`a rate of ${JSON.stringify(bad)} is refused`, r.status === 400, `${r.status}`);
  }
  r = await call(admin, "PUT", "/api/admin/rates/TOOLONG", { rate: 5 });
  t.check("a non-currency code is refused", r.status === 400, `${r.status}`);

  r = await call(admin, "PUT", "/api/admin/rates/EUR", { rate: 0.92 });
  t.check("a new currency can be added", r.status === 200, JSON.stringify(r.data));
  r = await call(anon, "GET", "/api/shop/rates");
  t.check("...and reaches the storefront", r.data.rates.EUR === 0.92, JSON.stringify(r.data.rates));
  r = await call(admin, "DELETE", "/api/admin/rates/EUR");
  t.check("...and can be removed again", r.status === 200, `${r.status}`);
  r = await call(anon, "GET", "/api/shop/rates");
  t.check("...leaving the storefront without it", r.data.rates.EUR === undefined, JSON.stringify(r.data.rates));

  // The whole point: money is recorded in USD whatever the shopper was looking at.
  r = await call(shopper, "GET", "/api/shop/orders");
  t.check("orders are still recorded in the currency the shop charges in",
    r.data.orders.every((order) => order.currency === "USD"), JSON.stringify(r.data.orders.map((o) => o.currency)));

  t.section("fulfilment");
  r = await call(admin, "GET", "/api/admin/orders");
  t.check("staff can list orders", r.status === 200 && Array.isArray(r.data.orders), JSON.stringify(r.data).slice(0, 160));
  t.check("...with a count per status to work from", typeof r.data.counts?.pending === "number", JSON.stringify(r.data.counts));
  const anOrder = r.data.orders.find((order) => order.status === "pending");
  t.check("...each carrying its lines and destination",
    Array.isArray(anOrder?.lines) && anOrder.lines.length > 0 && Boolean(anOrder.delivery), JSON.stringify(anOrder).slice(0, 200));
  t.check("...and the moves that are legal from where it is",
    JSON.stringify(anOrder?.nextStatuses) === JSON.stringify(["paid", "cancelled"]), JSON.stringify(anOrder?.nextStatuses));

  r = await call(outsider, "GET", "/api/admin/orders");
  t.check("the order list is closed without an admin session", r.status === 401, `${r.status}`);
  r = await call(shopper, "PATCH", `/api/admin/orders/${anOrder.id}/status`, { status: "shipped" });
  t.check("a customer cannot move their own order along", r.status === 401 || r.status === 403, `${r.status}`);

  // An order cannot ship before it is paid for. The console never offers the
  // move, but the server is what has to refuse it.
  r = await call(admin, "PATCH", `/api/admin/orders/${anOrder.id}/status`, { status: "shipped" });
  t.check("a pending order cannot jump straight to shipped", r.status === 409 && r.data.error === "bad_transition", JSON.stringify(r.data).slice(0, 160));
  t.check("...and says what it could do instead", JSON.stringify(r.data.allowed) === JSON.stringify(["paid", "cancelled"]), JSON.stringify(r.data.allowed));
  r = await call(admin, "PATCH", `/api/admin/orders/${anOrder.id}/status`, { status: "nonsense" });
  t.check("an unknown status is refused", r.status === 400, `${r.status}`);

  r = await call(admin, "PATCH", `/api/admin/orders/${anOrder.id}/status`, { status: "paid" });
  t.check("a pending order can be marked paid", r.status === 200 && r.data.status === "paid", JSON.stringify(r.data));
  r = await call(admin, "PATCH", `/api/admin/orders/${anOrder.id}/status`, { status: "shipped" });
  t.check("...and then shipped", r.status === 200 && r.data.status === "shipped", JSON.stringify(r.data));
  await new Promise((resolve) => setTimeout(resolve, 150));
  t.check("...which tells the customer it is on its way",
    /is on its way/.test(client.latestEmailFor(email)), (client.latestEmailFor(email).match(/Subject:.*/) || [])[0]);
  // Marking an order paid is internal bookkeeping until a provider confirms it.
  t.check("...but being marked paid does not claim money was taken",
    !/Subject:.*(paid|payment)/i.test(client.latestEmailFor(email)), (client.latestEmailFor(email).match(/Subject:.*/) || [])[0]);
  r = await call(admin, "PATCH", `/api/admin/orders/${anOrder.id}/status`, { status: "shipped" });
  t.check("marking it again changes nothing", r.status === 200 && r.data.unchanged === true, JSON.stringify(r.data));
  r = await call(admin, "PATCH", `/api/admin/orders/${anOrder.id}/status`, { status: "cancelled" });
  t.check("a shipped order cannot be cancelled", r.status === 409, JSON.stringify(r.data).slice(0, 160));

  // Cancelling means the goods never left, so the stock checkout took has to
  // come back — otherwise every cancellation quietly destroys inventory.
  await call(shopper, "POST", "/api/shop/cart", { itemId: "ITM-ORD-A", quantity: 2 });
  const stockBeforeCancel = (await call(admin, "GET", "/api/inventory/ITM-ORD-A")).data.quantity;
  r = await call(shopper, "POST", "/api/shop/cart/checkout", { delivery: address });
  const cancelNumber = r.data.orderNumber;
  const stockWhileHeld = (await call(admin, "GET", "/api/inventory/ITM-ORD-A")).data.quantity;
  t.check("checkout takes the stock", stockBeforeCancel - stockWhileHeld === 2, `${stockBeforeCancel} -> ${stockWhileHeld}`);
  const toCancel = (await call(admin, "GET", `/api/admin/orders?q=${cancelNumber}`)).data.orders[0];
  r = await call(admin, "PATCH", `/api/admin/orders/${toCancel.id}/status`, { status: "cancelled" });
  t.check("the order can be cancelled", r.status === 200 && r.data.status === "cancelled", JSON.stringify(r.data));
  const stockAfterCancel = (await call(admin, "GET", "/api/inventory/ITM-ORD-A")).data.quantity;
  t.check("...and its stock goes back on the shelf", stockAfterCancel === stockBeforeCancel, `${stockWhileHeld} -> ${stockAfterCancel}, expected ${stockBeforeCancel}`);
  r = await call(admin, "PATCH", `/api/admin/orders/${toCancel.id}/status`, { status: "paid" });
  t.check("a cancelled order is final", r.status === 409, JSON.stringify(r.data).slice(0, 160));

  await new Promise((resolve) => setTimeout(resolve, 150));
  mail = client.latestEmailFor(email);
  t.check("cancelling tells the customer", mail.includes(`order ${cancelNumber} was cancelled`), (mail.match(/Subject:.*/) || [])[0]);

  r = await call(admin, "GET", `/api/admin/orders?q=${cancelNumber}`);
  t.check("an order can be found by its number", r.data.orders.length === 1 && r.data.orders[0].orderNumber === cancelNumber, JSON.stringify(r.data).slice(0, 160));
  r = await call(admin, "GET", "/api/admin/orders?status=cancelled");
  t.check("...and filtered by status", r.data.orders.length > 0 && r.data.orders.every((order) => order.status === "cancelled"), JSON.stringify(r.data.orders.map((o) => o.status)));
  r = await call(admin, "GET", "/api/admin/orders?status=banana");
  t.check("an unknown status filter is refused", r.status === 400, `${r.status}`);

  t.section("the admin calendar counts orders, not product lines");
  const today = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  const month = `${today.getFullYear()}-${pad(today.getMonth() + 1)}`;
  const day = `${month}-${pad(today.getDate())}`;
  const tzOffset = -today.getTimezoneOffset();
  r = await call(admin, "GET", `/api/analytics/orders/day?date=${day}&tzOffset=${tzOffset}`);
  const dayOrders = r.data.orders || [];
  t.check("the day view lists orders with their lines", dayOrders.length > 0 && Array.isArray(dayOrders[0].lines),
    JSON.stringify(r.data).slice(0, 160));
  const twoLine = dayOrders.find((order) => order.lines.length === 2);
  t.check("a two-line order is one entry, not two", Boolean(twoLine), `${dayOrders.length} orders today`);
  t.check("...and names the buyer", twoLine?.buyerEmail === email, `${twoLine?.buyerEmail} vs ${email}`);
  r = await call(admin, "GET", `/api/analytics/orders/summary?month=${month}&tzOffset=${tzOffset}`);
  t.check("the month summary agrees with the day view", Number(r.data.days?.[day]) === dayOrders.length,
    `${r.data.days?.[day]} vs ${dayOrders.length}`);

  t.section("recommendations");
  const recoFixtures = [
    { externalId: "ITM-RECO-BASE", sku: "RECO-BASE", name: "Reco Laptop", brand: "Aurora", category: "Recos > Laptops", price: 100, quantity: 5, tags: ["laptop"] },
    { externalId: "ITM-RECO-UP", sku: "RECO-UP", name: "Reco Laptop Pro", brand: "Aurora", category: "Recos > Laptops", price: 150, quantity: 5, tags: ["laptop"] },
    { externalId: "ITM-RECO-DOWN", sku: "RECO-DOWN", name: "Reco Laptop Mini", brand: "Aurora", category: "Recos > Laptops", price: 60, quantity: 5, tags: ["laptop"] },
    { externalId: "ITM-RECO-FAR", sku: "RECO-FAR", name: "Reco Workstation", brand: "Aurora", category: "Recos > Laptops", price: 9000, quantity: 5, tags: ["laptop"] },
    { externalId: "ITM-RECO-OTHER", sku: "RECO-OTHER", name: "Reco Garden Hose", category: "Outdoors > Garden", price: 150, quantity: 5 },
    { externalId: "ITM-RECO-SIBLING", sku: "RECO-SIBLING", name: "Reco Laptop Sleeve", brand: "Aurora", category: "Recos > Accessories", price: 130, quantity: 5 },
  ];
  for (const fixture of recoFixtures) {
    await call(admin, "DELETE", `/api/inventory/${fixture.externalId}`);
    await call(admin, "POST", "/api/inventory", fixture);
  }

  r = await call(anon, "GET", "/api/shop/products/ITM-RECO-BASE/recommendations");
  const upgradeIds = (r.data.upgrades || []).map((item) => item.id);
  const alternativeIds = (r.data.alternatives || []).map((item) => item.id);
  t.check("recommendations are public", r.status === 200, JSON.stringify(r.data).slice(0, 120));
  t.check("a dearer sibling is offered as an upgrade", upgradeIds.includes("ITM-RECO-UP"), upgradeIds.join(","));
  t.check("the upgrade carries the price difference", r.data.upgrades?.[0]?.priceDelta === 50, JSON.stringify(r.data.upgrades?.[0]?.priceDelta));
  t.check("a cheaper sibling is never an upgrade", !upgradeIds.includes("ITM-RECO-DOWN"), upgradeIds.join(","));
  t.check("a wildly dearer item is not an upgrade path", !upgradeIds.includes("ITM-RECO-FAR"), upgradeIds.join(","));
  // A dearer accessory from the same brand is related, but it is not a better
  // version of a laptop — only the same category can be that.
  t.check("a dearer item of another kind is not an upgrade", !upgradeIds.includes("ITM-RECO-SIBLING"), upgradeIds.join(","));
  t.check("...but it is still offered as an alternative", alternativeIds.includes("ITM-RECO-SIBLING"), alternativeIds.join(","));
  t.check("a cheaper sibling is offered as an alternative", alternativeIds.includes("ITM-RECO-DOWN"), alternativeIds.join(","));
  t.check("an unrelated category is not recommended",
    ![...upgradeIds, ...alternativeIds].includes("ITM-RECO-OTHER"), [...upgradeIds, ...alternativeIds].join(","));
  t.check("nothing appears in both lists", !upgradeIds.some((id) => alternativeIds.includes(id)));
  t.check("cost price never leaks into a recommendation",
    [...(r.data.upgrades || []), ...(r.data.alternatives || [])].every((item) => item.cost === undefined && item.warehouse === undefined));
  r = await call(anon, "GET", "/api/shop/products/ITM-RECO-BASE/recommendations?limit=1");
  t.check("the limit is honoured", (r.data.upgrades || []).length <= 1 && (r.data.alternatives || []).length <= 1, JSON.stringify(r.data).slice(0, 120));
  r = await call(anon, "GET", "/api/shop/products/ITM-NOT-A-REAL-ID/recommendations");
  t.check("recommendations for a missing product are 404", r.status === 404, `${r.status}`);

  for (const fixture of recoFixtures) await call(admin, "DELETE", `/api/inventory/${fixture.externalId}`);

  t.section("concurrency");
  await call(admin, "POST", "/api/inventory", { externalId: "ITM-TEST-RACE", sku: "TEST-RACE", name: "Race Widget", category: "Testing > Fixtures", price: 1, quantity: 5, status: "Available" });
  await call(shopper, "POST", "/api/shop/cart", { itemId: "ITM-TEST-RACE", quantity: 5 });
  // Ten simultaneous checkouts of a five-unit basket: one must win outright.
  const attempts = await Promise.all(
    Array.from({ length: 10 }, () => call(shopper, "POST", "/api/shop/cart/checkout", { delivery: address }))
  );
  const succeeded = attempts.filter((attempt) => attempt.status === 201).length;
  t.check("simultaneous checkouts can't double-spend stock", succeeded === 1, `${succeeded} succeeded`);
  const raced = (await call(shopper, "GET", "/api/shop/products/ITM-TEST-RACE")).data;
  t.check("stock is exactly zero, never negative", raced.availableQuantity === 0, `${raced.availableQuantity}`);

  t.section("uploaded photos are normalised");
  // A photo larger than any tile needs, and one far smaller than the smallest.
  const bigPng = await sharp({
    create: { width: 2000, height: 1500, channels: 3, background: { r: 200, g: 60, b: 90 } },
  })
    .png()
    .toBuffer();
  const smallPng = await sharp({
    create: { width: 200, height: 200, channels: 3, background: { r: 30, g: 120, b: 200 } },
  })
    .png()
    .toBuffer();

  let up = await client.upload(admin, "/api/admin/upload", "image", [["big.png", bigPng]]);
  t.check("an oversized photo uploads", up.status === 200 && Boolean(up.data.url), JSON.stringify(up.data));
  t.check("...and is stored as WebP", (up.data.url || "").endsWith(".webp"), up.data.url);
  let stored = sharp(Buffer.from(await (await fetch(client.base + up.data.url)).arrayBuffer()));
  let meta = await stored.metadata();
  t.check("...capped at 1600px on its longest edge", Math.max(meta.width, meta.height) === 1600, `${meta.width}x${meta.height}`);
  t.check("...keeping its aspect ratio", Math.abs(meta.width / meta.height - 2000 / 1500) < 0.01, `${meta.width}x${meta.height}`);
  t.check("...and is not reported as undersized", up.data.undersized === false, JSON.stringify(up.data));
  await call(admin, "DELETE", "/api/admin/upload", { url: up.data.url });

  up = await client.upload(admin, "/api/admin/upload", "image", [["small.png", smallPng]]);
  stored = sharp(Buffer.from(await (await fetch(client.base + up.data.url)).arrayBuffer()));
  meta = await stored.metadata();
  // Enlarging here would bake the blur in and hide how small the original was.
  t.check("a small photo is never enlarged", meta.width === 200 && meta.height === 200, `${meta.width}x${meta.height}`);
  t.check("...and is reported as too small to look sharp", up.data.undersized === true, JSON.stringify(up.data));
  await call(admin, "DELETE", "/api/admin/upload", { url: up.data.url });

  for (const fixture of [...fixtures, { externalId: "ITM-TEST-RACE" }]) {
    await call(admin, "DELETE", `/api/inventory/${fixture.externalId}`);
  }

  return t.result();
}
