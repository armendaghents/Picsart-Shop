import { useEffect, useMemo, useState } from "react";
import Sidebar from "./components/Sidebar";
import AdminHeader from "./components/AdminHeader";
import SearchConsole from "./components/SearchConsole";
import Dashboard from "./components/Dashboard";
import FiltersSidebar from "./components/FiltersSidebar";
import InventoryResults from "./components/InventoryResults";
import InsightsPanel from "./components/InsightsPanel";
import ItemFormModal from "./components/ItemFormModal";
import ConfirmDeleteDialog from "./components/ConfirmDialog";
import { fetchDashboard, fetchFacets, fetchInventory, deleteItem } from "./api";
import { useDebouncedValue } from "../hooks/useDebouncedValue";

const DEFAULT_FILTERS = { category: "All", warehouse: "All", status: "All", maxPrice: 10000 };

export default function AdminApp() {
  const [dark, setDark] = useState(false);
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [sort, setSort] = useState("relevance");

  const [facets, setFacets] = useState({ categories: [], warehouses: [], statuses: [] });
  const [dashboard, setDashboard] = useState({});
  const [items, setItems] = useState([]);
  const [searchCount, setSearchCount] = useState(() => Number(sessionStorage.getItem("atlasSearchCount") || 0));

  const [formModal, setFormModal] = useState(null); // { mode: 'add' | 'edit', item? }
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const debouncedQuery = useDebouncedValue(query, 200);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  function loadFacets() {
    fetchFacets()
      .then(setFacets)
      .catch((error) => console.error("Facet load failed", error));
  }

  function loadDashboard() {
    fetchDashboard()
      .then(setDashboard)
      .catch((error) => console.error("Dashboard load failed", error));
  }

  useEffect(() => {
    loadFacets();
    loadDashboard();
  }, []);

  const previousQuery = useMemo(() => ({ current: "" }), []);
  useEffect(() => {
    if (!previousQuery.current && debouncedQuery) {
      const next = searchCount + 1;
      setSearchCount(next);
      sessionStorage.setItem("atlasSearchCount", String(next));
    }
    previousQuery.current = debouncedQuery;
  }, [debouncedQuery]);

  useEffect(() => {
    fetchInventory({
      q: debouncedQuery,
      category: filters.category,
      warehouse: filters.warehouse,
      status: filters.status,
      maxPrice: filters.maxPrice,
      sort,
    })
      .then((data) => setItems(data.items || []))
      .catch((error) => {
        console.error("Search failed", error);
        setItems([]);
      });
  }, [debouncedQuery, filters, sort]);

  function refreshAfterChange() {
    loadFacets();
    loadDashboard();
    fetchInventory({
      q: query,
      category: filters.category,
      warehouse: filters.warehouse,
      status: filters.status,
      maxPrice: filters.maxPrice,
      sort,
    }).then((data) => setItems(data.items || []));
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
      <Sidebar resultCount={dashboard.item_count || 0} />

      <main className="workspace">
        <AdminHeader dark={dark} onToggleDark={() => setDark((value) => !value)} onAddItem={() => setFormModal({ mode: "add" })} />

        <SearchConsole query={query} onQueryChange={setQuery} />

        <Dashboard dashboard={dashboard} searchCount={searchCount} />

        <section className="content-grid">
          <FiltersSidebar
            facets={facets}
            filters={filters}
            onChange={(patch) => setFilters((current) => ({ ...current, ...patch }))}
            onReset={() => setFilters(DEFAULT_FILTERS)}
            items={items}
          />

          <InventoryResults
            items={items}
            query={query}
            sort={sort}
            onSortChange={setSort}
            onEdit={(item) => setFormModal({ mode: "edit", item })}
            onDelete={setDeleteTarget}
          />

          <InsightsPanel items={items} />
        </section>
      </main>

      {formModal && (
        <ItemFormModal
          mode={formModal.mode}
          item={formModal.item}
          onClose={() => setFormModal(null)}
          onSaved={() => {
            setFormModal(null);
            refreshAfterChange();
          }}
        />
      )}

      <ConfirmDeleteDialog item={deleteTarget} onCancel={() => setDeleteTarget(null)} onConfirm={confirmDelete} deleting={deleting} />
    </div>
  );
}
