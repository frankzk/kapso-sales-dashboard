"use client";

// Liquidaciones 2 — la pantalla: dominios → hojas → grid con columnas
// configurables, más los tres paneles (columnas, estados y alias, observaciones).
//
// El grid está virtualizado a mano (filas de altura fija) porque una hoja de
// Consolidado de un mes trae 1.000–3.000 filas y el Excel del que venimos
// llegaba a 8.000: pintar todas es lo que hacía lento al Sheet.

import { useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, EmptyState, cn } from "@/components/ui";
import { OPERATIONAL_STATUSES } from "@/lib/order-status";
import { suggestStatus } from "@/lib/sheets/statuses";
import type { DomainWithStatuses, SheetWithColumns } from "@/lib/sheets/access";
import type {
  CellValue,
  ColumnDataType,
  ComputedRow,
  ObservationReason,
  ObservationRow,
  SheetColumnRow,
  StatusAliasRow,
  StatusEffect,
} from "@/lib/sheets/types";
import {
  addSheetRow,
  addManualColumn,
  createObservation,
  initializeSheets,
  removeStatusAlias,
  resolveObservation,
  saveColumnLayout,
  seedAliasesFromTemplate,
  setCell,
  setStatusAlias,
  upsertDomainStatus,
  type ColumnLayoutItem,
  type SheetActionResult,
} from "@/app/dashboard/liquidaciones-2/actions";

interface Props {
  orgId: string;
  orgIds: string[];
  stores: { id: string; name: string }[];
  domains: DomainWithStatuses[];
  sheets: SheetWithColumns[];
  sheet: SheetWithColumns | null;
  domain: DomainWithStatuses | null;
  rows: ComputedRow[];
  truncated: boolean;
  aliases: StatusAliasRow[];
  observations: ObservationRow[];
  reasons: ObservationReason[];
  openObservations: number;
  filters: { month: string; search: string };
  canEdit: boolean;
  canManage: boolean;
  panel: string | null;
  lastImport: Record<string, unknown> | null;
}

const ROW_HEIGHT = 34;
const OVERSCAN = 12;

const EFFECT_LABEL: Record<StatusEffect, string> = {
  informa: "Informa",
  entrega: "Entrega",
  devolucion: "Devolución",
  anulacion: "Cancelación del courier",
};

const STATUS_STYLE: Record<string, string> = {
  entregado: "bg-emerald-50 text-emerald-700",
  recogido: "bg-emerald-50 text-emerald-700",
  devuelto: "bg-amber-50 text-amber-700",
  anulado: "bg-rose-50 text-rose-700",
  transito: "bg-sky-50 text-sky-700",
  "tránsito": "bg-sky-50 text-sky-700",
  "en proceso": "bg-sky-50 text-sky-700",
  pendiente: "bg-slate-100 text-slate-600",
};

function statusStyle(value: CellValue): string {
  const key = String(value ?? "").toLowerCase();
  return STATUS_STYLE[key] ?? "bg-slate-100 text-slate-600";
}

function monthOptions(current: string): { key: string; label: string }[] {
  const out: { key: string; label: string }[] = [];
  const now = new Date();
  for (let i = 0; i < 18; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const key = `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}`;
    out.push({ key, label: d.toLocaleDateString("es-PE", { month: "long", year: "numeric", timeZone: "UTC" }) });
  }
  if (current && !out.some((o) => o.key === current)) out.unshift({ key: current, label: current });
  return out;
}

function formatCell(value: CellValue, type: ColumnDataType): string {
  if (value === null || value === undefined || value === "") return "";
  if (type === "number" && typeof value === "number") return value.toFixed(2);
  if (type === "boolean") return value ? "Sí" : "";
  return String(value);
}

