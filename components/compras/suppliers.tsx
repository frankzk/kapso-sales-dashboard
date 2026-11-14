"use client";

// La tabla de proveedores (MOM §45.7). Las estadísticas llegan calculadas del
// servidor (lib/compras-reportes.ts); «Comprado» solo viene con «Montos de
// compras». Crear, editar y borrar solo con «Compras» (y el servidor lo vuelve
// a pedir).

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, EmptyState, cn } from "@/components/ui";
import { formatDmy, whatsappShareUrl, type SupplierInput } from "@/lib/compras";
import { onTimeIsLow, shortageIsHigh, type SupplierStats } from "@/lib/compras-reportes";
import type { SupplierRow } from "@/lib/compras-server";
import { createSupplier, deleteSupplier, updateSupplier, type ComprasActionState } from "@/app/dashboard/compras/actions";
import { BTN_DANGER, BTN_GHOST, BTN_PRIMARY, BTN_SECONDARY, FIELD, Feedback, LABEL } from "@/components/compras/header-form";
import { fmtInt, fmtPct, fmtPen, fmtUsd } from "@/components/compras/format";

export interface SupplierViewRow {
  supplier: SupplierRow;
  stats: SupplierStats;
}

type FormState = { mode: "new" } | { mode: "edit"; supplier: SupplierRow } | null;

function SupplierForm({
  orgId,
  supplier,
  onDone,
}: {
  orgId: string;
  supplier: SupplierRow | null;
  onDone: (res: ComprasActionState) => void;
}) {
  const [v, setV] = useState<Required<{ [K in keyof SupplierInput]: string }>>({
    name: supplier?.name ?? "",
    country: supplier?.country ?? (supplier ? "" : "China"),
    whatsapp: supplier?.whatsapp ?? "",
    notes: supplier?.notes ?? "",
    contactName: supplier?.contact_name ?? "",
    email: supplier?.email ?? "",
    paymentTerms: supplier?.payment_terms ?? "",
  });
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((prev) => ({ ...prev, [k]: e.target.value }));
  return (
    <Card className="space-y-3 p-4">
      <h2 className="text-sm font-semibold text-slate-900">{supplier ? `Editar «${supplier.name}»` : "Nuevo proveedor"}</h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label className={LABEL}>
          Nombre
          <input className={FIELD} value={v.name} onChange={set("name")} maxLength={120} required />
        </label>
        <label className={LABEL}>
          País / origen
          <input className={FIELD} value={v.country} onChange={set("country")} maxLength={80} />
        </label>
        <label className={LABEL}>
          Condiciones de pago
          <input className={FIELD} value={v.paymentTerms} onChange={set("paymentTerms")} maxLength={200} placeholder="30 % adelanto, 70 % al embarque" />
        </label>
        <label className={LABEL}>
          Contacto
          <input className={FIELD} value={v.contactName} onChange={set("contactName")} maxLength={120} />
        </label>
        <label className={LABEL}>
          WhatsApp
          <input className={FIELD} value={v.whatsapp} onChange={set("whatsapp")} inputMode="tel" placeholder="+86…" />
        </label>
        <label className={LABEL}>
          Correo
          <input className={FIELD} value={v.email} onChange={set("email")} type="email" inputMode="email" maxLength={160} />
        </label>
        <label className={cn(LABEL, "sm:col-span-2 lg:col-span-3")}>
          Notas
          <textarea className={FIELD} rows={2} value={v.notes} onChange={set("notes")} maxLength={1000} />
        </label>
      </div>
      <Feedback error={error} />
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={BTN_PRIMARY}
          disabled={pending}
          onClick={() =>
            start(async () => {
              const res = supplier ? await updateSupplier(supplier.id, v) : await createSupplier(orgId, v);
              if (res.error) return setError(res.error);
              onDone(res);
            })
          }
        >
          {supplier ? "Guardar" : "Crear proveedor"}
        </button>
        <button type="button" className={BTN_GHOST} onClick={() => onDone({})} disabled={pending}>
          Cancelar
        </button>
      </div>
    </Card>
  );
}

const TH = "px-3 py-2 text-left text-xs font-medium text-slate-500";
const TD = "px-3 py-2.5 align-top text-sm text-slate-700";

