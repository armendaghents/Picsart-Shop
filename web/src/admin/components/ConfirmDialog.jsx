export default function ConfirmDeleteDialog({ item, onCancel, onConfirm, deleting }) {
  if (!item) return null;

  return (
    <div className="modal-overlay" onClick={(event) => event.target === event.currentTarget && onCancel()}>
      <div className="modal confirm-modal">
        <div className="modal-head">
          <h2>Delete item?</h2>
          <button type="button" className="icon-button subtle" onClick={onCancel}>
            ×
          </button>
        </div>
        <p>
          This removes <strong>{item.name}</strong> ({item.sku}) from inventory and the storefront. This can't be undone from
          the admin console.
        </p>
        <div className="modal-actions">
          <button type="button" className="text-button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="command-button command-danger" onClick={onConfirm} disabled={deleting}>
            {deleting ? "Deleting…" : "Delete item"}
          </button>
        </div>
      </div>
    </div>
  );
}
