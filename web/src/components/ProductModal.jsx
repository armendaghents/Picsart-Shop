import { useEffect, useState } from "react";
import { formatMoney } from "../currency";

function availabilityClass(label) {
  return `status-pill status-${label.replace(/\s+/g, "-").toLowerCase()}`;
}

function conditionClass(condition) {
  return `condition-pill condition-${condition.toLowerCase()}`;
}

export default function ProductModal({ product, t, currency, onClose, onOrder }) {
  const [photoIndex, setPhotoIndex] = useState(0);
  const [orderState, setOrderState] = useState("idle"); // idle | ordering | ordered | error
  const [zoomed, setZoomed] = useState(false);
  const [zoomOrigin, setZoomOrigin] = useState({ x: 50, y: 50 });

  useEffect(() => {
    setPhotoIndex(0);
    setOrderState("idle");
    setZoomed(false);
  }, [product?.id]);

  useEffect(() => {
    setZoomed(false);
  }, [photoIndex]);

  async function handleOrder() {
    setOrderState("ordering");
    try {
      await onOrder(product.id);
      setOrderState("ordered");
    } catch {
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
  const category = product.category.split(">").map((part) => part.trim()).at(-1);
  const subtitle = [product.brand, product.model, category].filter(Boolean).join(" · ");
  const photos = product.images && product.images.length ? product.images : null;

  return (
    <div
      className="modal-overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="product-modal">
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
                aria-label="Previous photo"
              >
                ‹
              </button>
              <button
                className="gallery-nav gallery-next"
                type="button"
                onClick={() => setPhotoIndex((index) => (index + 1) % photos.length)}
                aria-label="Next photo"
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
                <img src={url} alt={`${product.name} photo ${index + 1}`} />
              </button>
            ))}
          </div>
        )}

        <div className="product-modal-body">
          <div className="shop-card-badges">
            <span className={availabilityClass(product.availability)}>{availabilityLabel}</span>
            {product.condition && <span className={conditionClass(product.condition)}>{product.condition}</span>}
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
              onClick={handleOrder}
              disabled={!product.inStock || orderState === "ordering"}
            >
              {orderState === "ordering" ? t.ordering : orderState === "ordered" ? t.ordered : t.orderButton}
            </button>
            {orderState === "error" && <p className="order-error">{t.orderFailed}</p>}
          </div>
          <p className="product-modal-description">{product.description}</p>
          <div className="product-modal-tags">
            {(product.tags || []).map((tag) => (
              <span key={tag}>{tag}</span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
