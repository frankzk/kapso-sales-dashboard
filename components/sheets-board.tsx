"use client";

// Liquidaciones 2 — la pantalla: dominios → hojas → grid con columnas
// configurables, más los tres paneles (columnas, estados y alias, observaciones).
//
// Está pensada como la hoja de trabajo diaria de quien liquida, no como un
// panel técnico: lo que se ve primero es lo que la gente escribió en el
// cuaderno, y el estado del grupo va al lado como lectura (MOM §30.7).
//
// El grid está virtualizado a mano (filas de altura fija) porque una hoja de
// Consolidado de un mes trae 1.000–3.000 filas y el Excel del que venimos
// llegaba a 8.000: pintar todas es lo que hacía lento al Sheet.

import { useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, EmptyState, cn } from "@/components/ui";
import { OPERATIONAL_STATUSES, operationalLabel } from "@/lib/order-status";
import { suggestStatus } from "@/lib/sheets/statuses";
import { REPARTO_PAYMENT_ALIASES, REPARTO_PAYMENT_METHODS, isCuadernoSheet } from "@/lib/sheets/templates";
import type { DomainWithStatuses, SheetWithColumns } from "@/lib/sheets/access";
import type {
  CellValue,
  ColumnDataType,
  ComputedRow,
  DomainStatusRow,
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

type Runner = (action: () => Promise<SheetActionResult>, after?: () => void) => void;

const ROW_HEIGHT = 34;
const OVERSCAN = 12;

const EFFECT_LABEL: Record<StatusEffect, string> = {
  informa: "Informa (cuenta como intento)",
  entrega: "Entrega",
  devolucion: "Devolución",
  anulacion: "Cancelación del courier",
  sin_salida: "No salió (sin intento)",
};

/** Colores por familia semántica. Verde cierra bien, ámbar vuelve, rojo se cae, azul sigue en curso. */
const TONE: Record<string, string> = {
  emerald: "bg-emerald-50 text-emerald-700 ring-emerald-100",
  amber: "bg-amber-50 text-amber-700 ring-amber-100",
  rose: "bg-rose-50 text-rose-700 ring-rose-100",
  sky: "bg-sky-50 text-sky-700 ring-sky-100",
  slate: "bg-slate-100 text-slate-600 ring-slate-200",
};

function toneForEffect(effect: StatusEffect | undefined): string {
  switch (effect) {
    case "entrega":
      return "emerald";
    case "devolucion":
      return "amber";
    case "anulacion":
      return "rose";
    case "sin_salida":
      return "slate";
    default:
      return "sky";
  }
}

function toneForLabel(label: string): string {
  const l = label.toLowerCase();
  if (/entregad|recogid/.test(l)) return "emerald";
  if (/devuelt|retorno/.test(l)) return "amber";
  if (/anulad|cancelad|rechaz/.test(l)) return "rose";
  if (/pendiente|sin confirmar|nunca/.test(l)) return "slate";
  return "sky";
}

function Chip({ tone, title, children, className }: { tone: string; title?: string; children: ReactNode; className?: string }) {
  return (
    <span
      title={title}
      className={cn("inline-flex max-w-full items-center truncate rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset", TONE[tone] ?? TONE.slate, className)}
    >
      {children}
    </span>
  );
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

const money = (n: number) => `S/ ${n.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function formatCell(value: CellValue, type: ColumnDataType): string {
  if (value === null || value === undefined || value === "") return "";
  if (type === "number" && typeof value === "number") return value.toFixed(2);
  if (type === "boolean") return value ? "Sí" : "";
  return String(value);
}

/** Lo que el grid necesita saber de la hoja para pintar estados y editarlos. */
interface GridContext {
  cuaderno: boolean;
  statusByCode: Map<string, DomainStatusRow>;
  aliasSuggestions: string[];
  canManage: boolean;
  openStatuses: () => void;
}

const BTN = "rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors";
const BTN_QUIET = `${BTN} border-slate-200 bg-white text-slate-700 hover:bg-slate-50`;
const BTN_PRIMARY = `${BTN} border-brand-700 bg-brand-700 text-white hover:bg-brand-800`;
const BTN_OUTLINE = `${BTN} border-brand-700 text-brand-700 hover:bg-brand-50`;
const INPUT = "rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:border-brand-700 focus:outline-none";
const INPUT_XS = "rounded border border-slate-200 bg-white px-1.5 py-0.5 text-xs text-slate-800 focus:border-brand-700 focus:outline-none";

export function SheetsBoard(props: Props) {
  const { sheet, domain, rows, canEdit, canManage } = props;
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [panel, setPanel] = useState<string | null>(props.panel);

  const run: Runner = (action, after) => {
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

  const cuaderno = Boolean(sheet && domain && isCuadernoSheet(sheet, domain));
  const gridContext: GridContext = useMemo(
    () => ({
      cuaderno,
      statusByCode: new Map((domain?.statuses ?? []).map((s) => [s.code, s])),
      aliasSuggestions: [
        ...new Set([
          ...(domain?.statuses ?? []).filter((s) => s.active).map((s) => s.label),
          ...props.aliases.filter((a) => a.status_code).map((a) => a.alias),
        ]),
      ],
      canManage,
      openStatuses: () => setPanel("estados"),
    }),
    [cuaderno, domain, props.aliases, canManage],
  );

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Liquidaciones 2</h1>
          <p className="text-sm text-slate-500">
            Lo que se escribe en el cuaderno queda tal cual; el estado del grupo va al lado. Lo manual deja historial y lo que no cuadra abre una observación.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {props.orgIds.length > 1 && (
            <span className="text-xs text-slate-500">
              Organización {props.orgIds.indexOf(props.orgId) + 1} de {props.orgIds.length}
            </span>
          )}
          {canManage && (
            <button type="button" className={BTN_QUIET} disabled={pending} onClick={() => run(() => initializeSheets(props.orgId))}>
              Crear hojas que falten
            </button>
          )}
        </div>
      </header>

      {notice && (
        <div role="status" className={cn("rounded-lg px-3 py-2 text-sm", notice.ok ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-800")}>
          {notice.text}
        </div>
      )}

      <DomainNav domains={props.domains} sheetsByDomain={sheetsByDomain} domain={domain} sheet={sheet} hrefFor={hrefFor} />

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
            showMonth={domain.row_key === "pedido" || cuaderno}
            allowAllMonths={cuaderno}
          />

          {panel === "columnas" && canManage && <ColumnsPanel sheet={sheet} run={run} pending={pending} onClose={() => setPanel(null)} />}
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

          {cuaderno && (
            <CuadernoBar
              sheet={sheet}
              rows={rows}
              statusByCode={gridContext.statusByCode}
              canEdit={canEdit}
              lastImport={props.lastImport}
              onImported={() => router.refresh()}
            />
          )}
          {(domain.row_key === "valor" || cuaderno) && canEdit && (
            <AddRowForm sheet={sheet} domain={domain} cuaderno={cuaderno} suggestions={gridContext.aliasSuggestions} run={run} pending={pending} />
          )}

          <Grid
            sheet={sheet}
            rows={rows}
            context={gridContext}
            canEdit={canEdit}
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
// Navegación: dominios como pestañas, hojas del dominio activo como chips
// ---------------------------------------------------------------------------
function DomainNav(props: {
  domains: DomainWithStatuses[];
  sheetsByDomain: Map<string, SheetWithColumns[]>;
  domain: DomainWithStatuses | null;
  sheet: SheetWithColumns | null;
  hrefFor: (key: string) => string;
}) {
  const active = props.domain ?? props.domains.find((d) => (props.sheetsByDomain.get(d.id) ?? []).length) ?? null;
  const activeSheets = active ? (props.sheetsByDomain.get(active.id) ?? []) : [];
  return (
    <nav aria-label="Dominios y hojas" className="rounded-2xl border border-slate-200 bg-white">
      <div className="flex flex-wrap gap-1 border-b border-slate-100 px-2 pt-2">
        {props.domains.map((d) => {
          const list = props.sheetsByDomain.get(d.id) ?? [];
          const first = list[0];
          const isActive = active?.id === d.id;
          const cls = cn(
            "flex items-center gap-1.5 rounded-t-lg border-b-2 px-3 py-2 text-xs font-medium",
            isActive ? "border-brand-700 text-brand-700" : "border-transparent text-slate-500 hover:text-slate-800",
            !first && "cursor-default opacity-60",
          );
          const badge = (
            <span className={cn("rounded-full px-1.5 text-[10px] tabular-nums", isActive ? "bg-brand-50 text-brand-700" : "bg-slate-100 text-slate-500")}>
              {list.length}
            </span>
          );
          return first ? (
            <Link key={d.id} href={props.hrefFor(first.key)} className={cls} title={d.description ?? undefined} aria-current={isActive ? "page" : undefined}>
              {d.name}
              {badge}
            </Link>
          ) : (
            <span key={d.id} className={cls} title={`${d.description ?? d.name} · sin hojas todavía`}>
              {d.name}
              {badge}
            </span>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 px-3 py-2">
        {activeSheets.length === 0 && <span className="text-xs text-slate-400">Este dominio todavía no tiene hojas.</span>}
        {activeSheets.map((s) => {
          const selected = props.sheet?.id === s.id;
          return (
            <Link
              key={s.id}
              href={props.hrefFor(s.key)}
              aria-current={selected ? "page" : undefined}
              className={cn(
                "rounded-full border px-3 py-1 text-xs font-medium",
                selected ? "border-brand-700 bg-brand-700 text-white" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50",
              )}
            >
              {s.name}
            </Link>
          );
        })}
      </div>
    </nav>
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
      aria-pressed={panel === p}
      className={cn(BTN, panel === p ? "border-brand-700 bg-brand-50 text-brand-700" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50")}
    >
      {label}
    </button>
  );
  const hasVocabulary = domain.statuses.length > 0 || domain.key === "reparto_propio" || domain.key === "courier_externo";
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <form method="get" action="/dashboard/liquidaciones-2" className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="hoja" value={sheet.key} />
        {props.showMonth && (
          <select name="mes" aria-label="Mes" defaultValue={filters.month} className={INPUT} onChange={(e) => e.currentTarget.form?.requestSubmit()}>
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
          aria-label="Buscar"
          defaultValue={filters.search}
          placeholder={domain.row_key === "pedido" ? "Pedido o cliente" : "Buscar en la hoja"}
          className={cn(INPUT, "w-56")}
        />
        <button type="submit" className={cn(BTN, "border-slate-900 bg-slate-900 text-white hover:bg-slate-800")}>
          Buscar
        </button>
        {filters.search && (
          <Link href={props.hrefFor(sheet.key, { q: "" })} className="text-xs text-slate-500 underline">
            Limpiar
          </Link>
        )}
        <span className="text-xs text-slate-500">
          {props.rowCount.toLocaleString("es-PE")} filas
          {props.truncated ? " · tope alcanzado, acota el mes o busca" : ""}
        </span>
      </form>
      <div className="flex items-center gap-2">
        {btn(
          "observaciones",
          <>
            Observaciones
            {props.openObservations > 0 && <span className="ml-1 rounded-full bg-amber-100 px-1.5 text-[10px] text-amber-800">{props.openObservations}</span>}
          </>,
        )}
        {props.canManage && btn("columnas", "Columnas")}
        {props.canManage && hasVocabulary && btn("estados", "Estados y alias")}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Barra de la hoja cuaderno: cifras del periodo, desglose por método, importar
// ---------------------------------------------------------------------------
function CuadernoBar(props: {
  sheet: SheetWithColumns;
  rows: ComputedRow[];
  statusByCode: Map<string, DomainStatusRow>;
  canEdit: boolean;
  lastImport: Record<string, unknown> | null;
  onImported: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const totals = useMemo(() => {
    let entregados = 0;
    let efectivo = 0;
    let aCobrar = 0;
    let revision = 0;
    let vinculados = 0;
    const porMetodo = new Map<string, { n: number; monto: number }>();
    const isDelivered = (code: CellValue) => typeof code === "string" && props.statusByCode.get(code)?.effect === "entrega";
    for (const r of props.rows) {
      const delivered = isDelivered(r.cells.estado ?? null);
      if (delivered) entregados += 1;
      if (typeof r.cells.efectivo === "number") efectivo += r.cells.efectivo;
      if (typeof r.cells.a_cobrar === "number" && delivered) aCobrar += r.cells.a_cobrar;
      if (r.cells.revision) revision += 1;
      if (r.cells.vinculado === true) vinculados += 1;
      const m = typeof r.cells.metodo_pago === "string" && r.cells.metodo_pago ? r.cells.metodo_pago : null;
      if (m && delivered) {
        const e = porMetodo.get(m) ?? { n: 0, monto: 0 };
        e.n += 1;
        e.monto += typeof r.cells.a_cobrar === "number" ? r.cells.a_cobrar : 0;
        porMetodo.set(m, e);
      }
    }
    return { entregados, efectivo, aCobrar, revision, vinculados, porMetodo };
  }, [props.rows, props.statusByCode]);

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
        setResult({ ok: false, text: json.error ?? "No se pudo importar." });
        return;
      }
      const unknown = Array.isArray(json.unknownStatuses) ? (json.unknownStatuses as [string, number][]).length : 0;
      setResult({
        ok: true,
        text:
          `Importado «${String(json.worksheet ?? file.name)}»: ${json.rows} filas en ${json.blocks} rutas · ${json.inserted} nuevas, ${json.updated} actualizadas, ${json.keptManual} respetadas por edición manual · ${json.linked} vinculadas a un pedido de Kapta` +
          (unknown ? ` · ${unknown} estados sin equivalente: revísalos en «Estados y alias»` : ""),
      });
      props.onImported();
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const li = props.lastImport;
  const tile = (label: string, value: string, tone?: "amber" | "muted") => (
    <div className={cn("rounded-xl border px-3 py-2", tone === "amber" ? "border-amber-200 bg-amber-50" : "border-slate-200 bg-white")}>
      <p className={cn("text-[11px] font-medium", tone === "amber" ? "text-amber-700" : "text-slate-500")}>{label}</p>
      <p className={cn("text-base font-semibold tabular-nums", tone === "amber" ? "text-amber-800" : tone === "muted" ? "text-slate-500" : "text-slate-900")}>{value}</p>
    </div>
  );
  const methods = [...totals.porMetodo].sort((a, b) => b[1].n - a[1].n);

  return (
    <section className="space-y-2" aria-label="Resumen del periodo">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {tile("Puntos", props.rows.length.toLocaleString("es-PE"))}
          {tile("Entregados", totals.entregados.toLocaleString("es-PE"))}
          {tile("A cobrar entregado", money(totals.aCobrar))}
          {tile("Efectivo", money(totals.efectivo))}
          {tile("En Kapta", `${totals.vinculados.toLocaleString("es-PE")} de ${props.rows.length.toLocaleString("es-PE")}`, "muted")}
          {tile("A revisión", totals.revision.toLocaleString("es-PE"), totals.revision ? "amber" : "muted")}
        </div>
        <div className="flex items-center gap-3">
          {li && typeof li.at === "string" && (
            <span className="text-xs text-slate-400" title={String(li.filename ?? "")}>
              Última importación {li.at.slice(0, 10)}
            </span>
          )}
          {props.canEdit && (
            <label className={cn("cursor-pointer", busy ? `${BTN} border-slate-200 text-slate-400` : BTN_OUTLINE)}>
              {busy ? "Importando…" : "Importar Excel/CSV"}
              <input
                ref={fileRef}
                type="file"
                accept=".xlsx,.xlsm,.csv"
                className="hidden"
                aria-label="Archivo del cuaderno"
                disabled={busy}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void upload(f);
                }}
              />
            </label>
          )}
        </div>
      </div>
      {methods.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-slate-100 bg-slate-50 px-3 py-1.5 text-xs text-slate-600">
          <span className="font-medium text-slate-500">Cobro de los entregados</span>
          {methods.map(([m, e]) => (
            <span key={m}>
              {m} <b className="tabular-nums text-slate-800">{e.n}</b>
              <span className="text-slate-400"> · {money(e.monto)}</span>
            </span>
          ))}
        </div>
      )}
      {result && (
        <p role="status" className={cn("rounded-lg px-3 py-2 text-xs", result.ok ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-800")}>
          {result.text}
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Grid virtualizado
// ---------------------------------------------------------------------------
function Grid(props: {
  sheet: SheetWithColumns;
  rows: ComputedRow[];
  context: GridContext;
  canEdit: boolean;
  onEdit: (row: ComputedRow, column: SheetColumnRow, value: CellValue) => void;
  onFlag: ((row: ComputedRow) => void) | null;
}) {
  const { sheet, rows, context } = props;
  const columns = useMemo(
    () =>
      [...sheet.columns]
        .filter((c) => c.visible)
        // En cuaderno los «escritos» viven dentro de Estado y Método: no se pintan aparte.
        .filter((c) => !(context.cuaderno && (c.key === "estado_reportado" || c.key === "metodo_pago_reportado")))
        .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.position - b.position),
    [sheet.columns, context.cuaderno],
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

  const widthOf = (c: SheetColumnRow) => c.width ?? (c.data_type === "number" ? 100 : c.data_type === "status" ? 220 : 140);
  const pinnedOffsets = useMemo(() => {
    const out = new Map<string, number>();
    let acc = 0;
    for (const c of columns) {
      if (!c.pinned) break;
      out.set(c.key, acc);
      acc += widthOf(c);
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
                scope="col"
                style={{ width: widthOf(c), minWidth: widthOf(c), left: pinnedOffsets.get(c.key) }}
                className={cn(
                  "whitespace-nowrap border-b border-slate-200 px-2 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500",
                  c.pinned && "sticky z-30 bg-slate-50",
                  c.data_type === "number" && "text-right",
                )}
                title={c.kind === "manual" ? "Editable: haz clic en la celda" : c.kind === "campo" ? "Del pedido en Kapta" : c.kind === "derivada" ? "Calculada" : "Buscada en otra hoja"}
              >
                {c.label}
              </th>
            ))}
            {props.onFlag && (
              <th scope="col" className="whitespace-nowrap border-b border-slate-200 px-2 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                Obs.
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {start > 0 && (
            <tr style={{ height: start * ROW_HEIGHT }}>
              <td colSpan={columns.length + 1} />
            </tr>
          )}
          {slice.map((row, i) => {
            const review = typeof row.cells.revision === "string" && row.cells.revision ? row.cells.revision : null;
            const zebra = (start + i) % 2 === 1;
            const rowBg = review ? "bg-amber-50/60" : zebra ? "bg-slate-50/60" : "bg-white";
            return (
              <tr key={row.row_key} style={{ height: ROW_HEIGHT }} className={cn(rowBg, "hover:bg-brand-50/40")} title={review ? `A revisión: ${reviewLabel(review)}` : undefined}>
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
                        c.pinned && cn("sticky z-10", review ? "bg-amber-50" : zebra ? "bg-slate-50" : "bg-white"),
                        review && c.key === "revision" && "border-l-2 border-l-amber-400",
                        c.data_type === "number" && "text-right tabular-nums",
                        editable && "cursor-text hover:bg-brand-50/70 hover:shadow-[inset_0_0_0_1px_rgb(203_213_225)]",
                      )}
                      onClick={() => editable && !isEditing && setEditing({ rowKey: row.row_key, columnKey: c.key })}
                    >
                      {isEditing ? (
                        <CellEditor
                          column={c}
                          row={row}
                          context={context}
                          onCommit={(v) => {
                            setEditing(null);
                            const current = editorValueOf(c, row, context);
                            if (v !== current) props.onEdit(row, c, v);
                          }}
                          onCancel={() => setEditing(null)}
                        />
                      ) : (
                        <CellView column={c} row={row} context={context} />
                      )}
                    </td>
                  );
                })}
                {props.onFlag && (
                  <td className="border-b border-slate-100 px-2 py-1 text-center">
                    <button
                      type="button"
                      title="Abrir observación para esta fila"
                      aria-label="Abrir observación para esta fila"
                      className="text-slate-300 hover:text-amber-600"
                      onClick={() => props.onFlag?.(row)}
                    >
                      ⚑
                    </button>
                  </td>
                )}
              </tr>
            );
          })}
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

const REVIEW_LABELS: Record<string, string> = {
  sin_fecha: "el bloque no tenía fecha legible",
  estado_sin_equivalente: "el estado escrito no tiene equivalente",
  pedido_no_shopify: "no es un pedido de Shopify",
  pedido_repetido_en_el_dia: "el mismo pedido aparece dos veces en el día",
};

function reviewLabel(review: string): string {
  return review
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => REVIEW_LABELS[t] ?? t)
    .join("; ");
}

/** El valor que se edita: en cuaderno, Estado y Método editan lo ESCRITO. */
function editorValueOf(column: SheetColumnRow, row: ComputedRow, context: GridContext): CellValue {
  if (context.cuaderno && column.key === "estado") return row.cells.estado_reportado ?? row.cells.estado ?? null;
  if (context.cuaderno && column.key === "metodo_pago") return row.cells.metodo_pago_reportado ?? row.cells.metodo_pago ?? null;
  return row.cells[column.key] ?? null;
}

function CellView({ column, row, context }: { column: SheetColumnRow; row: ComputedRow; context: GridContext }) {
  const value = row.cells[column.key] ?? null;

  if (column.key === "pedido" && typeof value === "string" && value) {
    return (
      <Link href={`/dashboard/pedidos?q=${encodeURIComponent(value)}`} className="font-medium text-slate-900 hover:text-brand-700">
        {value}
      </Link>
    );
  }

  // Cuaderno: lo escrito primero, el grupo como chip.
  if (context.cuaderno && column.key === "estado") {
    const written = typeof row.cells.estado_reportado === "string" ? row.cells.estado_reportado : null;
    const code = typeof value === "string" ? value : null;
    const status = code ? context.statusByCode.get(code) : undefined;
    if (!written && !code) return <span className="text-slate-300">—</span>;
    return (
      <span className="flex items-center gap-1.5">
        <span className="truncate text-slate-800" title={written ?? undefined}>
          {written ?? status?.label ?? code}
        </span>
        {status ? (
          <Chip tone={toneForEffect(status.effect)} title={`Kapta: ${operationalLabel(status.operational_status)} · ${EFFECT_LABEL[status.effect]}`} className="shrink-0">
            {status.label}
          </Chip>
        ) : code ? (
          <Chip tone="slate" className="shrink-0" title="Estado sin etiqueta en el dominio">
            {code}
          </Chip>
        ) : context.canManage ? (
          <button
            type="button"
            className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 ring-1 ring-inset ring-amber-200 hover:bg-amber-100"
            title="Sin equivalente: asígnalo en Estados y alias"
            onClick={(e) => {
              e.stopPropagation();
              context.openStatuses();
            }}
          >
            Sin equivalente
          </button>
        ) : (
          <Chip tone="amber" className="shrink-0" title="Sin equivalente: pide a un administrador que lo asigne">
            Sin equivalente
          </Chip>
        )}
      </span>
    );
  }
  if (context.cuaderno && column.key === "metodo_pago") {
    const written = typeof row.cells.metodo_pago_reportado === "string" ? row.cells.metodo_pago_reportado : null;
    const method = typeof value === "string" && value ? value : null;
    if (!written && !method) return <span className="text-slate-300">—</span>;
    const same = written && method && written.trim().toLowerCase() === method.toLowerCase();
    return (
      <span className="flex items-center gap-1.5">
        <span className="truncate text-slate-800" title={written ?? undefined}>
          {written ?? method}
        </span>
        {method && !same ? (
          <Chip tone="slate" className="shrink-0" title="Método de la lista al que equivale">
            {method}
          </Chip>
        ) : !method && written ? (
          <Chip tone="amber" className="shrink-0" title="No está en la lista de métodos">
            Fuera de lista
          </Chip>
        ) : null}
      </span>
    );
  }

  if (column.data_type === "status") {
    if (!value) return <span className="text-slate-300">—</span>;
    const code = String(value);
    const status = context.statusByCode.get(code);
    if (status) {
      return (
        <Chip tone={toneForEffect(status.effect)} title={`Kapta: ${operationalLabel(status.operational_status)}`}>
          {status.label}
        </Chip>
      );
    }
    const label = OPERATIONAL_STATUSES.some((o) => o.code === code) ? operationalLabel(code) : code;
    return <Chip tone={toneForLabel(label)}>{label}</Chip>;
  }
  if (column.data_type === "boolean") {
    if (value === null || value === undefined) return <span className="text-slate-300">—</span>;
    return value ? (
      <span className="inline-flex items-center gap-1 text-emerald-700">
        <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
        Sí
      </span>
    ) : (
      <span className="text-slate-400">No</span>
    );
  }
  if (column.key === "revision" && typeof value === "string" && value) {
    return (
      <span className="text-xs text-amber-800" title={reviewLabel(value)}>
        {reviewLabel(value)}
      </span>
    );
  }
  const text = formatCell(value, column.data_type);
  return <span title={text || undefined}>{text || <span className="text-slate-300">—</span>}</span>;
}

function CellEditor(props: { column: SheetColumnRow; row: ComputedRow; context: GridContext; onCommit: (v: CellValue) => void; onCancel: () => void }) {
  const { column, context } = props;
  const initial = editorValueOf(column, props.row, context);
  const [draft, setDraft] = useState<string>(initial === null || initial === undefined ? "" : String(initial));
  const ref = useRef<HTMLInputElement | HTMLSelectElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const freeText = context.cuaderno && (column.key === "estado" || column.key === "metodo_pago");
  const commit = () =>
    props.onCommit(
      draft === ""
        ? null
        : !freeText && column.data_type === "number"
          ? Number(draft.replace(",", "."))
          : !freeText && column.data_type === "boolean"
            ? draft === "true"
            : draft,
    );
  const common = {
    className: "w-full rounded border border-brand-700 bg-white px-1 py-0.5 text-sm outline-none",
    onBlur: commit,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter") commit();
      if (e.key === "Escape") props.onCancel();
    },
    onClick: (e: React.MouseEvent) => e.stopPropagation(),
  };
  if (freeText) {
    const listId = `sheets-dl-${column.key}`;
    const options = column.key === "estado" ? context.aliasSuggestions : [...new Set([...REPARTO_PAYMENT_METHODS, ...Object.keys(REPARTO_PAYMENT_ALIASES)])];
    return (
      <>
        <input
          ref={ref as React.RefObject<HTMLInputElement>}
          type="text"
          list={listId}
          aria-label={column.label}
          placeholder={column.key === "estado" ? "Escribe como en el cuaderno" : "Efectivo, Yape GF, Izipay…"}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          {...common}
        />
        <datalist id={listId}>
          {options.map((o) => (
            <option key={o} value={o} />
          ))}
        </datalist>
      </>
    );
  }
  if (column.data_type === "select" || column.data_type === "boolean") {
    const options = column.data_type === "boolean" ? ["", "true", "false"] : ["", ...column.options];
    const labels: Record<string, string> = { "": "—", true: "Sí", false: "No" };
    return (
      <select ref={ref as React.RefObject<HTMLSelectElement>} aria-label={column.label} value={draft} onChange={(e) => setDraft(e.target.value)} {...common}>
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
      aria-label={column.label}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      {...common}
    />
  );
}

// ---------------------------------------------------------------------------
// Cabecera común de los paneles
// ---------------------------------------------------------------------------
function PanelHeader({ title, subtitle, onClose, right }: { title: string; subtitle?: string; onClose: () => void; right?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div>
        <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
        {subtitle && <p className="text-xs text-slate-500">{subtitle}</p>}
      </div>
      <div className="flex items-center gap-2">
        {right}
        <button type="button" className="text-xs text-slate-500 underline" onClick={onClose}>
          Cerrar
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel de columnas
// ---------------------------------------------------------------------------
function ColumnsPanel(props: { sheet: SheetWithColumns; run: Runner; pending: boolean; onClose: () => void }) {
  const { sheet } = props;
  const [layout, setLayout] = useState<ColumnLayoutItem[]>(() =>
    [...sheet.columns].sort((a, b) => a.position - b.position).map((c, i) => ({ key: c.key, visible: c.visible, pinned: c.pinned, width: c.width, position: i })),
  );
  const [label, setLabel] = useState("");
  const [type, setType] = useState<ColumnDataType>("text");
  const [options, setOptions] = useState("");
  const byKey = new Map(sheet.columns.map((c) => [c.key, c]));
  const KIND_LABEL: Record<string, string> = { campo: "del pedido", manual: "editable", lookup: "buscada", derivada: "calculada" };
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
  const patch = (key: string, p: Partial<ColumnLayoutItem>) => setLayout(layout.map((x) => (x.key === key ? { ...x, ...p } : x)));
  return (
    <Card className="space-y-3">
      <PanelHeader title={`Columnas de «${sheet.name}»`} subtitle="Qué se ve, en qué orden, cuáles quedan fijas a la izquierda y su ancho." onClose={props.onClose} />
      <div className="grid gap-1 md:grid-cols-2">
        {layout.map((item, i) => {
          const c = byKey.get(item.key);
          if (!c) return null;
          return (
            <div key={item.key} className="flex items-center gap-2 rounded-lg border border-slate-100 px-2 py-1 text-xs">
              <input type="checkbox" aria-label={`Mostrar ${c.label}`} checked={item.visible} onChange={(e) => patch(item.key, { visible: e.target.checked })} />
              <span className="w-40 truncate font-medium text-slate-800" title={c.label}>
                {c.label}
              </span>
              <span className="w-16 text-slate-400">{KIND_LABEL[c.kind] ?? c.kind}</span>
              <label className="flex items-center gap-1 text-slate-500">
                <input type="checkbox" checked={item.pinned} onChange={(e) => patch(item.key, { pinned: e.target.checked })} />
                fija
              </label>
              <input
                type="number"
                aria-label={`Ancho de ${c.label}`}
                value={item.width ?? ""}
                placeholder="ancho"
                className={cn(INPUT_XS, "w-16")}
                onChange={(e) => patch(item.key, { width: e.target.value ? Number(e.target.value) : null })}
              />
              <button type="button" aria-label="Subir" onClick={() => move(i, -1)} className="px-1 text-slate-500 hover:text-slate-800">
                ↑
              </button>
              <button type="button" aria-label="Bajar" onClick={() => move(i, 1)} className="px-1 text-slate-500 hover:text-slate-800">
                ↓
              </button>
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-end gap-2 border-t border-slate-100 pt-3">
        <button type="button" disabled={props.pending} className={BTN_PRIMARY} onClick={() => props.run(() => saveColumnLayout(sheet.id, layout))}>
          Guardar columnas
        </button>
        <span className="mx-1 text-xs text-slate-300">|</span>
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Nueva columna editable" aria-label="Nombre de la columna" className={INPUT} />
        <select value={type} aria-label="Tipo de la columna" onChange={(e) => setType(e.target.value as ColumnDataType)} className={INPUT}>
          <option value="text">Texto</option>
          <option value="number">Número</option>
          <option value="date">Fecha</option>
          <option value="select">Lista</option>
          <option value="boolean">Sí/No</option>
        </select>
        {type === "select" && (
          <input value={options} onChange={(e) => setOptions(e.target.value)} placeholder="Opciones separadas por coma" aria-label="Opciones" className={cn(INPUT, "w-64")} />
        )}
        <button
          type="button"
          disabled={props.pending || label.trim().length < 2}
          className={BTN_QUIET}
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
  run: Runner;
  pending: boolean;
  onClose: () => void;
}) {
  const { sheet, domain } = props;
  const [drafts, setDrafts] = useState<Record<string, { label: string; operational_status: string; effect: StatusEffect }>>({});
  const [nuevo, setNuevo] = useState({ code: "", label: "", operational_status: "intento_de_entrega", effect: "informa" as StatusEffect });
  const [alias, setAlias] = useState({ alias: "", status_code: "" });
  const [showMapped, setShowMapped] = useState(false);
  const draftOf = (s: DomainStatusRow) => drafts[s.code] ?? { label: s.label, operational_status: s.operational_status, effect: s.effect };
  const domainKind = domain.key === "reparto_propio" || domain.key === "courier_externo" ? domain.key : null;
  const labelOf = (code: string | null) => domain.statuses.find((s) => s.code === code)?.label ?? code ?? "";
  const unmapped = props.aliases.filter((a) => !a.status_code).sort((a, b) => b.seen_count - a.seen_count || a.alias.localeCompare(b.alias));
  const mapped = props.aliases.filter((a) => a.status_code).sort((a, b) => a.alias.localeCompare(b.alias));

  const statusSelect = (value: string, onChange: (v: string) => void, label: string) => (
    <select value={value} aria-label={label} onChange={(e) => onChange(e.target.value)} className={INPUT_XS}>
      <option value="">Sin equivalente</option>
      {domain.statuses
        .filter((s) => s.active)
        .map((s) => (
          <option key={s.code} value={s.code}>
            {s.label}
          </option>
        ))}
    </select>
  );

  return (
    <Card className="space-y-5">
      <PanelHeader
        title={`Estados y alias de «${sheet.name}»`}
        subtitle="Lo escrito se guarda tal cual. Un alias dice a qué estado del grupo equivale, y cada estado del grupo equivale a uno de Kapta."
        onClose={props.onClose}
      />

      {/* Alias de esta hoja */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-600">Alias de esta hoja</h4>
          {domainKind && (
            <button type="button" disabled={props.pending} className="text-xs text-slate-600 underline" onClick={() => props.run(() => seedAliasesFromTemplate(sheet.id))}>
              Cargar alias de plantilla
            </button>
          )}
        </div>

        {unmapped.length > 0 ? (
          <div className="space-y-1 rounded-xl border border-amber-200 bg-amber-50/50 p-2">
            <p className="text-xs font-medium text-amber-800">
              {unmapped.length} sin equivalente. Sus filas están a revisión hasta que les asignes uno.
            </p>
            <div className="grid gap-1 md:grid-cols-2">
              {unmapped.map((a) => {
                const suggestion = domainKind ? suggestStatus(a.alias, domainKind) : null;
                return (
                  <div key={a.id} className="flex items-center gap-2 rounded-lg border border-amber-200 bg-white px-2 py-1 text-xs">
                    <span className="w-48 truncate font-mono text-slate-800" title={a.alias}>
                      {a.alias}
                    </span>
                    {a.seen_count > 0 && <span className="text-slate-400">×{a.seen_count}</span>}
                    {suggestion && (
                      <button
                        type="button"
                        disabled={props.pending}
                        className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800 hover:bg-amber-200"
                        title="Aplicar esta sugerencia"
                        onClick={() => props.run(() => setStatusAlias(sheet.id, a.alias, suggestion))}
                      >
                        ¿{labelOf(suggestion)}?
                      </button>
                    )}
                    <span className="ml-auto flex items-center gap-1">
                      {statusSelect("", (v) => v && props.run(() => setStatusAlias(sheet.id, a.alias, v)), `Equivalente de ${a.alias}`)}
                      <button type="button" aria-label={`Quitar alias ${a.alias}`} className="text-slate-400 hover:text-rose-600" onClick={() => props.run(() => removeStatusAlias(sheet.id, a.alias))}>
                        ✕
                      </button>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <p className="text-xs text-slate-400">Todos los alias de esta hoja tienen equivalente.</p>
        )}

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <input value={alias.alias} onChange={(e) => setAlias({ ...alias, alias: e.target.value })} placeholder="Texto tal como se escribe" aria-label="Alias nuevo" className={cn(INPUT, "w-56")} />
          {statusSelect(alias.status_code, (v) => setAlias({ ...alias, status_code: v }), "Equivalente del alias nuevo")}
          <button
            type="button"
            disabled={props.pending || !alias.alias.trim()}
            className={BTN_QUIET}
            onClick={() => props.run(() => setStatusAlias(sheet.id, alias.alias, alias.status_code || null), () => setAlias({ alias: "", status_code: "" }))}
          >
            Añadir alias
          </button>
          <button type="button" className="ml-auto text-xs text-slate-500 underline" onClick={() => setShowMapped((v) => !v)}>
            {showMapped ? "Ocultar" : "Ver"} los {mapped.length} con equivalente
          </button>
        </div>
        {showMapped && (
          <div className="grid gap-1 md:grid-cols-3">
            {mapped.map((a) => (
              <div key={a.id} className="flex items-center gap-2 rounded-lg border border-slate-100 px-2 py-1 text-xs">
                <span className="w-40 truncate font-mono" title={a.alias}>
                  {a.alias}
                </span>
                {statusSelect(a.status_code ?? "", (v) => props.run(() => setStatusAlias(sheet.id, a.alias, v || null)), `Equivalente de ${a.alias}`)}
                <button type="button" aria-label={`Quitar alias ${a.alias}`} className="ml-auto text-slate-300 hover:text-rose-600" onClick={() => props.run(() => removeStatusAlias(sheet.id, a.alias))}>
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Vocabulario del dominio */}
      <section className="space-y-2 border-t border-slate-100 pt-4">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-600">Vocabulario del dominio «{domain.name}»</h4>
        <p className="text-xs text-slate-500">Vale para todas las hojas del dominio. El efecto dice qué aporta al Consolidado; una cancelación del courier nunca anula el pedido Shopify.</p>
        <div className="space-y-1">
          {domain.statuses.map((s) => {
            const d = draftOf(s);
            const set = (p: Partial<typeof d>) => setDrafts({ ...drafts, [s.code]: { ...d, ...p } });
            return (
              <div key={s.code} className={cn("flex flex-wrap items-center gap-2 rounded-lg border px-2 py-1 text-xs", s.active ? "border-slate-100" : "border-slate-100 opacity-60")}>
                <Chip tone={toneForEffect(d.effect)} className="w-36 justify-center">
                  {d.label || s.code}
                </Chip>
                <input value={d.label} aria-label={`Etiqueta de ${s.code}`} onChange={(e) => set({ label: e.target.value })} className={cn(INPUT_XS, "w-44")} />
                <select value={d.operational_status} aria-label={`Equivalente Kapta de ${s.code}`} onChange={(e) => set({ operational_status: e.target.value })} className={INPUT_XS}>
                  {OPERATIONAL_STATUSES.map((o) => (
                    <option key={o.code} value={o.code}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <select value={d.effect} aria-label={`Efecto de ${s.code}`} onChange={(e) => set({ effect: e.target.value as StatusEffect })} className={INPUT_XS}>
                  {(Object.keys(EFFECT_LABEL) as StatusEffect[]).map((k) => (
                    <option key={k} value={k}>
                      {EFFECT_LABEL[k]}
                    </option>
                  ))}
                </select>
                {!s.active && <span className="text-rose-600">inactivo</span>}
                <button
                  type="button"
                  disabled={props.pending}
                  className={cn(BTN_QUIET, "ml-auto px-2 py-0.5")}
                  onClick={() => props.run(() => upsertDomainStatus({ domainId: domain.id, code: s.code, ...d, active: s.active }))}
                >
                  Guardar
                </button>
              </div>
            );
          })}
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-slate-200 px-2 py-1 text-xs">
            <input value={nuevo.code} onChange={(e) => setNuevo({ ...nuevo, code: e.target.value })} placeholder="codigo_nuevo" aria-label="Código del estado nuevo" className={cn(INPUT_XS, "w-36")} />
            <input value={nuevo.label} onChange={(e) => setNuevo({ ...nuevo, label: e.target.value })} placeholder="Etiqueta" aria-label="Etiqueta del estado nuevo" className={cn(INPUT_XS, "w-44")} />
            <select value={nuevo.operational_status} aria-label="Equivalente Kapta del estado nuevo" onChange={(e) => setNuevo({ ...nuevo, operational_status: e.target.value })} className={INPUT_XS}>
              {OPERATIONAL_STATUSES.map((o) => (
                <option key={o.code} value={o.code}>
                  {o.label}
                </option>
              ))}
            </select>
            <select value={nuevo.effect} aria-label="Efecto del estado nuevo" onChange={(e) => setNuevo({ ...nuevo, effect: e.target.value as StatusEffect })} className={INPUT_XS}>
              {(Object.keys(EFFECT_LABEL) as StatusEffect[]).map((k) => (
                <option key={k} value={k}>
                  {EFFECT_LABEL[k]}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={props.pending || !nuevo.code.trim()}
              className={cn(BTN_PRIMARY, "px-2 py-0.5")}
              onClick={() => props.run(() => upsertDomainStatus({ domainId: domain.id, ...nuevo }), () => setNuevo({ ...nuevo, code: "", label: "" }))}
            >
              Añadir estado
            </button>
          </div>
        </div>
      </section>
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
  run: Runner;
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
      const monto = row.cells.monto ?? row.cells.a_cobrar;
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
  const FIELD_LABEL: Record<string, string> = { monto: "Monto", estado: "Estado", pedido: "Pedido", courier: "Courier", otro: "Otro" };

  return (
    <Card className="space-y-4">
      <PanelHeader
        title={`Observaciones abiertas de «${sheet.name}»`}
        subtitle="Una diferencia entre lo externo y Kapta se anota con los dos valores y se resuelve con un motivo. Nunca se corrige en silencio."
        onClose={props.onClose}
      />

      {props.canEdit && (
        <div className="grid gap-2 rounded-xl border border-dashed border-slate-200 p-3 text-xs md:grid-cols-6">
          <input value={form.rowKey} onChange={(e) => setForm({ ...form, rowKey: e.target.value })} placeholder="# Pedido o fila" aria-label="Pedido o fila" className={INPUT_XS} />
          <select value={form.field} aria-label="Qué se comparó" onChange={(e) => setForm({ ...form, field: e.target.value })} className={INPUT_XS}>
            {Object.entries(FIELD_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <input value={form.externalValue} onChange={(e) => setForm({ ...form, externalValue: e.target.value })} placeholder="Valor externo" aria-label="Valor externo" className={INPUT_XS} />
          <input value={form.kaptaValue} onChange={(e) => setForm({ ...form, kaptaValue: e.target.value })} placeholder="Valor Kapta" aria-label="Valor Kapta" className={INPUT_XS} />
          <select value={form.reasonCode} aria-label="Motivo" onChange={(e) => setForm({ ...form, reasonCode: e.target.value })} className={INPUT_XS}>
            <option value="">Motivo (opcional al abrir)</option>
            {reasons.map((r) => (
              <option key={r.code} value={r.code}>
                {r.label}
              </option>
            ))}
          </select>
          <div className="flex items-center gap-2">
            {difference !== null && <span className={cn("tabular-nums", difference === 0 ? "text-slate-400" : "font-medium text-amber-700")}>Δ {difference.toFixed(2)}</span>}
            <button
              type="button"
              disabled={props.pending || !form.rowKey.trim()}
              className={cn(BTN_PRIMARY, "px-3 py-1")}
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
          <input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="Nota" aria-label="Nota" className={cn(INPUT_XS, "md:col-span-6")} />
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
                <span className="font-medium text-slate-800">{FIELD_LABEL[o.field] ?? o.field}</span>
                <span>
                  externo <b>{o.external_value ?? "—"}</b>
                </span>
                <span>
                  Kapta <b>{o.kapta_value ?? "—"}</b>
                </span>
                {o.difference !== null && <span className="tabular-nums text-amber-700">Δ {Number(o.difference).toFixed(2)}</span>}
                {o.note && <span className="text-slate-500">· {o.note}</span>}
                <span className="text-slate-500">· {reasonLabel(o.reason_code)}</span>
                {props.canEdit && (
                  <span className="ml-auto flex items-center gap-1">
                    <select value={r.reason} aria-label="Motivo de cierre" onChange={(e) => setResolving({ ...resolving, [o.id]: { ...r, reason: e.target.value } })} className={INPUT_XS}>
                      <option value="">Motivo…</option>
                      {reasons.map((x) => (
                        <option key={x.code} value={x.code}>
                          {x.label}
                        </option>
                      ))}
                    </select>
                    <input value={r.note} aria-label="Nota de cierre" onChange={(e) => setResolving({ ...resolving, [o.id]: { ...r, note: e.target.value } })} placeholder="Nota de cierre" className={cn(INPUT_XS, "w-40")} />
                    <button type="button" disabled={props.pending || !r.reason} className={cn(BTN_QUIET, "px-2 py-0.5")} onClick={() => props.run(() => resolveObservation(o.id, r.reason, r.note))}>
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
// Fila nueva tecleada (catálogos y cuaderno)
// ---------------------------------------------------------------------------
function AddRowForm(props: { sheet: SheetWithColumns; domain: DomainWithStatuses; cuaderno: boolean; suggestions: string[]; run: Runner; pending: boolean }) {
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
  const set = (key: string, v: string) => setValues({ ...values, [key]: v });
  return (
    <div className="flex flex-wrap items-end gap-2 rounded-xl border border-dashed border-slate-200 bg-white p-3 text-xs">
      {columns.map((c) => {
        const freeStatus = props.cuaderno && c.key === "estado";
        const freePayment = props.cuaderno && c.key === "metodo_pago";
        return (
          <label key={c.key} className="flex flex-col gap-1">
            <span className="text-slate-500">
              {c.label}
              {c.required ? " *" : ""}
            </span>
            {freeStatus || freePayment ? (
              <>
                <input list={`sheets-add-${c.key}`} value={values[c.key] ?? ""} onChange={(e) => set(c.key, e.target.value)} placeholder={freeStatus ? "Como en el cuaderno" : "Efectivo, Yape GF…"} className={cn(INPUT_XS, "w-40")} />
                <datalist id={`sheets-add-${c.key}`}>
                  {(freeStatus ? props.suggestions : [...REPARTO_PAYMENT_METHODS]).map((o) => (
                    <option key={o} value={o} />
                  ))}
                </datalist>
              </>
            ) : c.data_type === "select" || c.data_type === "status" ? (
              <select value={values[c.key] ?? ""} onChange={(e) => set(c.key, e.target.value)} className={INPUT_XS}>
                <option value="">—</option>
                {(c.data_type === "status" ? props.domain.statuses.filter((s) => s.active).map((s) => ({ v: s.code, l: s.label })) : c.options.map((o) => ({ v: o, l: o }))).map((o) => (
                  <option key={o.v} value={o.v}>
                    {o.l}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type={c.data_type === "number" ? "number" : c.data_type === "date" ? "date" : "text"}
                step={c.data_type === "number" ? "0.01" : undefined}
                value={values[c.key] ?? ""}
                onChange={(e) => set(c.key, e.target.value)}
                className={cn(INPUT_XS, "w-36")}
              />
            )}
          </label>
        );
      })}
      <button type="button" disabled={props.pending} className={BTN_PRIMARY} onClick={() => props.run(() => addSheetRow(props.sheet.id, values), () => setValues({}))}>
        Guardar fila
      </button>
      <button type="button" className="text-slate-500 underline" onClick={() => setOpen(false)}>
        Cerrar
      </button>
    </div>
  );
}
