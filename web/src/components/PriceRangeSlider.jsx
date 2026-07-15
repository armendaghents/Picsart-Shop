import { formatMoney } from "../currency";

export default function PriceRangeSlider({ t, currency, bounds, value, onChange }) {
  const { min: boundsMin, max: boundsMax } = bounds;
  const { min, max } = value;
  const span = Math.max(1, boundsMax - boundsMin);
  const leftPercent = ((min - boundsMin) / span) * 100;
  const rightPercent = ((max - boundsMin) / span) * 100;

  function handleMinChange(event) {
    const next = Math.min(Number(event.target.value), max - 1);
    onChange({ min: next, max });
  }

  function handleMaxChange(event) {
    const next = Math.max(Number(event.target.value), min + 1);
    onChange({ min, max: next });
  }

  return (
    <div className="price-filter">
      <div className="price-filter-head">
        <span>{t.priceRange}</span>
        <span className="price-range-value">
          {formatMoney(min, currency)} – {formatMoney(max, currency)}
        </span>
      </div>
      <div className="dual-range">
        <div className="dual-range-track" />
        <div
          className="dual-range-fill"
          style={{ left: `${leftPercent}%`, width: `${Math.max(0, rightPercent - leftPercent)}%` }}
        />
        <input type="range" min={boundsMin} max={boundsMax} value={min} onChange={handleMinChange} />
        <input type="range" min={boundsMin} max={boundsMax} value={max} onChange={handleMaxChange} />
      </div>
    </div>
  );
}
