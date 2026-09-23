import { useEffect, useRef, useState } from "react";
import { fetchRecommendations } from "../api";
import { formatMoney } from "../currency";
import { errorMessage } from "../i18n";

const NO_RECOMMENDATIONS = { upgrades: [], alternatives: [] };

function availabilityClass(label) {
  return `status-pill status-${label.replace(/\s+/g, "-").toLowerCase()}`;
}

function conditionClass(condition) {
  return `condition-pill condition-${condition.toLowerCase()}`;
}

function RecommendationCard({ item, t, currency, priceDelta, onOpen }) {
  const photo = item.images && item.images.length ? item.images[0] : null;
  return (
    <button type="button" className="recommendation-card" onClick={() => onOpen(item.id)}>
      <span className="product-art recommendation-art" style={{ "--art-a": item.colors[0], "--art-b": item.colors[1] }}>
        {photo ? <img src={photo} alt={item.name} /> : <span>{item.icon}</span>}
      </span>
      <span className="recommendation-name">{item.name}</span>
      <span className="recommendation-price">
        {formatMoney(item.price, currency, item.currency)}
        {priceDelta > 0 && (
          <span className="recommendation-delta">+{formatMoney(priceDelta, currency, item.currency)}</span>
        )}
      </span>
      {!item.inStock && <span className="recommendation-stock">{t.unavailable}</span>}
    </button>
  );
}

