import PriceRangeSlider from "./PriceRangeSlider";

export default function FilterPopover({
  t,
  open,
  categories,
  category,
  onCategoryChange,
  sort,
  onSortChange,
  inStockOnly,
  onInStockOnlyChange,
  currency,
  priceBounds,
  priceValue,
  onPriceChange,
}) {
  if (!open) return null;

  return (
    <div className="filter-popover">
      <label className="filter-popover-field">
        <span>{t.category}</span>
        <select value={category} onChange={(event) => onCategoryChange(event.target.value)}>
          <option value="All">{t.allCategories}</option>
          {categories.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>

      <label className="filter-popover-field">
        <span className="sr-only">Sort</span>
        <select value={sort} onChange={(event) => onSortChange(event.target.value)}>
          <option value="relevance">{t.sortRelevance}</option>
          <option value="priceAsc">{t.sortPriceAsc}</option>
          <option value="priceDesc">{t.sortPriceDesc}</option>
          <option value="stock">{t.sortStock}</option>
          <option value="recent">{t.sortRecent}</option>
        </select>
      </label>

      <PriceRangeSlider t={t} currency={currency} bounds={priceBounds} value={priceValue} onChange={onPriceChange} />

      <label className="filter-popover-checkbox">
        <input type="checkbox" checked={inStockOnly} onChange={(event) => onInStockOnlyChange(event.target.checked)} />
        <span>{t.inStockOnly}</span>
      </label>
    </div>
  );
}
