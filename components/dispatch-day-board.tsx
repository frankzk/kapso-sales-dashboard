"use client";

// Despacho del día (MOM §29.13): dos pasos en una pantalla.
//   1 · Asignar: la cola de Lima (disponibles + tomados sin ruta) → un
//       motorizado, con tomar+asignar en una sola acción.
//   2 · Cotejar: las cajas de hoy por motorizado, con el cotejo de oficina en
//       línea, y quitar o mover un paquete desde la misma fila.
// Antes esto eran tres pantallas y 9-10 clics (docs/plan/despacho-crm.md).

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { cn } from "@/components/ui";
import { Hint } from "@/components/hint";
import { ScanAction } from "@/components/scan-action";
import { activeDispatchItems } from "@/lib/dispatch";
import { boxNextStep, dayBoxes, declinedPackages, splitAssignment, type DayManifest, type RiderBox } from "@/lib/dispatch-day";
import { addToTray, removeFromTray, summarizeScans, type TrayEntry } from "@/lib/dispatch-scan-tray";
import type { DispatchManifest } from "@/lib/dispatch-access";
import type { RiderPickupMode } from "@/lib/grupo-gf-courier";
import {
  assignGroupGfCourierRoute,
  moveManifestItem,
  scanAssignToRider,
  takeAndAssignGroupGfCourierOrders,
  type ScanAssignLine,
  type CourierAcceptedOrder,
  type CourierActionResult,
  type CourierAvailableOrder,
  type CourierRiderOption,
} from "@/app/dashboard/courier/actions";
import { removeManifestItem, scanManifestItem } from "@/app/dashboard/pedidos/despacho/actions";

interface Props {
  orgId: string;
  day: string;
  available: CourierAvailableOrder[];
  accepted: CourierAcceptedOrder[];
  riders: CourierRiderOption[];
  manifests: DispatchManifest[];
  canManageDispatch: boolean;
  /** 0177: exigir (verifica su caja antes de la ruta) · confirmar («Lo llevo» por paquete) · ninguno. */
  riderPickupMode: RiderPickupMode;
  /** Umbrales de efectivo de la ruta (MOM §29.9): aviso y límite. */
  cashWarning: number;
  cashLimit: number;
  pending: boolean;
  run: (action: () => Promise<CourierActionResult>) => void;
}

const money = (n: number) => `S/ ${n.toFixed(2)}`;
/** Sin decimales, para las líneas de una sola fila. */
const moneyShort = (n: number) => `S/ ${Math.round(n).toLocaleString("es-PE")}`;
const HELP_KEY = "kapta.despacho.ayuda-escaneo";

interface QueueRow {
  orderId: string;
  orderName: string;
  storeName: string;
  customerName: string;
  district: string;
  orderTotal: number;
  scheduledFor: string;
  tariffAmount: number;
  /** Ya tomado (solicitud sin ruta) o disponible. */
  taken: boolean;
  requestId: string | null;
  /** Solo los tomados: si Almacén ya lo armó. */
  armed: boolean | null;
  observation: string | null;
}