export default function ProductModal({ product, t, currency, onClose, onBuy, onOpenProduct }) {
  const [photoIndex, setPhotoIndex] = useState(0);
  const [orderState, setOrderState] = useState("idle"); // idle | adding | added | error
  const [orderError, setOrderError] = useState("");
  const [zoomed, setZoomed] = useState(false);
  const [zoomOrigin, setZoomOrigin] = useState({ x: 50, y: 50 });
  const [recommendations, setRecommendations] = useState(NO_RECOMMENDATIONS);
  const modalRef = useRef(null);

  useEffect(() => {
    setPhotoIndex(0);
    setOrderState("idle");
    setZoomed(false);
    // Following a recommendation swaps the product inside the open modal, so
    // send the panel back to the top — otherwise the new product opens
    // scrolled to wherever the previous one was being read.
    modalRef.current?.scrollTo({ top: 0 });
  }, [product?.id]);

  // A failed lookup leaves the modal exactly as it would be with nothing to
  // recommend: the product itself must never depend on this call.
  useEffect(() => {
    setRecommendations(NO_RECOMMENDATIONS);
    if (!product?.id) return undefined;

    let cancelled = false;
    fetchRecommendations(product.id)
      .then((data) => {
        if (cancelled) return;
        setRecommendations({ upgrades: data.upgrades || [], alternatives: data.alternatives || [] });
      })
      .catch((error) => console.error("Recommendations failed", error));

    return () => {
      cancelled = true;
    };
  }, [product?.id]);

  useEffect(() => {
    setZoomed(false);
  }, [photoIndex]);

  // Buying is now "add to basket". If nobody is signed in, the parent opens the
  // sign-in form and finishes this exact purchase once that succeeds — so the
  // click is never lost.
  async function handleBuy() {
    setOrderState("adding");
    setOrderError("");
    try {
      const outcome = await onBuy(product.id);
      setOrderState(outcome === "deferred" ? "idle" : "added");
    } catch (error) {
      setOrderError(errorMessage(t, error));
      setOrderState("error");
    }
  }

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  function pointFromEvent(event) {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.min(100, Math.max(0, ((event.clientX - rect.left) / rect.width) * 100));
    const y = Math.min(100, Math.max(0, ((event.clientY - rect.top) / rect.height) * 100));
    return { x, y };
  }

  function handleImageClick(event) {
    setZoomOrigin(pointFromEvent(event));
    setZoomed((current) => !current);
  }

  function handleImageMouseMove(event) {
    if (!zoomed) return;
    setZoomOrigin(pointFromEvent(event));
  }

  if (!product) return null;

  const availabilityLabel = t.availability[product.availability] || product.availability;
  const conditionLabel = t.condition[product.condition] || product.condition;
  const category = product.category ? product.category.split(">").map((part) => part.trim()).at(-1) : "";
  const subtitle = [product.brand, product.model, category].filter(Boolean).join(" · ");
  const photos = product.images && product.images.length ? product.images : null;

  return (
    <div
      className="modal-overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="product-modal" ref={modalRef}>
        <button type="button" className="icon-button subtle product-modal-close" onClick={onClose}>
          ×
        </button>
        <div className="product-art product-modal-art" style={{ "--art-a": product.colors[0], "--art-b": product.colors[1] }}>
          {photos ? (
            <img
              src={photos[photoIndex]}
              alt={product.name}
              className={`zoomable-image${zoomed ? " zoomable-image-zoomed" : ""}`}
              style={{ transformOrigin: `${zoomOrigin.x}% ${zoomOrigin.y}%` }}
              onClick={handleImageClick}
              onMouseMove={handleImageMouseMove}
            />
          ) : (
            <span>{product.icon}</span>
          )}

          {photos && photos.length > 1 && (
            <>
              <button
                className="gallery-nav gallery-prev"
                type="button"
                onClick={() => setPhotoIndex((index) => (index - 1 + photos.length) % photos.length)}
                aria-label={t.previousPhoto}
              >
                ‹
              </button>
              <button
                className="gallery-nav gallery-next"
                type="button"
                onClick={() => setPhotoIndex((index) => (index + 1) % photos.length)}
                aria-label={t.nextPhoto}
              >
                ›
              </button>
            </>
          )}
        </div>

        {photos && photos.length > 1 && (
          <div className="product-modal-thumbs">
            {photos.map((url, index) => (
              <button
                key={url}
                type="button"
                className={index === photoIndex ? "product-modal-thumb-active" : ""}
                onClick={() => setPhotoIndex(index)}
              >
                <img src={url} alt={t.photoAlt(product.name, index + 1)} />
              </button>
            ))}
          </div>
        )}

        <div className="product-modal-body">
          <div className="shop-card-badges">
            <span className={availabilityClass(product.availability)}>{availabilityLabel}</span>
            {product.condition && <span className={conditionClass(product.condition)}>{conditionLabel}</span>}
          </div>
          <h2>{product.name}</h2>
          <p className="product-modal-brand">{subtitle}</p>
          <div className="product-modal-meta">
            <span className="price">{formatMoney(product.price, currency, product.currency)}</span>
            <span className={`stock${product.inStock ? "" : " stock-empty"}`}>
              {product.inStock ? t.inStockSuffix(product.availableQuantity) : t.unavailable}
            </span>
          </div>
          <div className="product-modal-order">
            <button
              type="button"
              className="command-button"
              onClick={handleBuy}
              disabled={!product.inStock || orderState === "adding"}
            >
              {orderState === "adding" ? t.adding : orderState === "added" ? t.addedToBasket : t.addToBasket}
            </button>
            {orderState === "error" && <p className="order-error">{orderError || t.orderFailed}</p>}
          </div>
          <p className="product-modal-description">{product.description}</p>
          <div className="product-modal-tags">
            {(product.tags || []).map((tag) => (
              <span key={tag}>{tag}</span>
            ))}
          </div>

          {onOpenProduct && (
            <>
              {recommendations.upgrades.length > 0 && (
                <section className="product-recommendations">
                  <h3>{t.upgradeOptions}</h3>
                  <div className="recommendation-row">
                    {recommendations.upgrades.map((item) => (
                      <RecommendationCard
                        key={item.id}
                        item={item}
                        t={t}
                        currency={currency}
                        priceDelta={item.priceDelta}
                        onOpen={onOpenProduct}
                      />
                    ))}
                  </div>
                </section>
              )}

              {recommendations.alternatives.length > 0 && (
                <section className="product-recommendations">
                  <h3>{t.youMightAlsoLike}</h3>
                  <div className="recommendation-row">
                    {recommendations.alternatives.map((item) => (
                      <RecommendationCard key={item.id} item={item} t={t} currency={currency} onOpen={onOpenProduct} />
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
