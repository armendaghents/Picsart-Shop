// ---------------------------------------------------------------------------
// Showing prices in the customer's money
//
// The shop prices and charges in USD. Everything else here is a conversion for
// the customer's benefit, and the UI labels it as approximate — what is
// actually billed is the USD figure.
//
// The rates come from the server (GET /api/shop/rates) and are set by an admin,
// so correcting one is a minute's work rather than a code change and a deploy.
// They deliberately do not live in this file any more: a rate baked into the
// bundle is one nobody can fix.
//
// Held in module state rather than threaded through props so that the six
// components calling formatMoney keep their existing signatures. App sets it
// once when the rates arrive and re-renders, which is what puts the converted
// figures on screen.
// ---------------------------------------------------------------------------

// The currency prices are stored and charged in. Not configurable here: the
// server says so too, and the two must agree.
export const BASE_CURRENCY = "USD";

// Until the server answers, the only currency we can honestly show is the one
// prices are already in. No fallback table: a guessed rate shown as a price is
// worse than no choice of currency for a moment.
let rates = { [BASE_CURRENCY]: 1 };
let ratesUpdatedAt = null;

export function setRates(next, updatedAt = null) {
  rates = { [BASE_CURRENCY]: 1, ...(next || {}) };
  ratesUpdatedAt = updatedAt;
}

export function getRates() {
  return rates;
}

export function ratesUpdated() {
  return ratesUpdatedAt;
}

// What the currency selector should offer. Base first, then the rest
// alphabetically, so the list does not reorder itself as rates come and go.
export function availableCurrencies() {
  const others = Object.keys(rates).filter((code) => code !== BASE_CURRENCY).sort();
  return [BASE_CURRENCY, ...others];
}

// True when the figure shown is a conversion rather than the price itself.
export function isConverted(currency) {
  return currency !== BASE_CURRENCY;
}

export function convertMoney(amount, targetCurrency, originalCurrency = BASE_CURRENCY) {
  const to = rates[targetCurrency];
  const from = rates[originalCurrency];
  // An unknown currency means the rate has not loaded, or an admin removed it
  // while someone had it selected. Showing the unconverted number is wrong by a
  // known factor; inventing a rate is wrong by an unknown one.
  if (!to || !from) return Number(amount) || 0;
  return (Number(amount) || 0) * (to / from);
}

const LOCALES = { AMD: "hy-AM", RUB: "ru-RU" };

export function formatMoney(amount, targetCurrency, originalCurrency = BASE_CURRENCY) {
  const known = Boolean(rates[targetCurrency]);
  const currency = known ? targetCurrency : BASE_CURRENCY;
  const converted = convertMoney(amount, currency, originalCurrency);
  try {
    return new Intl.NumberFormat(LOCALES[currency] || "en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(converted);
  } catch {
    return `${currency} ${Math.round(converted)}`;
  }
}
