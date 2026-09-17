import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createDatabase, DATABASE_URL } from "./client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Never print credentials when reporting a connection problem.
export function describeConnection(url = DATABASE_URL) {
  try {
    const parsed = new URL(url);
    parsed.password = "";
    parsed.username = parsed.username ? parsed.username : "";
    return parsed.toString().replace(":@", "@");
  } catch {
    return "the configured DATABASE_URL";
  }
}

const SEED_ITEMS = [
  {
    externalId: "ITM-10021", sku: "PC-GAME-4090-32", barcode: "840192304112", serial: "SN-GPC-8842-A",
    name: "ApexForge Gaming Workstation", category: "Computers > Desktops > Gaming",
    warehouse: "West Hub", location: "A-12-04", status: "Available",
    brand: "ApexForge", model: "GX-4090", quantity: 18, reserved: 3, reorderPoint: 6,
    cost: 2670, price: 3499, currency: "USD", added: "2026-06-24", icon: "PC",
    colors: ["#107c72", "#5f6fb5"], tags: ["gaming pc", "desktop", "workstation", "computer", "gpu", "rtx"],
    ocr: "RTX graphics workstation quick start manual liquid cooled desktop tower",
    description: "Liquid-cooled desktop tower for rendering, simulation, gaming, and AI workloads.",
  },
  {
    externalId: "ITM-10044", sku: "LTP-ULTRA-14-M2", barcode: "840192304235", serial: "SN-LTP-1919-Z",
    name: "Northstar UltraBook 14", category: "Computers > Laptops",
    warehouse: "East Fulfillment", location: "B-03-18", status: "Available",
    brand: "Northstar", model: "UB14-M2", quantity: 42, reserved: 6, reorderPoint: 10,
    cost: 1120, price: 1599, currency: "USD", added: "2026-06-27", icon: "LT",
    colors: ["#6d7f2f", "#2f7f86"], tags: ["laptop", "notebook", "computer", "portable", "ultrabook"],
    ocr: "USB C charging guide enterprise deployment laptop warranty information",
    description: "Thin enterprise laptop with secure boot, long battery life, and docking support.",
  },
  {
    externalId: "ITM-10102", sku: "SCAN-ZB-2D-RUG", barcode: "619003881204", serial: "SN-SCN-4421-K",
    name: "Zebra 2D Rugged Barcode Scanner", category: "Warehouse > Scanners",
    warehouse: "West Hub", location: "C-01-09", status: "Low Stock",
    brand: "Zebra", model: "XR-2D", quantity: 5, reserved: 2, reorderPoint: 8,
    cost: 290, price: 429, currency: "USD", added: "2026-06-11", icon: "BC",
    colors: ["#b34824", "#c79010"], tags: ["barcode", "scanner", "qr", "warehouse", "handheld", "2d"],
    ocr: "QR code barcode imager pairing manual bluetooth cradle",
    description: "Drop-rated 2D scanner for barcode, QR, and serial capture on receiving lines.",
  },
  {
    externalId: "ITM-10155", sku: "CAM-OCR-8MP-IND", barcode: "619003881402", serial: "SN-CAM-7520-L",
    name: "Industrial OCR Inspection Camera", category: "Automation > Vision",
    warehouse: "North Storage", location: "V-22-11", status: "Available",
    brand: "OpticWorks", model: "OCR-8MP", quantity: 11, reserved: 1, reorderPoint: 4,
    cost: 820, price: 1249, currency: "USD", added: "2026-06-08", icon: "AI",
    colors: ["#5f6fb5", "#9b5f8f"], tags: ["ocr", "camera", "image search", "vision", "inspection", "ai"],
    ocr: "machine vision OCR serial number recognition lens calibration",
    description: "8MP inspection camera for OCR, label verification, and image-based search capture.",
  },
  {
    externalId: "ITM-10218", sku: "ROUT-ENT-AX12", barcode: "430088201932", serial: "SN-NET-1138-P",
    name: "Enterprise AX12 Mesh Router", category: "Networking > Routers",
    warehouse: "East Fulfillment", location: "N-08-02", status: "Available",
    brand: "CoreWave", model: "AX12", quantity: 27, reserved: 4, reorderPoint: 8,
    cost: 430, price: 699, currency: "USD", added: "2026-06-20", icon: "NW",
    colors: ["#2e7d52", "#235d95"], tags: ["router", "network", "wifi", "mesh", "enterprise", "access point"],
    ocr: "mesh router installation serial MAC address poe network appliance",
    description: "High-density Wi-Fi mesh router with enterprise monitoring and segmented networks.",
  },
  {
    externalId: "ITM-10301", sku: "PWR-UPS-3000VA", barcode: "731982201034", serial: "SN-PWR-6003-M",
    name: "3000VA Smart UPS Battery Backup", category: "Power > UPS",
    warehouse: "South Reserve", location: "P-14-21", status: "Reserved",
    brand: "VoltStack", model: "UPS-3000", quantity: 9, reserved: 9, reorderPoint: 3,
    cost: 760, price: 1199, currency: "USD", added: "2026-05-29", icon: "UP",
    colors: ["#353c48", "#c79010"], tags: ["ups", "battery", "power", "backup", "server", "rack"],
    ocr: "rack mount UPS battery backup load runtime warning replacement battery",
    description: "Rack-mount smart UPS with network card, runtime analytics, and replaceable batteries.",
  },
  {
    externalId: "ITM-10342", sku: "CHAIR-ERG-MESH-BLK", barcode: "500918220115", serial: "SN-FUR-2217-Q",
    name: "ErgoFlex Mesh Office Chair", category: "Facilities > Furniture",
    warehouse: "North Storage", location: "F-04-31", status: "Available",
    brand: "ErgoFlex", model: "MESH-BLK", quantity: 64, reserved: 12, reorderPoint: 15,
    cost: 145, price: 279, currency: "USD", added: "2026-06-18", icon: "ER",
    colors: ["#414141", "#107c72"], tags: ["chair", "office", "furniture", "ergonomic", "mesh"],
    ocr: "assembly instructions ergonomic office chair lumbar adjustment",
    description: "Adjustable ergonomic mesh chair for office, lab, and operations workstations.",
  },
  {
    externalId: "ITM-10409", sku: "KIT-IOT-TEMP-100", barcode: "744001922049", serial: "SN-IOT-5029-V",
    name: "IoT Temperature Sensor Kit", category: "Warehouse > Sensors",
    warehouse: "West Hub", location: "S-09-07", status: "Available",
    brand: "SenseGrid", model: "TEMP-100", quantity: 118, reserved: 14, reorderPoint: 20,
    cost: 42, price: 89, currency: "USD", added: "2026-06-30", icon: "Io",
    colors: ["#287e96", "#7f5a31"], tags: ["sensor", "temperature", "iot", "warehouse", "monitoring"],
    ocr: "temperature sensor calibration guide humidity warehouse monitoring",
    description: "Wireless temperature sensors for cold-chain monitoring, alerts, and reporting.",
  },
  {
    externalId: "ITM-10460", sku: "MON-UW-34-CURV", barcode: "857203114420", serial: "SN-MON-3390-D",
    name: "Meridian 34\" Curved UltraWide Monitor", category: "Computers > Monitors",
    warehouse: "East Fulfillment", location: "B-05-02", status: "Available",
    brand: "Meridian", model: "UW34C", quantity: 23, reserved: 2, reorderPoint: 6,
    cost: 340, price: 549, currency: "USD", added: "2026-06-15", icon: "MN",
    colors: ["#315f73", "#168f81"], tags: ["monitor", "display", "ultrawide", "curved", "computer"],
    ocr: "display port hdmi curved monitor stand assembly guide",
    description: "34-inch curved ultrawide display for workstations, control rooms, and creative work.",
  },
  {
    externalId: "ITM-10488", sku: "HDST-PRO-ANC-BLK", barcode: "857203114512", serial: "SN-HDS-4471-F",
    name: "Aerowave Pro ANC Headset", category: "Accessories > Audio",
    warehouse: "North Storage", location: "F-02-14", status: "Out of Stock",
    brand: "Aerowave", model: "PRO-ANC", quantity: 0, reserved: 0, reorderPoint: 12,
    cost: 60, price: 129, currency: "USD", added: "2026-05-02", icon: "HD",
    colors: ["#bd3c4c", "#414141"], tags: ["headset", "audio", "noise cancelling", "call center"],
    ocr: "wireless headset charging dock pairing guide microphone",
    description: "Active noise-cancelling wireless headset for calls, floor operations, and focus work.",
  },
  {
    externalId: "ITM-10512", sku: "SWTCH-24P-POE", barcode: "430088202145", serial: "SN-NET-2290-R",
    name: "24-Port PoE+ Managed Switch", category: "Networking > Switches",
    warehouse: "South Reserve", location: "N-11-06", status: "Low Stock",
    brand: "CoreWave", model: "POE24", quantity: 4, reserved: 1, reorderPoint: 5,
    cost: 260, price: 419, currency: "USD", added: "2026-06-02", icon: "SW",
    colors: ["#235d95", "#2e7d52"], tags: ["switch", "network", "poe", "managed", "ethernet"],
    ocr: "managed switch console port firmware update poe budget",
    description: "24-port managed PoE+ switch with VLAN support for camera and access-point rollouts.",
  },
  {
    externalId: "ITM-10540", sku: "CART-WH-FOLD-500", barcode: "731982202119", serial: "SN-CRT-1182-B",
    name: "FoldPro 500lb Warehouse Cart", category: "Warehouse > Material Handling",
    warehouse: "South Reserve", location: "P-02-08", status: "Available",
    brand: "FoldPro", model: "FC-500", quantity: 31, reserved: 5, reorderPoint: 8,
    cost: 95, price: 179, currency: "USD", added: "2026-06-05", icon: "CT",
    colors: ["#7f5a31", "#c79010"], tags: ["cart", "warehouse", "material handling", "folding", "500lb"],
    ocr: "folding cart weight capacity assembly warehouse handling",
    description: "Heavy-duty folding cart rated to 500lb for receiving, picking, and floor moves.",
  },
  {
    externalId: "ITM-10601", sku: "MAC-MBA-15-M3", barcode: "194253789012", serial: "SN-MBA-6610-A",
    name: "MacBook Air 15-inch", category: "Computers > Laptops > Mac",
    warehouse: "East Fulfillment", location: "B-04-01", status: "Available",
    brand: "Apple", model: "MacBook Air M3", quantity: 20, reserved: 3, reorderPoint: 6,
    cost: 1050, price: 1399, currency: "USD", added: "2026-07-01", icon: "MB",
    colors: ["#8e8e93", "#c7c7cc"], tags: ["mac", "macbook", "laptop", "apple", "computer", "notebook"],
    ocr: "MacBook Air quick start guide MagSafe charging port setup",
    description: "15-inch MacBook Air with the M3 chip — thin, silent, and all-day battery life.",
  },
  {
    externalId: "ITM-10602", sku: "MAC-MBP-14-M3P", barcode: "194253789029", serial: "SN-MBP-6611-B",
    name: "MacBook Pro 14-inch", category: "Computers > Laptops > Mac",
    warehouse: "East Fulfillment", location: "B-04-02", status: "Available",
    brand: "Apple", model: "MacBook Pro M3 Pro", quantity: 12, reserved: 2, reorderPoint: 4,
    cost: 1650, price: 2199, currency: "USD", added: "2026-07-01", icon: "MB",
    colors: ["#414141", "#6e6e73"], tags: ["mac", "macbook", "laptop", "apple", "computer", "pro"],
    ocr: "MacBook Pro quick start guide Liquid Retina XDR display",
    description: "14-inch MacBook Pro with the M3 Pro chip, built for demanding creative and dev workloads.",
  },
  {
    externalId: "ITM-10603", sku: "MAC-IMAC-24-M3", barcode: "194253789036", serial: "SN-IMC-6612-C",
    name: "iMac 24-inch", category: "Computers > Desktops > Mac",
    warehouse: "West Hub", location: "A-13-01", status: "Available",
    brand: "Apple", model: "iMac M3", quantity: 9, reserved: 1, reorderPoint: 3,
    cost: 1120, price: 1499, currency: "USD", added: "2026-07-02", icon: "MC",
    colors: ["#5f6fb5", "#8e8e93"], tags: ["mac", "imac", "desktop", "apple", "computer", "all-in-one"],
    ocr: "iMac quick start guide 4.5K Retina display setup",
    description: "24-inch all-in-one iMac with the M3 chip and a 4.5K Retina display.",
  },
  {
    externalId: "ITM-10604", sku: "MAC-MINI-M3", barcode: "194253789043", serial: "SN-MMN-6613-D",
    name: "Mac Mini", category: "Computers > Desktops > Mac",
    warehouse: "West Hub", location: "A-13-02", status: "Low Stock",
    brand: "Apple", model: "Mac Mini M3", quantity: 5, reserved: 1, reorderPoint: 5,
    cost: 480, price: 649, currency: "USD", added: "2026-07-02", icon: "MC",
    colors: ["#8e8e93", "#c7c7cc"], tags: ["mac", "mac mini", "desktop", "apple", "computer", "compact"],
    ocr: "Mac Mini quick start guide Thunderbolt port setup",
    description: "Compact Mac Mini with the M3 chip — small footprint, full desktop performance.",
  },
];

