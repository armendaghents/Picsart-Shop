import { useEffect, useRef, useState } from "react";
import { formatMoney } from "../currency";
import { errorMessage } from "../i18n";

function highlight(text, query) {
  if (!text) return text;
  const terms = query.split(/\s+/).filter((term) => term.length > 2).slice(0, 6);
  if (!terms.length) return text;
  const pattern = new RegExp(`(${terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  const parts = text.split(pattern);
  return parts.map((part, index) =>
    pattern.test(part) ? (
      <mark key={index}>{part}</mark>
    ) : (
      <span key={index}>{part}</span>
    )
  );
}

function availabilityClass(label) {
  return `status-pill status-${label.replace(/\s+/g, "-").toLowerCase()}`;
}

function conditionClass(condition) {
  return `condition-pill condition-${condition.toLowerCase()}`;
}

export default function ProductCard({ item, t, currency, query, onOpen, onAddToCart }) {
  const [photoIndex, setPhotoIndex] = useState(0);
  const [orderState, setOrderState] = useState("idle"); // idle | adding | added | error
  const [orderError, setOrderError] = useState("");
  const resetTimer = useRef(null);

  // The card stays on screen after a click, so the confirmation is a moment
  // rather than a permanent state — unlike the modal, which is dismissed.
  useEffect(() => () => clearTimeout(resetTimer.current), []);

  async function handleAdd(event) {
    // Without this the click also lands on the card and opens the modal.
    event.stopPropagation();
    clearTimeout(resetTimer.current);
    setOrderState("adding");
    setOrderError("");
    try {
      const outcome = await onAddToCart(item.id);
      // "deferred" means nobody is signed in: the sign-in form has opened and
      // will finish this exact add, so the card shouldn't claim success.
      if (outcome === "deferred") {
        setOrderState("idle");
        return;
      }
      setOrderState("added");
      resetTimer.current = setTimeout(() => setOrderState("idle"), 2000);
    } catch (error) {
      setOrderError(errorMessage(t, error));
      setOrderState("error");
      resetTimer.current = setTimeout(() => setOrderState("idle"), 4000);
    }
  }
  const availabilityLabel = t.availability[item.availability] || item.availability;
  const conditionLabel = t.condition[item.condition] || item.condition;
  const category = item.category ? item.category.split(">").map((part) => part.trim()).at(-1) : "";
  const photos = item.images && item.images.length ? item.images : null;
  const hasGallery = photos && photos.length > 1;

  function showPhoto(event, index) {
    event.stopPropagation();
    setPhotoIndex((index + photos.length) % photos.length);
  }

  return (
    <article className="shop-card" onClick={() => onOpen(item.id)}>
      <div className="product-art" style={{ "--art-a": item.colors[0], "--art-b": item.colors[1] }}>
        {photos ? <img src={photos[photoIndex]} alt={item.name} /> : <span>{item.icon}</span>}

        {hasGallery && (
          <>
            <button className="gallery-nav gallery-prev" type="button" onClick={(event) => showPhoto(event, photoIndex - 1)} aria-label={t.previousPhoto}>
              ‹
            </button>
            <button className="gallery-nav gallery-next" type="button" onClick={(event) => showPhoto(event, photoIndex + 1)} aria-label={t.nextPhoto}>
              ›
            </button>
            <div className="gallery-dots">
              {photos.map((_, index) => (
                <span key={index} className={index === photoIndex ? "gallery-dot-active" : ""} onClick={(event) => showPhoto(event, index)} />
              ))}
            </div>
          </>
        )}
      </div>
      <div className="shop-card-body">
        <div className="shop-card-badges">
          <span className={availabilityClass(item.availability)}>{availabilityLabel}</span>
          {item.condition && <span className={conditionClass(item.condition)}>{conditionLabel}</span>}
        </div>
        <h3>{highlight(item.name, query)}</h3>
        <p className="shop-brand">{[item.brand, category].filter(Boolean).join(" · ")}</p>
        <p className="shop-description">{highlight(item.description, query)}</p>
        <div className="shop-card-footer">
          <span className="price">{formatMoney(item.price, currency, item.currency)}</span>
          <span className={`stock${item.inStock ? "" : " stock-empty"}`}>
            {item.inStock ? t.inStockSuffix(item.availableQuantity) : t.unavailable}
          </span>
        </div>

        {onAddToCart && (
          <>
            <button
              className={`card-add${orderState === "added" ? " card-add-done" : ""}`}
              type="button"
              onClick={handleAdd}
              disabled={!item.inStock || orderState === "adding"}
            >
              {orderState === "adding"
                ? t.adding
                : orderState === "added"
                  ? t.addedToBasket
                  : item.inStock
                    ? t.addToBasket
                    : t.unavailable}
            </button>
            {orderState === "error" && <p className="card-add-error">{orderError || t.orderFailed}</p>}
          </>
        )}
      </div>
      <div className="shop-card-tooltip" aria-hidden="true">
        <p>{item.description}</p>
        <div className="tooltip-tags">
          {(item.tags || []).slice(0, 5).map((tag) => (
            <span key={tag}>{tag}</span>
          ))}
        </div>
      </div>
    </article>
  );
}
