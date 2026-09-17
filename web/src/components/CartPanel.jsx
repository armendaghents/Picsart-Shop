import { useEffect, useState } from "react";
import { convertMoney, formatMoney } from "../currency";
import { errorMessage } from "../i18n";

// Totals arrive from the server grouped by the item's own currency, so they are
// converted into the display currency one group at a time rather than being
// added together first — which would be wrong the moment two currencies meet.
function displayTotal(totals, currency) {
  const sum = (totals || []).reduce((running, entry) => running + convertMoney(entry.subtotal, currency, entry.currency), 0);
  return formatMoney(sum, currency, currency);
}

export default function CartPanel({ t, cart, currency, busy, onClose, onSetQuantity, onRemove, onCheckout }) {
  const [checkoutState, setCheckoutState] = useState("idle"); // idle | working | done | error
  const [message, setMessage] = useState("");
  const [placed, setPlaced] = useState(0);

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
    try {
      const result = await onCheckout();
      setPlaced(result.itemCount);
      setCheckoutState("done");
    } catch (error) {
      setMessage(errorMessage(t, error));
      setCheckoutState("error");
    }
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
            <ul className="cart-lines">
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

            <footer className="cart-footer">
              <div className="cart-subtotal">
                <span>{t.subtotal}</span>
                <strong>{displayTotal(cart.totals, currency)}</strong>
              </div>
              {checkoutState === "error" && <p className="auth-error">{message}</p>}
              <button
                className="cart-checkout"
                type="button"
                onClick={handleCheckout}
                disabled={busy || checkoutState === "working" || lines.some((line) => !line.purchasable)}
              >
                {checkoutState === "working" ? t.checkingOut : t.checkout}
              </button>
            </footer>
          </>
        )}
      </aside>
    </div>
  );
}
