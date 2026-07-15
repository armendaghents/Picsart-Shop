const formatMoney = (amount) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(amount || 0);

export default function Dashboard({ dashboard, searchCount }) {
  return (
    <section className="metrics" aria-label="Dashboard metrics">
      <article>
        <span>Inventory Value</span>
        <strong>{formatMoney(dashboard.inventory_value)}</strong>
        <small>Across all warehouses</small>
      </article>
      <article>
        <span>Items In Stock</span>
        <strong>{Number(dashboard.stock_count || 0).toLocaleString()}</strong>
        <small>Available units</small>
      </article>
      <article>
        <span>Low Stock</span>
        <strong>{Number(dashboard.low_stock_count || 0).toLocaleString()}</strong>
        <small>Needs attention</small>
      </article>
      <article>
        <span>Searches</span>
        <strong>{searchCount.toLocaleString()}</strong>
        <small>This session</small>
      </article>
    </section>
  );
}
