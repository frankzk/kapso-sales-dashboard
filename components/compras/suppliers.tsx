"use client";

// La tabla de proveedores (MOM §45.7). Las estadísticas llegan calculadas del
// servidor (lib/compras-reportes.ts); «Comprado» solo viene con «Montos de
// compras». Crear, editar y borrar solo con «Compras» (y el servidor lo vuelve
// a pedir).

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { cn } from "@/components/ui";
import { SECTION_CARD, SectionHead } from "@/components/ops-ui";
import { IconPlus, IconWhatsApp } from "@/components/icons";
import { ComprasEmpty } from "@/components/compras/chrome";
import { formatDmy, whatsappShareUrl, type SupplierInput } from "@/lib/compras";
import { onTimeIsLow, shortageIsHigh, type SupplierStats } from "@/lib/compras-reportes";
import type { SupplierRow } from "@/lib/compras-server";
import { createSupplier, deleteSupplier, updateSupplier, type ComprasActionState } from "@/app/dashboard/compras/actions";
import { BTN_GHOST, BTN_PRIMARY, BTN_REMOVE, BTN_SECONDARY_SM, FIELD, Feedback, Field, TEXTAREA } from "@/components/compras/header-form";
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
    <section aria-labelledby="proveedor-form-t" className={cn(SECTION_CARD, "space-y-4")}>
      <SectionHead id="proveedor-form-t" title={supplier ? `Editar «${supplier.name}»` : "Nuevo proveedor"} />
      <div className="grid gap-x-3 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Nombre">
          <input className={FIELD} value={v.name} onChange={set("name")} maxLength={120} required />
        </Field>
        <Field label="País / origen">
          <input className={FIELD} value={v.country} onChange={set("country")} maxLength={80} />
        </Field>
        <Field label="Condiciones de pago">
          <input className={FIELD} value={v.paymentTerms} onChange={set("paymentTerms")} maxLength={200} placeholder="30 % adelanto, 70 % al embarque" />
        </Field>
        <Field label="Contacto">
          <input className={FIELD} value={v.contactName} onChange={set("contactName")} maxLength={120} />
        </Field>
        <Field label="WhatsApp">
          <input className={FIELD} value={v.whatsapp} onChange={set("whatsapp")} inputMode="tel" placeholder="+86…" />
        </Field>
        <Field label="Correo">
          <input className={FIELD} value={v.email} onChange={set("email")} type="email" inputMode="email" maxLength={160} />
        </Field>
        <Field label="Notas" className="sm:col-span-2 lg:col-span-3">
          <textarea className={TEXTAREA} rows={2} value={v.notes} onChange={set("notes")} maxLength={1000} />
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
    </section>
  );
}

