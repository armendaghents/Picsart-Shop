import { useEffect, useRef, useState } from "react";
import Sidebar from "./components/Sidebar";
import AdminHeader from "./components/AdminHeader";
import SearchConsole from "./components/SearchConsole";
import Dashboard from "./components/Dashboard";
import FiltersSidebar from "./components/FiltersSidebar";
import InventoryResults from "./components/InventoryResults";
import AnalyticsPanel from "./components/AnalyticsPanel";
import ItemFormModal from "./components/ItemFormModal";
import ConfirmDeleteDialog from "./components/ConfirmDialog";
import Pagination from "../components/Pagination";
import { fetchDashboard, fetchFacets, fetchInventory, deleteItem } from "./api";
import { useDebouncedValue } from "../hooks/useDebouncedValue";

const DEFAULT_FILTERS = { category: "All", warehouse: "All", status: "All", model: "All", maxPrice: 10000 };
const PAGE_SIZE = 5;

export default function AdminApp() {
  const [dark, setDark] = useState(false);
  const [view, setView] = useState("search");
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [sort, setSort] = useState("relevance");

  const [facets, setFacets] = useState({ categories: [], warehouses: [], statuses: [], models: [] });
  const [dashboard, setDashboard] = useState({});
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  const [formModal, setFormModal] = useState(null); // { mode: 'add' | 'edit', item? }
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const debouncedQuery = useDebouncedValue(query, 200);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  function loadFacets() {
    fetchFacets(filters.category)
      .then(setFacets)
      .catch((error) => console.error("Facet load failed", error));
  }

  function loadDashboard() {
    fetchDashboard()
      .then(setDashboard)
      .catch((error) => console.error("Dashboard load failed", error));
  }

  useEffect(() => {
    loadDashboard();
  }, []);

  // Re-scope the model list whenever the selected category changes (e.g.
  // picking "Camera" should only offer camera models).
  useEffect(() => {
    loadFacets();
  }, [filters.category]);

  // Changing a filter/sort/query should jump back to page 1. Tracked via ref
  // (rather than a separate effect calling setPage) so a filter change never
  // fires two competing requests for two different pages.
  const filtersSignature = JSON.stringify([debouncedQuery, filters, sort]);
  const previousFiltersSignature = useRef(filtersSignature);

  useEffect(() => {
    const filtersChanged = previousFiltersSignature.current !== filtersSignature;
    previousFiltersSignature.current = filtersSignature;
    const requestedPage = filtersChanged ? 1 : page;
    if (filtersChanged && page !== 1) setPage(1);

    fetchInventory({
      q: debouncedQuery,
      category: filters.category,
      warehouse: filters.warehouse,
      status: filters.status,
      model: filters.model,
      maxPrice: filters.maxPrice,
      sort,
      page: requestedPage,
      pageSize: PAGE_SIZE,
    })
      .then((data) => {
        setItems(data.items || []);
        setTotal(data.total || 0);
        setTotalPages(data.totalPages || 1);
        if (data.page && data.page !== requestedPage) setPage(data.page);
      })
      .catch((error) => {
        console.error("Search failed", error);
        setItems([]);
        setTotal(0);
        setTotalPages(1);
      });
  }, [filtersSignature, page]);

  function refreshAfterChange({ resetPage = false, sortOverride } = {}) {
    loadFacets();
    loadDashboard();
    const requestedPage = resetPage ? 1 : page;
    const requestedSort = sortOverride || sort;
    if (resetPage && page !== 1) setPage(1);
    // A brand-new item (0 stock) still sorts toward the bottom under the
    // default relevance sort (ties break on stock descending), so landing on
    // page 1 alone doesn't guarantee it's visible — force "recent" too.
    if (sortOverride && sortOverride !== sort) setSort(sortOverride);
    fetchInventory({
      q: query,
      category: filters.category,
      warehouse: filters.warehouse,
      status: filters.status,
      model: filters.model,
      maxPrice: filters.maxPrice,
      sort: requestedSort,
      page: requestedPage,
      pageSize: PAGE_SIZE,
    }).then((data) => {
      setItems(data.items || []);
      setTotal(data.total || 0);
      setTotalPages(data.totalPages || 1);
      if (data.page && data.page !== requestedPage) setPage(data.page);
    });
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteItem(deleteTarget.id);
      setDeleteTarget(null);
      refreshAfterChange();
    } catch (error) {
      console.error("Delete failed", error);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="app">
      <Sidebar activeView={view} onNavigate={setView} />

      <main className="workspace">
        <AdminHeader dark={dark} onToggleDark={() => setDark((value) => !value)} onAddItem={() => setFormModal({ mode: "add" })} />

        {view === "analytics" ? (
          <AnalyticsPanel />
        ) : (
          <>
            <SearchConsole query={query} onQueryChange={setQuery} />

            <Dashboard dashboard={dashboard} />

            <section className="content-grid">
              <FiltersSidebar
                facets={facets}
                filters={filters}
                onChange={(patch) =>
                  setFilters((current) => ({
                    ...current,
                    ...patch,
                    ...(patch.category && patch.category !== current.category ? { model: "All" } : {}),
                  }))
                }
                onReset={() => setFilters(DEFAULT_FILTERS)}
              />

              <InventoryResults
                items={items}
                total={total}
                query={query}
                sort={sort}
                onSortChange={setSort}
                onEdit={(item) => setFormModal({ mode: "edit", item })}
                onDelete={setDeleteTarget}
                page={page}
                totalPages={totalPages}
                onPageChange={setPage}
              />
            </section>
          </>
        )}
      </main>

      {formModal && (
        <ItemFormModal
          mode={formModal.mode}
          item={formModal.item}
          onClose={() => setFormModal(null)}
          onSaved={() => {
            const wasAdd = formModal.mode === "add";
            setFormModal(null);
            refreshAfterChange({ resetPage: wasAdd, sortOverride: wasAdd ? "recent" : undefined });
          }}
        />
      )}

      <ConfirmDeleteDialog item={deleteTarget} onCancel={() => setDeleteTarget(null)} onConfirm={confirmDelete} deleting={deleting} />
    </div>
  );
}
