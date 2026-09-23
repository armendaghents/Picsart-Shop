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
  const before = (await call(shopper, "GET", "/api/shop/products/ITM-TEST-A")).data;
  const basket = (await call(shopper, "GET", "/api/shop/cart")).data;
  r = await call(shopper, "POST", "/api/shop/cart/checkout");
  t.check("checkout succeeds", r.status === 201 && r.data.ok === true, JSON.stringify(r.data));
  t.check("the charged total matches the basket", r.data.total === basket.totals[0].subtotal, `${r.data.total} vs ${basket.totals[0].subtotal}`);
  const after = (await call(shopper, "GET", "/api/shop/products/ITM-TEST-A")).data;
  t.check("stock moved by exactly the quantity bought",
    before.availableQuantity - after.availableQuantity === basket.lines.find((line) => line.itemId === "ITM-TEST-A").quantity);
  r = await call(shopper, "GET", "/api/shop/cart");
  t.check("the basket is empty afterwards", r.data.itemCount === 0);
  r = await call(shopper, "POST", "/api/shop/cart/checkout");
  t.check("checking out an empty basket is rejected", r.status === 400);
  r = await call(shopper, "GET", "/api/shop/orders");
  t.check("the order appears in the customer's history", (r.data.orders || []).length === 1, JSON.stringify(r.data).slice(0, 160));

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
  const attempts = await Promise.all(Array.from({ length: 10 }, () => call(shopper, "POST", "/api/shop/cart/checkout")));
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
