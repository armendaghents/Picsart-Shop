import { useEffect, useRef, useState } from "react";
import { createItem, updateItem, uploadImages } from "../api";

const STATUS_OPTIONS = ["Available", "Low Stock", "Reserved", "Out of Stock", "In Repair", "Archived"];
const CONDITION_OPTIONS = ["New", "Used"];

const BLANK_FORM = {
  name: "",
  sku: "",
  category: "",
  brand: "",
  model: "",
  warehouse: "",
  location: "",
  status: "Available",
  condition: "New",
  quantity: "0",
  reserved: "0",
  reorderPoint: "5",
  cost: "0",
  price: "0",
  barcode: "",
  serial: "",
  tags: "",
  description: "",
  images: [],
};

function itemToForm(item) {
  return {
    name: item.name || "",
    sku: item.sku || "",
    category: item.category || "",
    brand: item.brand || "",
    model: item.model || "",
    warehouse: item.warehouse || "",
    location: item.location || "",
    status: item.status || "Available",
    condition: item.condition || "New",
    quantity: String(item.quantity ?? 0),
    reserved: String(item.reserved ?? 0),
    reorderPoint: String(item.reorderPoint ?? 5),
    cost: String(item.cost ?? 0),
    price: String(item.price ?? 0),
    barcode: item.barcode || "",
    serial: item.serial || "",
    tags: (item.tags || []).join(", "),
    description: item.description || "",
    images: item.images || [],
  };
}

export default function ItemFormModal({ mode, item, onClose, onSaved }) {
  const [form, setForm] = useState(item ? itemToForm(item) : BLANK_FORM);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef(null);

  useEffect(() => {
    setForm(item ? itemToForm(item) : BLANK_FORM);
    setError("");
  }, [item, mode]);

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function handleImagesPick(event) {
    const files = Array.from(event.target.files || []);
    if (!files.length) return;
    setUploading(true);
    setError("");
    try {
      const { urls } = await uploadImages(files);
      setForm((current) => ({ ...current, images: [...current.images, ...urls] }));
    } catch (uploadError) {
      setError(uploadError.message);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function setAsMain(index) {
    setForm((current) => {
      const images = [...current.images];
      const [chosen] = images.splice(index, 1);
      return { ...current, images: [chosen, ...images] };
    });
  }

  function removePhoto(index) {
    setForm((current) => ({ ...current, images: current.images.filter((_, i) => i !== index) }));
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setSaving(true);
    setError("");

    const payload = {
      ...form,
      tags: form.tags ? form.tags.split(",").map((tag) => tag.trim()).filter(Boolean) : [],
    };

    try {
      if (mode === "edit") {
        await updateItem(item.id, payload);
      } else {
        await createItem(payload);
      }
      onSaved();
    } catch (submitError) {
      setError(submitError.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <form className="modal" onSubmit={handleSubmit}>
        <div className="modal-head">
          <h2>{mode === "edit" ? "Edit inventory item" : "Add inventory item"}</h2>
          <button type="button" className="icon-button subtle" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="photo-gallery-field">
          <div className="photo-gallery-grid">
            {form.images.map((url, index) => (
              <div key={url} className={`photo-gallery-item${index === 0 ? " photo-gallery-main" : ""}`}>
                <img src={url} alt={`Product photo ${index + 1}`} />
                {index === 0 && <span className="photo-gallery-badge">Main</span>}
                <div className="photo-gallery-actions">
                  {index !== 0 && (
                    <button type="button" onClick={() => setAsMain(index)} title="Set as main photo">
                      ★
                    </button>
                  )}
                  <button type="button" onClick={() => removePhoto(index)} title="Remove photo">
                    ×
                  </button>
                </div>
              </div>
            ))}
            <label className="photo-gallery-add">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif"
                multiple
                onChange={handleImagesPick}
                disabled={uploading}
                hidden
              />
              <span>{uploading ? "Uploading…" : "+ Add photos"}</span>
            </label>
          </div>
          <p className="image-upload-hint">
            First photo is the main one shown on the storefront. Click ★ on any other photo to make it the main one. JPG,
            PNG, WEBP, or GIF, up to 5MB each.
          </p>
        </div>

        <div className="modal-grid">
          <label>
            Name
            <input value={form.name} onChange={(e) => update("name", e.target.value)} required placeholder="e.g. Titan Rack Server" />
          </label>
          <label>
            SKU
            <input value={form.sku} onChange={(e) => update("sku", e.target.value)} required placeholder="e.g. SRV-TITAN-01" />
          </label>
          <label>
            Category path
            <input value={form.category} onChange={(e) => update("category", e.target.value)} required placeholder="e.g. Servers > Rack" />
          </label>
          <label>
            Brand
            <input value={form.brand} onChange={(e) => update("brand", e.target.value)} placeholder="e.g. Titan" />
          </label>
          <label>
            Model
            <input value={form.model} onChange={(e) => update("model", e.target.value)} placeholder="e.g. RX-1" />
          </label>
          <label>
            Condition
            <select value={form.condition} onChange={(e) => update("condition", e.target.value)}>
              {CONDITION_OPTIONS.map((condition) => (
                <option key={condition}>{condition}</option>
              ))}
            </select>
          </label>
          <label>
            Warehouse
            <input value={form.warehouse} onChange={(e) => update("warehouse", e.target.value)} required placeholder="e.g. West Hub" />
          </label>
          <label>
            Location code
            <input value={form.location} onChange={(e) => update("location", e.target.value)} required placeholder="e.g. A-01-01" />
          </label>
          <label>
            Status
            <select value={form.status} onChange={(e) => update("status", e.target.value)}>
              {STATUS_OPTIONS.map((status) => (
                <option key={status}>{status}</option>
              ))}
            </select>
          </label>
          <label>
            Quantity
            <input type="number" min="0" value={form.quantity} onChange={(e) => update("quantity", e.target.value)} />
          </label>
          <label>
            Reserved
            <input type="number" min="0" value={form.reserved} onChange={(e) => update("reserved", e.target.value)} />
          </label>
          <label>
            Reorder point
            <input type="number" min="0" value={form.reorderPoint} onChange={(e) => update("reorderPoint", e.target.value)} />
          </label>
          <label>
            Cost price
            <input type="number" min="0" step="0.01" value={form.cost} onChange={(e) => update("cost", e.target.value)} />
          </label>
          <label>
            Selling price
            <input type="number" min="0" step="0.01" value={form.price} onChange={(e) => update("price", e.target.value)} />
          </label>
          <label>
            Barcode
            <input value={form.barcode} onChange={(e) => update("barcode", e.target.value)} placeholder="optional" />
          </label>
          <label>
            Serial number
            <input value={form.serial} onChange={(e) => update("serial", e.target.value)} placeholder="optional" />
          </label>
          <label className="span-2">
            Tags (comma separated)
            <input value={form.tags} onChange={(e) => update("tags", e.target.value)} placeholder="e.g. server, rack, compute" />
          </label>
          <label className="span-2">
            Description
            <textarea rows="2" value={form.description} onChange={(e) => update("description", e.target.value)} placeholder="Customer-facing description" />
          </label>
        </div>

        {error && <p className="modal-error">{error}</p>}

        <div className="modal-actions">
          <button type="button" className="text-button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="command-button" disabled={saving || uploading}>
            {saving ? "Saving…" : "Save item"}
          </button>
        </div>
      </form>
    </div>
  );
}
