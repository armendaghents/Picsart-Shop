const formatMoney = (amount) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(amount || 0);

const formatCount = (value) => Number(value || 0).toLocaleString();

// "Sep 16" rather than a raw date, since it sits inside a sentence. The stored
// day is a UTC date, so it is read back as one — otherwise a browser west of
// UTC would render every snapshot a day early.
function formatSince(date) {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString("en-US", { day: "numeric", month: "short", timeZone: "UTC" });
}

// A tile shows movement only when there is an earlier day recorded to compare
// against, and only when something actually moved. A flat "↑ 0" on every tile
// is noise, and on the first day of tracking it would be a lie.
function Delta({ change, percent, since, invert = false }) {
  if (change === undefined || change === null || !since) return null;
  if (change === 0) {
    return <em className="metric-delta metric-delta-flat">No change since {formatSince(since)}</em>;
  }

  const up = change > 0;
  // For low stock, a rise is the bad direction — colour follows meaning, not sign.
  const good = invert ? !up : up;
  const magnitude =
    percent === null || percent === undefined
      ? formatCount(Math.abs(change))
      : `${Math.abs(percent).toFixed(1)}%`;

  return (
    <em className={`metric-delta ${good ? "metric-delta-up" : "metric-delta-down"}`}>
      {up ? "↑" : "↓"} {magnitude} since {formatSince(since)}
    </em>
  );
}

export default function Dashboard({ dashboard }) {
  const trend = dashboard.trend || null;

  return (
    <section className="metrics" aria-label="Dashboard metrics">
      <article>
        <span>Inventory Value</span>
        <strong>{formatMoney(dashboard.inventory_value)}</strong>
        <Delta change={trend?.inventory_value} percent={trend?.inventory_value_pct} since={trend?.since} />
        <small>Across all warehouses</small>
      </article>
      <article>
        <span>Items In Stock</span>
        <strong>{formatCount(dashboard.stock_count)}</strong>
        <Delta change={trend?.stock_count} since={trend?.since} />
        <small>Available units</small>
      </article>
      <article>
        <span>Low Stock</span>
        <strong>{formatCount(dashboard.low_stock_count)}</strong>
        <Delta change={trend?.low_stock_count} since={trend?.since} invert />
        <small>Needs attention</small>
      </article>
    </section>
  );
}
