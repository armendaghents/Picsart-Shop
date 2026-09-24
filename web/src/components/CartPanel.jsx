import { useEffect, useState } from "react";
import { fetchLatestDelivery } from "../api";
import { BASE_CURRENCY, convertMoney, formatMoney, isConverted } from "../currency";
import { errorMessage } from "../i18n";

// Totals arrive from the server grouped by the item's own currency, so they are
// converted into the display currency one group at a time rather than being
// added together first — which would be wrong the moment two currencies meet.
function displayTotal(totals, currency) {
  const sum = (totals || []).reduce((running, entry) => running + convertMoney(entry.subtotal, currency, entry.currency), 0);
  return formatMoney(sum, currency, currency);
}

// What the customer is actually billed. Converted figures are a convenience;
// this is the number that reaches their card, so it is stated outright rather
// than left to be discovered on a statement.
function chargedTotal(totals) {
  const sum = (totals || []).reduce((running, entry) => running + convertMoney(entry.subtotal, BASE_CURRENCY, entry.currency), 0);
  return formatMoney(sum, BASE_CURRENCY, BASE_CURRENCY);
}

// The address fields use short names on the wire; these are the translation
// keys that go with them.
const FIELD_LABEL_KEYS = {
  name: "recipientName",
  phone: "phone",
  country: "country",
  city: "city",
  line1: "addressLine1",
  line2: "addressLine2",
  postalCode: "postalCode",
  notes: "deliveryNotes",
};

const EMPTY_DELIVERY = {
  method: "delivery",
  name: "",
  phone: "",
  country: "",
  city: "",
  line1: "",
  line2: "",
  postalCode: "",
  notes: "",
};

