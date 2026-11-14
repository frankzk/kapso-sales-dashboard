"use client";

// La cabecera de una importación (MOM §45): crear y editar. Incluye el alta
// rápida de proveedor, porque una importación necesita uno.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { TRANSPORTS, limaToday, type HeaderInput } from "@/lib/compras";
import { createImport, createSupplier, updateImportHeader } from "@/app/dashboard/compras/actions";
import type { ImportRow, SupplierRow } from "@/lib/compras-server";

export const FIELD = "w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-sm text-slate-900 focus:border-brand-500 focus:outline-none";
export const LABEL = "block text-xs font-medium text-slate-600";
export const BTN_PRIMARY =
  "inline-flex h-9 items-center justify-center rounded-md bg-brand-600 px-3 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50";
export const BTN_SECONDARY =
  "inline-flex h-9 items-center justify-center rounded-md border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50";
export const BTN_GHOST = "inline-flex h-8 items-center rounded-md px-2.5 text-sm text-slate-600 hover:bg-slate-50 hover:text-slate-900 disabled:opacity-50";
export const BTN_DANGER =
  "inline-flex h-8 items-center rounded-md border border-red-200 bg-white px-2.5 text-sm text-red-700 hover:bg-red-50 disabled:opacity-50";

export function Feedback({ error, notice }: { error?: string | null; notice?: string | null }) {
  if (error) return <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>;
  if (notice) return <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</p>;
  return null;
}

function SupplierQuickCreate({
  orgId,
  onCreated,
  onCancel,
}: {
  orgId: string;
  onCreated: (s: SupplierRow) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [country, setCountry] = useState("China");
  const [whatsapp, setWhatsapp] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <p className="text-xs font-semibold text-slate-700">Nuevo proveedor</p>
      <div className="grid gap-2 sm:grid-cols-3">
        <input className={FIELD} placeholder="Nombre" value={name} onChange={(e) => setName(e.target.value)} />
        <input className={FIELD} placeholder="País" value={country} onChange={(e) => setCountry(e.target.value)} />
        <input className={FIELD} placeholder="WhatsApp (+86…)" inputMode="tel" value={whatsapp} onChange={(e) => setWhatsapp(e.target.value)} />
      </div>
      <Feedback error={error} />
      <div className="flex gap-2">
        <button
          type="button"
          className={BTN_PRIMARY}
          disabled={pending}
          onClick={() =>
            start(async () => {
              const res = await createSupplier(orgId, { name, country, whatsapp });
              if (res.error || !res.id) return setError(res.error ?? "No se pudo crear.");
              onCreated({ id: res.id, name: name.trim(), country: country.trim() || null, whatsapp: whatsapp.trim() || null, notes: null, contact_name: null, email: null, payment_terms: null });
            })
          }
        >
          Crear proveedor
        </button>
        <button type="button" className={BTN_GHOST} onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </div>
  );
}