export function SheetsBoard(props: Props) {
  const { sheet, domain, rows, canEdit, canManage } = props;
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [panel, setPanel] = useState<string | null>(props.panel);

  const run = (action: () => Promise<SheetActionResult>, after?: () => void) => {
    startTransition(async () => {
      const result = await action();
      setNotice(result.ok ? (result.message ? { ok: true, text: result.message } : null) : { ok: false, text: result.error ?? "Error" });
      if (result.ok) {
        after?.();
        router.refresh();
      }
    });
  };

  const sheetsByDomain = useMemo(() => {
    const map = new Map<string, SheetWithColumns[]>();
    for (const s of props.sheets) map.set(s.domain_id, [...(map.get(s.domain_id) ?? []), s]);
    return map;
  }, [props.sheets]);

  const hrefFor = (sheetKey: string, extra: Record<string, string> = {}) => {
    const params = new URLSearchParams({ hoja: sheetKey });
    if (props.orgIds.length > 1) params.set("org", props.orgId);
    if (props.filters.month) params.set("mes", props.filters.month);
    for (const [k, v] of Object.entries(extra)) v ? params.set(k, v) : params.delete(k);
    return `/dashboard/liquidaciones-2?${params.toString()}`;
  };

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Liquidaciones 2</h1>
          <p className="text-sm text-slate-500">
            Hojas por dominio sobre los pedidos de Kapta. Lo manual deja historial; lo que no cuadra abre una observación.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {props.orgIds.length > 1 && (
            <span className="text-xs text-slate-500">Organización {props.orgIds.indexOf(props.orgId) + 1} de {props.orgIds.length}</span>
          )}
          {canManage && (
            <button
              type="button"
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
              disabled={pending}
              onClick={() => run(() => initializeSheets(props.orgId))}
            >
              Crear hojas que falten
            </button>
          )}
        </div>
      </header>

      {notice && (
        <div className={cn("rounded-lg px-3 py-2 text-sm", notice.ok ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-800")}>
          {notice.text}
        </div>
      )}

      {/* Dominios y hojas */}
      <nav className="space-y-2">
        {props.domains.map((d) => {
          const list = sheetsByDomain.get(d.id) ?? [];
          return (
            <div key={d.id} className="flex flex-wrap items-center gap-2">
              <span
                className={cn(
                  "w-36 shrink-0 text-xs font-semibold uppercase tracking-wide",
                  domain?.id === d.id ? "text-brand-700" : "text-slate-500",
                )}
                title={d.description ?? undefined}
              >
                {d.name}
              </span>
              {list.length === 0 && <span className="text-xs text-slate-400">Sin hojas todavía</span>}
              {list.map((s) => (
                <Link
                  key={s.id}
                  href={hrefFor(s.key)}
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs font-medium",
                    sheet?.id === s.id
                      ? "border-brand-700 bg-brand-700 text-white"
                      : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50",
                  )}
                >
                  {s.name}
                </Link>
              ))}
            </div>
          );
        })}
      </nav>

      {!sheet || !domain ? (
        <EmptyState title="Elige una hoja" />
      ) : (
        <>
          <Toolbar
            sheet={sheet}
            domain={domain}
            filters={props.filters}
            rowCount={rows.length}
            truncated={props.truncated}
            openObservations={props.observations.length}
            panel={panel}
            setPanel={setPanel}
            canManage={canManage}
            hrefFor={hrefFor}
            showMonth={domain.row_key === "pedido" || domain.row_key === "punto"}
            allowAllMonths={domain.row_key === "punto"}
          />

          {panel === "columnas" && canManage && (
            <ColumnsPanel sheet={sheet} run={run} pending={pending} onClose={() => setPanel(null)} />
          )}
          {panel === "estados" && canManage && (
            <StatusesPanel sheet={sheet} domain={domain} aliases={props.aliases} run={run} pending={pending} onClose={() => setPanel(null)} />
          )}
          {panel === "observaciones" && (
            <ObservationsPanel
              sheet={sheet}
              observations={props.observations}
              reasons={props.reasons}
              rows={rows}
              canEdit={canEdit}
              run={run}
              pending={pending}
              onClose={() => setPanel(null)}
            />
          )}
          {domain.row_key === "punto" && (
            <RepartoBar sheet={sheet} rows={rows} canEdit={canEdit} lastImport={props.lastImport} onImported={() => router.refresh()} />
          )}
          {(domain.row_key === "valor" || domain.row_key === "punto") && canEdit && (
            <AddRowForm sheet={sheet} domain={domain} run={run} pending={pending} />
          )}

          <Grid
            sheet={sheet}
            rows={rows}
            canEdit={canEdit}
            pending={pending}
            onEdit={(row, column, value) =>
              run(() => setCell({ sheetId: sheet.id, rowKey: row.row_key, orderId: row.order_id, columnKey: column.key, value }))
            }
            onFlag={
              canEdit
                ? (row) => {
                    setPanel("observaciones");
                    window.dispatchEvent(new CustomEvent("sheets:flag", { detail: row }));
                  }
                : null
            }
          />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------
function Toolbar(props: {
  sheet: SheetWithColumns;
  domain: DomainWithStatuses;
  filters: { month: string; search: string };
  rowCount: number;
  truncated: boolean;
  openObservations: number;
  panel: string | null;
  setPanel: (p: string | null) => void;
  canManage: boolean;
  hrefFor: (key: string, extra?: Record<string, string>) => string;
  showMonth: boolean;
  allowAllMonths?: boolean;
}) {
  const { sheet, domain, filters, panel, setPanel } = props;
  const toggle = (p: string) => setPanel(panel === p ? null : p);
  const btn = (p: string, label: ReactNode) => (
    <button
      type="button"
      onClick={() => toggle(p)}
      className={cn(
        "rounded-lg border px-3 py-1.5 text-xs font-medium",
        panel === p ? "border-brand-700 bg-brand-50 text-brand-700" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50",
      )}
    >
      {label}
    </button>
  );
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <form method="get" action="/dashboard/liquidaciones-2" className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="hoja" value={sheet.key} />
        {props.showMonth && (
          <select
            name="mes"
            defaultValue={filters.month}
            className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
            onChange={(e) => e.currentTarget.form?.requestSubmit()}
          >
            {monthOptions(filters.month === "todos" ? "" : filters.month).map((m) => (
              <option key={m.key} value={m.key}>
                {m.label}
              </option>
            ))}
            {props.allowAllMonths && <option value="todos">Todos los meses</option>}
          </select>
        )}
        <input
          name="q"
          defaultValue={filters.search}
          placeholder={domain.row_key === "pedido" ? "Buscar pedido o cliente" : "Buscar"}
          className="w-56 rounded-lg border border-slate-200 px-2 py-1.5 text-sm"
        />
        <button type="submit" className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white">
          Buscar
        </button>
        {filters.search && (
          <Link href={props.hrefFor(sheet.key, { q: "" })} className="text-xs text-slate-500 underline">
            Limpiar
          </Link>
        )}
        <span className="text-xs text-slate-500">
          {props.rowCount.toLocaleString("es-PE")} filas{props.truncated ? " (tope alcanzado: acota el mes o busca)" : ""}
        </span>
      </form>
      <div className="flex items-center gap-2">
        {btn("observaciones", <>Observaciones{props.openObservations ? ` · ${props.openObservations}` : ""}</>)}
        {props.canManage && btn("columnas", "Columnas")}
        {props.canManage && (domain.statuses.length > 0 || domain.key === "reparto_propio" || domain.key === "courier_externo") &&
          btn("estados", "Estados y alias")}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Grid virtualizado
// ---------------------------------------------------------------------------
function Grid(props: {
  sheet: SheetWithColumns;
  rows: ComputedRow[];
  canEdit: boolean;
  pending: boolean;
  onEdit: (row: ComputedRow, column: SheetColumnRow, value: CellValue) => void;
  onFlag: ((row: ComputedRow) => void) | null;
}) {
  const { sheet, rows } = props;
  const columns = useMemo(
    () => [...sheet.columns].filter((c) => c.visible).sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.position - b.position),
    [sheet.columns],
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(560);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setHeight(Math.max(320, window.innerHeight - el.getBoundingClientRect().top - 24));
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN);
  const slice = rows.slice(start, end);

  const [editing, setEditing] = useState<{ rowKey: string; columnKey: string } | null>(null);

  // Offsets de las columnas fijadas, para el sticky horizontal.
  const pinnedOffsets = useMemo(() => {
    const out = new Map<string, number>();
    let acc = 0;
    for (const c of columns) {
      if (!c.pinned) break;
      out.set(c.key, acc);
      acc += c.width ?? 140;
    }
    return out;
  }, [columns]);

  if (!columns.length) return <EmptyState title="Esta hoja no tiene columnas visibles" />;
  if (!rows.length) return <EmptyState title="Sin filas para este filtro" />;

  return (
    <div ref={scrollRef} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} style={{ height }} className="overflow-auto rounded-2xl border border-slate-200 bg-white">
      <table className="min-w-full border-separate border-spacing-0 text-sm">
        <thead className="sticky top-0 z-20 bg-slate-50">
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                style={{ width: c.width ?? 140, minWidth: c.width ?? 140, left: pinnedOffsets.get(c.key) }}
                className={cn(
                  "border-b border-slate-200 px-2 py-2 text-left text-xs font-semibold text-slate-600",
                  c.pinned && "sticky z-30 bg-slate-50",
                  c.data_type === "number" && "text-right",
                )}
                title={`${c.kind}${c.kind === "manual" ? " · editable" : ""}`}
              >
                {c.label}
                {c.kind === "manual" && <span className="ml-1 text-[10px] font-normal text-slate-400">✎</span>}
              </th>
            ))}
            {props.onFlag && <th className="border-b border-slate-200 px-2 py-2 text-xs font-semibold text-slate-600">Obs.</th>}
          </tr>
        </thead>
        <tbody>
          {start > 0 && (
            <tr style={{ height: start * ROW_HEIGHT }}>
              <td colSpan={columns.length + 1} />
            </tr>
          )}
          {slice.map((row) => (
            <tr key={row.row_key} style={{ height: ROW_HEIGHT }} className="hover:bg-slate-50">
              {columns.map((c) => {
                const value = row.cells[c.key] ?? null;
                const isEditing = editing?.rowKey === row.row_key && editing.columnKey === c.key;
                const editable = props.canEdit && c.kind === "manual";
                return (
                  <td
                    key={c.key}
                    style={{ left: pinnedOffsets.get(c.key) }}
                    className={cn(
                      "truncate border-b border-slate-100 px-2 py-1 align-middle",
                      c.pinned && "sticky z-10 bg-white",
                      c.data_type === "number" && "text-right tabular-nums",
                      editable && "cursor-text",
                    )}
                    onClick={() => editable && !isEditing && setEditing({ rowKey: row.row_key, columnKey: c.key })}
                  >
                    {isEditing ? (
                      <CellEditor
                        column={c}
                        value={value}
                        onCommit={(v) => {
                          setEditing(null);
                          if (v !== value) props.onEdit(row, c, v);
                        }}
                        onCancel={() => setEditing(null)}
                      />
                    ) : (
                      <CellView column={c} value={value} />
                    )}
                  </td>
                );
              })}
              {props.onFlag && (
                <td className="border-b border-slate-100 px-2 py-1 text-center">
                  <button
                    type="button"
                    title="Abrir observación para esta fila"
                    className="text-slate-400 hover:text-amber-600"
                    onClick={() => props.onFlag?.(row)}
                  >
                    ⚑
                  </button>
                </td>
              )}
            </tr>
          ))}
          {end < rows.length && (
            <tr style={{ height: (rows.length - end) * ROW_HEIGHT }}>
              <td colSpan={columns.length + 1} />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function CellView({ column, value }: { column: SheetColumnRow; value: CellValue }) {
  if (column.key === "pedido" && typeof value === "string" && value) {
    return (
      <Link href={`/dashboard/pedidos?q=${encodeURIComponent(value)}`} className="font-medium text-slate-900 hover:text-brand-700">
        {value}
      </Link>
    );
  }
  if (column.data_type === "status" && value) {
    return <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", statusStyle(value))}>{String(value)}</span>;
  }
  if (column.data_type === "boolean") {
    return <span className={value ? "font-medium text-rose-700" : "text-slate-300"}>{value ? "Sí" : "—"}</span>;
  }
  const text = formatCell(value, column.data_type);
  return <span title={text}>{text}</span>;
}

function CellEditor(props: { column: SheetColumnRow; value: CellValue; onCommit: (v: CellValue) => void; onCancel: () => void }) {
  const { column } = props;
  const [draft, setDraft] = useState<string>(props.value === null || props.value === undefined ? "" : String(props.value));
  const ref = useRef<HTMLInputElement | HTMLSelectElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const commit = () => props.onCommit(draft === "" ? null : column.data_type === "number" ? Number(draft.replace(",", ".")) : column.data_type === "boolean" ? draft === "true" : draft);
  const common = {
    className: "w-full rounded border border-brand-700 px-1 py-0.5 text-sm outline-none",
    onBlur: commit,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter") commit();
      if (e.key === "Escape") props.onCancel();
    },
  };
  if (column.data_type === "select" || column.data_type === "boolean") {
    const options = column.data_type === "boolean" ? ["", "true", "false"] : ["", ...column.options];
    const labels: Record<string, string> = { "": "—", true: "Sí", false: "No" };
    return (
      <select ref={ref as React.RefObject<HTMLSelectElement>} value={draft} onChange={(e) => setDraft(e.target.value)} {...common}>
        {options.map((o) => (
          <option key={o} value={o}>
            {labels[o] ?? o}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      ref={ref as React.RefObject<HTMLInputElement>}
      type={column.data_type === "number" ? "number" : column.data_type === "date" ? "date" : "text"}
      step={column.data_type === "number" ? "0.01" : undefined}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      {...common}
    />
  );
}

// ---------------------------------------------------------------------------
// Panel de columnas
// ---------------------------------------------------------------------------
function ColumnsPanel(props: { sheet: SheetWithColumns; run: (a: () => Promise<SheetActionResult>, after?: () => void) => void; pending: boolean; onClose: () => void }) {
  const { sheet } = props;
  const [layout, setLayout] = useState<ColumnLayoutItem[]>(() =>
    [...sheet.columns].sort((a, b) => a.position - b.position).map((c, i) => ({ key: c.key, visible: c.visible, pinned: c.pinned, width: c.width, position: i })),
  );
  const [label, setLabel] = useState("");
  const [type, setType] = useState<ColumnDataType>("text");
  const [options, setOptions] = useState("");
  const byKey = new Map(sheet.columns.map((c) => [c.key, c]));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= layout.length) return;
    const a = layout[i];
    const b = layout[j];
    if (!a || !b) return;
    const next = [...layout];
    next[i] = b;
    next[j] = a;
    setLayout(next.map((item, idx) => ({ ...item, position: idx })));
  };
  return (
    <Card className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-800">Columnas de «{sheet.name}»</h3>
        <button type="button" className="text-xs text-slate-500 underline" onClick={props.onClose}>Cerrar</button>
      </div>
      <div className="grid gap-1 md:grid-cols-2">
        {layout.map((item, i) => {
          const c = byKey.get(item.key);
          if (!c) return null;
          return (
            <div key={item.key} className="flex items-center gap-2 rounded-lg border border-slate-100 px-2 py-1 text-xs">
              <input type="checkbox" checked={item.visible} onChange={(e) => setLayout(layout.map((x) => (x.key === item.key ? { ...x, visible: e.target.checked } : x)))} title="Visible" />
              <span className="w-40 truncate font-medium text-slate-800" title={`${c.kind} · ${c.data_type}`}>{c.label}</span>
              <span className="w-16 text-slate-400">{c.kind}</span>
              <label className="flex items-center gap-1 text-slate-500">
                <input type="checkbox" checked={item.pinned} onChange={(e) => setLayout(layout.map((x) => (x.key === item.key ? { ...x, pinned: e.target.checked } : x)))} />
                fija
              </label>
              <input
                type="number"
                value={item.width ?? ""}
                placeholder="ancho"
                className="w-16 rounded border border-slate-200 px-1"
                onChange={(e) => setLayout(layout.map((x) => (x.key === item.key ? { ...x, width: e.target.value ? Number(e.target.value) : null } : x)))}
              />
              <button type="button" onClick={() => move(i, -1)} className="px-1 text-slate-500">↑</button>
              <button type="button" onClick={() => move(i, 1)} className="px-1 text-slate-500">↓</button>
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-end gap-2 border-t border-slate-100 pt-3">
        <button type="button" disabled={props.pending} className="rounded-lg bg-brand-700 px-3 py-1.5 text-xs font-medium text-white" onClick={() => props.run(() => saveColumnLayout(sheet.id, layout))}>
          Guardar columnas
        </button>
        <span className="mx-2 text-xs text-slate-400">|</span>
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Nueva columna manual" className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm" />
        <select value={type} onChange={(e) => setType(e.target.value as ColumnDataType)} className="rounded-lg border border-slate-200 px-2 py-1.5 text-sm">
          <option value="text">Texto</option>
          <option value="number">Número</option>
          <option value="date">Fecha</option>
          <option value="select">Lista</option>
          <option value="boolean">Sí/No</option>
        </select>
        {type === "select" && (
          <input value={options} onChange={(e) => setOptions(e.target.value)} placeholder="Opciones separadas por coma" className="w-64 rounded-lg border border-slate-200 px-2 py-1.5 text-sm" />
        )}
        <button
          type="button"
          disabled={props.pending || label.trim().length < 2}
          className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700"
          onClick={() =>
            props.run(
              () => addManualColumn(sheet.id, { label, data_type: type, options: options.split(",").map((o) => o.trim()).filter(Boolean) }),
              () => {
                setLabel("");
                setOptions("");
              },
            )
          }
        >
          Añadir columna
        </button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Panel de estados del dominio y alias de la hoja
// ---------------------------------------------------------------------------
function StatusesPanel(props: {
  sheet: SheetWithColumns;
  domain: DomainWithStatuses;
  aliases: StatusAliasRow[];
  run: (a: () => Promise<SheetActionResult>, after?: () => void) => void;
  pending: boolean;
  onClose: () => void;
}) {
  const { sheet, domain } = props;
  const [drafts, setDrafts] = useState<Record<string, { label: string; operational_status: string; effect: StatusEffect }>>({});
  const [nuevo, setNuevo] = useState({ code: "", label: "", operational_status: "intento_de_entrega", effect: "informa" as StatusEffect });
  const [alias, setAlias] = useState({ alias: "", status_code: "" });
  const draftOf = (code: string) => {
    const s = domain.statuses.find((x) => x.code === code)!;
    return drafts[code] ?? { label: s.label, operational_status: s.operational_status, effect: s.effect };
  };
  const domainKind = domain.key === "reparto_propio" || domain.key === "courier_externo" ? domain.key : null;
  return (
    <Card className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-slate-800">Estados del dominio «{domain.name}»</h3>
          <p className="text-xs text-slate-500">Cada estado equivale a un estado operativo de Kapta. El efecto dice si propone cerrar el pedido; una cancelación del courier nunca anula el pedido Shopify.</p>
        </div>
        <button type="button" className="text-xs text-slate-500 underline" onClick={props.onClose}>Cerrar</button>
      </div>
      <div className="space-y-1">
        {domain.statuses.map((s) => {
          const d = draftOf(s.code);
          return (
            <div key={s.code} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-100 px-2 py-1 text-xs">
              <code className="w-36 text-slate-500">{s.code}</code>
              <input value={d.label} onChange={(e) => setDrafts({ ...drafts, [s.code]: { ...d, label: e.target.value } })} className="w-44 rounded border border-slate-200 px-1 py-0.5" />
              <select value={d.operational_status} onChange={(e) => setDrafts({ ...drafts, [s.code]: { ...d, operational_status: e.target.value } })} className="rounded border border-slate-200 px-1 py-0.5">
                {OPERATIONAL_STATUSES.map((o) => (
                  <option key={o.code} value={o.code}>{o.label}</option>
                ))}
              </select>
              <select value={d.effect} onChange={(e) => setDrafts({ ...drafts, [s.code]: { ...d, effect: e.target.value as StatusEffect } })} className="rounded border border-slate-200 px-1 py-0.5">
                {(Object.keys(EFFECT_LABEL) as StatusEffect[]).map((k) => (
                  <option key={k} value={k}>{EFFECT_LABEL[k]}</option>
                ))}
              </select>
              {!s.active && <span className="text-rose-600">inactivo</span>}
              <button
                type="button"
                disabled={props.pending}
                className="rounded border border-slate-200 px-2 py-0.5 text-slate-700"
                onClick={() => props.run(() => upsertDomainStatus({ domainId: domain.id, code: s.code, ...d, active: s.active }))}
              >
                Guardar
              </button>
            </div>
          );
        })}
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-slate-200 px-2 py-1 text-xs">
          <input value={nuevo.code} onChange={(e) => setNuevo({ ...nuevo, code: e.target.value })} placeholder="codigo_nuevo" className="w-36 rounded border border-slate-200 px-1 py-0.5" />
          <input value={nuevo.label} onChange={(e) => setNuevo({ ...nuevo, label: e.target.value })} placeholder="Etiqueta" className="w-44 rounded border border-slate-200 px-1 py-0.5" />
          <select value={nuevo.operational_status} onChange={(e) => setNuevo({ ...nuevo, operational_status: e.target.value })} className="rounded border border-slate-200 px-1 py-0.5">
            {OPERATIONAL_STATUSES.map((o) => (
              <option key={o.code} value={o.code}>{o.label}</option>
            ))}
          </select>
          <select value={nuevo.effect} onChange={(e) => setNuevo({ ...nuevo, effect: e.target.value as StatusEffect })} className="rounded border border-slate-200 px-1 py-0.5">
            {(Object.keys(EFFECT_LABEL) as StatusEffect[]).map((k) => (
              <option key={k} value={k}>{EFFECT_LABEL[k]}</option>
            ))}
          </select>
          <button
            type="button"
            disabled={props.pending || !nuevo.code.trim()}
            className="rounded bg-brand-700 px-2 py-0.5 text-white"
            onClick={() => props.run(() => upsertDomainStatus({ domainId: domain.id, ...nuevo }), () => setNuevo({ ...nuevo, code: "", label: "" }))}
          >
            Añadir estado
          </button>
        </div>
      </div>

      <div className="space-y-2 border-t border-slate-100 pt-3">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-600">Alias de «{sheet.name}»</h4>
          {domainKind && (
            <button type="button" disabled={props.pending} className="text-xs text-slate-600 underline" onClick={() => props.run(() => seedAliasesFromTemplate(sheet.id))}>
              Cargar alias de plantilla
            </button>
          )}
        </div>
        <p className="text-xs text-slate-500">Lo que se escribe o llega en un archivo, normalizado, y a qué estado equivale. Un alias sin equivalente deja la fila a revisión.</p>
        {props.aliases.length === 0 && <p className="text-xs text-slate-400">Sin alias todavía.</p>}
        <div className="grid gap-1 md:grid-cols-2">
          {props.aliases.map((a) => (
            <div key={a.id} className={cn("flex items-center gap-2 rounded-lg border px-2 py-1 text-xs", a.status_code ? "border-slate-100" : "border-amber-200 bg-amber-50")}>
              <span className="w-56 truncate font-mono" title={a.alias}>{a.alias}</span>
              <select
                value={a.status_code ?? ""}
                disabled={props.pending}
                className="rounded border border-slate-200 px-1 py-0.5"
                onChange={(e) => props.run(() => setStatusAlias(sheet.id, a.alias, e.target.value || null))}
              >
                <option value="">Sin equivalente</option>
                {domain.statuses.map((s) => (
                  <option key={s.code} value={s.code}>{s.label}</option>
                ))}
              </select>
              {!a.status_code && domainKind && suggestStatus(a.alias, domainKind) && (
                <span className="text-amber-700">¿{suggestStatus(a.alias, domainKind)}?</span>
              )}
              {a.seen_count > 0 && <span className="text-slate-400">×{a.seen_count}</span>}
              <button type="button" className="ml-auto text-slate-400 hover:text-rose-600" onClick={() => props.run(() => removeStatusAlias(sheet.id, a.alias))}>
                ✕
              </button>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <input value={alias.alias} onChange={(e) => setAlias({ ...alias, alias: e.target.value })} placeholder="Texto tal como llega" className="w-56 rounded border border-slate-200 px-2 py-1" />
          <select value={alias.status_code} onChange={(e) => setAlias({ ...alias, status_code: e.target.value })} className="rounded border border-slate-200 px-1 py-1">
            <option value="">Sin equivalente</option>
            {domain.statuses.map((s) => (
              <option key={s.code} value={s.code}>{s.label}</option>
            ))}
          </select>
          <button
            type="button"
            disabled={props.pending || !alias.alias.trim()}
            className="rounded border border-slate-200 px-2 py-1 text-slate-700"
            onClick={() => props.run(() => setStatusAlias(sheet.id, alias.alias, alias.status_code || null), () => setAlias({ alias: "", status_code: "" }))}
          >
            Añadir alias
          </button>
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Panel de observaciones de cuadre
// ---------------------------------------------------------------------------
function ObservationsPanel(props: {
  sheet: SheetWithColumns;
  observations: ObservationRow[];
  reasons: ObservationReason[];
  rows: ComputedRow[];
  canEdit: boolean;
  run: (a: () => Promise<SheetActionResult>, after?: () => void) => void;
  pending: boolean;
  onClose: () => void;
}) {
  const { sheet, reasons } = props;
  const empty = { rowKey: "", orderId: null as string | null, field: "monto", externalValue: "", kaptaValue: "", reasonCode: "", note: "" };
  const [form, setForm] = useState(empty);
  const [resolving, setResolving] = useState<Record<string, { reason: string; note: string }>>({});

  useEffect(() => {
    const onFlag = (e: Event) => {
      const row = (e as CustomEvent<ComputedRow>).detail;
      const monto = row.cells.monto;
      setForm({
        ...empty,
        rowKey: row.row_key,
        orderId: row.order_id,
        kaptaValue: typeof monto === "number" ? monto.toFixed(2) : "",
      });
    };
    window.addEventListener("sheets:flag", onFlag);
    return () => window.removeEventListener("sheets:flag", onFlag);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const difference = (() => {
    const a = Number(form.externalValue.replace(",", "."));
    const b = Number(form.kaptaValue.replace(",", "."));
    return form.field === "monto" && Number.isFinite(a) && Number.isFinite(b) && form.externalValue && form.kaptaValue ? Math.round((a - b) * 100) / 100 : null;
  })();
  const reasonLabel = (code: string | null) => reasons.find((r) => r.code === code)?.label ?? code ?? "—";

  return (
    <Card className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-slate-800">Observaciones abiertas de «{sheet.name}»</h3>
          <p className="text-xs text-slate-500">Una diferencia entre lo externo y Kapta se anota con los dos valores y se resuelve con un motivo. Nunca se corrige en silencio.</p>
        </div>
        <button type="button" className="text-xs text-slate-500 underline" onClick={props.onClose}>Cerrar</button>
      </div>

      {props.canEdit && (
        <div className="grid gap-2 rounded-lg border border-dashed border-slate-200 p-3 text-xs md:grid-cols-6">
          <input value={form.rowKey} onChange={(e) => setForm({ ...form, rowKey: e.target.value })} placeholder="# Pedido o fila" className="rounded border border-slate-200 px-2 py-1" />
          <select value={form.field} onChange={(e) => setForm({ ...form, field: e.target.value })} className="rounded border border-slate-200 px-2 py-1">
            <option value="monto">Monto</option>
            <option value="estado">Estado</option>
            <option value="pedido">Pedido</option>
            <option value="courier">Courier</option>
            <option value="otro">Otro</option>
          </select>
          <input value={form.externalValue} onChange={(e) => setForm({ ...form, externalValue: e.target.value })} placeholder="Valor externo" className="rounded border border-slate-200 px-2 py-1" />
          <input value={form.kaptaValue} onChange={(e) => setForm({ ...form, kaptaValue: e.target.value })} placeholder="Valor Kapta" className="rounded border border-slate-200 px-2 py-1" />
          <select value={form.reasonCode} onChange={(e) => setForm({ ...form, reasonCode: e.target.value })} className="rounded border border-slate-200 px-2 py-1">
            <option value="">Motivo (opcional al abrir)</option>
            {reasons.map((r) => (
              <option key={r.code} value={r.code}>{r.label}</option>
            ))}
          </select>
          <div className="flex items-center gap-2">
            {difference !== null && <span className={cn("tabular-nums", difference === 0 ? "text-slate-400" : "font-medium text-amber-700")}>Δ {difference.toFixed(2)}</span>}
            <button
              type="button"
              disabled={props.pending || !form.rowKey.trim()}
              className="rounded bg-brand-700 px-3 py-1 font-medium text-white"
              onClick={() =>
                props.run(
                  () =>
                    createObservation({
                      sheetId: sheet.id,
                      rowKey: form.rowKey.trim(),
                      orderId: form.orderId ?? props.rows.find((r) => r.row_key === form.rowKey.trim())?.order_id ?? null,
                      field: form.field,
                      externalValue: form.externalValue,
                      kaptaValue: form.kaptaValue,
                      difference,
                      reasonCode: form.reasonCode || null,
                      note: form.note,
                    }),
                  () => setForm(empty),
                )
              }
            >
              Abrir
            </button>
          </div>
          <input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="Nota" className="rounded border border-slate-200 px-2 py-1 md:col-span-6" />
        </div>
      )}

      {props.observations.length === 0 ? (
        <p className="text-xs text-slate-400">No hay observaciones abiertas en esta hoja.</p>
      ) : (
        <div className="space-y-1">
          {props.observations.map((o) => {
            const r = resolving[o.id] ?? { reason: o.reason_code ?? "", note: "" };
            return (
              <div key={o.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-100 bg-amber-50/40 px-2 py-1 text-xs">
                <span className="text-slate-400">{o.created_at.slice(0, 10)}</span>
                <span className="font-medium text-slate-800">{o.field}</span>
                <span>externo <b>{o.external_value ?? "—"}</b></span>
                <span>Kapta <b>{o.kapta_value ?? "—"}</b></span>
                {o.difference !== null && <span className="tabular-nums text-amber-700">Δ {Number(o.difference).toFixed(2)}</span>}
                {o.note && <span className="text-slate-500">· {o.note}</span>}
                <span className="text-slate-500">· {reasonLabel(o.reason_code)}</span>
                {props.canEdit && (
                  <span className="ml-auto flex items-center gap-1">
                    <select value={r.reason} onChange={(e) => setResolving({ ...resolving, [o.id]: { ...r, reason: e.target.value } })} className="rounded border border-slate-200 px-1 py-0.5">
                      <option value="">Motivo…</option>
                      {reasons.map((x) => (
                        <option key={x.code} value={x.code}>{x.label}</option>
                      ))}
                    </select>
                    <input value={r.note} onChange={(e) => setResolving({ ...resolving, [o.id]: { ...r, note: e.target.value } })} placeholder="Nota de cierre" className="w-40 rounded border border-slate-200 px-1 py-0.5" />
                    <button type="button" disabled={props.pending || !r.reason} className="rounded border border-slate-200 px-2 py-0.5 text-slate-700" onClick={() => props.run(() => resolveObservation(o.id, r.reason, r.note))}>
                      Resolver
                    </button>
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Fila nueva tecleada (catálogos y reparto)
// ---------------------------------------------------------------------------
function AddRowForm(props: {
  sheet: SheetWithColumns;
  domain: DomainWithStatuses;
  run: (a: () => Promise<SheetActionResult>, after?: () => void) => void;
  pending: boolean;
}) {
  const columns = [...props.sheet.columns]
    .filter((c) => c.kind === "manual" && c.visible && !["estado_reportado", "metodo_pago_reportado", "revision"].includes(c.key))
    .sort((a, b) => a.position - b.position);
  const [values, setValues] = useState<Record<string, string>>({});
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button type="button" className="text-xs font-medium text-brand-700 underline" onClick={() => setOpen(true)}>
        + Añadir fila a mano
      </button>
    );
  }
  return (
    <div className="flex flex-wrap items-end gap-2 rounded-lg border border-dashed border-slate-200 bg-white p-3 text-xs">
      {columns.map((c) => (
        <label key={c.key} className="flex flex-col gap-1">
          <span className="text-slate-500">{c.label}{c.required ? " *" : ""}</span>
          {c.data_type === "select" || c.data_type === "status" ? (
            <select value={values[c.key] ?? ""} onChange={(e) => setValues({ ...values, [c.key]: e.target.value })} className="rounded border border-slate-200 px-2 py-1">
              <option value="">—</option>
              {(c.data_type === "status" ? props.domain.statuses.filter((s) => s.active).map((s) => ({ v: s.code, l: s.label })) : c.options.map((o) => ({ v: o, l: o }))).map((o) => (
                <option key={o.v} value={o.v}>{o.l}</option>
              ))}
            </select>
          ) : (
            <input
              type={c.data_type === "number" ? "number" : c.data_type === "date" ? "date" : "text"}
              step={c.data_type === "number" ? "0.01" : undefined}
              value={values[c.key] ?? ""}
              onChange={(e) => setValues({ ...values, [c.key]: e.target.value })}
              className="w-36 rounded border border-slate-200 px-2 py-1"
            />
          )}
        </label>
      ))}
      <button
        type="button"
        disabled={props.pending}
        className="rounded bg-brand-700 px-3 py-1.5 font-medium text-white"
        onClick={() => props.run(() => addSheetRow(props.sheet.id, values), () => setValues({}))}
      >
        Guardar fila
      </button>
      <button type="button" className="text-slate-500 underline" onClick={() => setOpen(false)}>Cerrar</button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Barra de una hoja de reparto: totales del periodo e importación de archivo
// ---------------------------------------------------------------------------
function RepartoBar(props: {
  sheet: SheetWithColumns;
  rows: ComputedRow[];
  canEdit: boolean;
  lastImport: Record<string, unknown> | null;
  onImported: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const totals = useMemo(() => {
    let entregados = 0;
    let efectivo = 0;
    let aCobrar = 0;
    let revision = 0;
    let vinculados = 0;
    const porMetodo = new Map<string, number>();
    for (const r of props.rows) {
      if (r.cells.estado === "entregado") entregados += 1;
      if (typeof r.cells.efectivo === "number") efectivo += r.cells.efectivo;
      if (typeof r.cells.a_cobrar === "number" && r.cells.estado === "entregado") aCobrar += r.cells.a_cobrar;
      if (r.cells.revision) revision += 1;
      if (r.cells.vinculado === true) vinculados += 1;
      const m = typeof r.cells.metodo_pago === "string" && r.cells.metodo_pago ? r.cells.metodo_pago : null;
      if (m && r.cells.estado === "entregado") porMetodo.set(m, (porMetodo.get(m) ?? 0) + 1);
    }
    return { entregados, efectivo, aCobrar, revision, vinculados, porMetodo };
  }, [props.rows]);

  const upload = async (file: File) => {
    setBusy(true);
    setResult(null);
    try {
      const fd = new FormData();
      fd.set("file", file);
      fd.set("sheetId", props.sheet.id);
      const res = await fetch("/api/sheets/import", { method: "POST", body: fd });
      const json = (await res.json()) as Record<string, unknown> & { error?: string };
      if (!res.ok) {
        setResult(json.error ?? "No se pudo importar.");
        return;
      }
      const unknown = Array.isArray(json.unknownStatuses) ? (json.unknownStatuses as [string, number][]).length : 0;
      setResult(
        `Importado «${String(json.worksheet ?? file.name)}»: ${json.rows} filas en ${json.blocks} rutas · ${json.inserted} nuevas, ${json.updated} actualizadas, ${json.keptManual} respetadas por edición manual · ${json.linked} vinculadas a un pedido de Kapta` +
          (unknown ? ` · ${unknown} estados sin equivalente: revísalos en «Estados y alias»` : ""),
      );
      props.onImported();
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const money = (n: number) => `S/ ${n.toFixed(2)}`;
  const li = props.lastImport;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-4">
        <span><b>{props.rows.length}</b> puntos</span>
        <span><b>{totals.entregados}</b> entregados</span>
        <span>a cobrar entregado <b>{money(totals.aCobrar)}</b></span>
        <span>efectivo <b>{money(totals.efectivo)}</b></span>
        {[...totals.porMetodo].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([m, n]) => (
          <span key={m} className="text-slate-500">{m} {n}</span>
        ))}
        <span className={totals.revision ? "font-medium text-amber-700" : "text-slate-400"}>{totals.revision} a revisión</span>
        <span className="text-slate-500">{totals.vinculados} en Kapta</span>
      </div>
      <div className="flex items-center gap-2">
        {li && typeof li.at === "string" && (
          <span className="text-slate-400" title={String(li.filename ?? "")}>última importación {li.at.slice(0, 10)}</span>
        )}
        {props.canEdit && (
          <label className={cn("cursor-pointer rounded-lg border px-3 py-1.5 font-medium", busy ? "border-slate-200 text-slate-400" : "border-brand-700 text-brand-700 hover:bg-brand-50")}>
            {busy ? "Importando…" : "Importar Excel/CSV"}
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xlsm,.csv"
              className="hidden"
              disabled={busy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void upload(f);
              }}
            />
          </label>
        )}
      </div>
      {result && <p className="w-full text-slate-700">{result}</p>}
    </div>
  );
}
