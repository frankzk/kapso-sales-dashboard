"use client";

// Despacho del día (MOM §29.13): dos pasos en una pantalla.
//   1 · Asignar: la cola de Lima (disponibles + tomados sin ruta) → un
//       motorizado, con tomar+asignar en una sola acción.
//   2 · Cotejar: las cajas de hoy por motorizado, con el cotejo de oficina en
//       línea, y quitar o mover un paquete desde la misma fila.
// Antes esto eran tres pantallas y 9-10 clics (docs/plan/despacho-crm.md).

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { cn } from "@/components/ui";
import { ScanAction } from "@/components/scan-action";
import { activeDispatchItems } from "@/lib/dispatch";
import { boxNextStep, dayBoxes, declinedPackages, splitAssignment, type DayManifest, type RiderBox } from "@/lib/dispatch-day";
import { addToTray, removeFromTray, summarizeScans, type TrayEntry } from "@/lib/dispatch-scan-tray";
import type { DispatchManifest } from "@/lib/dispatch-access";
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
  /** 0175: si el motorizado verifica su caja o la custodia pasa al asignar. */
  riderPickupCheckRequired: boolean;
  pending: boolean;
  run: (action: () => Promise<CourierActionResult>) => void;
}

const money = (n: number) => `S/ ${n.toFixed(2)}`;

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
  const riderName = riders.find((r) => r.id === riderId)?.fullName ?? "";

  const boxes = useMemo(() => dayBoxes(props.manifests as unknown as DayManifest[], day), [props.manifests, day]);
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

  return (
    <section aria-labelledby="dispatch-day-title" className="space-y-4">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h2 id="dispatch-day-title" className="text-base font-semibold text-slate-950">Despacho del día · {formatDay(day)}</h2>
          <p className="mt-1 max-w-4xl text-sm leading-6 text-slate-600">
            Marca pedidos y asígnalos a un motorizado en un paso. A la derecha, su caja: cotéjala aquí mismo y quita o mueve lo que haga falta. El motorizado recibe su caja desde el teléfono y solo entonces ve la ruta.
          </p>
        </div>
        <div className="flex flex-wrap gap-3 text-xs text-slate-600">
          <span><b className="text-slate-900">{queue.length}</b> por asignar</span>
          <span><b className="text-slate-900">{boxes.length}</b> cajas hoy</span>
          <span><b className="text-slate-900">{dayCod}</b> paquetes en cajas</span>
          <span className={cn("rounded-full px-2 py-0.5 font-medium", props.riderPickupCheckRequired ? "bg-sky-100 text-sky-800" : "bg-slate-100 text-slate-700")} title="Se cambia en la base: logistics_providers.rider_pickup_check_required">
            verificación del motorizado: {props.riderPickupCheckRequired ? "activada" : "desactivada · la custodia pasa al asignar"}
          </span>
          {declined.length > 0 && <span className="rounded-full bg-amber-100 px-2 py-0.5 font-semibold text-amber-800">{declined.length} no recogidos</span>}
        </div>
      </div>

      {declined.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <p className="font-semibold">Paquetes que un motorizado no recogió de su caja</p>
          <ul className="mt-1 space-y-1">
            {declined.map((d) => (
              <li key={`${d.manifestId}:${d.shipmentId}`} className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{d.orderName ?? "Pedido"}</span>
                <span className="text-amber-800/80">{d.customerName} · {d.district}</span>
                <span>· no recogido por <b>{d.riderName}</b>: {d.reason}</span>
                <span className="text-amber-800/80">→ vuelve a «por asignar»; márcalo a la izquierda y asígnalo a otro motorizado.</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        {/* ── 1 · Asignar ── */}
        <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">1 · Asignar escaneando</p>
            <p className="mt-1 text-sm text-slate-600">Elige motorizado y escanea QR tras QR: cada lectura toma el pedido, lo pone en su caja y lo deja cotejado. Sin motorizado, los QR se guardan y se asignan todos al elegirlo.</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <select
                value={riderId}
                onChange={(e) => { setRiderId(e.target.value); if (tray.length) void drainTray(e.target.value); }}
                aria-label="Motorizado para escanear"
                className="min-h-10 rounded-lg border border-slate-300 px-2 text-sm"
              >
                <option value="">Escanear primero, elegir después</option>
                {riders.map((r) => <option key={r.id} value={r.id}>{r.fullName}</option>)}
              </select>
              <input type="date" value={scanDay} min={day} onChange={(e) => setScanDay(e.target.value || day)} aria-label="Día de la caja" className="min-h-10 rounded-lg border border-slate-300 px-2 text-sm" />
              <label className="flex items-center gap-1 text-xs text-slate-600" title="Límite de efectivo de la ruta (MOM §29.9)">
                <input type="checkbox" checked={overrideCash} onChange={(e) => setOverrideCash(e.target.checked)} /> Autorizo superar el límite de efectivo
              </label>
            </div>
            {canManageDispatch ? (
              <ScanAction
                context="supervisor_asignacion"
                disabled={pending || draining}
                assign={{ orgId, riderId, scheduledFor: scanDay, overrideCash }}
                onQueue={(code) => setTray((cur) => addToTray(cur, code))}
                onResult={(r) => { if (r.line) pushLine(r.line); }}
              />
            ) : (
              <p className="mt-2 text-xs text-amber-700">Tu rol no organiza rutas: puedes mirar, no asignar.</p>
            )}
            {tray.length > 0 && (
              <div className="mt-3 rounded-lg border border-sky-200 bg-sky-50 p-2 text-sm text-sky-900">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span><b>{tray.length}</b> escaneados en espera de motorizado</span>
                  <button type="button" disabled={!riderId || draining} onClick={() => void drainTray(riderId)} className="min-h-9 rounded-lg bg-sky-700 px-3 text-xs font-semibold text-white disabled:opacity-50">
                    {draining ? "Asignando…" : riderId ? `Asignar los ${tray.length} a ${riderName}` : "Elige motorizado arriba"}
                  </button>
                </div>
                <ul className="mt-1 flex flex-wrap gap-1">
                  {tray.map((e) => (
                    <li key={e.code} className="flex items-center gap-1 rounded-full bg-white px-2 py-0.5 text-xs">
                      <span className="font-mono">{e.code}</span>
                      <button type="button" aria-label={`Quitar ${e.code}`} onClick={() => setTray((cur) => removeFromTray(cur, e.code))} className="text-slate-400 hover:text-red-600">×</button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {lines.length > 0 && (
              <div className="mt-3">
                <div className="flex flex-wrap gap-3 text-xs text-slate-600">
                  <span><b className="text-emerald-700">{summary.assigned}</b> en la caja</span>
                  <span>efectivo previsto <b className="text-slate-900">{money(summary.cash)}</b></span>
                  {summary.alreadyInBox > 0 && <span>{summary.alreadyInBox} ya estaban</span>}
                  {summary.inOtherBox > 0 && <span className="text-amber-700">{summary.inOtherBox} en otra caja</span>}
                  {summary.blocked > 0 && <span className="text-red-700">{summary.blocked} no elegibles</span>}
                  {summary.unknown > 0 && <span className="text-red-700">{summary.unknown} desconocidos</span>}
                  <button type="button" onClick={() => setLines([])} className="ml-auto underline">Limpiar</button>
                </div>
                <ul className="mt-2 max-h-72 divide-y divide-slate-100 overflow-auto rounded-lg border border-slate-200" aria-live="polite">
                  {lines.map((l, i) => (
                    <li key={`${l.code}:${i}`} className={cn("flex flex-wrap items-center gap-2 px-3 py-1.5 text-sm", l.status === "asignado_cotejado" ? "bg-emerald-50/60" : l.status === "ya_en_caja" ? "" : l.status === "en_otra_caja" ? "bg-amber-50/60" : "bg-red-50/60")}>
                      <span className={cn("grid size-5 place-items-center rounded-full text-[11px] font-bold", l.status === "asignado_cotejado" ? "bg-emerald-600 text-white" : l.status === "ya_en_caja" ? "bg-slate-300 text-white" : l.status === "en_otra_caja" ? "bg-amber-500 text-white" : "bg-red-600 text-white")}>{l.status === "asignado_cotejado" ? "✓" : l.status === "en_otra_caja" ? "↔" : l.status === "ya_en_caja" ? "=" : "!"}</span>
                      <span className="font-semibold text-slate-900">{l.orderName ?? l.code}</span>
                      {l.amount != null && <span className="text-xs text-slate-500">{money(l.amount)}</span>}
                      <span className="text-xs text-slate-600">{l.message}</span>
                      {l.cashWarning && <span className="text-xs text-amber-700">{l.cashWarning}</span>}
                      {l.status === "en_otra_caja" && l.manifestId && l.shipmentId && riderId && (
                        <button
                          type="button"
                          disabled={pending || draining}
                          onClick={() => run(async () => moveManifestItem(orgId, l.manifestId!, l.shipmentId!, riderId, `Escaneado en la caja de ${riderName}`))}
                          className="min-h-8 rounded-lg border border-amber-300 px-2 text-xs font-medium text-amber-800 disabled:opacity-50"
                        >
                          Mover a {riderName}
                        </button>
                      )}
                      {l.status === "bloqueado_efectivo" && !overrideCash && (
                        <button type="button" onClick={() => setOverrideCash(true)} className="min-h-8 rounded-lg border border-red-300 px-2 text-xs font-medium text-red-800">Autorizar y volver a escanear</button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <details className="group">
          <summary className="cursor-pointer border-b border-slate-200 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500 hover:bg-slate-50">Asignar desde la lista <span className="font-normal normal-case text-slate-400">· vía secundaria, {queue.length} en cola</span></summary>
          <div className="border-b border-slate-200 px-4 py-3">
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Pedido, cliente o distrito"
                aria-label="Buscar en la cola"
                className="min-h-10 w-52 rounded-lg border border-slate-300 px-3 text-sm"
              />
              <select value={store} onChange={(e) => setStore(e.target.value)} aria-label="Tienda" className="min-h-10 rounded-lg border border-slate-300 px-2 text-sm">
                <option value="">Todas las tiendas</option>
                {stores.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <select value={district} onChange={(e) => setDistrict(e.target.value)} aria-label="Distrito" className="min-h-10 rounded-lg border border-slate-300 px-2 text-sm">
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
            <select value={riderId} onChange={(e) => setRiderId(e.target.value)} aria-label="Motorizado" className="min-h-10 rounded-lg border border-slate-300 px-2 text-sm">
              {!riders.length && <option value="">Sin motorizados</option>}
              {riders.map((r) => <option key={r.id} value={r.id}>{r.fullName}</option>)}
            </select>
            <button
              type="button"
              disabled={pending || !canManageDispatch || !riderId || !selected.size}
              onClick={assign}
              className="min-h-10 rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
            >
              {pending ? "Asignando…" : `Asignar${selected.size ? ` ${selected.size}` : ""} a ${riderName || "…"}`}
            </button>
            <label className="flex items-center gap-1 text-xs text-slate-600" title="Límite de efectivo de la ruta (MOM §29.9)">
              <input type="checkbox" checked={overrideCash} onChange={(e) => setOverrideCash(e.target.checked)} /> Autorizo superar el límite de efectivo
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

        {/* ── 2 · Cotejar por motorizado ── */}
        <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">2 · Cotejar por motorizado</p>
            <p className="mt-1 text-sm text-slate-600">Abre una caja para escanear sus paquetes. Al 100 %, el motorizado la recibe desde su teléfono.</p>
          </div>
          {!boxes.length && <p className="px-4 py-8 text-center text-sm text-slate-500">Todavía no hay cajas hoy. Asigna pedidos a la izquierda.</p>}
          <ul className="divide-y divide-slate-100">
            {boxes.map((box) => (
              <BoxRow
                key={box.riderId ?? box.riderName}
                box={box}
                riders={riders}
                orgId={orgId}
                open={openBox === (box.riderId ?? box.riderName)}
                onToggle={() => setOpenBox(openBox === (box.riderId ?? box.riderName) ? null : (box.riderId ?? box.riderName))}
                canManage={canManageDispatch}
                onChanged={() => router.refresh()}
              />
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

function BoxRow({ box, riders, orgId, open, onToggle, canManage, onChanged }: {
  box: RiderBox;
  riders: CourierRiderOption[];
  orgId: string;
  open: boolean;
  onToggle: () => void;
  canManage: boolean;
  onChanged: () => void;
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
  return (
    <li>
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-slate-50">
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-slate-950">{box.riderName} <span className="text-xs font-normal text-slate-500">· {box.loads.length > 1 ? `${box.loads.length} cargas` : `carga ${load.load_number ?? 1}`}</span></p>
          <p className="text-xs text-slate-600">{box.assigned} asignados · {box.officeChecked} cotejados · {box.pickupChecked} recibidos{box.declined ? ` · ${box.declined} no recogidos` : ""}</p>
        </div>
        <div className="w-40 text-right">
          <p className={cn("text-xs font-medium", load.state === "in_custody" ? "text-emerald-700" : box.officeChecked < box.assigned ? "text-amber-700" : "text-sky-700")}>{boxNextStep(box)}</p>
          <progress value={pct} max={100} aria-label={`Cotejo de ${box.riderName}`} className="mt-1 h-1.5 w-full accent-brand-600" />
        </div>
        <span aria-hidden className="text-slate-400">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="space-y-3 border-t border-slate-100 bg-slate-50/60 px-4 py-3">
          {message && <p role="status" className={cn("rounded-lg px-3 py-2 text-sm", message.ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-700")}>{message.text}</p>}
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
                          {item.pickup_checked_at && <p className="text-[11px] text-emerald-700">recibido por el motorizado</p>}
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