const TH = "sticky top-0 z-[1] border-y border-line bg-white py-2 pr-3 text-left text-xs font-semibold text-ink-600";
const TD = "py-2.5 pr-3 align-top text-sm leading-5 text-ink-700";
const DASH = <span className="text-ink-300">—</span>;

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

  const actions = (s: SupplierRow, stats: SupplierStats) => (
    <div className="flex gap-1">
      <button type="button" className={BTN_SECONDARY_SM} disabled={pending} onClick={() => setForm({ mode: "edit", supplier: s })}>
        Editar
      </button>
      <button
        type="button"
        className={BTN_REMOVE}
        disabled={pending || stats.imports > 0}
        title={stats.imports > 0 ? "Tiene importaciones: no se puede borrar" : undefined}
        onClick={() => remove(s)}
      >
        Borrar
      </button>
    </div>
  );

  const importsLink = (s: SupplierRow, stats: SupplierStats) =>
    stats.imports ? (
      <Link href={`/dashboard/compras?v=todas&proveedor=${s.id}${orgQuery}`} className="font-medium tabular-nums text-brand-700 hover:underline">
        {fmtInt(stats.imports)} importaci{stats.imports === 1 ? "ón" : "ones"}
      </Link>
    ) : (
      <span className="text-ink-500">Sin importaciones</span>
    );

  return (
    <div className="space-y-4">
      {feedback && <Feedback error={feedback.error} notice={feedback.notice} />}
      {canManage && form && (
        <SupplierForm key={form.mode === "edit" ? form.supplier.id : "new"} orgId={orgId} supplier={form.mode === "edit" ? form.supplier : null} onDone={done} />
      )}

      <section aria-label="Proveedores" className="overflow-hidden rounded-lg bg-white shadow-control ring-1 ring-line">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 sm:px-5">
          <p className="text-[13px] leading-5 tabular-nums text-ink-500">
            {fmtInt(rows.length)} proveedor{rows.length === 1 ? "" : "es"}
          </p>
          {canManage && !form && (
            <button type="button" className={BTN_PRIMARY} onClick={() => setForm({ mode: "new" })}>
              <IconPlus aria-hidden />
              Nuevo proveedor
            </button>
          )}
        </div>
        {!rows.length ? (
          <div className="border-t border-line">
            <ComprasEmpty title="Sin proveedores">
              {canManage ? "Crea uno con «Nuevo proveedor» o desde el formulario de una importación." : "Cuando se registre uno, aparecerá aquí."}
            </ComprasEmpty>
          </div>
        ) : (
          <>
            <table className="hidden w-full table-fixed text-left xl:table">
              <thead>
                <tr>
                  <th className={cn(TH, "w-[16%] pl-5")}>Proveedor</th>
                  <th className={cn(TH, "w-[14%]")}>Contacto</th>
                  <th className={cn(TH, "w-[12%]")}>Importaciones</th>
                  <th className={cn(TH, "w-[6%] text-right")}>Tarda</th>
                  <th className={cn(TH, "w-[7%] text-right")}>A tiempo</th>
                  <th className={cn(TH, "w-[9%] text-right")}>Faltantes y dañadas</th>
                  {canMoney && <th className={cn(TH, "w-[10%] text-right")}>Comprado (USD)</th>}
                  <th className={cn(TH, "pl-3")}>Le compras</th>
                  {canManage && <th className={cn(TH, "w-[136px] pr-5")}>
                    <span className="sr-only">Acciones</span>
                  </th>}
                </tr>
              </thead>
              <tbody>
                {rows.map(({ supplier: s, stats }) => (
                  <tr key={s.id} className="border-b border-line transition-colors duration-150 last:border-0 hover:bg-wash">
                    <td className={cn(TD, "pl-5")}>
                      <p className="font-medium text-ink-900">{s.name}</p>
                      <p className="truncate text-[13px] text-ink-500">{s.country ?? "Origen sin indicar"}</p>
                      {s.payment_terms && (
                        <p className="mt-0.5 line-clamp-2 text-[13px] text-ink-600" title="Condiciones de pago">
                          {s.payment_terms}
                        </p>
                      )}
                    </td>
                    <td className={cn(TD, "space-y-0.5")}>
                      {s.contact_name && <p className="truncate text-ink-900">{s.contact_name}</p>}
                      {s.whatsapp && (
                        <p className="text-[13px]">
                          <a href={whatsappShareUrl("", s.whatsapp)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-brand-700 hover:underline" aria-label={`WhatsApp ${s.whatsapp}`}>
                            <IconWhatsApp aria-hidden className="size-3.5 shrink-0" />
                            <span className="break-all tabular-nums">{s.whatsapp}</span>
                          </a>
                        </p>
                      )}
                      {s.email && (
                        <p className="break-all text-[13px]">
                          <a href={`mailto:${s.email}`} className="text-brand-700 hover:underline">
                            {s.email}
                          </a>
                        </p>
                      )}
                      {!s.contact_name && !s.whatsapp && !s.email && DASH}
                    </td>
                    <td className={TD}>
                      {importsLink(s, stats)}
                      {stats.imports > 0 && (
                        <p className="text-[13px] tabular-nums text-ink-500">
                          {fmtInt(stats.bought)} comprada{stats.bought === 1 ? "" : "s"} · última {formatDmy(stats.lastOrderedOn)}
                        </p>
                      )}
                    </td>
                    <td className={cn(TD, "text-right tabular-nums text-ink-900")}>
                      {stats.avgLeadDays != null ? <span title={`Promedio de ${stats.leadSamples} que llegaron`}>{Math.round(stats.avgLeadDays)} días</span> : DASH}
                    </td>
                    <td className={cn(TD, "text-right tabular-nums text-ink-900")}>
                      {stats.onTimeShare != null ? <Share value={stats.onTimeShare} bad={onTimeIsLow(stats.onTimeShare)} badLabel="bajo" title={`De ${stats.onTimeSamples} con llegada estimada`} /> : DASH}
                    </td>
                    <td className={cn(TD, "text-right tabular-nums text-ink-900")}>
                      {stats.shortageShare != null ? <Share value={stats.shortageShare} bad={shortageIsHigh(stats.shortageShare)} badLabel="alto" /> : DASH}
                    </td>
                    {canMoney && (
                      <td className={cn(TD, "text-right tabular-nums")}>
                        <p className="whitespace-nowrap font-medium text-ink-900">{fmtUsd(stats.boughtUsd ?? 0)}</p>
                        {(stats.boughtPen ?? 0) > 0 && (
                          <p className="text-[13px] text-ink-500">
                            {fmtPen(stats.boughtPen)}
                            {stats.boughtWithoutFx ? ` · ${stats.boughtWithoutFx} sin tipo de cambio` : ""}
                          </p>
                        )}
                      </td>
                    )}
                    <td className={cn(TD, "pl-3")}>
                      <TopProducts stats={stats} />
                    </td>
                    {canManage && <td className={cn(TD, "py-2 pr-5")}>{actions(s, stats)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>

            <ul className="divide-y divide-line border-t border-line xl:hidden">
              {rows.map(({ supplier: s, stats }) => (
                <li key={s.id} className="px-4 py-3 sm:px-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold leading-5 text-ink-900">{s.name}</p>
                      <p className="text-[13px] leading-5 text-ink-500">
                        {s.country ?? "Origen sin indicar"}
                        {s.payment_terms ? ` · ${s.payment_terms}` : ""}
                      </p>
                    </div>
                    {canMoney && <p className="shrink-0 text-sm font-medium leading-5 tabular-nums text-ink-900">{fmtUsd(stats.boughtUsd ?? 0)}</p>}
                  </div>
                  <p className="mt-1 text-[13px] leading-5 tabular-nums text-ink-700">
                    {importsLink(s, stats)}
                    {stats.avgLeadDays != null && ` · tarda ${Math.round(stats.avgLeadDays)} días`}
                    {stats.onTimeShare != null && (
                      <>
                        {" · a tiempo "}
                        <Share value={stats.onTimeShare} bad={onTimeIsLow(stats.onTimeShare)} badLabel="bajo" />
                      </>
                    )}
                    {stats.shortageShare != null && (
                      <>
                        {" · faltantes "}
                        <Share value={stats.shortageShare} bad={shortageIsHigh(stats.shortageShare)} badLabel="alto" />
                      </>
                    )}
                  </p>
                  {(s.contact_name || s.whatsapp || s.email) && (
                    <p className="mt-0.5 flex flex-wrap gap-x-3 text-[13px] leading-5">
                      {s.contact_name && <span className="text-ink-700">{s.contact_name}</span>}
                      {s.whatsapp && (
                        <a href={whatsappShareUrl("", s.whatsapp)} target="_blank" rel="noopener noreferrer" className="text-brand-700 hover:underline">
                          WhatsApp {s.whatsapp}
                        </a>
                      )}
                      {s.email && (
                        <a href={`mailto:${s.email}`} className="break-all text-brand-700 hover:underline">
                          {s.email}
                        </a>
                      )}
                    </p>
                  )}
                  {stats.topProducts.length > 0 && (
                    <div className="mt-1.5">
                      <TopProducts stats={stats} />
                    </div>
                  )}
                  {canManage && (
                    <div className="-ml-2.5 mt-2">{actions(s, stats)}</div>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}

/** Un porcentaje; en `crit` cuando cruza su umbral, y el lector oye por qué (el color no es la única señal). */
function Share({ value, bad, badLabel, title }: { value: number; bad: boolean; badLabel: string; title?: string }) {
  return (
    <span title={title} className={cn("tabular-nums", bad && "font-semibold text-crit-fg")}>
      {fmtPct(value)}
      {bad && <span className="sr-only"> ({badLabel})</span>}
    </span>
  );
}

function TopProducts({ stats }: { stats: SupplierStats }) {
  if (!stats.topProducts.length) return DASH;
  return (
    <ul className="space-y-0.5 text-[13px] leading-5">
      {stats.topProducts.map((p) => (
        <li key={p.key} className="line-clamp-2 text-ink-700">
          <span className="tabular-nums">{fmtInt(p.units)}</span> × {p.name}
          {p.sku ? <span className="font-mono text-xs text-ink-500"> · {p.sku}</span> : null}
        </li>
      ))}
    </ul>
  );
}
