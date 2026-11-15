"use client";

// La cabecera de una compra (MOM §45): crear y editar. Incluye el alta
// rápida de proveedor, porque una compra necesita uno. Al crear se elige el
// tipo (MOM §45.12): «Importación» o «Compra local (laboratorio / maquila)»;
// una compra local no lleva transporte, paquetera ni guía.
//
// También guarda los controles de Compras en el mundo de operación
// (DESIGN.md): campos de 36 px con anillo fino, botones de 6 px y avisos en el
// lavado de su tono. Con puntero táctil todo sube a 44 px.

import { useEffect, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/components/ui";
import { Badge, Banner, FIELD as OPS_FIELD, FIELD_BOX, SidePanel, opsButtonClass } from "@/components/ops-ui";
import { IconPlus } from "@/components/icons";
import { TRANSPORTS, hasShipping, limaToday, traceCodes, traceMissingText, type HeaderInput, type ImportKind } from "@/lib/compras";
import { createImport, createSupplier, updateImportHeader } from "@/app/dashboard/compras/actions";
import type { ImportRow, SupplierRow } from "@/lib/compras-server";

/** Campo o selector de 36 px a todo el ancho (44 px con puntero táctil). */
export const FIELD = `${OPS_FIELD} pointer-coarse:h-11`;
/** Área de texto: el mismo anillo, sin alto fijo. */
export const TEXTAREA = `${FIELD_BOX} w-full px-3 py-2 leading-5`;
/** Un campo de ancho fijo: `FIELD_BOX` con alto, ancho y relleno (DESIGN.md › Inputs). */
export const fieldBox = (width: string) => cn(FIELD_BOX, "h-9 px-3 pointer-coarse:h-11", width);
/** La etiqueta de un campo: 13 px en `ink-700`, sobre su control. */
export const LABEL = "grid min-w-0 content-start gap-1.5 text-[13px] font-medium leading-5 text-ink-700";
export const BTN_PRIMARY = opsButtonClass("primary", "md", "pointer-coarse:h-11");
export const BTN_SECONDARY = opsButtonClass("secondary", "md", "pointer-coarse:h-11");
export const BTN_SECONDARY_SM = opsButtonClass("secondary", "sm", "pointer-coarse:h-11");
export const BTN_GHOST = opsButtonClass("ghost", "sm", "pointer-coarse:h-11");
export const BTN_DANGER = opsButtonClass("danger", "sm", "pointer-coarse:h-11");
/** «Quitar» en una fila: fantasma que se pone en `crit` al pasar. */
export const BTN_REMOVE = opsButtonClass("ghost", "sm", "text-ink-500 hover:bg-crit-wash hover:text-crit-fg pointer-coarse:h-11");

/** Un campo con su etiqueta, ligados por el `<label>`. */
export function Field({ label, hint, className, children }: { label: ReactNode; hint?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <label className={cn(LABEL, className)}>
      <span>{label}</span>
      {children}
      {hint && <span className="text-xs font-normal text-ink-500">{hint}</span>}
    </label>
  );
}

/** El resultado de una acción: error en `crit`, hecho en `ok`. */
export function Feedback({ error, notice }: { error?: string | null; notice?: string | null }) {
  if (error) {
    return (
      <Banner tone="crit" role="alert">
        <p>{error}</p>
      </Banner>
    );
  }
  if (notice) {
    return (
      <Banner tone="ok" role="status">
        <p>{notice}</p>
      </Banner>
    );
  }
  return null;
}

function SupplierQuickCreate({
  orgId,
  local = false,
  onCreated,
  onCancel,
}: {
  orgId: string;
  /** Un laboratorio o maquila de Perú (compra local). */
  local?: boolean;
  onCreated: (s: SupplierRow) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [country, setCountry] = useState(local ? "Perú" : "China");
  const [whatsapp, setWhatsapp] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="mt-2 space-y-3 rounded-lg bg-wash p-3">
      <p className="text-[13px] font-semibold text-ink-900">{local ? "Nuevo laboratorio o maquila" : "Nuevo proveedor"}</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Nombre">
          <input className={FIELD} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="País">
          <input className={FIELD} value={country} onChange={(e) => setCountry(e.target.value)} />
        </Field>
        <Field label="WhatsApp">
          <input className={FIELD} placeholder={local ? "+51…" : "+86…"} inputMode="tel" value={whatsapp} onChange={(e) => setWhatsapp(e.target.value)} />
        </Field>
      </div>
      <Feedback error={error} />
      <div className="flex flex-wrap gap-2">
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
          {local ? "Crear laboratorio" : "Crear proveedor"}
        </button>
        <button type="button" className={BTN_GHOST} onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </div>
  );
}

/** Formulario de cabecera. Sin `imp` crea (con el tipo elegido); con `imp` edita (el tipo no cambia). */
export function ImportHeaderForm({
  orgId,
  suppliers: initialSuppliers,
  imp,
  kind: newKind = "importacion",
  onDone,
  /** En una columna angosta (el riel del detalle) los campos van uno debajo de otro. */
  narrow = false,
}: {
  orgId: string;
  suppliers: SupplierRow[];
  imp?: ImportRow;
  /** Al crear: importación o compra local (MOM §45.12). */
  kind?: ImportKind;
  onDone?: () => void;
  narrow?: boolean;
}) {
  const router = useRouter();
  const kind: ImportKind = imp?.kind ?? newKind;
  const shipping = hasShipping(kind);
  const [suppliers, setSuppliers] = useState(initialSuppliers);
  const [creatingSupplier, setCreatingSupplier] = useState(false);
  const [form, setForm] = useState<Required<{ [K in keyof HeaderInput]: string }>>({
    supplierId: imp?.supplier_id ?? "",
    origin: imp?.origin ?? (imp ? "" : shipping ? "China" : "Lima"),
    platformOrder: imp?.platform_order ?? "",
    proformaNumber: imp?.proforma_number ?? "",
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
      const res = imp ? await updateImportHeader(imp.id, form) : await createImport(orgId, { ...form, kind });
      if (res.error) return setError(res.error);
      setError(null);
      if (!imp && res.id) router.push(`/dashboard/compras/${res.id}`);
      else router.refresh();
      onDone?.();
    });
  }

  const wide = narrow ? "" : "sm:col-span-2";
  // Los tres códigos de una importación (MOM §45.15), con su «N de 3».
  const codes = traceCodes({ kind, proforma_number: form.proformaNumber, platform_order: form.platformOrder, tracking_number: form.trackingNumber });
  return (
    <div className="space-y-4">
      <div className={cn("grid gap-x-3 gap-y-4", !narrow && "sm:grid-cols-2")}>
        <div className={cn("min-w-0", wide)}>
          <Field label={shipping ? "Proveedor" : "Laboratorio o maquila"}>
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
              <button type="button" className={BTN_SECONDARY} onClick={() => setCreatingSupplier(true)} disabled={creatingSupplier}>
                Nuevo
              </button>
            </div>
          </Field>
          {creatingSupplier && (
            <SupplierQuickCreate
              orgId={orgId}
              local={!shipping}
              onCancel={() => setCreatingSupplier(false)}
              onCreated={(s) => {
                setSuppliers((list) => [...list, s].sort((a, b) => a.name.localeCompare(b.name)));
                setForm((f) => ({ ...f, supplierId: s.id, origin: f.origin || s.country || "" }));
                setCreatingSupplier(false);
              }}
            />
          )}
        </div>
        <Field label="Origen">
          <input className={FIELD} placeholder={shipping ? "China, Yiwu" : "Lima, Ate"} value={form.origin} onChange={set("origin")} />
        </Field>
        {!shipping && (
          <Field label="N.º de orden o cotización">
            <input className={FIELD} value={form.platformOrder} onChange={set("platformOrder")} />
          </Field>
        )}
        {/* Una compra local la entrega el laboratorio: sin transporte, paquetera, guía ni códigos (MOM §45.12, §45.15). */}
        {shipping && (
          <>
            <fieldset className={cn("min-w-0 space-y-3 rounded-lg bg-wash p-3", wide)}>
              <legend className="sr-only">Códigos de trazabilidad</legend>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-[13px] font-semibold text-ink-900">Códigos de trazabilidad</p>
                <Badge tone={codes.missing.length ? "warn" : "ok"} className="tabular-nums">
                  {codes.filled} de {codes.total}
                </Badge>
              </div>
              <div className={cn("grid gap-3", !narrow && "sm:grid-cols-3")}>
                <Field label="Código de la proforma invoice">
                  <input className={cn(FIELD, "font-mono")} placeholder="PI-…" value={form.proformaNumber} onChange={set("proformaNumber")} />
                </Field>
                <Field label="Orden de Alibaba">
                  <input className={cn(FIELD, "font-mono")} value={form.platformOrder} onChange={set("platformOrder")} />
                </Field>
                <Field label="Guía de envío">
                  <input className={cn(FIELD, "font-mono")} placeholder="AWB de DHL…" value={form.trackingNumber} onChange={set("trackingNumber")} />
                </Field>
              </div>
              <p className="text-xs leading-4 text-ink-500">
                {codes.missing.length ? `${traceMissingText(codes.missing)} ` : ""}Para pasar a Pagado hacen falta la proforma y la orden de Alibaba; para
                pasar a En tránsito, también la guía. Con los tres, el costo se puede seguir de punta a punta.
              </p>
            </fieldset>
            <Field label="Transporte">
              <select className={FIELD} value={form.transport} onChange={set("transport")}>
                {TRANSPORTS.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Paquetera">
              <input className={FIELD} placeholder="DHL, FedEx, UPS…" value={form.carrier} onChange={set("carrier")} />
            </Field>
            <Field label="Enlace de seguimiento (opcional)" className={wide}>
              <input className={FIELD} placeholder="https://…" inputMode="url" value={form.trackingUrl} onChange={set("trackingUrl")} />
            </Field>
          </>
        )}
        <Field label="Fecha del pedido">
          <input type="date" className={FIELD} value={form.orderedOn} onChange={set("orderedOn")} />
        </Field>
        <Field label={shipping ? "Llegada estimada" : "Entrega estimada"}>
          <input type="date" className={FIELD} value={form.eta} onChange={set("eta")} />
        </Field>
        {imp && (
          <Field label="Llegó a la bodega">
            <input type="date" className={FIELD} value={form.arrivedOn} onChange={set("arrivedOn")} />
          </Field>
        )}
        <Field label="Notas" className={wide}>
          <textarea className={TEXTAREA} rows={3} value={form.notes} onChange={set("notes")} />
        </Field>
      </div>
      <Feedback error={error} />
      <div className="flex flex-wrap gap-2">
        <button type="button" className={BTN_PRIMARY} disabled={pending} onClick={submit}>
          {pending ? "Guardando…" : imp ? "Guardar datos" : shipping ? "Crear importación" : "Crear compra local"}
        </button>
        {onDone && (
          <button type="button" className={BTN_GHOST} onClick={onDone} disabled={pending}>
            Cancelar
          </button>
        )}
      </div>
    </div>
  );
}

const KIND_CHOICES: { id: ImportKind; label: string; help: string }[] = [
  { id: "importacion", label: "Importación", help: "Del extranjero, en dólares, con guía y aviso a la bodega." },
  { id: "local", label: "Compra local (laboratorio / maquila)", help: "En soles, sin guía; cada entrega con su foto y cada pago con su comprobante." },
];

/** «Nueva compra»: elige el tipo y abre el formulario en un panel lateral. */
export function NewImportButton({ orgId, suppliers }: { orgId: string; suppliers: SupplierRow[] }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<ImportKind>("importacion");
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [open]);
  return (
    <>
      <button type="button" className={BTN_PRIMARY} onClick={() => setOpen(true)} aria-haspopup="dialog">
        <IconPlus aria-hidden />
        Nueva compra
      </button>
      {open && (
        <SidePanel
          label="Nueva compra"
          title="Nueva compra"
          meta={
            kind === "local"
              ? "Laboratorio o maquila y entrega estimada. Productos (en soles), documentos, pagos y entregas se agregan después, en su detalle."
              : "Proveedor, guía y llegada. Productos, documentos y costos se agregan después, en su detalle."
          }
          width="sm:max-w-[640px]"
          onClose={() => setOpen(false)}
        >
          <div className="space-y-4">
            <div role="radiogroup" aria-label="Tipo de compra" className="grid gap-2 sm:grid-cols-2">
              {KIND_CHOICES.map((k) => (
                <button
                  key={k.id}
                  type="button"
                  role="radio"
                  aria-checked={kind === k.id}
                  className={cn(
                    // La tarjeta de elección: el mismo anillo que un chip elegido, con su ayuda debajo.
                    "flex min-h-11 flex-col items-start gap-0.5 rounded-lg px-3 py-2 text-left text-[13px] font-medium transition-shadow",
                    kind === k.id ? "bg-brand-50 text-brand-700 ring-2 ring-inset ring-brand-600" : "bg-white text-ink-700 ring-1 ring-inset ring-line-strong hover:ring-ink-300",
                  )}
                  onClick={() => setKind(k.id)}
                >
                  <span>{k.label}</span>
                  <span className="text-xs font-normal leading-4 text-ink-500">{k.help}</span>
                </button>
              ))}
            </div>
            {/* `key`: al cambiar el tipo, el formulario vuelve a sus valores de ese tipo. */}
            <ImportHeaderForm key={kind} orgId={orgId} suppliers={suppliers} kind={kind} onDone={() => setOpen(false)} />
          </div>
        </SidePanel>
      )}
    </>
  );
}
