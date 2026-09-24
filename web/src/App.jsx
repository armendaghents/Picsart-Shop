import { useEffect, useMemo, useRef, useState } from "react";
import Header from "./components/Header";
import SearchBar from "./components/SearchBar";
import FilterPopover from "./components/FilterPopover";
import ProductGrid from "./components/ProductGrid";
import ProductModal from "./components/ProductModal";
import AuthModal from "./components/AuthModal";
import CartPanel from "./components/CartPanel";
import AccountPanel from "./components/AccountPanel";
import Pagination from "./components/Pagination";
import Footer from "./components/Footer";
import { TRANSLATIONS } from "./i18n";
import {
  fetchFacets,
  fetchProducts,
  fetchProduct,
  fetchCart,
  addToCart,
  setCartQuantity,
  removeFromCart,
  checkout,
  restoreSession,
  logout,
  fetchRates,
} from "./api";
import { useDebouncedValue } from "./hooks/useDebouncedValue";
import { useScrolled } from "./hooks/useScrolled";
import { availableCurrencies, getRates, setRates } from "./currency";

function readStored(key, fallback) {
  return localStorage.getItem(key) || fallback;
}

const DEFAULT_SORT = "relevance";
const PAGE_SIZE = 20;

export default function App() {
  const [lang, setLang] = useState(() => readStored("atlas_lang", "en"));
  const [currency, setCurrency] = useState(() => readStored("atlas_currency", "USD"));
  // Bumped when the server's rates arrive. The rates themselves live in
  // currency.js so every formatMoney call site keeps its signature; this is
  // what tells React that the numbers on screen have changed.
  const [ratesVersion, setRatesVersion] = useState(0);
  const [dark, setDark] = useState(false);
  // Compacts as soon as the page moves, and expands again only back at the very
  // top — the gap is what stops the header oscillating. See useScrolled.
  const compact = useScrolled(8, 0);

  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");
  const [sort, setSort] = useState(DEFAULT_SORT);
  const [inStockOnly, setInStockOnly] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtersAnchorRef = useRef(null);

  const [categories, setCategories] = useState([]);
  const [priceBounds, setPriceBounds] = useState({ min: 0, max: 10000 });
  const [priceValue, setPriceValue] = useState({ min: 0, max: 10000 });

  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [selectedProductId, setSelectedProductId] = useState(null);
  const [selectedProduct, setSelectedProduct] = useState(null);

  const [user, setUser] = useState(null);
  const [cart, setCart] = useState(null);
  const [cartBusy, setCartBusy] = useState(false);
  const [cartOpen, setCartOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [authError, setAuthError] = useState("");
  const [accountOpen, setAccountOpen] = useState(false);
  // The product someone tried to buy while signed out. Held here so the
  // purchase completes by itself once they finish signing in.
  const [pendingBuyId, setPendingBuyId] = useState(null);
  // Bumped after a checkout so the grid re-queries stock that just changed.
  const [catalogVersion, setCatalogVersion] = useState(0);

  const t = TRANSLATIONS[lang] || TRANSLATIONS.en;
  const debouncedPrice = useDebouncedValue(priceValue, 200);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.title = t.pageTitle;
    localStorage.setItem("atlas_lang", lang);
  }, [lang, t]);

  // Auto sign-in: a still-valid access token answers straight away, otherwise
  // the refresh token is exchanged for a new session behind the scenes.
  useEffect(() => {
    let cancelled = false;
    restoreSession()
      .then((restored) => {
        if (!cancelled) setUser(restored);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!user) {
      setCart(null);
      return;
    }
    let cancelled = false;
    fetchCart()
      .then((loaded) => {
        if (!cancelled) setCart(loaded);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [user]);

  // Google sign-in returns by redirect, so a failure can only be reported in the
  // URL. Read it once, reopen the modal with the reason, and strip the parameter
  // so a refresh doesn't show the same message again.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const reason = params.get("auth_error");
    if (!reason) return;
    // Cancelling on Google's consent screen is a choice, not an error.
    if (reason !== "cancelled") {
      setAuthError(t.googleSignInFailed);
      setAuthOpen(true);
    }
    params.delete("auth_error");
    const query = params.toString();
    window.history.replaceState({}, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
    // Runs once on load: t is read for the message only, and the language
    // cannot have changed before this point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    localStorage.setItem("atlas_currency", currency);
  }, [currency]);

  useEffect(() => {
    fetchRates()
      .then((data) => {
        setRates(data.rates, data.updatedAt);
        setRatesVersion((value) => value + 1);
      })
      // Leaving the storefront on USD is the honest failure: prices are in USD,
      // so nothing shown is wrong — there is just no conversion on offer.
      .catch((error) => console.error("Rate load failed", error));
  }, []);

  // A currency stored from a previous visit may no longer be offered.
  useEffect(() => {
    if (ratesVersion && !availableCurrencies().includes(currency)) setCurrency("USD");
  }, [ratesVersion, currency]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  useEffect(() => {
    if (!filtersOpen) return;
    function handlePointerDown(event) {
      if (filtersAnchorRef.current && !filtersAnchorRef.current.contains(event.target)) {
        setFiltersOpen(false);
      }
    }
    function handleKeyDown(event) {
      if (event.key === "Escape") setFiltersOpen(false);
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [filtersOpen]);

  useEffect(() => {
    fetchFacets()
      .then((data) => {
        setCategories(data.categories || []);
        // Always start at 0 (not the cheapest item's price). The upper bound is
        // a round USD figure, growing automatically if the catalogue exceeds
        // it. It used to be derived from a hardcoded AMD rate, which tied the
        // slider to a number nobody could correct — and the bound belongs to
        // the catalogue, not to whichever currency happens to be on screen.
        const floor = 0;
        const ceiling = Math.max(5000, Math.ceil((data.maxPrice || 0) / 100) * 100);
        setPriceBounds({ min: floor, max: ceiling });
        setPriceValue({ min: floor, max: ceiling });
      })
      .catch((error) => console.error("Facet load failed", error));
  }, []);

  // Changing a filter should jump back to page 1. Tracked via ref (rather
  // than a separate effect calling setPage) so a filter change never fires
  // two competing requests for two different pages.
  const filtersSignature = JSON.stringify([query, category, sort, inStockOnly, debouncedPrice]);
  const previousFiltersSignature = useRef(filtersSignature);

  useEffect(() => {
    const filtersChanged = previousFiltersSignature.current !== filtersSignature;
    previousFiltersSignature.current = filtersSignature;
    const requestedPage = filtersChanged ? 1 : page;
    if (filtersChanged && page !== 1) setPage(1);

    fetchProducts({
      q: query,
      category,
      sort,
      inStockOnly,
      minPrice: debouncedPrice.min,
      maxPrice: debouncedPrice.max,
      page: requestedPage,
      pageSize: PAGE_SIZE,
    })
      .then((data) => {
        setItems(data.items || []);
        setTotal(data.total || 0);
        setTotalPages(data.totalPages || 1);
      })
      .catch((error) => {
        console.error("Search failed", error);
        setItems([]);
        setTotal(0);
        setTotalPages(1);
      });
  }, [filtersSignature, page, catalogVersion]);

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

  const summary = query ? t.resultsFor(total, query) : t.productsCount(total);

  function changePage(nextPage) {
    setPage(nextPage);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // Returns "deferred" when the click can't be completed yet because nobody is
  // signed in; the sign-in form takes it from there.
  async function handleBuy(id) {
    if (!user) {
      setPendingBuyId(id);
      setAuthOpen(true);
      return "deferred";
    }
    setCart(await addToCart(id));
    return "added";
  }

  async function handleAuthenticated(authenticatedUser) {
    setUser(authenticatedUser);
    setAuthOpen(false);

    const buyNow = pendingBuyId;
    setPendingBuyId(null);
    try {
      // Their basket may already have things in it from another device.
      const loaded = buyNow ? await addToCart(buyNow) : await fetchCart();
      setCart(loaded);
      if (buyNow) setCartOpen(true);
    } catch {
      // A basket that fails to load shouldn't undo a successful sign-in.
    }
  }

  async function handleSignOut() {
    try {
      await logout();
    } finally {
      setUser(null);
      setCart(null);
      setCartOpen(false);
      setAccountOpen(false);
    }
  }

  async function runCartAction(action) {
    setCartBusy(true);
    try {
      setCart(await action());
    } finally {
      setCartBusy(false);
    }
  }

  async function handleCheckout(delivery) {
    const result = await checkout(delivery);
    setCart(await fetchCart());
    // Stock moved, so the grid behind the basket is now out of date.
    setCatalogVersion((value) => value + 1);
    return result;
  }

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
          currencies={availableCurrencies()}
          onCurrencyChange={setCurrency}
          dark={dark}
          onToggleDark={() => setDark((value) => !value)}
          onHome={goHome}
          compact={compact}
          user={user}
          cartCount={cart?.itemCount || 0}
          onOpenCart={() => (user ? setCartOpen(true) : setAuthOpen(true))}
          onSignIn={() => setAuthOpen(true)}
          onSignOut={handleSignOut}
          onOpenAccount={() => setAccountOpen(true)}
          searchSlot={
            <div className="search-anchor" ref={filtersAnchorRef}>
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
      </div>

      <p className="shop-result-summary shop-result-summary-standalone">{summary}</p>

      <ProductGrid
        items={items}
        t={t}
        currency={currency}
        query={query}
        onOpenProduct={setSelectedProductId}
        onAddToCart={handleBuy}
      />

      <Pagination t={t} page={page} totalPages={totalPages} onPageChange={changePage} />

      <ProductModal
        product={selectedProduct}
        t={t}
        currency={currency}
        onClose={() => setSelectedProductId(null)}
        onBuy={handleBuy}
        onOpenProduct={setSelectedProductId}
      />

      {authOpen && (
        <AuthModal
          t={t}
          initialError={authError}
          onClose={() => {
            setAuthOpen(false);
            setAuthError("");
            setPendingBuyId(null);
          }}
          onAuthenticated={handleAuthenticated}
        />
      )}

      {accountOpen && user && (
        <AccountPanel
          t={t}
          user={user}
          currency={currency}
          onClose={() => setAccountOpen(false)}
          onUserChange={setUser}
        />
      )}

      {cartOpen && user && (
        <CartPanel
          t={t}
          cart={cart}
          currency={currency}
          busy={cartBusy}
          onClose={() => setCartOpen(false)}
          onSetQuantity={(itemId, quantity) => runCartAction(() => setCartQuantity(itemId, Math.max(0, quantity)))}
          onRemove={(itemId) => runCartAction(() => removeFromCart(itemId))}
          onCheckout={handleCheckout}
        />
      )}

      <Footer t={t} />
    </div>
  );
}