function categoryPath(name) {
  return name;
}

async function ensureCategory(db, path) {
  const existing = await db.prepare(`SELECT id FROM categories WHERE path = ?`).get(path);
  if (existing) return existing.id;
  const name = path.split(">").map((part) => part.trim()).at(-1);
  const created = await db.prepare(`INSERT INTO categories (name, path) VALUES (?, ?) RETURNING id`).get(name, path);
  return created.id;
}

async function ensureWarehouse(db, name) {
  const existing = await db.prepare(`SELECT id FROM warehouses WHERE name = ?`).get(name);
  if (existing) return existing.id;
  const created = await db.prepare(`INSERT INTO warehouses (name) VALUES (?) RETURNING id`).get(name);
  return created.id;
}

async function ensureLocation(db, warehouseId, code) {
  const existing = await db.prepare(`SELECT id FROM locations WHERE warehouse_id = ? AND code = ?`).get(warehouseId, code);
  if (existing) return existing.id;
  const created = await db
    .prepare(`INSERT INTO locations (warehouse_id, code) VALUES (?, ?) RETURNING id`)
    .get(warehouseId, code);
  return created.id;
}

export async function indexItemInFts(db, item) {
  await db.prepare(`DELETE FROM inventory_fts WHERE item_id = ?`).run(item.id);
  await db.prepare(
    `INSERT INTO inventory_fts (item_id, name, brand, model, sku, barcode, serial_number, tags, ocr_text, description, category_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    item.id,
    item.name || "",
    item.brand || "",
    item.model || "",
    item.sku || "",
    item.barcode || "",
    item.serial_number || "",
    (() => { try { return JSON.parse(item.tags || "[]").join(" "); } catch { return ""; } })(),
    item.ocr_text || "",
    item.description || "",
    item.category_path || ""
  );
}

async function insertItem(db, item) {
  const categoryId = await ensureCategory(db, categoryPath(item.category));
  const warehouseId = await ensureWarehouse(db, item.warehouse);
  const locationId = await ensureLocation(db, warehouseId, item.location);

  const created = await db.prepare(
    `INSERT INTO inventory_items (
      external_id, sku, barcode, serial_number, name, brand, model,
      category_id, warehouse_id, location_id, status, quantity, reserved_quantity, reorder_point,
      purchase_price, selling_price, currency, description, ocr_text, icon, colors, tags, added_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    RETURNING id`
  ).get(
    item.externalId, item.sku, item.barcode, item.serial, item.name, item.brand, item.model,
    categoryId, warehouseId, locationId, item.status, item.quantity, item.reserved, item.reorderPoint,
    item.cost, item.price, item.currency, item.description, item.ocr, item.icon,
    JSON.stringify(item.colors), JSON.stringify(item.tags), item.added
  );

  const id = created.id;
  await indexItemInFts(db, {
    id,
    name: item.name,
    brand: item.brand,
    model: item.model,
    sku: item.sku,
    barcode: item.barcode,
    serial_number: item.serial,
    tags: JSON.stringify(item.tags),
    ocr_text: item.ocr,
    description: item.description,
    category_path: item.category,
  });
  return id;
}

async function tableColumns(db, table) {
  return db
    .prepare(
      `SELECT column_name, is_nullable, data_type FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = ?`
    )
    .all(table);
}

// CREATE TABLE IF NOT EXISTS doesn't add new columns to an already-existing
// table, so anyone whose database predates these columns needs them added by
// hand here.
async function runMigrations(db) {
  const itemColumns = await tableColumns(db, "inventory_items");
  const names = itemColumns.map((column) => column.column_name);

  if (!names.includes("condition")) {
    await db.exec("ALTER TABLE inventory_items ADD COLUMN condition TEXT NOT NULL DEFAULT 'New'");
  }

  if (!names.includes("images")) {
    await db.exec("ALTER TABLE inventory_items ADD COLUMN images TEXT");
    // Backfill from the old single image_url column, if it existed.
    if (names.includes("image_url")) {
      const rows = await db.prepare("SELECT id, image_url FROM inventory_items WHERE image_url IS NOT NULL").all();
      const update = db.prepare("UPDATE inventory_items SET images = ? WHERE id = ?");
      for (const row of rows) await update.run(JSON.stringify([row.image_url]), row.id);
    }
  }

  if (!names.includes("custom_fields")) {
    await db.exec("ALTER TABLE inventory_items ADD COLUMN custom_fields TEXT");
  }

  // Warehouse, location, name, SKU, and category are all optional. On a database
  // created before that change the columns are still NOT NULL; unlike SQLite,
  // Postgres can drop the constraint in place, so no table rebuild is needed.
  for (const column of ["warehouse_id", "location_id", "name", "sku", "category_id"]) {
    const existing = itemColumns.find((entry) => entry.column_name === column);
    if (existing && existing.is_nullable === "NO") {
      await db.exec(`ALTER TABLE inventory_items ALTER COLUMN ${column} DROP NOT NULL`);
    }
  }

  // Columns added after customer accounts shipped.
  const userColumns = (await tableColumns(db, "users")).map((column) => column.column_name);
  for (const [column, definition] of [
    ["email_verified_at", "TEXT"],
    ["password_changed_at", "TEXT"],
    ["totp_secret", "TEXT"],
    ["totp_enabled_at", "TEXT"],
    ["recovery_codes", "TEXT"],
    ["sessions_valid_from", "BIGINT"],
  ]) {
    if (!userColumns.includes(column)) {
      await db.exec(`ALTER TABLE users ADD COLUMN ${column} ${definition}`);
    }
  }
  // Anyone who registered before email verification existed stays signed in:
  // they are treated as already verified rather than locked out.
  if (!userColumns.includes("email_verified_at")) {
    await db.exec("UPDATE users SET email_verified_at = created_at WHERE email_verified_at IS NULL");
  }

  // Shipped briefly as INTEGER, which a millisecond timestamp overflows.
  const validFrom = (await tableColumns(db, "users")).find((column) => column.column_name === "sessions_valid_from");
  if (validFrom && validFrom.data_type === "integer") {
    await db.exec("ALTER TABLE users ALTER COLUMN sessions_valid_from TYPE BIGINT");
  }

  const refreshColumns = (await tableColumns(db, "refresh_tokens")).map((column) => column.column_name);
  if (!refreshColumns.includes("last_used_at")) {
    await db.exec("ALTER TABLE refresh_tokens ADD COLUMN last_used_at TEXT");
  }

  // Orders placed before customer accounts existed have no buyer.
  const orderColumns = await tableColumns(db, "orders");
  if (!orderColumns.some((column) => column.column_name === "user_id")) {
    await db.exec("ALTER TABLE orders ADD COLUMN user_id INTEGER REFERENCES users(id)");
  }
  if (!orderColumns.some((column) => column.column_name === "category")) {
    await db.exec("ALTER TABLE orders ADD COLUMN category TEXT");
  }

  // An order snapshots the item's name and SKU, both of which are optional.
  for (const column of ["name", "sku"]) {
    const existing = orderColumns.find((entry) => entry.column_name === column);
    if (existing && existing.is_nullable === "NO") {
      await db.exec(`ALTER TABLE orders ALTER COLUMN ${column} DROP NOT NULL`);
    }
  }
}

// Dropped in dependency order so the foreign keys don't block the reset.
// Anything that references another table is dropped before the table it points
// at: cart_items/orders/refresh_tokens/auth_codes all reference users, and
// cart_items also references inventory_items.
const DROP_ALL = `
  DROP TABLE IF EXISTS inventory_fts;
  DROP TABLE IF EXISTS cart_items;
  DROP TABLE IF EXISTS orders;
  DROP TABLE IF EXISTS refresh_tokens;
  DROP TABLE IF EXISTS auth_codes;
  DROP TABLE IF EXISTS search_events;
  DROP TABLE IF EXISTS inventory_items;
  DROP TABLE IF EXISTS locations;
  DROP TABLE IF EXISTS warehouses;
  DROP TABLE IF EXISTS categories;
  DROP TABLE IF EXISTS users;
`;

export async function openDatabase({ reset = false, seed = true } = {}) {
  const db = createDatabase();

  try {
    await db.prepare("SELECT 1").get();
  } catch (error) {
    await db.close().catch(() => {});
    throw new Error(
      `Cannot connect to PostgreSQL at ${describeConnection()} — ${error.message}\n` +
        `Start PostgreSQL and make sure the database exists (createdb atlas), or set DATABASE_URL in .env.`
    );
  }

  if (reset) await db.exec(DROP_ALL);

  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await db.exec(schema);
  await runMigrations(db);

  const { count } = await db.prepare("SELECT COUNT(*) AS count FROM inventory_items").get();
  if (seed && count === 0) {
    await db.transaction(async (tx) => {
      for (const item of SEED_ITEMS) await insertItem(tx, item);
    });
    console.log(`Seeded ${SEED_ITEMS.length} inventory items into ${describeConnection()}`);
  }

  return db;
}

// Allow `node db/init.js --reset` to rebuild the database from scratch.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const reset = process.argv.includes("--reset");
  try {
    const db = await openDatabase({ reset });
    console.log(reset ? "Database reset and reseeded." : "Database is ready.");
    await db.close();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