export function SuppliersView({
  orgId,
  orgQuery,
  rows,
  canManage,
  canMoney,
}: {
  orgId: string;
  orgQuery: string;
  rows: SupplierViewRow[];
  canManage: boolean;
  canMoney: boolean;
}) {
  const router = useRouter();
  const [form, setForm] = useState<FormState>(null);
  const [feedback, setFeedback] = useState<ComprasActionState | null>(null);
  const [pending, start] = useTransition();

  const done = (res: ComprasActionState) => {
    setForm(null);
    if (res.notice || res.error) setFeedback(res);
    if (res.notice) router.refresh();
  };

  const remove = (s: SupplierRow) => {
    if (!window.confirm(`¿Borrar el proveedor «${s.name}»?`)) return;
    start(async () => {
      const res = await deleteSupplier(s.id);
      setFeedback(res);
      if (!res.error) router.refresh();
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-500">
          {rows.length} proveedor{rows.length === 1 ? "" : "es"}
        </p>
        {canManage && !form && (
          <button type="button" className={BTN_PRIMARY} onClick={() => setForm({ mode: "new" })}>
            Nuevo proveedor
          </button>
        )}
      </div>
      {feedback && <Feedback error={feedback.error} notice={feedback.notice} />}
      {canManage && form && (
        <SupplierForm key={form.mode === "edit" ? form.supplier.id : "new"} orgId={orgId} supplier={form.mode === "edit" ? form.supplier : null} onDone={done} />
      )}

      {!rows.length ? (
        <EmptyState title="Sin proveedores">
          {canManage ? "Crea uno con «Nuevo proveedor» o desde el formulario de una importación." : "Cuando se registre uno, aparecerá aquí."}
        </EmptyState>
      ) : (
        <Card className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[960px] text-sm">
              <thead className="border-b border-slate-200 bg-slate-50">
                <tr>
                  <th className={TH}>Proveedor</th>
                  <th className={TH}>Condiciones de pago</th>
                  <th className={TH}>Contacto</th>
                  <th className={TH}>Importaciones</th>
                  <th className={cn(TH, "text-right")}>Tarda</th>
                  <th className={cn(TH, "text-right")}>A tiempo</th>
                  <th className={cn(TH, "text-right")}>Faltantes y dañadas</th>
                  {canMoney && <th className={cn(TH, "text-right")}>Comprado (USD)</th>}
                  <th className={TH}>Le compras</th>
                  {canManage && <th className={TH}>
                    <span className="sr-only">Acciones</span>
                  </th>}
                </tr>
              </thead>
              <tbody>
                {rows.map(({ supplier: s, stats }) => (
                  <tr key={s.id} className="border-b border-slate-100 last:border-0">
                    <td className={TD}>
                      <p className="font-medium text-slate-900">{s.name}</p>
                      <p className="text-xs text-slate-500">{s.country ?? "Origen sin indicar"}</p>
                    </td>
                    <td className={cn(TD, "max-w-[180px]")}>{s.payment_terms ?? <span className="text-slate-400">—</span>}</td>
                    <td className={cn(TD, "max-w-[200px] space-y-0.5")}>
                      {s.contact_name && <p className="truncate">{s.contact_name}</p>}
                      {s.whatsapp && (
                        <p className="truncate text-xs">
                          <a href={whatsappShareUrl("", s.whatsapp)} target="_blank" rel="noopener noreferrer" className="text-brand-700 hover:underline">
                            WhatsApp {s.whatsapp}
                          </a>
                        </p>
                      )}
                      {s.email && (
                        <p className="truncate text-xs">
                          <a href={`mailto:${s.email}`} className="text-brand-700 hover:underline">
                            {s.email}
                          </a>
                        </p>
                      )}
                      {!s.contact_name && !s.whatsapp && !s.email && <span className="text-slate-400">—</span>}
                    </td>
                    <td className={TD}>
                      {stats.imports ? (
                        <Link href={`/dashboard/compras?v=todas&proveedor=${s.id}${orgQuery}`} className="font-medium text-brand-700 hover:underline">
                          {fmtInt(stats.imports)}
                        </Link>
                      ) : (
                        <span className="text-slate-400">0</span>
                      )}
                      {stats.imports > 0 && (
                        <p className="text-xs text-slate-500">
                          {fmtInt(stats.bought)} comprada{stats.bought === 1 ? "" : "s"} · última {formatDmy(stats.lastOrderedOn)}
                        </p>
                      )}
                    </td>
                    <td className={cn(TD, "text-right")}>
                      {stats.avgLeadDays != null ? (
                        <span title={`Promedio de ${stats.leadSamples} que llegaron`}>{Math.round(stats.avgLeadDays)} días</span>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                    <td className={cn(TD, "text-right", onTimeIsLow(stats.onTimeShare) && "font-semibold text-red-700")}>
                      {stats.onTimeShare != null ? (
                        <span title={`De ${stats.onTimeSamples} con llegada estimada`}>{fmtPct(stats.onTimeShare)}</span>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                    <td className={cn(TD, "text-right", shortageIsHigh(stats.shortageShare) && "font-semibold text-red-700")}>
                      {stats.shortageShare != null ? fmtPct(stats.shortageShare) : <span className="text-slate-400">—</span>}
                    </td>
                    {canMoney && (
                      <td className={cn(TD, "text-right")}>
                        <p className="font-medium text-slate-900">{fmtUsd(stats.boughtUsd ?? 0)}</p>
                        {(stats.boughtPen ?? 0) > 0 && (
                          <p className="text-xs text-slate-500">
                            {fmtPen(stats.boughtPen)}
                            {stats.boughtWithoutFx ? ` · ${stats.boughtWithoutFx} sin tipo de cambio` : ""}
                          </p>
                        )}
                      </td>
                    )}
                    <td className={cn(TD, "max-w-[220px]")}>
                      {stats.topProducts.length ? (
                        <ul className="space-y-0.5 text-xs">
                          {stats.topProducts.map((p) => (
                            <li key={p.key} className="truncate">
                              {fmtInt(p.units)} × {p.name}
                              {p.sku ? <span className="text-slate-400"> · {p.sku}</span> : null}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                    {canManage && (
                      <td className={cn(TD, "whitespace-nowrap text-right")}>
                        <div className="flex justify-end gap-1.5">
                          <button type="button" className={BTN_SECONDARY} disabled={pending} onClick={() => setForm({ mode: "edit", supplier: s })}>
                            Editar
                          </button>
                          <button
                            type="button"
                            className={BTN_DANGER}
                            disabled={pending || stats.imports > 0}
                            title={stats.imports > 0 ? "Tiene importaciones: no se puede borrar" : undefined}
                            onClick={() => remove(s)}
                          >
                            Borrar
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
