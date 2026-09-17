// The storefront and admin surface: catalogue search, inventory CRUD, the
// basket, checkout, and the CSRF/session protections around them.

import { makeJar, makeRecorder } from "./helpers.mjs";

export default async function run(client, { adminPassword }) {
  const { call } = client;
  const t = makeRecorder("shop + admin");

  const admin = makeJar();
  await call(admin, "GET", "/api/auth/csrf");
  await call(admin, "POST", "/api/admin/login", { password: adminPassword });

  t.section("admin inventory");
  let r = await call(admin, "GET", "/api/facets");
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

  t.section("concurrency");
  await call(admin, "POST", "/api/inventory", { externalId: "ITM-TEST-RACE", sku: "TEST-RACE", name: "Race Widget", category: "Testing > Fixtures", price: 1, quantity: 5, status: "Available" });
  await call(shopper, "POST", "/api/shop/cart", { itemId: "ITM-TEST-RACE", quantity: 5 });
  // Ten simultaneous checkouts of a five-unit basket: one must win outright.
  const attempts = await Promise.all(Array.from({ length: 10 }, () => call(shopper, "POST", "/api/shop/cart/checkout")));
  const succeeded = attempts.filter((attempt) => attempt.status === 201).length;
  t.check("simultaneous checkouts can't double-spend stock", succeeded === 1, `${succeeded} succeeded`);
  const raced = (await call(shopper, "GET", "/api/shop/products/ITM-TEST-RACE")).data;
  t.check("stock is exactly zero, never negative", raced.availableQuantity === 0, `${raced.availableQuantity}`);

  for (const fixture of [...fixtures, { externalId: "ITM-TEST-RACE" }]) {
    await call(admin, "DELETE", `/api/inventory/${fixture.externalId}`);
  }

  return t.result();
}
