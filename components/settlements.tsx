"use client";

// Pantalla de liquidaciones de motorizados.
//
// Un principio manda en toda la pantalla: la diferencia se MUESTRA, nunca se
// esconde ni se corrige sola. El cuadre contra el Master y el cuadre del
// depósito se enseñan por separado (son problemas distintos), y el botón de
// cerrar se niega mientras queden líneas sin vincular, salvo que alguien con
// permiso decida cerrarlo a conciencia.
//
// Mundo de operación (DESIGN.md, 22-11-2026): título de 28 px, tarjetas de
// sección con su cabecera, la tabla con hairlines, chapas de 4 px y el marco de
// cifras que separa lo reportado de lo que valida Kapta (MOM §14).

import { useId, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { OrderLink } from "@/components/order-link";
import { cn, TABLE_WRAP_FROM } from "@/components/ui";
import {
  Badge,
  Banner,
  CARD_ZONE,
  CHECKBOX,
  FIELD,
  FIELD_BOX,
  OpsButton,
  SECTION_CARD,
  SectionHead,
  type BadgeTone,
} from "@/components/ops-ui";
import { Field } from "@/components/settings-ui";
import { IconAlert } from "@/components/icons";
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

// Cerrada es un estado final, no un aviso: chapa neutra, como en Compras.
const STATUS_TONE: Record<string, BadgeTone> = {
  borrador: "neutral",
  cuadrada: "ok",
  con_descuadre: "warn",
  cerrada: "neutral",
};
const STATUS_LABEL: Record<string, string> = {
  borrador: "Borrador",
  cuadrada: "Sin diferencias",
  con_descuadre: "Revisión necesaria",
  cerrada: "Cerrada",
};

// De dónde salió el lote. Sin emoji: el mundo de operación no decora.
const SOURCE_LABEL: Record<string, string> = {
  foto: "Foto",
  hoja: "Hoja",
  ruta: "Ruta",
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

const VERDICT_TONE: Record<SettlementVerdict, BadgeTone> = {
  conforme: "ok",
  cobro_de_mas: "info",
  cobro_de_menos: "warn",
  entregado_sin_cobro: "crit",
  cobro_sin_entrega: "crit",
  sin_pedido: "neutral",
};

/** Celda de encabezado de las tablas de esta pantalla. */
const TH = "border-y border-line bg-white px-3 py-2 text-left text-xs font-medium text-ink-600";

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

  const hrefFor = (s: SettlementRow) =>
    detail?.settlement.id === s.id ? "/dashboard/liquidaciones" : `/dashboard/liquidaciones?id=${s.id}`;

  return (
    <div className="mx-auto max-w-[76rem] space-y-4">
      <header>
        <h1 className="text-[28px] font-bold leading-9 tracking-[-0.01em] text-ink-900">Liquidaciones</h1>
        <p className="mt-1 max-w-[68ch] text-sm text-ink-500">
          De couriers y motorizados. Sube una foto o un Excel/CSV: Kapta conserva lo reportado y lo
          compara con el Master. Las diferencias quedan visibles y toda corrección manual guarda
          historial.
        </p>
      </header>

      {msg && (
        <Banner tone="info" role="status">
          {msg}
        </Banner>
      )}

      {canEdit && <UploadPanel stores={stores} riders={riders} onDone={setMsg} />}

      <section aria-label="Liquidaciones cargadas" className="overflow-hidden rounded-lg bg-white shadow-control ring-1 ring-line">
        {settlements.length === 0 ? (
          <p className="px-4 py-12 text-center text-sm text-ink-500">
            Todavía no hay liquidaciones: sube la primera hoja arriba.
          </p>
        ) : (
          <>
            {/* Teléfono: cada lote es una fila de lista, sin desplazamiento horizontal. */}
            <ul className="divide-y divide-line md:hidden">
              {settlements.map((s) => {
                const open = detail?.settlement.id === s.id;
                return (
                  <li key={s.id}>
                    <Link
                      href={hrefFor(s)}
                      aria-current={open ? "true" : undefined}
                      className={cn("block px-4 py-3 hover:bg-wash", open && "bg-brand-100/70")}
                    >
                      <span className="flex items-center justify-between gap-3">
                        <span className={cn("text-sm font-medium tabular-nums", open ? "text-brand-700" : "text-ink-900")}>
                          {s.settlement_date}
                        </span>
                        <Badge tone={STATUS_TONE[s.status] ?? "neutral"}>{STATUS_LABEL[s.status] ?? s.status}</Badge>
                      </span>
                      <span className={cn("mt-0.5 block text-[13px]", open ? "text-ink-600" : "text-ink-500")}>
                        {responsibilityName(s)} · {SOURCE_LABEL[s.source] ?? "Manual"}
                      </span>
                      <span className={cn("block text-[13px] tabular-nums", open ? "text-ink-600" : "text-ink-500")}>
                        Depósito {money(Number(s.declared_cash) + Number(s.declared_yape))} · Pago {money(s.payout_amount)}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>

            <div className={cn("hidden md:block", TABLE_WRAP_FROM[1060])}>
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr>
                    <th className={cn(TH, "sticky top-0 z-[1] border-t-0 pl-4")}>Fecha</th>
                    <th className={cn(TH, "sticky top-0 z-[1] border-t-0")}>Responsable del lote</th>
                    <th className={cn(TH, "sticky top-0 z-[1] border-t-0")}>Origen</th>
                    <th className={cn(TH, "sticky top-0 z-[1] border-t-0 text-right")}>Depósito registrado</th>
                    <th className={cn(TH, "sticky top-0 z-[1] border-t-0 text-right")}>Pago motorizado</th>
                    <th className={cn(TH, "sticky top-0 z-[1] border-t-0 pr-4")}>Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {settlements.map((s) => {
                    const open = detail?.settlement.id === s.id;
                    const support = open ? "text-ink-600" : "text-ink-500";
                    return (
                      <tr
                        key={s.id}
                        onClick={() => router.push(hrefFor(s))}
                        className={cn(
                          "cursor-pointer border-b border-line last:border-0",
                          open ? "bg-brand-100/70" : "hover:bg-wash",
                        )}
                      >
                        <td className="py-2.5 pl-4 pr-3">
                          {/* El enlace da el teclado; el clic en la fila sigue abriéndola. */}
                          <Link
                            href={hrefFor(s)}
                            onClick={(e) => e.stopPropagation()}
                            aria-current={open ? "true" : undefined}
                            className={cn("font-medium tabular-nums", open ? "text-brand-700" : "text-ink-900 hover:text-brand-700")}
                          >
                            {s.settlement_date}
                          </Link>
                        </td>
                        <td className="px-3 py-2.5 text-ink-900">{responsibilityName(s)}</td>
                        <td className={cn("px-3 py-2.5", support)}>{SOURCE_LABEL[s.source] ?? "Manual"}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap text-ink-900">
                          {money(Number(s.declared_cash) + Number(s.declared_yape))}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap text-ink-900">{money(s.payout_amount)}</td>
                        <td className="py-2.5 pl-3 pr-4">
                          <Badge tone={STATUS_TONE[s.status] ?? "neutral"}>{STATUS_LABEL[s.status] ?? s.status}</Badge>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

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
  const id = useId();
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
    <section className={SECTION_CARD} aria-labelledby={`${id}-title`}>
      <SectionHead
        id={`${id}-title`}
        title="Cargar una liquidación"
        help="Foto del cuaderno o Excel/CSV del courier. La foto se transcribe y lo ilegible queda en blanco para que lo completes: nunca se inventa un monto. La fecha que pongas manda sobre la que traiga el archivo. En reportes de Axel, la columna CLIENTE decide si cada fila pertenece a Aurela o Kenku."
      />
      <div className="grid gap-x-4 gap-y-4 pt-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Tienda" htmlFor={`${id}-store`}>
          <select id={`${id}-store`} value={storeId} onChange={(e) => setStoreId(e.target.value)} className={FIELD}>
            {stores.length > 1 && <option value="__all__">Aurela + Kenku (según CLIENTE)</option>}
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Courier o motorizado" htmlFor={`${id}-who`}>
          <select id={`${id}-who`} value={responsibility} onChange={(e) => setResponsibility(e.target.value)} className={FIELD}>
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
        </Field>
        <Field label="Fecha de la liquidación" htmlFor={`${id}-date`}>
          <input
            id={`${id}-date`}
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className={cn(FIELD, "tabular-nums")}
          />
        </Field>
        <Field label="Efectivo depositado" htmlFor={`${id}-cash`}>
          <input
            id={`${id}-cash`}
            inputMode="decimal"
            value={cash}
            onChange={(e) => setCash(e.target.value)}
            placeholder="0.00"
            className={cn(FIELD, "tabular-nums")}
          />
        </Field>
        <Field label="Yape depositado" htmlFor={`${id}-yape`}>
          <input
            id={`${id}-yape`}
            inputMode="decimal"
            value={yape}
            onChange={(e) => setYape(e.target.value)}
            placeholder="0.00"
            className={cn(FIELD, "tabular-nums")}
          />
        </Field>
        <Field label="Foto o Excel/CSV" htmlFor={`${id}-file`}>
          <input
            id={`${id}-file`}
            ref={fileRef}
            type="file"
            accept="image/*,.csv,.xlsx,text/csv"
            className="block w-full min-w-0 text-[13px] text-ink-700 file:mr-3 file:h-9 file:cursor-pointer file:rounded-md file:border-0 file:bg-white file:px-3 file:text-sm file:font-semibold file:text-ink-700 file:shadow-control file:ring-1 file:ring-inset file:ring-line-strong hover:file:bg-wash"
          />
        </Field>
      </div>
      <div className={cn(CARD_ZONE, "mt-4 flex flex-wrap items-center justify-end gap-3")}>
        {err && (
          <p role="alert" className="mr-auto text-[13px] text-crit-fg">
            {err}
          </p>
        )}
        <OpsButton variant="primary" onClick={upload} disabled={busy}>
          {busy ? "Leyendo…" : "Cargar liquidación"}
        </OpsButton>
      </div>
    </section>
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
    <section className={SECTION_CARD} aria-labelledby="liquidacion-detalle">
      <SectionHead
        id="liquidacion-detalle"
        title={`Liquidación del ${settlement.settlement_date}`}
        badge={<Badge tone={STATUS_TONE[settlement.status] ?? "neutral"}>{STATUS_LABEL[settlement.status] ?? settlement.status}</Badge>}
        aside={
          <OpsButton variant="ghost" size="sm" onClick={() => router.push("/dashboard/liquidaciones")}>
            Cerrar detalle
          </OpsButton>
        }
      />

      <div className="space-y-4 pt-4">
        <TotalsGrid reconciled={reconciled} payout={payout} courier={settlement.courier} />

        {settlement.source === "ruta" && settlement.route_id && (
          <Banner tone="info">
            Este lote conserva el reporte por tienda. La ganancia y el saldo neto del motorizado se aprueban una
            sola vez en su ruta diaria:{" "}
            <a
              className="inline-flex min-h-11 items-center font-semibold text-brand-700 underline underline-offset-4"
              href={`/dashboard/courier/reparto?id=${settlement.route_id}&dia=${settlement.settlement_date}`}
            >
              Ver ganancia y saldo del motorizado
            </a>
            .
          </Banner>
        )}

        {err && (
          <Banner tone="crit" role="alert">
            {err}
          </Banner>
        )}

        {/* `relative`: el texto oculto del encabezado (sr-only, absoluto) se
            recorta con la tabla; sin él estiraba la página en el teléfono. */}
        <div className="relative overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr>
                <th className={TH}>Cliente</th>
                <th className={TH}>Pedido</th>
                <th className={cn(TH, "text-right")}>Reportado cobrado</th>
                <th className={cn(TH, "text-right")}>Comisión reportada</th>
                <th className={cn(TH, "text-right")}>Esperado según Kapta</th>
                <th className={cn(TH, "text-right")}>Diferencia</th>
                <th className={cn(TH, "min-w-[220px]")}>Resultado de validación</th>
                {canEdit && !closed && (
                  <th className={TH}>
                    <span className="sr-only">Acciones</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {reconciled.lines.map((r) => (
                <tr key={r.line.id} className="border-b border-line align-top">
                  <td className="px-3 py-2.5">
                    <span className="block leading-5 text-ink-900">{r.line.customer_name ?? r.line.guide_code ?? "—"}</span>
                    {r.line.district && (
                      <span className="block text-[13px] leading-5 text-ink-500">{r.line.district}</span>
                    )}
                    {(r.line.store_hint || r.line.declared_status) && (
                      <span className="block text-[13px] font-medium leading-5 text-ink-600">
                        {[r.line.store_hint, r.line.declared_status].filter(Boolean).join(" · ")}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-ink-900">
                    {r.line.order_id ? (
                      <OrderLink orderId={r.line.order_id} className="font-medium text-brand-700 hover:underline">
                        {orderNames[r.line.order_id] ?? r.line.order_name ?? "—"}
                      </OrderLink>
                    ) : (
                      (r.line.order_name ?? "—")
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap text-ink-900">{money(r.declared)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap text-ink-600">
                    {r.line.declared_fee === null || r.line.declared_fee === undefined
                      ? "—"
                      : money(r.line.declared_fee)}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-ink-600">
                    <span className="whitespace-nowrap">{r.verdict === "sin_pedido" ? "—" : money(r.expected)}</span>
                    {/* La guía lleva pedidos acompañantes (MOM §32): lo esperado
                        es la suma, y sin decirlo el número no casa con el pedido. */}
                    {r.verdict !== "sin_pedido" && (r.facts?.companion_total ?? 0) > 0 && (
                      <span className="block text-[13px] text-ink-500">
                        incl. {money(r.facts!.companion_total!)} de acompañantes
                      </span>
                    )}
                  </td>
                  <td
                    className={cn(
                      "whitespace-nowrap px-3 py-2.5 text-right font-medium tabular-nums",
                      r.difference < 0 ? "text-crit-fg" : r.difference > 0 ? "text-info-fg" : "text-ink-500",
                    )}
                  >
                    {r.verdict === "sin_pedido" ? "—" : money(r.difference)}
                  </td>
                  <td className="px-3 py-2.5">
                    <Badge tone={VERDICT_TONE[r.verdict]} wrap>
                      {VERDICT_LABELS[r.verdict]}
                    </Badge>
                  </td>
                  {canEdit && !closed && (
                    <td className="min-w-[264px] px-3 py-2.5 text-right">
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
          <Banner tone="warn">
            {reconciled.totals.reviewCount} línea(s) requieren confirmación. Revisa la tienda, el nombre, el
            distrito y el monto; asigna el pedido correcto o marca &quot;sin pedido&quot;. No se podrá procesar
            la liquidación mientras queden pendientes.
          </Banner>
        )}
      </div>

      {canEdit && !closed && (
        <>
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
          <div className={cn(CARD_ZONE, "mt-4 flex flex-wrap items-center gap-2")}>
            <OpsButton
              disabled={pending}
              onClick={() => run(() => applySettlementToMaster(settlement.id))}
              title="Marca en el Master las entregas y rechazos que declara esta liquidación"
            >
              Aplicar al Master
            </OpsButton>
            <OpsButton disabled={pending} onClick={() => run(() => recheckSettlement(settlement.id))}>
              Actualizar validación
            </OpsButton>
            {canClose && (
              <div className="ml-auto flex flex-wrap items-center gap-3">
                {!settlement.courier && (
                  <label className="flex items-center gap-2 text-[13px] text-ink-700">
                    <input
                      type="checkbox"
                      checked={deduct}
                      onChange={(e) => setDeduct(e.target.checked)}
                      className={CHECKBOX}
                    />
                    Descontar el faltante del pago
                  </label>
                )}
                <OpsButton
                  variant="primary"
                  disabled={pending}
                  onClick={() =>
                    settlement.source === "ruta" && settlement.route_id
                      ? router.push(`/dashboard/courier/reparto?id=${settlement.route_id}&dia=${settlement.settlement_date}`)
                      : run(() => closeSettlement(settlement.id, { deductShortfall: deduct }))
                  }
                >
                  {settlement.source === "ruta" && settlement.route_id
                    ? "Revisar cierre diario de la ruta"
                    : settlement.courier
                      ? "Cerrar lote"
                      : "Cerrar y fijar el pago"}
                </OpsButton>
              </div>
            )}
          </div>
        </>
      )}

      {closed && (
        <p className={cn(CARD_ZONE, "mt-4 text-[13px] leading-5 text-ink-500")}>
          Cerrada el {settlement.closed_at?.slice(0, 10)}.{" "}
          {settlement.courier ? (
            <>La comisión del courier quedó fijada con los valores revisados.</>
          ) : (
            <>
              Pago congelado en{" "}
              <strong className="font-semibold tabular-nums text-ink-900">{money(settlement.payout_amount)}</strong>.
            </>
          )}{" "}
          Si hay que corregir algo, abre una liquidación de ajuste.
        </p>
      )}
    </section>
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
        <OpsButton size="sm" disabled={disabled} onClick={search}>
          Cotejar pedido
        </OpsButton>
        <OpsButton
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={() => onRun(() => relinkLine(settlementId, lineId, null))}
        >
          Sin pedido
        </OpsButton>
      </div>
    );
  }

  return (
    <div className="w-full space-y-2 rounded-lg bg-wash p-2 text-left">
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
          aria-label="Buscar el pedido"
          placeholder="Nombre, pedido o distrito"
          className={cn(FIELD_BOX, "h-8 min-w-0 flex-1 px-2 text-[13px]")}
        />
        <OpsButton size="sm" disabled={searching || disabled} onClick={search}>
          {searching ? "Buscando…" : "Buscar"}
        </OpsButton>
      </div>
      {searchError && (
        <p role="alert" className="text-[13px] text-crit-fg">
          {searchError}
        </p>
      )}
      {!searching && candidates.length === 0 && (
        <p className="text-[13px] text-ink-500">
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
              "block w-full rounded-md bg-white p-2 text-left ring-1 ring-inset transition-shadow disabled:opacity-50",
              candidate.warnings.length ? "ring-warn-fg" : "ring-line-strong hover:ring-ink-300",
            )}
          >
            <span className="flex items-center justify-between gap-2">
              <strong className="text-[13px] font-semibold text-ink-900">{candidate.orderName}</strong>
              <span className="text-xs tabular-nums text-ink-500">{candidate.score} pts</span>
            </span>
            <span className="block text-xs leading-4 text-ink-600">
              {candidate.storeName} · {candidate.customerName} · {candidate.district}
            </span>
            <span className="block text-xs leading-4 tabular-nums text-ink-500">
              {candidate.total === null ? "Monto —" : money(candidate.total)} · {candidate.status}
              {candidate.reasons.length ? ` · ${candidate.reasons.join(", ")}` : ""}
            </span>
            {candidate.warnings.map((warning) => (
              <span key={warning} className="mt-1 flex items-start gap-1 text-xs font-medium leading-4 text-warn-fg">
                <IconAlert className="size-3.5 shrink-0" aria-hidden />
                Revisa antes de vincular: {warning}
              </span>
            ))}
          </button>
        ))}
      </div>
      <div className="flex justify-between gap-2">
        <OpsButton variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancelar
        </OpsButton>
        <OpsButton
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={() => onRun(() => relinkLine(settlementId, lineId, null))}
        >
          Confirmar que no tiene pedido
        </OpsButton>
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
        className="text-[13px] font-medium text-brand-700 underline-offset-4 hover:underline disabled:opacity-50"
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
  const input = cn(FIELD_BOX, "mt-1 h-8 w-full px-2 text-[13px]");

  return (
    <div className="w-full space-y-2 rounded-lg bg-wash p-3 text-left">
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-[13px] font-medium text-ink-700">
          Monto reportado
          <input
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            placeholder="Sin lectura"
            className={cn(input, "tabular-nums")}
          />
        </label>
        <label className="block text-[13px] font-medium text-ink-700">
          Comisión reportada
          <input
            inputMode="decimal"
            value={fee}
            onChange={(event) => setFee(event.target.value)}
            placeholder="Sin lectura"
            className={cn(input, "tabular-nums")}
          />
        </label>
      </div>
      <label className="block text-[13px] font-medium text-ink-700">
        Motivo de la corrección
        <input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Ej. La foto muestra comisión S/ 10"
          className={input}
        />
      </label>
      <p className="text-xs leading-4 text-ink-500">
        La imagen original no cambia. Kapta guardará el valor anterior, el nuevo y quién lo corrigió.
      </p>
      <div className="flex items-center justify-end gap-2">
        <OpsButton variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancelar
        </OpsButton>
        <OpsButton
          variant="primary"
          size="sm"
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
        >
          Guardar corrección
        </OpsButton>
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

  // Un marco de cifras (dato con celdas, no una tarjeta): anillo `line`, sin sombra.
  return (
    <section className="overflow-hidden rounded-lg ring-1 ring-line" aria-label="Validación del lote">
      <div
        className={cn(
          "flex flex-wrap items-start justify-between gap-3 px-4 py-3",
          issues.length ? "bg-warn-wash" : "bg-ok-wash",
        )}
      >
        <div className="min-w-0">
          <p className={cn("text-sm font-semibold", issues.length ? "text-warn-fg" : "text-ok-fg")}>
            {issues.length ? "Revisión necesaria antes de cerrar" : "Todo coincide"}
          </p>
          <p className="mt-0.5 text-[13px] leading-5 text-ink-700">
            {issues.length ? issues.join("; ") : "El reporte, el Master y el depósito no muestran diferencias."}
          </p>
        </div>
        <Badge>{courierLabel(courier) ?? "Motorizado propio"}</Badge>
      </div>

      <div className="grid border-t border-line lg:grid-cols-2 lg:divide-x lg:divide-line">
        {[
          { title: courier ? "Reportado por el courier" : "Reportado por el motorizado", items: reported },
          { title: "Validación de Kapta", items: kapta },
        ].map((group, i) => (
          <div key={group.title} className={cn("p-4", i > 0 && "border-t border-line lg:border-t-0")}>
            <h4 className="text-sm font-semibold text-ink-900">{group.title}</h4>
            <dl className="mt-3 grid grid-cols-2 gap-x-5 gap-y-4">
              {group.items.map((item) => (
                <div key={item.label}>
                  <dt className="text-[13px] leading-5 text-ink-600">{item.label}</dt>
                  <dd
                    className={cn(
                      "mt-0.5 text-base font-semibold tabular-nums",
                      item.tone === "bad" ? "text-crit-fg" : item.tone === "warn" ? "text-warn-fg" : item.tone === "good" ? "text-ok-fg" : "text-ink-900",
                    )}
                  >
                    {item.value}
                  </dd>
                  <p className="mt-0.5 text-xs leading-4 text-ink-500">{item.hint}</p>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>

      {!courier && payout && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line bg-wash px-4 py-3 text-sm">
          <span className="text-ink-700">Pago calculado al motorizado propio</span>
          <strong className="font-semibold tabular-nums text-ink-900">{money(payout.net)}</strong>
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
  const id = useId();
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
    <div className={cn(CARD_ZONE, "mt-4")}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="text-sm font-semibold leading-5 text-ink-900">Datos del lote</h4>
          <p className="mt-0.5 text-[13px] leading-5 text-ink-500">
            Asigna quién reportó la ruta y registra lo que realmente ingresó a la empresa.
          </p>
        </div>
        <OpsButton size="sm" disabled={disabled} onClick={saveHeader}>
          Guardar datos del lote
        </OpsButton>
      </div>

      <div className="mt-4 grid gap-x-4 gap-y-4 md:grid-cols-2 xl:grid-cols-4">
        <Field label="Responsable del lote" htmlFor={`${id}-who`}>
          <select
            id={`${id}-who`}
            value={responsibility}
            onChange={(e) => setResponsibility(e.target.value)}
            disabled={disabled}
            className={FIELD}
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
        </Field>
        <Field label="Efectivo depositado a la empresa" htmlFor={`${id}-cash`}>
          <input
            id={`${id}-cash`}
            type="number"
            min="0"
            step="0.01"
            value={cashValue}
            onChange={(e) => setCashValue(e.target.value)}
            disabled={disabled}
            className={cn(FIELD, "tabular-nums")}
          />
        </Field>
        <Field label="Yape / POS depositado a la empresa" htmlFor={`${id}-yape`}>
          <input
            id={`${id}-yape`}
            type="number"
            min="0"
            step="0.01"
            value={yapeValue}
            onChange={(e) => setYapeValue(e.target.value)}
            disabled={disabled}
            className={cn(FIELD, "tabular-nums")}
          />
        </Field>
        <Field label="Nota del lote" htmlFor={`${id}-note`}>
          <input
            id={`${id}-note`}
            value={noteValue}
            onChange={(e) => setNoteValue(e.target.value)}
            disabled={disabled}
            placeholder="Observación opcional"
            className={FIELD}
          />
        </Field>
      </div>

      <details className="mt-4 text-[13px] text-ink-700">
        <summary className="cursor-pointer select-none font-medium">Dar de alta un motorizado propio</summary>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            aria-label="Nombre del motorizado"
            placeholder="Nombre del motorizado"
            className={cn(FIELD_BOX, "h-9 w-56 px-3")}
          />
          <OpsButton
            disabled={disabled || !newName.trim()}
            onClick={() => {
              const name = newName.trim();
              setNewName("");
              onRun(() =>
                createRider({ storeId: null, fullName: name, docNumber: null, phone: null, courier: null }),
              );
            }}
          >
            Crear motorizado
          </OpsButton>
        </div>
      </details>
    </div>
  );
}