export default function CartPanel({ t, cart, currency, busy, onClose, onSetQuantity, onRemove, onCheckout }) {
  // basket -> delivery -> done. The address is a step rather than a long form
  // under the lines, so the basket stays readable on a phone.
  const [step, setStep] = useState("basket");
  const [checkoutState, setCheckoutState] = useState("idle"); // idle | working | done | error
  const [message, setMessage] = useState("");
  const [placed, setPlaced] = useState(0);
  const [delivery, setDelivery] = useState(EMPTY_DELIVERY);
  // Keyed by field name, straight from the server's `fields` array, so the
  // form marks exactly what the server objected to.
  const [fieldErrors, setFieldErrors] = useState({});

  // Prefilled from the customer's last order, so a returning shopper confirms
  // an address instead of retyping it. A failure here is silent on purpose:
  // an empty form still works, and there is nothing useful to say about it.
  useEffect(() => {
    let cancelled = false;
    fetchLatestDelivery()
      .then((data) => {
        if (cancelled || !data.delivery) return;
        setDelivery((current) => ({
          ...current,
          ...Object.fromEntries(Object.entries(data.delivery).map(([key, value]) => [key, value ?? ""])),
        }));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  function setField(field, value) {
    setDelivery((current) => ({ ...current, [field]: value }));
    setFieldErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  }

  useEffect(() => {
    function onKeyDown(event) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  async function handleCheckout() {
    setCheckoutState("working");
    setMessage("");
    setFieldErrors({});
    try {
      const result = await onCheckout(delivery);
      setPlaced(result.itemCount);
      setCheckoutState("done");
    } catch (error) {
      // The server is the authority on what a shippable address is, so its
      // per-field complaints are shown rather than re-deriving the rules here
      // and risking a form that disagrees with the thing enforcing them.
      const fields = error.data?.fields;
      if (Array.isArray(fields)) {
        setFieldErrors(Object.fromEntries(fields.map((problem) => [problem.field, problem.message])));
      }
      setMessage(errorMessage(t, error));
      setCheckoutState("error");
    }
  }

  function field(name, { type = "text", autoComplete } = {}) {
    return (
      <label className={`cart-field${fieldErrors[name] ? " cart-field-bad" : ""}`}>
        <span>{t[FIELD_LABEL_KEYS[name]]}</span>
        <input
          type={type}
          value={delivery[name]}
          autoComplete={autoComplete}
          onChange={(event) => setField(name, event.target.value)}
        />
        {fieldErrors[name] && <em>{fieldErrors[name]}</em>}
      </label>
    );
  }

  const lines = cart?.lines || [];

  return (
    <div className="cart-overlay" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="cart-panel" role="dialog" aria-modal="true" aria-label={t.basket}>
        <header className="cart-header">
          <h2>{t.basket}</h2>
          <button className="modal-close" type="button" onClick={onClose} aria-label={t.close}>
            ×
          </button>
        </header>

        {checkoutState === "done" ? (
          <div className="cart-empty">
            <p className="cart-success">{t.checkoutDone(placed)}</p>
            <button className="cart-checkout" type="button" onClick={onClose}>
              {t.keepShopping}
            </button>
          </div>
        ) : !lines.length ? (
          <div className="cart-empty">
            <p>{t.basketEmpty}</p>
            <p className="cart-hint">{t.basketHint}</p>
          </div>
        ) : (
          <>
            <ul className={`cart-lines${step === "delivery" ? " cart-lines-compact" : ""}`}>
              {lines.map((line) => (
                <li key={line.itemId} className={`cart-line${line.purchasable ? "" : " cart-line-problem"}`}>
                  <div className="cart-line-thumb" style={{ background: `linear-gradient(135deg, ${line.colors[0]}, ${line.colors[1] || line.colors[0]})` }}>
                    {line.image ? <img src={line.image} alt={line.name || ""} /> : <span>{line.icon}</span>}
                  </div>

                  <div className="cart-line-body">
                    <strong>{line.name || line.sku || "—"}</strong>
                    <span className="cart-line-unit">
                      {formatMoney(line.unitPrice, currency, line.currency)} {t.each}
                    </span>
                    {!line.purchasable && <span className="cart-line-warning">{t.lineUnavailable}</span>}

                    <div className="cart-qty">
                      <button
                        type="button"
                        onClick={() => onSetQuantity(line.itemId, line.quantity - 1)}
                        disabled={busy}
                        aria-label={t.decreaseQuantity}
                      >
                        −
                      </button>
                      <span>{line.quantity}</span>
                      <button
                        type="button"
                        onClick={() => onSetQuantity(line.itemId, line.quantity + 1)}
                        disabled={busy || line.quantity >= line.availableQuantity}
                        aria-label={t.increaseQuantity}
                      >
                        +
                      </button>
                      <button className="cart-remove" type="button" onClick={() => onRemove(line.itemId)} disabled={busy}>
                        {t.remove}
                      </button>
                    </div>
                  </div>

                  <div className="cart-line-total">{formatMoney(line.lineTotal, currency, line.currency)}</div>
                </li>
              ))}
            </ul>

            {step === "delivery" && (
              <form
                className="cart-delivery"
                onSubmit={(event) => {
                  event.preventDefault();
                  handleCheckout();
                }}
              >
                <h3>{t.deliveryTitle}</h3>

                <fieldset className="cart-method">
                  <legend>{t.deliveryMethod}</legend>
                  {["delivery", "pickup"].map((method) => (
                    <label key={method} className={delivery.method === method ? "is-selected" : ""}>
                      <input
                        type="radio"
                        name="delivery-method"
                        value={method}
                        checked={delivery.method === method}
                        onChange={() => setField("method", method)}
                      />
                      <span>{method === "delivery" ? t.methodDelivery : t.methodPickup}</span>
                    </label>
                  ))}
                </fieldset>

                {field("name", { autoComplete: "name" })}
                {field("phone", { type: "tel", autoComplete: "tel" })}

                {/* A pickup order has nowhere to ship to, so asking for an
                    address would be asking the customer to invent one. The
                    server applies the same rule — see normaliseDelivery(). */}
                {delivery.method === "delivery" ? (
                  <>
                    {field("country", { autoComplete: "country-name" })}
                    {field("city", { autoComplete: "address-level2" })}
                    {field("line1", { autoComplete: "address-line1" })}
                    {field("line2", { autoComplete: "address-line2" })}
                    {field("postalCode", { autoComplete: "postal-code" })}
                  </>
                ) : (
                  <p className="cart-hint">{t.pickupHint}</p>
                )}

                {field("notes")}
                <p className="cart-hint">{t.deliveryNotesHint}</p>

                <div className="cart-subtotal">
                  <span>{t.subtotal}</span>
                  <strong>{displayTotal(cart.totals, currency)}</strong>
                </div>
                {isConverted(currency) && <p className="cart-approx">{t.approxNote(chargedTotal(cart.totals))}</p>}
                {checkoutState === "error" && <p className="auth-error">{message}</p>}
                <button
                  className="cart-checkout"
                  type="submit"
                  disabled={busy || checkoutState === "working" || lines.some((line) => !line.purchasable)}
                >
                  {checkoutState === "working" ? t.checkingOut : t.checkout}
                </button>
                <button className="cart-back" type="button" onClick={() => setStep("basket")}>
                  {t.backToBasket}
                </button>
              </form>
            )}

            {step === "basket" && (
              <footer className="cart-footer">
                <div className="cart-subtotal">
                  <span>{t.subtotal}</span>
                  <strong>{displayTotal(cart.totals, currency)}</strong>
                </div>
                {isConverted(currency) && <p className="cart-approx">{t.approxNote(chargedTotal(cart.totals))}</p>}
                <button
                  className="cart-checkout"
                  type="button"
                  onClick={() => setStep("delivery")}
                  disabled={busy || lines.some((line) => !line.purchasable)}
                >
                  {t.continueToDelivery}
                </button>
              </footer>
            )}
          </>
        )}
      </aside>
    </div>
  );
}
