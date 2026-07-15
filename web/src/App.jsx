import { useEffect, useMemo, useState } from "react";
import Header from "./components/Header";
import SearchBar from "./components/SearchBar";
import FilterPopover from "./components/FilterPopover";
import ProductGrid from "./components/ProductGrid";
import ProductModal from "./components/ProductModal";
import Footer from "./components/Footer";
import { TRANSLATIONS, QUICK_SEARCHES } from "./i18n";
import { fetchFacets, fetchProducts, fetchProduct } from "./api";
import { useDebouncedValue } from "./hooks/useDebouncedValue";
import { useScrolled } from "./hooks/useScrolled";
import { EXCHANGE_RATES } from "./currency";

function readStored(key, fallback) {
  return localStorage.getItem(key) || fallback;
}

const DEFAULT_SORT = "relevance";

export default function App() {
  const [lang, setLang] = useState(() => readStored("atlas_lang", "en"));
  const [currency, setCurrency] = useState(() => readStored("atlas_currency", "USD"));
  const [dark, setDark] = useState(false);
  const compact = useScrolled(8);

  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");
  const [sort, setSort] = useState(DEFAULT_SORT);
  const [inStockOnly, setInStockOnly] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const [categories, setCategories] = useState([]);
  const [priceBounds, setPriceBounds] = useState({ min: 0, max: 10000 });
  const [priceValue, setPriceValue] = useState({ min: 0, max: 10000 });

  const [items, setItems] = useState([]);
  const [selectedProductId, setSelectedProductId] = useState(null);
  const [selectedProduct, setSelectedProduct] = useState(null);

  const t = TRANSLATIONS[lang] || TRANSLATIONS.en;
  const debouncedPrice = useDebouncedValue(priceValue, 200);

  useEffect(() => {
    document.documentElement.lang = lang;
    localStorage.setItem("atlas_lang", lang);
  }, [lang]);

  useEffect(() => {
    localStorage.setItem("atlas_currency", currency);
  }, [currency]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  useEffect(() => {
    fetchFacets()
      .then((data) => {
        setCategories(data.categories || []);
        // Always start at 0 (not the cheapest item's price). Upper bound is a
        // round 2,000,000 AMD (converted to the internal USD unit prices are
        // stored in), growing automatically if the catalog ever exceeds it.
        const floor = 0;
        const amdCeilingInUsd = Math.ceil(2000000 / EXCHANGE_RATES.AMD / 100) * 100;
        const ceiling = Math.max(amdCeilingInUsd, Math.ceil((data.maxPrice || 0) / 100) * 100);
        setPriceBounds({ min: floor, max: ceiling });
        setPriceValue({ min: floor, max: ceiling });
      })
      .catch((error) => console.error("Facet load failed", error));
  }, []);

  useEffect(() => {
    fetchProducts({
      q: query,
      category,
      sort,
      inStockOnly,
      minPrice: debouncedPrice.min,
      maxPrice: debouncedPrice.max,
    })
      .then((data) => setItems(data.items || []))
      .catch((error) => {
        console.error("Search failed", error);
        setItems([]);
      });
  }, [query, category, sort, inStockOnly, debouncedPrice]);

  useEffect(() => {
    if (!selectedProductId) {
      setSelectedProduct(null);
      return;
    }
    const cached = items.find((item) => item.id === selectedProductId);
    if (cached) {
      setSelectedProduct(cached);
      return;
    }
    fetchProduct(selectedProductId)
      .then(setSelectedProduct)
      .catch((error) => console.error("Product load failed", error));
  }, [selectedProductId, items]);

  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (category !== "All") count += 1;
    if (inStockOnly) count += 1;
    if (priceValue.min !== priceBounds.min || priceValue.max !== priceBounds.max) count += 1;
    return count;
  }, [category, inStockOnly, priceValue, priceBounds]);

  const summary = query ? t.resultsFor(items.length, query) : t.productsCount(items.length);

  function goHome() {
    setQuery("");
    setCategory("All");
    setSort(DEFAULT_SORT);
    setInStockOnly(false);
    setPriceValue(priceBounds);
    setFiltersOpen(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return (
    <div className="shop-app">
      <div className={`sticky-header${compact ? " sticky-header-compact" : ""}`}>
        <Header
          t={t}
          lang={lang}
          onLangChange={setLang}
          currency={currency}
          onCurrencyChange={setCurrency}
          dark={dark}
          onToggleDark={() => setDark((value) => !value)}
          onHome={goHome}
          compact={compact}
          searchSlot={
            <div className="search-anchor">
              <SearchBar
                t={t}
                query={query}
                onSearch={setQuery}
                filtersOpen={filtersOpen}
                onToggleFilters={() => setFiltersOpen((value) => !value)}
                activeFilterCount={activeFilterCount}
              />

              <FilterPopover
                t={t}
                open={filtersOpen}
                categories={categories}
                category={category}
                onCategoryChange={setCategory}
                sort={sort}
                onSortChange={setSort}
                inStockOnly={inStockOnly}
                onInStockOnlyChange={setInStockOnly}
                currency={currency}
                priceBounds={priceBounds}
                priceValue={priceValue}
                onPriceChange={setPriceValue}
              />
            </div>
          }
        />

        <div className={`quick-searches quick-searches-row${compact ? " quick-searches-collapsed" : ""}`}>
          {QUICK_SEARCHES.map((search) => (
            <button key={search.q} type="button" className="chip" onClick={() => setQuery(search.q)}>
              {search[lang] || search.en}
            </button>
          ))}
        </div>
      </div>

      <p className="shop-result-summary shop-result-summary-standalone">{summary}</p>

      <ProductGrid items={items} t={t} currency={currency} query={query} onOpenProduct={setSelectedProductId} />

      <ProductModal product={selectedProduct} t={t} currency={currency} onClose={() => setSelectedProductId(null)} />

      <Footer t={t} />
    </div>
  );
}