/** Formulario de cabecera. Sin `imp` crea; con `imp` edita. */
export function ImportHeaderForm({
  orgId,
  suppliers: initialSuppliers,
  imp,
  onDone,
}: {
  orgId: string;
  suppliers: SupplierRow[];
  imp?: ImportRow;
  onDone?: () => void;
}) {
  const router = useRouter();
  const [suppliers, setSuppliers] = useState(initialSuppliers);
  const [creatingSupplier, setCreatingSupplier] = useState(false);
  const [form, setForm] = useState<Required<{ [K in keyof HeaderInput]: string }>>({
    supplierId: imp?.supplier_id ?? "",
    origin: imp?.origin ?? (imp ? "" : "China"),
    platformOrder: imp?.platform_order ?? "",
    transport: imp?.transport ?? "courier",
    carrier: imp?.carrier ?? "",
    trackingNumber: imp?.tracking_number ?? "",
    trackingUrl: imp?.tracking_url ?? "",
    orderedOn: imp?.ordered_on ?? limaToday(),
    eta: imp?.eta ?? "",
    arrivedOn: imp?.arrived_on ?? "",
    notes: imp?.notes ?? "",
  });
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  function submit() {
    start(async () => {
      const res = imp ? await updateImportHeader(imp.id, form) : await createImport(orgId, form);
      if (res.error) return setError(res.error);
      setError(null);
      if (!imp && res.id) router.push(`/dashboard/compras/${res.id}`);
      else router.refresh();
      onDone?.();
    });
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1 sm:col-span-2">
          <label className={LABEL}>Proveedor</label>
          <div className="flex gap-2">
            <select className={FIELD} value={form.supplierId} onChange={set("supplierId")}>
              <option value="">Sin proveedor</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.country ? ` · ${s.country}` : ""}
                </option>
              ))}
            </select>
            <button type="button" className={BTN_SECONDARY} onClick={() => setCreatingSupplier(true)}>
              Nuevo
            </button>
          </div>
          {creatingSupplier && (
            <SupplierQuickCreate
              orgId={orgId}
              onCancel={() => setCreatingSupplier(false)}
              onCreated={(s) => {
                setSuppliers((list) => [...list, s].sort((a, b) => a.name.localeCompare(b.name)));
                setForm((f) => ({ ...f, supplierId: s.id, origin: f.origin || s.country || "" }));
                setCreatingSupplier(false);
              }}
            />
          )}
        </div>
        <div className="space-y-1">
          <label className={LABEL}>Origen</label>
          <input className={FIELD} placeholder="China, Yiwu" value={form.origin} onChange={set("origin")} />
        </div>
        <div className="space-y-1">
          <label className={LABEL}>N.º de orden (Alibaba u otra)</label>
          <input className={FIELD} value={form.platformOrder} onChange={set("platformOrder")} />
        </div>
        <div className="space-y-1">
          <label className={LABEL}>Transporte</label>
          <select className={FIELD} value={form.transport} onChange={set("transport")}>
            {TRANSPORTS.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <label className={LABEL}>Paquetera</label>
          <input className={FIELD} placeholder="DHL, FedEx, UPS…" value={form.carrier} onChange={set("carrier")} />
        </div>
        <div className="space-y-1">
          <label className={LABEL}>N.º de guía</label>
          <input className={FIELD} value={form.trackingNumber} onChange={set("trackingNumber")} />
        </div>
        <div className="space-y-1">
          <label className={LABEL}>Enlace de seguimiento (opcional)</label>
          <input className={FIELD} placeholder="https://…" inputMode="url" value={form.trackingUrl} onChange={set("trackingUrl")} />
        </div>
        <div className="space-y-1">
          <label className={LABEL}>Fecha del pedido</label>
          <input type="date" className={FIELD} value={form.orderedOn} onChange={set("orderedOn")} />
        </div>
        <div className="space-y-1">
          <label className={LABEL}>Llegada estimada</label>
          <input type="date" className={FIELD} value={form.eta} onChange={set("eta")} />
        </div>
        {imp && (
          <div className="space-y-1">
            <label className={LABEL}>Llegó a la bodega</label>
            <input type="date" className={FIELD} value={form.arrivedOn} onChange={set("arrivedOn")} />
          </div>
        )}
        <div className="space-y-1 sm:col-span-2">
          <label className={LABEL}>Notas</label>
          <textarea className={FIELD} rows={2} value={form.notes} onChange={set("notes")} />
        </div>
      </div>
      <Feedback error={error} />
      <div className="flex flex-wrap gap-2">
        <button type="button" className={BTN_PRIMARY} disabled={pending} onClick={submit}>
          {imp ? "Guardar datos" : "Crear importación"}
        </button>
        {onDone && (
          <button type="button" className={BTN_GHOST} onClick={onDone}>
            Cancelar
          </button>
        )}
      </div>
    </div>
  );
}

/** «Nueva importación»: abre el formulario en la lista. */
export function NewImportButton({ orgId, suppliers }: { orgId: string; suppliers: SupplierRow[] }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button type="button" className={BTN_PRIMARY} onClick={() => setOpen(true)}>
        Nueva importación
      </button>
    );
  }
  return (
    <div className="w-full rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <p className="mb-3 text-sm font-semibold text-slate-900">Nueva importación</p>
      <ImportHeaderForm orgId={orgId} suppliers={suppliers} onDone={() => setOpen(false)} />
    </div>
  );
}
