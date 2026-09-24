// ---------------------------------------------------------------------------
// The vocabulary an order is written in — shared by the server, the migration
// that backfills old rows, and anything else that has to agree on what a
// status means or what an order number looks like.
// ---------------------------------------------------------------------------

import crypto from "node:crypto";

// The lifecycle. A payment provider's flow maps onto these directly, which is
// the point: when checkout starts taking money it advances 'pending' to 'paid'
// from the webhook and nothing else about the shape has to change.
//
//   pending    placed, not paid for. Every order starts here.
//   paid       money confirmed by the provider. Safe to pick and pack.
//   shipped    handed to the courier.
//   cancelled  called off before it shipped; stock goes back.
//   refunded   money returned after it was taken.
//
// Kept in one list so the database CHECK constraint and the API validation
// cannot drift apart — both read this.
export const ORDER_STATUSES = ["pending", "paid", "shipped", "cancelled", "refunded"];

export const ORDER_STATUS_PENDING = "pending";

export function isOrderStatus(value) {
  return ORDER_STATUSES.includes(value);
}

// Crockford's base32 without I, L, O and U: no character can be confused with
// another when a customer reads their order number down the phone, and no
// four-letter word can appear in one by accident.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

// The reference a customer quotes and support searches for. Random rather than
// sequential on purpose — a counter would publish how many orders the shop has
// taken, and let anyone guess a neighbouring order's number.
//
// 10 characters of this alphabet is 50 bits, so collisions stay negligible far
// past any volume this shop will see; the UNIQUE constraint is the backstop.
export function newOrderNumber() {
  const bytes = crypto.randomBytes(10);
  let out = "";
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return `PS-${out.slice(0, 5)}-${out.slice(5)}`;
}

// Money is stored as a whole number of minor units (cents), never as a float:
// 0.1 + 0.2 is not 0.3 in binary floating point, and a shop that rounds a
// fraction of a cent the wrong way on every line eventually fails to balance.
export function toMinor(amount) {
  return Math.round((Number(amount) || 0) * 100);
}

export function fromMinor(minor) {
  return Number(minor || 0) / 100;
}

// One spelling of money for anything a customer reads. Falls back to a plain
// "USD 12.50" if the runtime does not know the currency code, rather than
// throwing somewhere awkward like the middle of sending a receipt.
export function formatMoney(minor, currency = "USD") {
  const amount = fromMinor(minor);
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

// ---------------------------------------------------------------------------
// Where the order is going
//
// Collected at checkout and snapshotted onto the order, like the product
// fields beside it: a customer who later moves house must not retroactively
// change where last month's parcel was sent.
// ---------------------------------------------------------------------------

export const DELIVERY_METHODS = ["delivery", "pickup"];
export const DELIVERY_DEFAULT_METHOD = "delivery";

// Generous, but bounded — these end up on a shipping label, and the database
// should not be a place to store a novel. Lengths are in characters.
const LIMITS = {
  name: 120,
  phone: 40,
  country: 80,
  city: 80,
  line1: 200,
  line2: 200,
  postalCode: 32,
  notes: 500,
};

// Needed whichever way the order is collected: someone has to be named, and
// reachable, or a failed delivery has no recovery.
const ALWAYS_REQUIRED = ["name", "phone"];

// Needed only when something is actually being shipped. A pickup order has no
// address, and demanding one would be asking the customer to invent it.
const SHIPPING_REQUIRED = ["country", "city", "line1"];

const FIELD_LABELS = {
  name: "Recipient name",
  phone: "Phone number",
  country: "Country",
  city: "City",
  line1: "Street address",
  line2: "Address line 2",
  postalCode: "Postal code",
  notes: "Delivery notes",
};

function cleanText(value) {
  // Collapse runs of whitespace, including the newlines a paste from a contact
  // card brings along, so a label does not come out with a hole in it.
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

// Deliberately loose. Phone formats differ by country and by how the person
// happens to write theirs; the only thing worth insisting on is that there are
// enough digits to be a real number. Anything stricter rejects real customers.
function hasEnoughDigits(phone) {
  return (phone.match(/\d/g) || []).length >= 6;
}

// Returns the cleaned values plus a list of what's wrong, rather than throwing
// on the first problem: a checkout form should light up every bad field at
// once, not make the customer discover them one submit at a time.
export function normaliseDelivery(input) {
  const raw = input && typeof input === "object" ? input : {};
  const errors = [];

  let method = cleanText(raw.method).toLowerCase() || DELIVERY_DEFAULT_METHOD;
  if (!DELIVERY_METHODS.includes(method)) {
    errors.push({ field: "method", message: `Choose one of: ${DELIVERY_METHODS.join(", ")}.` });
    method = DELIVERY_DEFAULT_METHOD;
  }

  const value = { method };
  for (const field of Object.keys(LIMITS)) {
    const text = cleanText(raw[field]);
    if (text.length > LIMITS[field]) {
      errors.push({ field, message: `${FIELD_LABELS[field]} must be ${LIMITS[field]} characters or fewer.` });
    }
    value[field] = text.slice(0, LIMITS[field]) || null;
  }

  const required = method === "pickup" ? ALWAYS_REQUIRED : [...ALWAYS_REQUIRED, ...SHIPPING_REQUIRED];
  for (const field of required) {
    if (!value[field]) errors.push({ field, message: `${FIELD_LABELS[field]} is required.` });
  }

  if (value.phone && !hasEnoughDigits(value.phone)) {
    errors.push({ field: "phone", message: "Enter a phone number we can reach you on." });
  }

  return { value, errors };
}

// ---------------------------------------------------------------------------
// Moving an order through its lifecycle
//
// Not every status can follow every other: an order cannot ship before it is
// paid for, and money cannot be refunded that was never taken. Stating the
// legal moves once, here, is what stops the admin console's buttons and the
// server's validation from drifting apart — and it is the same table the
// payment webhook will consult when it advances an order to 'paid'.
// ---------------------------------------------------------------------------
const TRANSITIONS = {
  pending: ["paid", "cancelled"],
  paid: ["shipped", "cancelled", "refunded"],
  shipped: ["refunded"],
  // Terminal. Reopening a cancelled order would have to re-reserve stock that
  // has already gone back on the shelf and may since have been sold; placing a
  // fresh order is the honest way to do it.
  cancelled: [],
  refunded: [],
};

export function nextStatuses(from) {
  return TRANSITIONS[from] || [];
}

export function canTransition(from, to) {
  return nextStatuses(from).includes(to);
}

// Cancelling means the goods never left, so what was taken off the shelf goes
// back. A refund does not: the item may be damaged, kept, or still in transit,
// and quietly restocking something nobody has inspected would sell a customer
// a unit that does not exist. Staff put those back by hand once they arrive.
export function releasesStock(from, to) {
  return to === "cancelled";
}
