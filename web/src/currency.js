export const EXCHANGE_RATES = {
  USD: 1,
  AMD: 390,
  RUB: 90,
};

export function formatMoney(amount, targetCurrency, originalCurrency = "USD") {
  const converted = (Number(amount) || 0) * (EXCHANGE_RATES[targetCurrency] / EXCHANGE_RATES[originalCurrency]);
  const locale = targetCurrency === "AMD" ? "hy-AM" : targetCurrency === "RUB" ? "ru-RU" : "en-US";
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: targetCurrency,
    maximumFractionDigits: 0,
  }).format(converted);
}
