// A small demo catalogue for trying out recommendations.
//
// The products below are deliberately *related* to each other — three category
// branches, three brands, and a clear price ladder inside each one — because
// that is what the recommendation engine needs to have anything to say. A
// catalogue where every item sits in its own category and costs nothing shows
// empty shelves no matter how well the ranking works.
//
//   npm run db:demo            add them (existing products are left alone)
//   npm run db:demo -- --remove   take them away again
//
// Every row uses an ITM-DEMO-* id, so removal can never touch real inventory.

import path from "node:path";
import { fileURLToPath } from "node:url";

import { describeConnection, insertItem, openDatabase } from "./init.js";

const ID_PREFIX = "ITM-DEMO-";

// Shared defaults, so each product below only states what makes it different.
function product(item) {
  return {
    barcode: null,
    serial: null,
    warehouse: "West Hub",
    location: "D-01-01",
    status: "Available",
    quantity: 12,
    reserved: 0,
    reorderPoint: 5,
    currency: "USD",
    ocr: "",
    added: "2026-09-01",
    ...item,
    externalId: `${ID_PREFIX}${item.sku}`,
    cost: Math.round(item.price * 0.7 * 100) / 100,
  };
}

// Three ladders. Within each, the dearer models are upgrades of the cheaper
// ones; across them, the shared "Computers" branch and the shared brands make
// everything an alternative for everything else.
const DEMO_ITEMS = [
  // Laptops -----------------------------------------------------------------
  product({
    sku: "NL-AIR-13", name: "Northlight Air 13", brand: "Northlight", model: "AIR-13",
    category: "Computers > Laptops", price: 799, icon: "LT", colors: ["#4b7bec", "#3867d6"],
    tags: ["laptop", "notebook", "portable", "ultrabook"],
    description: "Featherweight 13-inch laptop for writing, mail, and travel.",
  }),
  product({
    sku: "NL-AIR-15", name: "Northlight Air 15", brand: "Northlight", model: "AIR-15",
    category: "Computers > Laptops", price: 999, icon: "LT", colors: ["#4b7bec", "#2d98da"],
    tags: ["laptop", "notebook", "portable", "ultrabook"],
    description: "The Air with a bigger screen and a larger battery, same weightless feel.",
  }),
  product({
    sku: "NL-PRO-14", name: "Northlight Pro 14", brand: "Northlight", model: "PRO-14",
    category: "Computers > Laptops", price: 1499, icon: "LT", colors: ["#3867d6", "#8854d0"],
    tags: ["laptop", "notebook", "pro", "workstation"],
    description: "Colour-accurate display and a proper cooling system for editing and code.",
  }),
  product({
    sku: "NL-PRO-16", name: "Northlight Pro 16", brand: "Northlight", model: "PRO-16",
    category: "Computers > Laptops", price: 2299, quantity: 4, icon: "LT", colors: ["#8854d0", "#4b7bec"],
    tags: ["laptop", "notebook", "pro", "workstation"],
    description: "The largest Pro: sixteen inches, more memory, and a full day of rendering.",
  }),
  product({
    sku: "VD-BOOK-14", name: "Veridian Book 14", brand: "Veridian", model: "BK-14",
    category: "Computers > Laptops", price: 899, icon: "LT", colors: ["#20bf6b", "#0fb9b1"],
    tags: ["laptop", "notebook", "portable"],
    description: "Aluminium 14-inch laptop with an all-day battery and a matte screen.",
  }),
  product({
    sku: "VD-BOOK-PRO-15", name: "Veridian Book Pro 15", brand: "Veridian", model: "BK-P15",
    category: "Computers > Laptops", price: 1699, quantity: 0, icon: "LT", colors: ["#0fb9b1", "#20bf6b"],
    tags: ["laptop", "notebook", "pro"],
    description: "Discrete graphics, a second SSD bay, and a keyboard built for long days.",
  }),

  // Monitors ----------------------------------------------------------------
  product({
    sku: "LM-24-FHD", name: "Lumen 24\" FHD Monitor", brand: "Lumen", model: "L24F",
    category: "Computers > Monitors", price: 229, quantity: 20, icon: "MN", colors: ["#fa8231", "#f7b731"],
    tags: ["monitor", "display", "screen", "1080p"],
    description: "A tidy 24-inch desk monitor with a height-adjustable stand.",
  }),
  product({
    sku: "LM-27-QHD", name: "Lumen 27\" QHD Monitor", brand: "Lumen", model: "L27Q",
    category: "Computers > Monitors", price: 349, quantity: 14, icon: "MN", colors: ["#f7b731", "#fa8231"],
    tags: ["monitor", "display", "screen", "1440p"],
    description: "Sharper and larger: 1440p across 27 inches, with USB-C power delivery.",
  }),
  product({
    sku: "LM-34-UW", name: "Lumen 34\" UltraWide Monitor", brand: "Lumen", model: "L34U",
    category: "Computers > Monitors", price: 649, quantity: 6, icon: "MN", colors: ["#eb3b5a", "#fa8231"],
    tags: ["monitor", "display", "screen", "ultrawide"],
    description: "One ultrawide panel instead of two monitors, with a built-in KVM switch.",
  }),
  product({
    sku: "VD-DISP-27-5K", name: "Veridian 27\" 5K Display", brand: "Veridian", model: "VD-27-5K",
    category: "Computers > Monitors", price: 1299, quantity: 3, reorderPoint: 5, icon: "MN", colors: ["#0fb9b1", "#4b7bec"],
    tags: ["monitor", "display", "screen", "5k", "retina"],
    description: "Reference-grade 5K panel, colour calibrated at the factory.",
  }),

  // Accessories -------------------------------------------------------------
  product({
    sku: "NL-KB-COMPACT", name: "Northlight Compact Keyboard", brand: "Northlight", model: "KB-C",
    category: "Computers > Accessories > Keyboards", price: 79, quantity: 30, icon: "KB", colors: ["#778ca3", "#4b6584"],
    tags: ["keyboard", "accessory", "wireless"],
    description: "Sixty-percent wireless keyboard that disappears into a bag.",
  }),
  product({
    sku: "NL-KB-MECH", name: "Northlight Mechanical Keyboard", brand: "Northlight", model: "KB-M",
    category: "Computers > Accessories > Keyboards", price: 149, quantity: 18, icon: "KB", colors: ["#4b6584", "#3867d6"],
    tags: ["keyboard", "accessory", "mechanical", "wireless"],
    description: "Hot-swappable switches, aluminium frame, and per-key backlighting.",
  }),
  product({
    sku: "LM-MOUSE", name: "Lumen Precision Mouse", brand: "Lumen", model: "M-PRE",
    category: "Computers > Accessories > Mice", price: 59, quantity: 40, icon: "MS", colors: ["#f7b731", "#778ca3"],
    tags: ["mouse", "accessory", "wireless"],
    description: "Light, quiet, and accurate — a mouse that gets out of the way.",
  }),
  product({
    sku: "LM-MOUSE-ERGO", name: "Lumen Ergo Mouse Pro", brand: "Lumen", model: "M-ERGO",
    category: "Computers > Accessories > Mice", price: 109, quantity: 4, reorderPoint: 6, icon: "MS", colors: ["#fa8231", "#f7b731"],
    tags: ["mouse", "accessory", "ergonomic", "wireless"],
    description: "Vertical grip and programmable buttons, for hands that work all day.",
  }),
  product({
    sku: "VD-DOCK-USBC", name: "Veridian USB-C Dock", brand: "Veridian", model: "DK-12",
    category: "Computers > Accessories > Docks", price: 249, quantity: 9, icon: "DK", colors: ["#20bf6b", "#778ca3"],
    tags: ["dock", "accessory", "usb-c", "hub"],
    description: "One cable for two displays, ethernet, and 100W of laptop charging.",
  }),
];

