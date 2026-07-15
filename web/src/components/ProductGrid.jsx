import ProductCard from "./ProductCard";

export default function ProductGrid({ items, t, currency, query, onOpenProduct }) {
  if (!items.length) {
    return <div className="empty-state">{t.emptyState}</div>;
  }

  return (
    <section className="shop-results" aria-label="Products">
      {items.map((item) => (
        <ProductCard key={item.id} item={item} t={t} currency={currency} query={query} onOpen={onOpenProduct} />
      ))}
    </section>
  );
}