export function DispatchDayBoard(props: Props) {
  const { orgId, day, riders, canManageDispatch, pending, run } = props;
  const router = useRouter();
  const [riderId, setRiderId] = useState(riders[0]?.id ?? "");
  const [overrideCash, setOverrideCash] = useState(false);
  const [query, setQuery] = useState("");
  const [store, setStore] = useState("");
  const [district, setDistrict] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openBox, setOpenBox] = useState<string | null>(null);
  // Modo escaneo (§29.13): la vía principal. Fecha de la caja, hoy por defecto.
  const [scanDay, setScanDay] = useState(day);
  const [dayOpen, setDayOpen] = useState(false);
  const [boxesOpen, setBoxesOpen] = useState(false);
  // Una línea de ayuda bajo el campo de código que se cierra y no vuelve.
  const [helpDismissed, setHelpDismissed] = useState(true);
  useEffect(() => {
    try {
      setHelpDismissed(window.localStorage.getItem(HELP_KEY) === "1");
    } catch {
      setHelpDismissed(false);
    }
  }, []);
  const dismissHelp = () => {
    setHelpDismissed(true);
    try {
      window.localStorage.setItem(HELP_KEY, "1");
    } catch {
      /* sin almacenamiento: se cierra solo en esta vista */
    }
  };
  const [lines, setLines] = useState<ScanAssignLine[]>([]);
  const [tray, setTray] = useState<TrayEntry[]>([]);
  const [draining, setDraining] = useState(false);
  const summary = useMemo(() => summarizeScans(lines), [lines]);

  function pushLine(line: ScanAssignLine) {
    setLines((cur) => [line, ...cur].slice(0, 200));
    if (line.status === "asignado_cotejado" || line.status === "ya_en_caja") router.refresh();
  }

  /** «Escanear primero»: al elegir motorizado, la bandeja se vacía en la caja de una vez. */
  async function drainTray(targetRiderId: string) {
    if (!targetRiderId || !tray.length || draining) return;
    setDraining(true);
    try {
      for (const entry of tray) {
        const line = await scanAssignToRider(orgId, targetRiderId, entry.code, { overrideCash, scheduledFor: scanDay });
        setLines((cur) => [line, ...cur].slice(0, 200));
        setTray((cur) => removeFromTray(cur, entry.code));
      }
      router.refresh();
    } finally {
      setDraining(false);
    }
  }

  const queue = useMemo<QueueRow[]>(() => {
    const taken: QueueRow[] = props.accepted
      .filter((o) => !o.route)
      .map((o) => ({
        orderId: o.orderId,
        orderName: o.orderName,
        storeName: o.storeName,
        customerName: o.customerName,
        district: o.district,
        orderTotal: o.orderTotal,
        scheduledFor: o.scheduledFor,
        tariffAmount: o.tariffAmount,
        taken: true,
        requestId: o.requestId,
        armed: o.preparationState === "listo_despacho",
        observation: o.observation,
      }));
    const takenIds = new Set(taken.map((t) => t.orderId));
    const free: QueueRow[] = props.available
      .filter((o) => !takenIds.has(o.orderId))
      .map((o) => ({
        orderId: o.orderId,
        orderName: o.orderName,
        storeName: o.storeName,
        customerName: o.customerName,
        district: o.district,
        orderTotal: o.orderTotal,
        scheduledFor: o.scheduledFor,
        tariffAmount: o.tariffAmount,
        taken: false,
        requestId: null,
        armed: null,
        observation: null,
      }));
    return [...taken, ...free];
  }, [props.accepted, props.available]);

  const stores = useMemo(() => [...new Set(queue.map((q) => q.storeName))].sort(), [queue]);
  const districts = useMemo(() => [...new Set(queue.map((q) => q.district))].sort((a, b) => a.localeCompare(b, "es")), [queue]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("es");
    return queue.filter((q) => {
      if (store && q.storeName !== store) return false;
      if (district && q.district !== district) return false;
      if (!needle) return true;
      return `${q.orderName} ${q.customerName} ${q.district} ${q.storeName}`.toLocaleLowerCase("es").includes(needle);
    });
  }, [queue, query, store, district]);
  const visible = filtered.slice(0, 100);
  const allVisibleSelected = visible.length > 0 && visible.every((q) => selected.has(q.orderId));
  const selectedTotal = queue.filter((q) => selected.has(q.orderId)).reduce((sum, q) => sum + q.orderTotal, 0);
  const boxes = useMemo(() => dayBoxes(props.manifests as unknown as DayManifest[], day), [props.manifests, day]);
  const riderName = riders.find((r) => r.id === riderId)?.fullName ?? "";
  const riderBoxCount = (id: string) => boxes.find((b) => b.riderId === id)?.assigned ?? 0;
  /** Efectivo previsto por motorizado hoy: suma de los pedidos tomados con ruta de ese día. */
  const boxCash = useMemo(() => {
    const out = new Map<string, number>();
    for (const o of props.accepted) {
      if (!o.route || o.route.routeDate !== day || !o.route.riderId) continue;
      out.set(o.route.riderId, (out.get(o.route.riderId) ?? 0) + o.orderTotal);
    }
    return out;
  }, [props.accepted, day]);
  const declined = useMemo(() => declinedPackages(boxes), [boxes]);
  const dayCod = boxes.reduce((sum, b) => sum + b.loads.reduce((s, l) => s + activeDispatchItems(l.items).length, 0), 0);

  function toggle(id: string) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function assign() {
    if (!riderId || !selected.size) return;
    const split = splitAssignment(selected, props.available, props.accepted);
    setSelected(new Set());
    run(async () => {
      const messages: string[] = [];
      for (let i = 0; i < split.orderIds.length; i += 50) {
        const r = await takeAndAssignGroupGfCourierOrders(orgId, riderId, split.orderIds.slice(i, i + 50), { overrideCash });
        messages.push(r.error ?? r.notice ?? "");
      }
      if (split.requestIds.length) {
        const r = await assignGroupGfCourierRoute(orgId, riderId, split.requestIds, { overrideCash });
        messages.push([r.notice, r.cashWarning, r.error, ...r.failed.map((f) => f.error)].filter(Boolean).join(" "));
      }
      return { notice: messages.filter(Boolean).join(" ") || `Asignados a ${riderName}.` };
    });
  }

  const riderTail = props.riderPickupMode === "exigir"
    ? " Él verifica la caja antes de ver la ruta."
    : props.riderPickupMode === "confirmar"
      ? " Él confirma cada paquete al cargarlo en la moto («Lo llevo»)."
      : "";
  const helpText = `Escanea con el paquete en la mano: entra a la caja del motorizado y a su ruta.${riderTail} Corte 11:30.`;

  return (
    <section aria-labelledby="dispatch-day-title" className="space-y-3">
      {/* Cabecera: una sola línea. Fecha · contadores · cambiar día. */}
      <div className="flex items-center gap-2 text-xs text-slate-600">
        <h2 id="dispatch-day-title" className="sr-only">Despacho del día</h2>
        <span className="min-w-0 truncate whitespace-nowrap" title={`${queue.length} por asignar${boxes.length ? ` · ${boxes.length} cajas · ${dayCod} paquetes` : ""}`}>
          <b className="text-slate-900">{scanDay === day ? `Hoy, ${formatDayShort(day)}` : formatDayShort(scanDay)}</b>
          {" · "}<span className="tabular-nums">{queue.length.toLocaleString("es-PE")}</span> por asignar
          {boxes.length > 0 && <> · <span className="tabular-nums">{boxes.length}</span> {boxes.length === 1 ? "caja" : "cajas"} · <span className="tabular-nums">{dayCod}</span> paq.</>}
        </span>
        <Hint label="Cómo funciona el despacho" text={helpText} />
        {dayOpen ? (
          <span className="ml-auto flex shrink-0 items-center gap-1">
            <input type="date" value={scanDay} min={day} onChange={(e) => setScanDay(e.target.value || day)} aria-label="Día de la caja" className="min-h-7 rounded-lg border border-slate-300 px-1 text-xs" />
            <button type="button" onClick={() => { setScanDay(day); setDayOpen(false); }} className="underline">hoy</button>
          </span>
        ) : (
          <button type="button" onClick={() => setDayOpen(true)} className="ml-auto shrink-0 whitespace-nowrap text-slate-400 underline-offset-2 hover:text-slate-700 hover:underline" title="Por defecto la caja es de hoy, o del día que dicta el corte de las 11:30">cambiar día</button>
        )}
      </div>

      {declined.length > 0 && (
        <details className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <summary className="cursor-pointer font-semibold">{declined.length} {declined.length === 1 ? "paquete no recogido" : "paquetes no recogidos"} · vuelven a «por asignar»</summary>
          <ul className="mt-1 space-y-1">
            {declined.map((d) => (
              <li key={`${d.manifestId}:${d.shipmentId}`} className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{d.orderName ?? "Pedido"}</span>
                <span className="text-amber-800/80">{d.customerName} · {d.district}</span>
                <span>· no recogido por <b>{d.riderName}</b>: {d.reason}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="grid min-w-0 gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        {/* ── Asignar ── */}
        <div className="min-w-0 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="px-4 py-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
              <div className="min-w-0 flex-1">
                <select
                  value={riderId}
                  onChange={(e) => { setRiderId(e.target.value); if (tray.length) void drainTray(e.target.value); }}
                  aria-label="¿Quién sale hoy?"
                  className="min-h-14 w-full rounded-xl border border-slate-300 bg-white px-3 text-base font-medium text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 sm:min-h-12 sm:text-sm"
                >
                  <option value="">¿Quién sale hoy?</option>
                  {riders.map((r) => <option key={r.id} value={r.id}>{r.fullName}</option>)}
                </select>
                {riderId && riderBoxCount(riderId) > 0 && (
                  <p className="mt-1 truncate text-xs text-slate-500">{riderName} · {riderBoxCount(riderId)} en su caja</p>
                )}
              </div>
              <div className="sm:w-56">
                {canManageDispatch ? (
                  <ScanAction
                    context="supervisor_asignacion"
                    compact
                    disabled={pending || draining}
                    assign={{ orgId, riderId, scheduledFor: scanDay, overrideCash }}
                    onQueue={(code) => setTray((cur) => addToTray(cur, code))}
                    onResult={(r) => { if (r.line) pushLine(r.line); }}
                  />
                ) : (
                  <p className="text-xs text-amber-700">Tu rol no organiza rutas: puedes mirar, no asignar.</p>
                )}
              </div>
            </div>
            {!helpDismissed && canManageDispatch && (
              <p className="mt-2 flex items-center gap-2 text-xs text-slate-500">
                <span className="min-w-0 flex-1">Cada escaneo toma el pedido, lo pone en la caja de {riderName || "quien elijas"} y lo deja cotejado.</span>
                <button type="button" onClick={dismissHelp} aria-label="Cerrar ayuda" className="shrink-0 text-slate-400 hover:text-slate-700">×</button>
              </p>
            )}

            {tray.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-sky-50 px-2 py-1.5 text-xs text-sky-900">
                <span><b>{tray.length}</b> en espera de motorizado</span>
                {tray.map((e) => (
                  <span key={e.code} className="flex items-center gap-1 rounded-full bg-white px-2 py-0.5 font-mono">
                    {e.code}
                    <button type="button" aria-label={`Quitar ${e.code}`} onClick={() => setTray((cur) => removeFromTray(cur, e.code))} className="text-slate-400 hover:text-red-600">×</button>
                  </span>
                ))}
                <button type="button" disabled={!riderId || draining} onClick={() => void drainTray(riderId)} className="ml-auto min-h-8 rounded-lg bg-sky-700 px-3 font-semibold text-white disabled:opacity-50">
                  {draining ? "Asignando…" : riderId ? `Asignar a ${riderName}` : "Elige motorizado"}
                </button>
              </div>
            )}

            {lines.length > 0 && (
              <div className="mt-3">
                <ul className="max-h-72 divide-y divide-slate-100 overflow-auto rounded-xl border border-slate-200" aria-live="polite">
                  {lines.map((l, i) => {
                    const r = scanRowPresentation(l, riderName);
                    return (
                      <li key={`${l.code}:${i}`} className={cn("flex items-center gap-2 px-3 py-1.5 text-sm", r.rowClass)} title={[l.message, l.cashWarning].filter(Boolean).join(" · ")}>
                        <span className="min-w-0 flex-1 truncate">
                          <span className="font-semibold text-slate-900">{l.orderName ?? l.code}</span>
                          <span className={cn("ml-2 text-xs font-medium", r.textClass)}>{r.text}</span>
                        </span>
                        {l.amount != null && <span className="shrink-0 text-xs tabular-nums text-slate-600">{moneyShort(l.amount)}</span>}
                        {l.status === "en_otra_caja" && l.manifestId && l.shipmentId && riderId && (
                          <button type="button" disabled={pending || draining} onClick={() => run(async () => moveManifestItem(orgId, l.manifestId!, l.shipmentId!, riderId, `Escaneado en la caja de ${riderName}`))} className="min-h-8 shrink-0 rounded-lg border border-amber-300 px-2 text-xs font-medium text-amber-800 disabled:opacity-50">Mover</button>
                        )}
                        {l.status === "bloqueado_efectivo" && !overrideCash && (
                          <button type="button" onClick={() => setOverrideCash(true)} title="Autoriza superar el límite de efectivo de la ruta y vuelve a escanear" className="min-h-8 shrink-0 rounded-lg border border-amber-300 px-2 text-xs font-medium text-amber-800">Autorizar</button>
                        )}
                      </li>
                    );
                  })}
                </ul>
                <div className={cn("sticky bottom-0 mt-1 flex items-center gap-2 bg-white py-1 text-xs", summary.cash >= props.cashLimit ? "text-red-700" : summary.cash >= props.cashWarning ? "text-amber-700" : "text-slate-700")}>
                  <span className="min-w-0 truncate whitespace-nowrap" title={`${summary.assigned} en la caja · efectivo previsto ${money(summary.cash)}${summary.cash >= props.cashLimit ? " · supera el límite" : summary.cash >= props.cashWarning ? " · cerca del límite" : ""}${overrideCash ? " · límite autorizado" : ""}`}>
                    <b className="tabular-nums">{summary.assigned}</b> en la caja{riderName ? ` de ${riderName}` : ""} · <b className="tabular-nums">{moneyShort(summary.cash)}</b>
                  </span>
                  <button type="button" onClick={() => setLines([])} className="ml-auto shrink-0 text-slate-500 underline">Limpiar</button>
                </div>
              </div>
            )}
          </div>

          <details className="group border-t border-slate-100">
          <summary className="cursor-pointer px-4 py-2 text-xs text-slate-500 hover:bg-slate-50">Asignar desde la lista</summary>
          <div className="border-b border-slate-200 px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Pedido, cliente o distrito"
                aria-label="Buscar en la cola"
                className="min-h-10 w-full min-w-0 rounded-lg border border-slate-300 px-3 text-sm sm:w-52"
              />
              <select value={store} onChange={(e) => setStore(e.target.value)} aria-label="Tienda" className="min-h-10 min-w-0 flex-1 rounded-lg border border-slate-300 px-2 text-sm sm:flex-none">
                <option value="">Todas las tiendas</option>
                {stores.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <select value={district} onChange={(e) => setDistrict(e.target.value)} aria-label="Distrito" className="min-h-10 min-w-0 flex-1 rounded-lg border border-slate-300 px-2 text-sm sm:flex-none">
                <option value="">Todos los distritos</option>
                {districts.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
              <span className="text-xs text-slate-500">{filtered.length} en cola{filtered.length > 100 ? " · se muestran 100" : ""}</span>
            </div>
          </div>

          <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={allVisibleSelected} onChange={() => setSelected(allVisibleSelected ? new Set() : new Set(visible.map((q) => q.orderId)))} aria-label="Marcar los visibles" />
              <span className="font-medium text-slate-800">{selected.size ? `${selected.size} marcados · ${money(selectedTotal)}` : "Marca pedidos"}</span>
            </label>
            <button
              type="button"
              disabled={pending || !canManageDispatch || !riderId || !selected.size}
              onClick={assign}
              title={riderId ? undefined : "Elige el motorizado arriba"}
              className="min-h-10 max-w-full truncate rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
            >
              {pending ? "Asignando…" : `Asignar${selected.size ? ` ${selected.size}` : ""} a ${riderName || "…"}`}
            </button>
            <label className="flex items-center gap-1 text-xs text-slate-600" title="Límite de efectivo de la ruta (MOM §29.9)">
              <input type="checkbox" checked={overrideCash} onChange={(e) => setOverrideCash(e.target.checked)} /> <span className="whitespace-nowrap">superar el límite</span>
            </label>
          </div>

          <ul className="max-h-[60vh] divide-y divide-slate-100 overflow-auto">
            {visible.map((q) => (
              <li key={q.orderId} className={cn("flex items-start gap-3 px-4 py-2 text-sm hover:bg-slate-50", selected.has(q.orderId) && "bg-brand-50/60")}>
                <input type="checkbox" checked={selected.has(q.orderId)} onChange={() => toggle(q.orderId)} aria-label={`Marcar ${q.orderName}`} className="mt-1" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={`/dashboard/pedidos?q=${encodeURIComponent(q.orderName)}`} className="font-semibold text-slate-950 hover:text-brand-700">{q.orderName}</Link>
                    <span className="text-xs text-slate-500">{q.storeName}</span>
                    <Link href={`/dashboard/pedidos?q=${encodeURIComponent(q.orderName)}&abrir=${encodeURIComponent(q.orderId)}&seccion=historial`} className="text-[11px] text-brand-700 underline">Ver actividad</Link>
                    {q.taken && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-700">tomado · sin caja</span>}
                    {q.taken && q.armed && <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">armado</span>}
                    {q.observation && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800" title={q.observation}>observado</span>}
                  </div>
                  <p className="truncate text-slate-600">{q.customerName} · {q.district}</p>
                </div>
                <div className="text-right text-xs text-slate-600">
                  <p className="font-semibold text-slate-900">{money(q.orderTotal)}</p>
                  <p>tarifa {money(q.tariffAmount)} · {formatDay(q.scheduledFor)}</p>
                </div>
              </li>
            ))}
            {!visible.length && <li className="px-4 py-8 text-center text-sm text-slate-500">Nada por asignar con ese filtro.</li>}
          </ul>
          </details>
        </div>

        {/* ── Cajas de hoy: solo cuando hay cajas; plegadas en móvil, abiertas en escritorio ── */}
        {boxes.length > 0 && (
          <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
            <button
              type="button"
              onClick={() => setBoxesOpen((v) => !v)}
              aria-expanded={boxesOpen}
              className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-semibold text-slate-900 xl:cursor-default"
            >
              Cajas de hoy
              <span className="text-xs font-normal tabular-nums text-slate-500">{boxes.length} · {dayCod} paq.</span>
              <span aria-hidden className="ml-auto text-slate-400 xl:hidden">{boxesOpen ? "▾" : "▸"}</span>
            </button>
            <ul className={cn("divide-y divide-slate-100 border-t border-slate-100", boxesOpen ? "block" : "hidden", "xl:block")}>
              {boxes.map((box) => (
                <BoxRow
                  key={box.riderId ?? box.riderName}
                  box={box}
                  cash={box.riderId ? (boxCash.get(box.riderId) ?? 0) : 0}
                  riders={riders}
                  orgId={orgId}
                  open={openBox === (box.riderId ?? box.riderName)}
                  onToggle={() => setOpenBox(openBox === (box.riderId ?? box.riderName) ? null : (box.riderId ?? box.riderName))}
                  canManage={canManageDispatch}
                  onChanged={() => router.refresh()}
                  pickupMode={props.riderPickupMode}
                />
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}

function BoxRow({ box, cash, riders, orgId, open, onToggle, canManage, onChanged, pickupMode }: {
  box: RiderBox;
  /** Efectivo previsto de la caja. */
  cash: number;
  riders: CourierRiderOption[];
  orgId: string;
  open: boolean;
  onToggle: () => void;
  canManage: boolean;
  onChanged: () => void;
  pickupMode: RiderPickupMode;
}) {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [scanMode, setScanMode] = useState<"oficina_cotejo" | "supervisor_retiro">("oficina_cotejo");
  const load = box.loads[0]!;
  const canCheck = canManage && !["in_custody", "cancelled"].includes(load.state);
  const say = (r: { error?: string; notice?: string }) => {
    setMessage(r.error ? { ok: false, text: r.error } : r.notice ? { ok: true, text: r.notice } : null);
    if (!r.error) onChanged();
  };
  const scan = (manifestId: string, code: string) => start(async () => say(await scanManifestItem(manifestId, code, "office")));
  const remove = (manifestId: string, shipmentId: string) => {
    const reason = window.prompt("¿Por qué se quita este paquete de la caja?");
    if (!reason) return;
    start(async () => say(await removeManifestItem(manifestId, shipmentId, reason)));
  };
  const move = (manifestId: string, shipmentId: string, targetRiderId: string) => {
    const reason = window.prompt("¿Por qué cambia de motorizado?");
    if (!reason) return;
    start(async () => say(await moveManifestItem(orgId, manifestId, shipmentId, targetRiderId, reason)));
  };
  const pct = box.assigned ? Math.round((box.officeChecked / box.assigned) * 100) : 0;
  // Modo «confirmar» (0177): lo asignado que el motorizado aún no confirmó con
  // «Lo llevo». Se puede quitar o mover desde aquí; el RPC borra su parada.
  const confirmMode = pickupMode === "confirmar";
  const unconfirmed = confirmMode
    ? box.loads.filter((m) => m.state === "in_custody").flatMap((m) => activeDispatchItems(m.items).filter((i) => !i.pickup_checked_at).map((i) => ({ manifestId: m.id, item: i })))
    : [];
  return (
    <li>
      <button type="button" onClick={onToggle} aria-expanded={open} title={`${boxNextStep(box)} · ${box.assigned} asignados · ${box.officeChecked} cotejados · ${box.pickupChecked} ${confirmMode ? "confirmados" : "recibidos"}${box.declined ? ` · ${box.declined} no recogidos` : ""}${box.loads.length > 1 ? ` · ${box.loads.length} cargas` : ""}`} className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm hover:bg-slate-50">
        <span className="min-w-0 flex-1 truncate whitespace-nowrap">
          <span className="font-semibold text-slate-950">{box.riderName}</span>
          <span className="text-slate-600"> · <span className="tabular-nums">{box.assigned}</span> paq. · <span className="tabular-nums">{moneyShort(cash)}</span></span>
          {confirmMode
            ? <span className={cn("text-xs tabular-nums", box.pickupChecked < box.assigned ? "text-amber-700" : "text-emerald-700")}> · conf. {box.pickupChecked}/{box.assigned}</span>
            : <span className={cn("text-xs tabular-nums", load.state === "in_custody" ? "text-emerald-700" : box.officeChecked < box.assigned ? "text-amber-700" : "text-sky-700")}> · cot. {box.officeChecked}/{box.assigned}</span>}
          {box.declined ? <span className="text-xs text-amber-700"> · {box.declined} no rec.</span> : null}
        </span>
        <span aria-hidden className="shrink-0 text-slate-400">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="space-y-3 border-t border-slate-100 bg-slate-50/60 px-4 py-3">
          {message && <p role="status" className={cn("rounded-lg px-3 py-2 text-sm", message.ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-700")}>{message.text}</p>}
          {confirmMode && unconfirmed.length > 0 && (
            <details className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              <summary className="cursor-pointer font-semibold">Sin confirmar por {box.riderName} · {unconfirmed.length}</summary>
              <p className="mt-1 text-xs text-amber-800/80">Asignados que todavía no escaneó al sacarlos del almacén. Si no se los llevó, quítalos o muévelos: vuelven a «por asignar».</p>
              <ul className="mt-1 divide-y divide-amber-100">
                {unconfirmed.map(({ manifestId, item }) => {
                  const s = item.shipment;
                  const code = s?.output_code ?? s?.guide_code ?? s?.order_name ?? "";
                  return (
                    <li key={item.id} className="flex items-center gap-2 py-1.5">
                      <span className="min-w-0 flex-1 truncate"><span className="font-medium">{s?.order_name ?? code}</span> <span className="text-xs text-amber-800/80">{s?.customer_name} · {s?.district}</span></span>
                      {canManage && (
                        <>
                          <select
                            aria-label={`Mover ${s?.order_name ?? code} a otro motorizado`}
                            defaultValue=""
                            disabled={pending}
                            onChange={(e) => { const v = e.target.value; e.target.value = ""; if (v) move(manifestId, item.shipment_id, v); }}
                            className="min-h-9 rounded-lg border border-amber-300 bg-white px-1 text-xs"
                          >
                            <option value="">Mover a…</option>
                            {riders.filter((r) => r.id !== box.riderId).map((r) => <option key={r.id} value={r.id}>{r.fullName}</option>)}
                          </select>
                          <button type="button" disabled={pending} onClick={() => remove(manifestId, item.shipment_id)} className="min-h-9 rounded-lg px-2 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-50">Quitar</button>
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
            </details>
          )}
          {box.loads.map((m) => {
            const active = activeDispatchItems(m.items);
            const removed = m.items.filter((i) => !!i.removed_at);
            const checkable = canCheck && !["in_custody", "cancelled"].includes(m.state);
            return (
              <div key={m.id} className="rounded-lg border border-slate-200 bg-white">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-3 py-2 text-xs">
                  <span className="font-medium text-slate-700">Carga {m.load_number ?? 1} · {stateLabel(m.state)}</span>
                  <Link href={`/dashboard/courier/rutas?manifiesto=${encodeURIComponent(m.id)}`} className="text-brand-700 underline">Abrir en la mesa</Link>
                </div>
                {checkable && (
                  <div className="px-3 pb-2">
                    <div className="mt-2 flex gap-1 text-xs" role="group" aria-label="Qué hace el escaneo">
                      {([["oficina_cotejo", "Cotejar"], ["supervisor_retiro", "Retirar"]] as const).map(([mode, text]) => (
                        <button key={mode} type="button" onClick={() => setScanMode(mode)} aria-pressed={scanMode === mode} className={cn("rounded-full px-3 py-1 font-medium", scanMode === mode ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-700")}>{text}</button>
                      ))}
                    </div>
                    <ScanAction context={scanMode} manifestId={m.id} disabled={pending} onResult={(r) => say(r)} />
                  </div>
                )}
                <ul className="divide-y divide-slate-100">
                  {active.map((item) => {
                    const s = item.shipment;
                    const code = s?.output_code ?? s?.guide_code ?? s?.order_name ?? "";
                    return (
                      <li key={item.id} className={cn("flex items-center gap-2 px-3 py-2 text-sm", item.office_checked_at ? "bg-emerald-50/50" : "")}>
                        <span aria-label={item.office_checked_at ? "Cotejado" : "Pendiente"} className={cn("grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-bold", item.office_checked_at ? "bg-emerald-600 text-white" : "bg-slate-200 text-slate-600")}>{item.office_checked_at ? "✓" : "·"}</span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium text-slate-900">{s?.order_name ?? code} <span className="text-xs font-normal text-slate-500">{s?.customer_name} · {s?.district}</span></p>
                          {item.pickup_checked_at && <p className="text-[11px] text-emerald-700">{confirmMode ? "lo lleva" : "recibido por el motorizado"}</p>}
                          {confirmMode && m.state === "in_custody" && !item.pickup_checked_at && <p className="text-[11px] text-amber-700">por confirmar</p>}
                          {s?.order_name && <Link href={`/dashboard/pedidos?q=${encodeURIComponent(s.order_name)}&abrir=${encodeURIComponent(s.order_id ?? "")}&seccion=historial`} className="text-[11px] text-brand-700 underline">Ver actividad</Link>}
                        </div>
                        {checkable && !item.office_checked_at && code && (
                          <button type="button" disabled={pending} onClick={() => scan(m.id, code)} className="min-h-9 rounded-lg border border-slate-300 px-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">Cotejar</button>
                        )}
                        {checkable && (
                          <>
                            <select
                              aria-label={`Mover ${s?.order_name ?? code} a otro motorizado`}
                              defaultValue=""
                              disabled={pending}
                              onChange={(e) => { const v = e.target.value; e.target.value = ""; if (v) move(m.id, item.shipment_id, v); }}
                              className="min-h-9 rounded-lg border border-slate-300 px-1 text-xs"
                            >
                              <option value="">Mover a…</option>
                              {riders.filter((r) => r.id !== box.riderId).map((r) => <option key={r.id} value={r.id}>{r.fullName}</option>)}
                            </select>
                            <button type="button" disabled={pending} onClick={() => remove(m.id, item.shipment_id)} className="min-h-9 rounded-lg px-2 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50">Quitar</button>
                          </>
                        )}
                      </li>
                    );
                  })}
                  {!active.length && <li className="px-3 py-4 text-center text-xs text-slate-500">Sin paquetes activos.</li>}
                </ul>
                {removed.length > 0 && (
                  <details className="border-t border-slate-100 px-3 py-2 text-xs text-slate-600">
                    <summary className="cursor-pointer">Retirados o no recogidos ({removed.length})</summary>
                    <ul className="mt-1 space-y-1">
                      {removed.map((i) => <li key={i.id}>{i.shipment?.order_name ?? i.shipment_id} · {i.removal_reason}</li>)}
                    </ul>
                  </details>
                )}
              </div>
            );
          })}
        </div>
      )}
    </li>
  );
}

function stateLabel(state: string): string {
  return ({
    draft: "sin cotejar",
    office_check: "cotejo de oficina",
    ready_for_pickup: "lista para que la reciba",
    pickup_check: "el motorizado está recibiendo",
    in_custody: "en poder del motorizado",
    cancelled: "cancelada",
  } as Record<string, string>)[state] ?? state;
}

function formatDay(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : value;
}

const MONTHS_SHORT = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "set", "oct", "nov", "dic"];

/** `2026-09-19` → «19 set». */
function formatDayShort(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return value;
  return `${Number(m[3])} ${MONTHS_SHORT[Number(m[2]) - 1] ?? m[2]}`;
}

/**
 * Cómo se lee el resultado de un escaneo en su fila, con color por gravedad:
 * verde entró, ámbar hay algo que decidir (mover, autorizar, ya estaba), rojo
 * no entró.
 */
function scanRowPresentation(l: ScanAssignLine, riderName: string): { text: string; textClass: string; rowClass: string } {
  switch (l.status) {
    case "asignado_cotejado":
      return { text: `En la caja de ${l.riderName ?? riderName}`, textClass: "text-emerald-700", rowClass: "bg-emerald-50/50" };
    case "ya_en_caja":
      return { text: "Ya estaba", textClass: "text-amber-700", rowClass: "bg-amber-50/40" };
    case "en_otra_caja":
      return { text: `En la caja de ${l.riderName ?? "otro"} → Mover`, textClass: "text-amber-700", rowClass: "bg-amber-50/40" };
    case "bloqueado_efectivo":
      return { text: "Límite de efectivo → Autorizar", textClass: "text-amber-700", rowClass: "bg-amber-50/40" };
    case "no_elegible":
      return { text: l.message ? `No elegible: ${l.message.replace(/\.$/, "")}` : "No elegible", textClass: "text-red-700", rowClass: "bg-red-50/50" };
    default:
      return { text: "QR desconocido", textClass: "text-red-700", rowClass: "bg-red-50/50" };
  }
}
