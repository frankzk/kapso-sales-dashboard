"use client";

// Pantalla de liquidaciones de motorizados.
//
// Un principio manda en toda la pantalla: la diferencia se MUESTRA, nunca se
// esconde ni se corrige sola. El cuadre contra el Master y el cuadre del
// depósito se enseñan por separado (son problemas distintos), y el botón de
// cerrar se niega mientras queden líneas sin vincular, salvo que alguien con
// permiso decida cerrarlo a conciencia.

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, EmptyState, Section, cn, STICKY_HEAD, TABLE_WRAP } from "@/components/ui";
import { VERDICT_LABELS, type ReconciledSettlement, type SettlementVerdict } from "@/lib/settlements";
import type { RiderPayout } from "@/lib/settlements";
import type { RiderRow, SettlementDetail, SettlementRow } from "@/lib/settlements-access";
import {
  applySettlementToMaster,
  closeSettlement,
  correctSettlementLineValues,
  createRider,
  recheckSettlement,
  relinkLine,
  searchSettlementOrders,
  updateSettlementHeader,
  type SettlementOrderCandidate,
} from "@/app/dashboard/liquidaciones/actions";

interface StoreOpt {
  id: string;
  name: string;
}

const money = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : `S/ ${n.toFixed(2)}`;

const STATUS_STYLE: Record<string, string> = {
  borrador: "bg-slate-100 text-slate-600",
  cuadrada: "bg-emerald-50 text-emerald-700",
  con_descuadre: "bg-amber-50 text-amber-700",
  cerrada: "bg-slate-800 text-white",
};
const STATUS_LABEL: Record<string, string> = {
  borrador: "Borrador",
  cuadrada: "Sin diferencias",
  con_descuadre: "Revisión necesaria",
  cerrada: "Cerrada",
};

const SETTLEMENT_COURIERS = [
  { id: "axel", label: "Axel Courier" },
  { id: "aliclik", label: "Aliclik" },
  { id: "swayp", label: "Swayp (antes Fénix)" },
  { id: "urpi", label: "Urpi" },
  { id: "tanders", label: "Tanders" },
] as const;

function courierLabel(id: string | null | undefined): string | null {
  if (!id) return null;
  return SETTLEMENT_COURIERS.find((courier) => courier.id === id.toLowerCase())?.label ?? id;
}

const VERDICT_STYLE: Record<SettlementVerdict, string> = {
  conforme: "bg-emerald-50 text-emerald-700",
  cobro_de_mas: "bg-sky-50 text-sky-700",
  cobro_de_menos: "bg-amber-50 text-amber-700",
  entregado_sin_cobro: "bg-red-50 text-red-700",
  cobro_sin_entrega: "bg-red-50 text-red-700",
  sin_pedido: "bg-slate-100 text-slate-600",
};

