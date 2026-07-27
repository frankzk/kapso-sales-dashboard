"use client";

// Pantalla de liquidaciones de motorizados.
//
// Un principio manda en toda la pantalla: la diferencia se MUESTRA, nunca se
// esconde ni se corrige sola. El cuadre contra el Master y el cuadre del
// depósito se enseñan por separado (son problemas distintos), y el botón de
// cerrar se niega mientras queden líneas sin vincular, salvo que alguien con
// permiso decida cerrarlo a conciencia.

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, EmptyState, Section, cn } from "@/components/ui";
import { VERDICT_LABELS, type ReconciledSettlement, type SettlementVerdict } from "@/lib/settlements";
import type { RiderPayout } from "@/lib/settlements";
import type { RiderRow, SettlementDetail, SettlementRow } from "@/lib/settlements-access";
import {
  closeSettlement,
  createRider,
  recheckSettlement,
  relinkLine,
  updateSettlementHeader,
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
  cuadrada: "Cuadrada",
  con_descuadre: "Con descuadre",
  cerrada: "Cerrada",
};

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

  const riderName = (id: string | null, raw: string | null) =>
    riders.find((r) => r.id === id)?.full_name ?? raw ?? "Sin asignar";

  return (
    <div className="space-y-6">
      <Section title="Liquidaciones de motorizados">
        <p className="text-sm text-slate-500">
          Sube la hoja del motorizado —{" "}
          <strong className="font-medium text-slate-700">foto del cuaderno</strong> o{" "}
          <strong className="font-medium text-slate-700">Excel/CSV</strong> — y se cruza con el
          Master: qué guías entregó de verdad y cuánta plata debía traer. Lo que no cuadre se
          muestra línea por línea; nada se corrige solo.
        </p>
      </Section>

      {msg && (
        <Card className="border-brand-200 bg-brand-50 p-3 text-sm text-brand-800">{msg}</Card>
      )}

      {canEdit && <UploadPanel stores={stores} riders={riders} onDone={setMsg} />}

      <Card className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
              <tr>
                <th className="px-4 py-2.5 font-medium">Fecha</th>
                <th className="px-4 py-2.5 font-medium">Motorizado</th>
                <th className="px-4 py-2.5 font-medium">Origen</th>
                <th className="px-4 py-2.5 font-medium">Declarado</th>
                <th className="px-4 py-2.5 font-medium">Pago</th>
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
                      {riderName(s.rider_id, s.rider_name_raw)}
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
  const [storeId, setStoreId] = useState(stores[0]?.id ?? "");
  const [riderId, setRiderId] = useState("");
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
    if (riderId) fd.append("riderId", riderId);
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
          {stores.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <select
          value={riderId}
          onChange={(e) => setRiderId(e.target.value)}
          className="rounded-lg border border-slate-300 px-2 py-2 text-sm"
        >
          <option value="">Motorizado (se puede asignar después)</option>
          {riders.map((r) => (
            <option key={r.id} value={r.id}>
              {r.full_name}
            </option>
          ))}
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
        que traiga el archivo.
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

      <TotalsGrid reconciled={reconciled} payout={payout} />

      {err && <p className="text-sm text-red-600">{err}</p>}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="border-b border-slate-200 text-left text-xs text-slate-500">
            <tr>
              <th className="px-3 py-2 font-medium">Cliente</th>
              <th className="px-3 py-2 font-medium">Pedido</th>
              <th className="px-3 py-2 font-medium">Cobró</th>
              <th className="px-3 py-2 font-medium">Comisión</th>
              <th className="px-3 py-2 font-medium">Debía</th>
              <th className="px-3 py-2 font-medium">Diferencia</th>
              <th className="px-3 py-2 font-medium">Cuadre</th>
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
                  <td className="px-3 py-2 text-right">
                    {r.verdict === "sin_pedido" && r.line.match_status === "review" && (
                      <button
                        disabled={pending}
                        onClick={() => run(() => relinkLine(settlement.id, r.line.id, null))}
                        className="text-xs text-slate-500 underline hover:text-slate-700 disabled:opacity-50"
                      >
                        Sin pedido
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {reconciled.totals.reviewCount > 0 && (
        <p className="text-xs text-amber-700">
          {reconciled.totals.reviewCount} línea(s) no se pudieron vincular con un pedido. Búscalas en
          el Master por la guía y corrígelas ahí, o márcalas como &quot;sin pedido&quot; si no
          corresponden a ninguno.
        </p>
      )}

      {canEdit && !closed && (
        <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
          <RiderPicker
            settlementId={settlement.id}
            riders={riders}
            current={settlement.rider_id}
            cash={Number(settlement.declared_cash)}
            yape={Number(settlement.declared_yape)}
            note={settlement.note}
            disabled={pending}
            onRun={run}
          />
          <button
            disabled={pending}
            onClick={() => run(() => recheckSettlement(settlement.id))}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            Recalcular cuadre
          </button>
          {canClose && (
            <>
              <label className="flex items-center gap-1.5 text-xs text-slate-600">
                <input
                  type="checkbox"
                  checked={deduct}
                  onChange={(e) => setDeduct(e.target.checked)}
                />
                Descontar el faltante del pago
              </label>
              <button
                disabled={pending}
                onClick={() =>
                  run(() => closeSettlement(settlement.id, { deductShortfall: deduct }))
                }
                className="rounded-lg bg-slate-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-900 disabled:opacity-50"
              >
                Cerrar y fijar el pago
              </button>
              {!reconciled.totals.balanced && (
                <button
                  disabled={pending}
                  onClick={() => {
                    if (
                      !confirm(
                        "Vas a cerrar una liquidación que NO cuadra. El pago quedará congelado y el descuadre anotado. ¿Seguro?",
                      )
                    )
                      return;
                    run(() =>
                      closeSettlement(settlement.id, { deductShortfall: deduct, force: true }),
                    );
                  }}
                  className="text-xs text-red-600 underline hover:text-red-700 disabled:opacity-50"
                >
                  Cerrar con descuadre
                </button>
              )}
            </>
          )}
        </div>
      )}

      {closed && (
        <p className="border-t border-slate-100 pt-3 text-xs text-slate-500">
          Cerrada el {settlement.closed_at?.slice(0, 10)}. Pago congelado en{" "}
          <strong className="text-slate-700">{money(settlement.payout_amount)}</strong>. Si hay que
          corregir algo, abre una liquidación de ajuste: este número ya no se reescribe.
        </p>
      )}
    </Card>
  );
}

function TotalsGrid({
  reconciled,
  payout,
}: {
  reconciled: ReconciledSettlement;
  payout: RiderPayout | null;
}) {
  const t = reconciled.totals;
  const cells = useMemo(
    () => [
      { label: "Cobró (declarado)", value: money(t.declaredTotal) },
      { label: "Debía cobrar (Master)", value: money(t.expectedTotal) },
      {
        label: "Diferencia vs. Master",
        value: money(t.difference),
        tone: t.difference < 0 ? "bad" : t.difference > 0 ? "warn" : "good",
      },
      { label: "Comisión del courier", value: money(t.feeTotal), hint: "se la queda" },
      { label: "Debía depositar", value: money(t.expectedDeposit), hint: "cobrado − comisión" },
      { label: "Depositó", value: money(t.depositTotal) },
      {
        label: "Diferencia del depósito",
        value: money(t.depositDifference),
        tone: t.depositDifference < 0 ? "bad" : t.depositDifference > 0 ? "warn" : "good",
      },
      {
        label: "Pago al motorizado",
        value: payout ? money(payout.net) : "—",
        hint: payout?.missingTariffs
          ? `faltan ${payout.missingTariffs} tarifa(s)`
          : `${t.deliveredCount} entrega(s)`,
      },
    ],
    [t, payout],
  );

  return (
    <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-4">
      {cells.map((c) => (
        <div key={c.label} className="rounded-lg border border-slate-200 p-2.5">
          <p className="text-[11px] text-slate-500">{c.label}</p>
          <p
            className={cn(
              "mt-0.5 text-sm font-semibold",
              c.tone === "bad" ? "text-red-600" : c.tone === "warn" ? "text-sky-700" : "text-slate-800",
            )}
          >
            {c.value}
          </p>
          {c.hint && <p className="text-[11px] text-slate-400">{c.hint}</p>}
        </div>
      ))}
    </div>
  );
}

function RiderPicker({
  settlementId,
  riders,
  current,
  cash,
  yape,
  note,
  disabled,
  onRun,
}: {
  settlementId: string;
  riders: RiderRow[];
  current: string | null;
  cash: number;
  yape: number;
  note: string | null;
  disabled: boolean;
  onRun: (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>) => void;
}) {
  const [riderId, setRiderId] = useState(current ?? "");
  const [newName, setNewName] = useState("");

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        value={riderId}
        onChange={(e) => {
          const v = e.target.value;
          setRiderId(v);
          onRun(() =>
            updateSettlementHeader(settlementId, {
              riderId: v || null,
              declaredCash: cash,
              declaredYape: yape,
              note,
            }),
          );
        }}
        disabled={disabled}
        className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
      >
        <option value="">Sin motorizado asignado</option>
        {riders.map((r) => (
          <option key={r.id} value={r.id}>
            {r.full_name}
          </option>
        ))}
      </select>
      <input
        value={newName}
        onChange={(e) => setNewName(e.target.value)}
        placeholder="Alta rápida: nombre"
        className="w-44 rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
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
        className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
      >
        Dar de alta
      </button>
    </div>
  );
}