async function addDemoItems(db) {
  const existing = new Set(
    (await db.prepare(`SELECT external_id FROM inventory_items WHERE external_id LIKE ?`).all(`${ID_PREFIX}%`))
      .map((row) => row.external_id)
  );

  const pending = DEMO_ITEMS.filter((item) => !existing.has(item.externalId));
  if (!pending.length) {
    console.log(`All ${DEMO_ITEMS.length} demo products are already in ${describeConnection()}. Nothing to do.`);
    return;
  }

  await db.transaction(async (tx) => {
    for (const item of pending) await insertItem(tx, item);
  });
  console.log(`Added ${pending.length} demo products to ${describeConnection()}.`);
  if (existing.size) console.log(`(${existing.size} were already there and were left alone.)`);
  console.log(`Remove them again with: npm run db:demo -- --remove`);
}

// A hard delete, not the soft delete the admin console does: these rows are
// scaffolding, and a soft-deleted row would keep its SKU and block a re-seed.
async function removeDemoItems(db) {
  await db.transaction(async (tx) => {
    await tx
      .prepare(
        `DELETE FROM inventory_fts WHERE item_id IN
           (SELECT id FROM inventory_items WHERE external_id LIKE ?)`
      )
      .run(`${ID_PREFIX}%`);
    const { changes } = await tx.prepare(`DELETE FROM inventory_items WHERE external_id LIKE ?`).run(`${ID_PREFIX}%`);
    console.log(`Removed ${changes} demo product${changes === 1 ? "" : "s"} from ${describeConnection()}.`);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  let db;
  try {
    db = await openDatabase({ seed: false });
    if (process.argv.includes("--remove")) await removeDemoItems(db);
    else await addDemoItems(db);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await db?.close();
  }
}