export function SettlementsBoard({
  stores,
  riders,
  settlements,
  detail,
  payout,
  canEdit,
  canClose,
}: {
  stores: StoreOpt[];
  riders: RiderRow[];
  settlements: SettlementRow[];
  detail: SettlementDetail | null;
  payout: RiderPayout | null;
  canEdit: boolean;
  canClose: boolean;
}) {
  const router = useRouter();
  const [msg, setMsg] = useState<string | null>(null);

  const responsibilityName = (settlement: SettlementRow) =>
    courierLabel(settlement.courier) ??
    riders.find((r) => r.id === settlement.rider_id)?.full_name ??
    settlement.rider_name_raw ??
    "Sin responsable";

  return (
    <div className="space-y-6">
      <Section title="Liquidaciones de couriers y motorizados">
        <p className="text-sm text-slate-500">
          Sube una <strong className="font-medium text-slate-700">foto</strong> o un{" "}
          <strong className="font-medium text-slate-700">Excel/CSV</strong>. Kapta conserva lo
          reportado y lo compara con el Master. Las diferencias quedan visibles y toda corrección
          manual guarda historial.
        </p>
      </Section>

      {msg && (
        <Card className="border-brand-200 bg-brand-50 p-3 text-sm text-brand-800">{msg}</Card>
      )}

      {canEdit && <UploadPanel stores={stores} riders={riders} onDone={setMsg} />}

      <Card className="p-0">
        <div className={TABLE_WRAP}>
          <table className="w-full min-w-[720px] text-sm">
            <thead className={cn(STICKY_HEAD, "bg-slate-50 text-left text-xs text-slate-500")}>
              <tr>
                <th className="px-4 py-2.5 font-medium">Fecha</th>
                <th className="px-4 py-2.5 font-medium">Responsable del lote</th>
                <th className="px-4 py-2.5 font-medium">Origen</th>
                <th className="px-4 py-2.5 font-medium">Depósito registrado</th>
                <th className="px-4 py-2.5 font-medium">Pago motorizado</th>
                <th className="px-4 py-2.5 font-medium">Estado</th>
              </tr>
            </thead>
            <tbody>
              {settlements.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-10">
                    <EmptyState title="Todavía no hay liquidaciones">
                      Sube la primera hoja arriba.
                    </EmptyState>
                  </td>
                </tr>
              )}
              {settlements.map((s) => {
                const open = detail?.settlement.id === s.id;
                return (
                  <tr
                    key={s.id}
                    onClick={() =>
                      router.push(open ? "/dashboard/liquidaciones" : `/dashboard/liquidaciones?id=${s.id}`)
                    }
                    className={cn(
                      "cursor-pointer border-b border-slate-100 hover:bg-slate-50",
                      open && "bg-slate-50",
                    )}
                  >
                    <td className="px-4 py-2.5 font-medium text-slate-800">{s.settlement_date}</td>
                    <td className="px-4 py-2.5 text-slate-700">
                      {responsibilityName(s)}
                    </td>
                    <td className="px-4 py-2.5 text-slate-500">
                      {s.source === "foto" ? "📷 Foto" : s.source === "hoja" ? "📄 Hoja" : "✍️ Manual"}
                    </td>
                    <td className="px-4 py-2.5 text-slate-700">
                      {money(Number(s.declared_cash) + Number(s.declared_yape))}
                    </td>
                    <td className="px-4 py-2.5 text-slate-700">{money(s.payout_amount)}</td>
                    <td className="px-4 py-2.5">
                      <span
                        className={cn(
                          "rounded-full px-2 py-0.5 text-xs font-medium",
                          STATUS_STYLE[s.status] ?? "bg-slate-100 text-slate-600",
                        )}
                      >
                        {STATUS_LABEL[s.status] ?? s.status}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {detail && (
        <SettlementDetailPanel
          detail={detail}
          payout={payout}
          riders={riders}
          canEdit={canEdit}
          canClose={canClose}
          onDone={setMsg}
        />
      )}
    </div>
  );
}

function UploadPanel({
  stores,
  riders,
  onDone,
}: {
  stores: StoreOpt[];
  riders: RiderRow[];
  onDone: (m: string) => void;
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [storeId, setStoreId] = useState(stores.length > 1 ? "__all__" : (stores[0]?.id ?? ""));
  const [responsibility, setResponsibility] = useState("");
  const [date, setDate] = useState("");
  const [cash, setCash] = useState("");
  const [yape, setYape] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function upload() {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setErr("Elige la foto o el Excel de la liquidación.");
      return;
    }
    setBusy(true);
    setErr(null);
    const fd = new FormData();
    fd.append("file", file);
    fd.append("storeId", storeId);
    if (responsibility.startsWith("courier:")) {
      fd.append("courier", responsibility.slice("courier:".length));
    }
    if (responsibility.startsWith("rider:")) {
      fd.append("riderId", responsibility.slice("rider:".length));
    }
    if (date) fd.append("settlementDate", date);
    if (cash) fd.append("declaredCash", cash);
    if (yape) fd.append("declaredYape", yape);
    try {
      const res = await fetch("/api/settlements/upload", { method: "POST", body: fd });
      const json = await res.json();
      if (!res.ok) {
        setErr(json.error ?? "No se pudo cargar.");
      } else if (json.duplicate) {
        onDone("Ese archivo ya estaba cargado; no se duplicó nada.");
        router.push(`/dashboard/liquidaciones?id=${json.settlementId}`);
      } else {
        if (fileRef.current) fileRef.current.value = "";
        onDone(
          `Liquidación cargada desde ${json.source === "foto" ? "la foto" : "la hoja"}: ` +
            `${json.inserted} líneas — ${json.linked} con pedido, ${json.review} a revisión.`,
        );
        router.push(`/dashboard/liquidaciones?id=${json.settlementId}`);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error de red.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-3 p-4">
      <h3 className="text-sm font-semibold text-slate-800">Cargar una liquidación</h3>
      <div className="flex flex-wrap gap-2">
        <select
          value={storeId}
          onChange={(e) => setStoreId(e.target.value)}
          className="rounded-lg border border-slate-300 px-2 py-2 text-sm"
        >
          {stores.length > 1 && (
            <option value="__all__">Aurela + Kenku (según CLIENTE)</option>
          )}
          {stores.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <select
          value={responsibility}
          onChange={(e) => setResponsibility(e.target.value)}
          className="rounded-lg border border-slate-300 px-2 py-2 text-sm"
        >
          <option value="">Courier o motorizado (asignar después)</option>
          <optgroup label="Couriers">
            {SETTLEMENT_COURIERS.map((courier) => (
              <option key={courier.id} value={`courier:${courier.id}`}>
                {courier.label}
              </option>
            ))}
          </optgroup>
          <optgroup label="Motorizados propios">
            {riders.map((r) => (
              <option key={r.id} value={`rider:${r.id}`}>
                {r.full_name}
              </option>
            ))}
          </optgroup>
        </select>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="rounded-lg border border-slate-300 px-2 py-2 text-sm"
        />
        <input
          value={cash}
          onChange={(e) => setCash(e.target.value)}
          placeholder="Efectivo depositado"
          className="w-44 rounded-lg border border-slate-300 px-2 py-2 text-sm"
        />
        <input
          value={yape}
          onChange={(e) => setYape(e.target.value)}
          placeholder="Yape depositado"
          className="w-40 rounded-lg border border-slate-300 px-2 py-2 text-sm"
        />
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/*,.csv,.xlsx,text/csv"
        className="block text-sm text-slate-600"
      />
      <p className="text-xs text-slate-400">
        Foto del cuaderno o Excel/CSV del courier. La foto se transcribe y lo ilegible queda en
        blanco para que lo completes: nunca se inventa un monto. La fecha que pongas manda sobre la
        que traiga el archivo. En reportes de Axel, la columna CLIENTE decide si cada fila pertenece
        a Aurela o Kenku.
      </p>
      {err && <p className="text-sm text-red-600">{err}</p>}
      <button
        onClick={upload}
        disabled={busy}
        className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
      >
        {busy ? "Leyendo…" : "Cargar liquidación"}
      </button>
    </Card>
  );
}

function SettlementDetailPanel({
  detail,
  payout,
  riders,
  canEdit,
  canClose,
  onDone,
}: {
  detail: SettlementDetail;
  payout: RiderPayout | null;
  riders: RiderRow[];
  canEdit: boolean;
  canClose: boolean;
  onDone: (m: string) => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [deduct, setDeduct] = useState(false);
  const { settlement, reconciled, orderNames } = detail;
  const closed = settlement.status === "cerrada";

  const run = (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>) =>
    start(async () => {
      setErr(null);
      const res = await fn();
      if (!res.ok) setErr(res.error ?? "No se pudo completar.");
      else {
        onDone(res.message ?? "Listo.");
        router.refresh();
      }
    });

  return (
    <Card className="space-y-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-800">
          Liquidación del {settlement.settlement_date}
          {closed && <span className="ml-2 text-xs font-normal text-slate-500">· cerrada</span>}
        </h3>
        <button
          onClick={() => router.push("/dashboard/liquidaciones")}
          className="text-xs text-slate-500 hover:text-slate-700"
        >
          Cerrar detalle
        </button>
      </div>

      <TotalsGrid
        reconciled={reconciled}
        payout={payout}
        courier={settlement.courier}
      />

      {err && <p className="text-sm text-red-600">{err}</p>}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="border-b border-slate-200 text-left text-xs text-slate-500">
            <tr>
              <th className="px-3 py-2 font-medium">Cliente</th>
              <th className="px-3 py-2 font-medium">Pedido</th>
              <th className="px-3 py-2 font-medium">Reportado cobrado</th>
              <th className="px-3 py-2 font-medium">Comisión reportada</th>
              <th className="px-3 py-2 font-medium">Esperado según Kapta</th>
              <th className="px-3 py-2 font-medium">Diferencia</th>
              <th className="min-w-[220px] px-3 py-2 font-medium">Resultado de validación</th>
              {canEdit && !closed && <th className="px-3 py-2 font-medium" />}
            </tr>
          </thead>
          <tbody>
            {reconciled.lines.map((r) => (
              <tr key={r.line.id} className="border-b border-slate-100">
                <td className="px-3 py-2 text-slate-700">
                  {r.line.customer_name ?? r.line.guide_code ?? "—"}
                  {r.line.district && (
                    <span className="block text-[11px] text-slate-400">{r.line.district}</span>
                  )}
                  {(r.line.store_hint || r.line.declared_status) && (
                    <span className="block text-[11px] font-medium text-slate-500">
                      {[r.line.store_hint, r.line.declared_status].filter(Boolean).join(" · ")}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-slate-700">
                  {r.line.order_id
                    ? (orderNames[r.line.order_id] ?? r.line.order_name ?? "—")
                    : (r.line.order_name ?? "—")}
                </td>
                <td className="px-3 py-2 text-slate-700">{money(r.declared)}</td>
                <td className="px-3 py-2 text-slate-500">
                  {r.line.declared_fee === null || r.line.declared_fee === undefined
                    ? "—"
                    : money(r.line.declared_fee)}
                </td>
                <td className="px-3 py-2 text-slate-500">
                  {r.verdict === "sin_pedido" ? "—" : money(r.expected)}
                </td>
                <td
                  className={cn(
                    "px-3 py-2 font-medium",
                    r.difference < 0 ? "text-red-600" : r.difference > 0 ? "text-sky-700" : "text-slate-400",
                  )}
                >
                  {r.verdict === "sin_pedido" ? "—" : money(r.difference)}
                </td>
                <td className="px-3 py-2">
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-xs font-medium",
                      VERDICT_STYLE[r.verdict],
                    )}
                  >
                    {VERDICT_LABELS[r.verdict]}
                  </span>
                </td>
                {canEdit && !closed && (
                  <td className="min-w-[300px] px-3 py-2 text-right">
                    <div className="flex flex-col items-end gap-2">
                      {r.verdict === "sin_pedido" && r.line.match_status === "review" && (
                        <RowMatchPicker
                          settlementId={settlement.id}
                          lineId={r.line.id}
                          disabled={pending}
                          onRun={run}
                        />
                      )}
                      <LineCorrectionForm
                        settlementId={settlement.id}
                        lineId={r.line.id}
                        declaredAmount={r.line.declared_amount}
                        declaredFee={r.line.declared_fee ?? null}
                        disabled={pending}
                        onRun={run}
                      />
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {reconciled.totals.reviewCount > 0 && (
        <p className="text-xs text-amber-700">
          {reconciled.totals.reviewCount} línea(s) requieren confirmación. Revisa la tienda,
          el nombre, el distrito y el monto; asigna el pedido correcto o marca &quot;sin
          pedido&quot;. No se podrá procesar la liquidación mientras queden pendientes.
        </p>
      )}

      {canEdit && !closed && (
        <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
          <SettlementResponsibilityPicker
            settlementId={settlement.id}
            riders={riders}
            currentRider={settlement.rider_id}
            currentCourier={settlement.courier}
            cash={Number(settlement.declared_cash)}
            yape={Number(settlement.declared_yape)}
            note={settlement.note}
            disabled={pending}
            onRun={run}
          />
          <button
            disabled={pending}
            onClick={() => run(() => applySettlementToMaster(settlement.id))}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            title="Marca en el Master las entregas y rechazos que declara esta liquidación"
          >
            Aplicar al Master
          </button>
          <button
            disabled={pending}
            onClick={() => run(() => recheckSettlement(settlement.id))}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            Actualizar validación
          </button>
          {canClose && (
            <>
              {!settlement.courier && (
                <label className="flex items-center gap-1.5 text-xs text-slate-600">
                  <input
                    type="checkbox"
                    checked={deduct}
                    onChange={(e) => setDeduct(e.target.checked)}
                  />
                  Descontar el faltante del pago
                </label>
              )}
              <button
                disabled={pending}
                onClick={() =>
                  run(() => closeSettlement(settlement.id, { deductShortfall: deduct }))
                }
                className="rounded-lg bg-slate-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-900 disabled:opacity-50"
              >
                {settlement.courier ? "Cerrar lote" : "Cerrar y fijar el pago"}
              </button>
            </>
          )}
        </div>
      )}

      {closed && (
        <p className="border-t border-slate-100 pt-3 text-xs text-slate-500">
          Cerrada el {settlement.closed_at?.slice(0, 10)}.{" "}
          {settlement.courier ? (
            <>La comisión del courier quedó fijada con los valores revisados.</>
          ) : (
            <>
              Pago congelado en{" "}
              <strong className="text-slate-700">{money(settlement.payout_amount)}</strong>.
            </>
          )}{" "}
          Si hay que corregir algo, abre una liquidación de ajuste.
        </p>
      )}
    </Card>
  );
}

function RowMatchPicker({
  settlementId,
  lineId,
  disabled,
  onRun,
}: {
  settlementId: string;
  lineId: string;
  disabled: boolean;
  onRun: (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<SettlementOrderCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const search = async () => {
    setOpen(true);
    setSearching(true);
    setSearchError(null);
    const result = await searchSettlementOrders(settlementId, lineId, query);
    setSearching(false);
    if (!result.ok) {
      setSearchError(result.error ?? "No se pudo buscar.");
      setCandidates([]);
      return;
    }
    setCandidates(result.candidates ?? []);
  };

  if (!open) {
    return (
      <div className="flex justify-end gap-2">
        <button
          type="button"
          disabled={disabled}
          onClick={search}
          className="rounded-md bg-brand-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50"
        >
          Cotejar pedido
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onRun(() => relinkLine(settlementId, lineId, null))}
          className="rounded-md border border-slate-300 px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50"
        >
          Sin pedido
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50/60 p-2 text-left">
      <div className="flex gap-1.5">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void search();
            }
          }}
          placeholder="Nombre, pedido o distrito"
          className="min-w-0 flex-1 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs"
        />
        <button
          type="button"
          disabled={searching || disabled}
          onClick={search}
          className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs font-medium text-slate-700 disabled:opacity-50"
        >
          {searching ? "Buscando…" : "Buscar"}
        </button>
      </div>
      {searchError && <p className="text-[11px] text-red-600">{searchError}</p>}
      {!searching && candidates.length === 0 && (
        <p className="text-[11px] text-slate-500">
          Sin coincidencias seguras. Prueba con el código del pedido o más parte del nombre.
        </p>
      )}
      <div className="max-h-52 space-y-1 overflow-y-auto">
        {candidates.map((candidate) => (
          <button
            key={candidate.orderId}
            type="button"
            disabled={disabled}
            onClick={() => onRun(() => relinkLine(settlementId, lineId, candidate.orderId))}
            className={cn(
              "block w-full rounded-md border bg-white p-2 text-left hover:border-brand-300 hover:bg-brand-50 disabled:opacity-50",
              candidate.warnings.length ? "border-amber-400" : "border-slate-200",
            )}
          >
            <span className="flex items-center justify-between gap-2">
              <strong className="text-xs text-slate-800">{candidate.orderName}</strong>
              <span className="text-[10px] font-semibold text-brand-700">
                {candidate.score} pts
              </span>
            </span>
            <span className="block text-[11px] text-slate-600">
              {candidate.storeName} · {candidate.customerName} · {candidate.district}
            </span>
            <span className="block text-[10px] text-slate-400">
              {candidate.total === null ? "Monto —" : money(candidate.total)} · {candidate.status}
              {candidate.reasons.length ? ` · ${candidate.reasons.join(", ")}` : ""}
            </span>
            {candidate.warnings.map((warning) => (
              <span key={warning} className="mt-1 block text-[10px] font-medium text-amber-700">
                Revisa antes de vincular: {warning}
              </span>
            ))}
          </button>
        ))}
      </div>
      <div className="flex justify-between gap-2">
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-[11px] text-slate-500 underline"
        >
          Cancelar
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onRun(() => relinkLine(settlementId, lineId, null))}
          className="text-[11px] text-slate-600 underline"
        >
          Confirmar que no tiene pedido
        </button>
      </div>
    </div>
  );
}

function LineCorrectionForm({
  settlementId,
  lineId,
  declaredAmount,
  declaredFee,
  disabled,
  onRun,
}: {
  settlementId: string;
  lineId: string;
  declaredAmount: number | null;
  declaredFee: number | null;
  disabled: boolean;
  onRun: (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(declaredAmount === null ? "" : String(declaredAmount));
  const [fee, setFee] = useState(declaredFee === null ? "" : String(declaredFee));
  const [reason, setReason] = useState("");

  if (!open) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
        className="text-xs font-medium text-slate-600 underline decoration-slate-300 underline-offset-4 hover:text-slate-900 disabled:opacity-50"
      >
        Corregir monto o comisión
      </button>
    );
  }

  const parseMoney = (value: string): number | null => {
    if (!value.trim()) return null;
    const parsed = Number(value.replace(",", "."));
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  };
  const amountValue = parseMoney(amount);
  const feeValue = parseMoney(fee);
  const invalid =
    !reason.trim() ||
    (amountValue !== null && (!Number.isFinite(amountValue) || amountValue < 0)) ||
    (feeValue !== null && (!Number.isFinite(feeValue) || feeValue < 0));

  return (
    <div className="w-full space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-2 text-left">
      <div className="grid grid-cols-2 gap-2">
        <label className="text-[11px] font-medium text-slate-600">
          Monto reportado
          <input
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            placeholder="Sin lectura"
            className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-800"
          />
        </label>
        <label className="text-[11px] font-medium text-slate-600">
          Comisión reportada
          <input
            inputMode="decimal"
            value={fee}
            onChange={(event) => setFee(event.target.value)}
            placeholder="Sin lectura"
            className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-800"
          />
        </label>
      </div>
      <label className="block text-[11px] font-medium text-slate-600">
        Motivo de la corrección
        <input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Ej. La foto muestra comisión S/ 10"
          className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-800"
        />
      </label>
      <p className="text-[10px] leading-4 text-slate-500">
        La imagen original no cambia. Kapta guardará el valor anterior, el nuevo y quién lo corrigió.
      </p>
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-xs text-slate-500 hover:text-slate-800"
        >
          Cancelar
        </button>
        <button
          type="button"
          disabled={disabled || invalid}
          onClick={() => {
            setOpen(false);
            onRun(() =>
              correctSettlementLineValues(settlementId, lineId, {
                declaredAmount: amountValue,
                declaredFee: feeValue,
                reason,
              }),
            );
          }}
          className="rounded-md bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-40"
        >
          Guardar corrección
        </button>
      </div>
    </div>
  );
}

function TotalsGrid({
  reconciled,
  payout,
  courier,
}: {
  reconciled: ReconciledSettlement;
  payout: RiderPayout | null;
  courier: string | null;
}) {
  const t = reconciled.totals;
  const pendingLinks = t.reviewCount;
  const differentRows = Math.max(0, t.mismatchCount - t.reviewCount);
  const issues: string[] = [];
  if (pendingLinks) issues.push(`${pendingLinks} fila(s) sin pedido confirmado`);
  if (differentRows) issues.push(`${differentRows} fila(s) difieren del Master`);
  if (t.depositDifference < -0.005) {
    issues.push(`falta registrar o depositar ${money(-t.depositDifference)}`);
  }
  if (t.depositDifference > 0.005) {
    issues.push(`hay un excedente de depósito de ${money(t.depositDifference)}`);
  }
  if (payout?.missingTariffs) {
    issues.push(`${payout.missingTariffs} tarifa(s) de motorizado sin configurar`);
  }

  type ReviewMetric = {
    label: string;
    value: string;
    hint: string;
    tone?: "bad" | "warn" | "good";
  };
  const reported: ReviewMetric[] = [
    { label: "Cobrado total", value: money(t.declaredTotal), hint: "Suma de las filas del reporte" },
    {
      label: courier ? "Comisión retenida" : "Costos declarados",
      value: money(t.feeTotal),
      hint: courier ? "Lo que el courier descuenta" : "Incluye comisiones registradas",
    },
    { label: "Cobro directo a la empresa", value: money(t.directCollected), hint: "Yape, POS o transferencia" },
    { label: "Neto que debe depositar", value: money(t.expectedDeposit), hint: "Cobrado menos comisión y cobro directo" },
  ];
  const kapta: ReviewMetric[] = [
    { label: "Entregas según el Master", value: money(t.expectedTotal), hint: `${t.deliveredCount} pedido(s) entregado(s)` },
    {
      label: "Diferencia courier vs. Kapta",
      value: money(t.difference),
      tone: Math.abs(t.difference) > 0.005 ? "warn" : "good",
      hint: "Reportado menos esperado",
    },
    { label: "Depósito registrado", value: money(t.depositTotal), hint: "Efectivo más Yape registrado" },
    {
      label: "Saldo del depósito",
      value:
        Math.abs(t.depositDifference) <= 0.005
          ? "S/ 0.00"
          : t.depositDifference < 0
            ? `Falta ${money(-t.depositDifference)}`
            : `Excede ${money(t.depositDifference)}`,
      tone: Math.abs(t.depositDifference) > 0.005 ? "bad" : "good",
      hint: "Depósito registrado menos neto esperado",
    },
  ];

  return (
    <section className="overflow-hidden rounded-xl border border-slate-200" aria-label="Validación del lote">
      <div
        className={cn(
          "flex flex-wrap items-start justify-between gap-3 px-4 py-3",
          issues.length ? "bg-amber-50 text-amber-950" : "bg-emerald-50 text-emerald-950",
        )}
      >
        <div>
          <p className="text-sm font-semibold">
            {issues.length ? "Revisión necesaria antes de cerrar" : "Todo coincide"}
          </p>
          <p className="mt-0.5 text-xs opacity-80">
            {issues.length ? issues.join("; ") : "El reporte, el Master y el depósito no muestran diferencias."}
          </p>
        </div>
        <span className="rounded-full bg-white/70 px-2.5 py-1 text-xs font-medium">
          {courierLabel(courier) ?? "Motorizado propio"}
        </span>
      </div>

      <div className="grid lg:grid-cols-2 lg:divide-x lg:divide-slate-200">
        {[
          { title: courier ? "Reportado por el courier" : "Reportado por el motorizado", items: reported },
          { title: "Validación de Kapta", items: kapta },
        ].map((group) => (
          <div key={group.title} className="p-4">
            <h4 className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
              {group.title}
            </h4>
            <dl className="mt-3 grid grid-cols-2 gap-x-5 gap-y-4">
              {group.items.map((item) => (
                <div key={item.label}>
                  <dt className="text-[11px] leading-4 text-slate-500">{item.label}</dt>
                  <dd
                    className={cn(
                      "mt-0.5 text-sm font-semibold tabular-nums text-slate-900",
                      item.tone === "bad" && "text-red-700",
                      item.tone === "warn" && "text-amber-700",
                      item.tone === "good" && "text-emerald-700",
                    )}
                  >
                    {item.value}
                  </dd>
                  <p className="mt-0.5 text-[10px] leading-4 text-slate-400">{item.hint}</p>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>

      {!courier && payout && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 bg-slate-50 px-4 py-3 text-sm">
          <span className="text-slate-600">Pago calculado al motorizado propio</span>
          <strong className="tabular-nums text-slate-900">{money(payout.net)}</strong>
        </div>
      )}
    </section>
  );
}

function SettlementResponsibilityPicker({
  settlementId,
  riders,
  currentRider,
  currentCourier,
  cash,
  yape,
  note,
  disabled,
  onRun,
}: {
  settlementId: string;
  riders: RiderRow[];
  currentRider: string | null;
  currentCourier: string | null;
  cash: number;
  yape: number;
  note: string | null;
  disabled: boolean;
  onRun: (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>) => void;
}) {
  const [responsibility, setResponsibility] = useState(
    currentCourier
      ? `courier:${currentCourier}`
      : currentRider
        ? `rider:${currentRider}`
        : "",
  );
  const [newName, setNewName] = useState("");
  const [cashValue, setCashValue] = useState(String(cash));
  const [yapeValue, setYapeValue] = useState(String(yape));
  const [noteValue, setNoteValue] = useState(note ?? "");
  const knownCourier = SETTLEMENT_COURIERS.some((courier) => courier.id === currentCourier);

  function saveHeader() {
    const courier = responsibility.startsWith("courier:")
      ? responsibility.slice("courier:".length)
      : null;
    const riderId = responsibility.startsWith("rider:")
      ? responsibility.slice("rider:".length)
      : null;
    onRun(() =>
      updateSettlementHeader(settlementId, {
        riderId,
        courier,
        declaredCash: Number(cashValue) || 0,
        declaredYape: Number(yapeValue) || 0,
        note: noteValue,
      }),
    );
  }

  return (
    <div className="w-full rounded-xl border border-slate-200 bg-slate-50 p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-700">Datos del lote</p>
          <p className="text-[11px] text-slate-500">
            Asigna quién reportó la ruta y registra lo que realmente ingresó a la empresa.
          </p>
        </div>
        <button
          type="button"
          disabled={disabled}
          onClick={saveHeader}
          className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          Guardar datos del lote
        </button>
      </div>

      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
        <label className="text-xs font-medium text-slate-600">
          Responsable del lote
          <select
            value={responsibility}
            onChange={(e) => setResponsibility(e.target.value)}
            disabled={disabled}
            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm text-slate-800"
          >
            <option value="">Sin responsable asignado</option>
            <optgroup label="Couriers">
              {!knownCourier && currentCourier && (
                <option value={`courier:${currentCourier}`}>{courierLabel(currentCourier)}</option>
              )}
              {SETTLEMENT_COURIERS.map((courier) => (
                <option key={courier.id} value={`courier:${courier.id}`}>
                  {courier.label}
                </option>
              ))}
            </optgroup>
            <optgroup label="Motorizados propios">
              {riders.map((r) => (
                <option key={r.id} value={`rider:${r.id}`}>
                  {r.full_name}
                </option>
              ))}
            </optgroup>
          </select>
        </label>
        <label className="text-xs font-medium text-slate-600">
          Efectivo depositado a la empresa
          <input
            type="number"
            min="0"
            step="0.01"
            value={cashValue}
            onChange={(e) => setCashValue(e.target.value)}
            disabled={disabled}
            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm text-slate-800"
          />
        </label>
        <label className="text-xs font-medium text-slate-600">
          Yape / POS depositado a la empresa
          <input
            type="number"
            min="0"
            step="0.01"
            value={yapeValue}
            onChange={(e) => setYapeValue(e.target.value)}
            disabled={disabled}
            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm text-slate-800"
          />
        </label>
        <label className="text-xs font-medium text-slate-600">
          Nota del lote
          <input
            value={noteValue}
            onChange={(e) => setNoteValue(e.target.value)}
            disabled={disabled}
            placeholder="Observación opcional"
            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm text-slate-800"
          />
        </label>
      </div>

      <details className="mt-2 text-xs text-slate-600">
        <summary className="cursor-pointer select-none font-medium">Dar de alta un motorizado propio</summary>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Nombre del motorizado"
            className="w-56 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm"
          />
          <button
            disabled={disabled || !newName.trim()}
            onClick={() => {
              const name = newName.trim();
              setNewName("");
              onRun(() =>
                createRider({ storeId: null, fullName: name, docNumber: null, phone: null, courier: null }),
              );
            }}
            className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-700 hover:bg-slate-100 disabled:opacity-50"
          >
            Crear motorizado
          </button>
        </div>
      </details>
    </div>
  );
}
