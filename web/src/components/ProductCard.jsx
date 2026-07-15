import { useState } from "react";
import { formatMoney } from "../currency";

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

export default function ProductCard({ item, t, currency, query, onOpen }) {
  const [photoIndex, setPhotoIndex] = useState(0);
  const availabilityLabel = t.availability[item.availability] || item.availability;
  const category = item.category.split(">").map((part) => part.trim()).at(-1);
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
            <button className="gallery-nav gallery-prev" type="button" onClick={(event) => showPhoto(event, photoIndex - 1)} aria-label="Previous photo">
              ‹
            </button>
            <button className="gallery-nav gallery-next" type="button" onClick={(event) => showPhoto(event, photoIndex + 1)} aria-label="Next photo">
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
          {item.condition && <span className={conditionClass(item.condition)}>{item.condition}</span>}
        </div>
        <h3>{highlight(item.name, query)}</h3>
        <p className="shop-brand">
          {item.brand} {item.brand ? "·" : ""} {category}
        </p>
        <p className="shop-description">{highlight(item.description, query)}</p>
        <div className="shop-card-footer">
          <span className="price">{formatMoney(item.price, currency, item.currency)}</span>
          <span className={`stock${item.inStock ? "" : " stock-empty"}`}>
            {item.inStock ? t.inStockSuffix(item.availableQuantity) : t.unavailable}
          </span>
        </div>
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
