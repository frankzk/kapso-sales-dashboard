"use client";

// Detalle de una importación (MOM §45). Todo lo de dinero (costos por unidad,
// costos repartidos, pagos, costo aterrizado, margen, tipo de cambio y «Pasar
// a Costos») solo se dibuja con «Montos de compras»; sin ese permiso el
// servidor ni siquiera lo manda (lib/compras-server.ts).
//
// Con solo «Recepción de compras» (MOM §45.11) se ve sin montos, se guarda la
// recepción y se suben fotos; nada más se edita. «Leer con IA» (MOM §45.10) y
// la foto de un producto, solo con «Compras».
//
// Monedas (MOM §45.3, 0342): cada costo y cada pago se muestra en SU moneda y,
// con tipo de cambio, su equivalente en una línea secundaria; lo que necesita
// convertir y no lo tiene dice «Falta el tipo de cambio». «Incluye IGV» en un
// costo guarda el total con IGV y entra al costo ÷ 1,18.
//
// Compras locales, cortesía y entregas (MOM §45.12–§45.14, 0343): una compra
// local va en soles y no lleva transporte, guía ni aviso a la bodega; cada
// producto puede traer unidades de cortesía; lo que llega se registra por
// entregas (fecha, quién, unidades por producto y fotos) con su avance «Llegaron
// 400 de 600 (+50 cortesía) · faltan 250». Una entrega de una compra local lleva
// foto y un pago, la captura del comprobante.
//
// En el mundo de operación (DESIGN.md): título de 28 px con su chapa, el marco
// de cifras, un índice pegajoso con el aviso de la última acción, la próxima
// acción con anillo azul y cada parte en su tarjeta de sección sobre el lienzo.
// Desde 1280 px el estado, el aviso a la bodega y los datos van en un riel a
// la derecha, como el detalle de Stripe.

import { useEffect, useMemo, useRef, useState, useTransition, type ComponentType, type ReactNode, type SVGProps } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/components/ui";
import { Badge, Banner, CARD_ZONE, SECTION_CARD, SectionHead, choiceChipClass } from "@/components/ops-ui";
import {
  IconActivity,
  IconArrowLeft,
  IconArrowUpRight,
  IconChat,
  IconChevronRight,
  IconClipboard,
  IconCopy,
  IconDownload,
  IconMoney,
  IconPackage,
  IconPackageCheck,
  IconPlus,
  IconReceipt,
  IconTruck,
  IconWhatsApp,
  IconX,
} from "@/components/icons";
import {
  ALLOCATIONS,
  COST_KINDS,
  CURRENCIES,
  DELIVERY_PHOTO_REQUIRED,
  DOC_KINDS,
  IGV_HELP,
  IGV_TREATMENTS,
  IMPORT_STATUSES,
  IMPORT_STATUS_LABEL,
  MISSING_FX,
  MOVEMENT_EVENT_KINDS,
  PAYMENT_METHODS,
  PAYMENT_VOUCHER_REQUIRED,
  RECEIVED_STATUSES,
  TRAVELING_STATUSES,
  allocationLabel,
  baseCurrencyOf,
  deliveryNeedsPhoto,
  expectedUnits,
  hasShipping,
  importKindLabel,
  lineProgress,
  lineProgressText,
  paymentNeedsVoucher,
  TRACE_CODES,
  statusTraceBlocker,
  traceCodes,
  canUploadDocKind,
  costKindLabel,
  costPushPlan,
  docKindLabel,
  formatDmy,
  importAlerts,
  importChecklist,
  igvOf,
  isActiveStatus,
  landedCostOf,
  landedCosts,
  landedItemOf,
  limaToday,
  marginOf,
  moneyInPen,
  moneyInUsd,
  moneyOf,
  moneySummary,
  netOfIgv,
  parseDecimal,
  paymentMethodLabel,
  receptionSummary,
  trackingPublicUrl,
  transportLabel,
  warehouseMessage,
  whatsappShareUrl,
  type Currency,
  type IgvTreatment,
  type ImportEventKind,
} from "@/lib/compras";
import type { CostRow, DeliveryRow, ImportDetail, ItemRow, PaymentRow } from "@/lib/compras-server";
import {
  addImportCost,
  addImportItem,
  addImportPayment,
  pushImportCosts,
  readImportDocumentWithAi,
  registerImportDocument,
  removeImportCost,
  removeImportDocument,
  removeImportItem,
  updateDelivery,
  registerDelivery,
  removeDelivery,
  removeImportPayment,
  setImportFx,
  updateImportCost,
  updateImportPayment,
  setImportItemPhoto,
  setImportStatus,
  setWarehouseReported,
  updateImportItem,
  type AiReadState,
  type ComprasActionState,
} from "@/app/dashboard/compras/actions";
import { AiProposalBox } from "@/components/compras/ai-proposal";
import { canReadWithAi, type PickerProduct } from "@/lib/compras-ia";
import { ProductPicker } from "@/components/compras/product-picker";
import {
  BTN_GHOST,
  BTN_PRIMARY,
  BTN_REMOVE,
  BTN_SECONDARY,
  BTN_SECONDARY_SM,
  FIELD,
  Feedback,
  Field,
  ImportHeaderForm,
  LABEL,
  TEXTAREA,
  fieldBox,
} from "@/components/compras/header-form";
import { FigureCell, FigureFrame, importStatusTone } from "@/components/compras/chrome";
import { uploadImportFile } from "@/components/compras/upload";
import { useCopyToClipboard } from "@/components/copy-button";
import { fmtBytes, fmtDateTime, fmtInt, fmtMoney, fmtPct, fmtPen, fmtPenUnit, fmtSplit, fmtUnit, fmtUsd, fmtUsdUnit } from "@/components/compras/format";

type Store = { id: string; name: string };
type Run = (fn: () => Promise<ComprasActionState>, after?: () => void) => void;
type SectionId = "estado" | "bodega" | "productos" | "recepcion" | "aterrizado" | "costos" | "pagos" | "pasar" | "documentos" | "historial" | "datos";

const SECTION_LABEL: Record<SectionId, string> = {
  estado: "Estado",
  bodega: "Bodega",
  productos: "Productos",
  recepcion: "Entregas",
  aterrizado: "Costo aterrizado",
  costos: "Costos",
  pagos: "Pagos",
  pasar: "Pasar a Costos",
  documentos: "Documentos",
  historial: "Historial",
  datos: "Datos",
};

const sectionDomId = (id: SectionId) => `compra-${id}`;

/** Una tarjeta de sección del detalle, con su ancla para el índice. */
function Section({ id, className, children }: { id: SectionId; className?: string; children: ReactNode }) {
  return (
    <section id={sectionDomId(id)} tabIndex={-1} aria-labelledby={`${sectionDomId(id)}-t`} className={cn(SECTION_CARD, "scroll-mt-20 space-y-4 outline-none", className)}>
      {children}
    </section>
  );
}

/** Las filas de una lista dentro de la tarjeta: hairlines de borde a borde. */
const ROWS = "-mx-4 divide-y divide-line border-t border-line sm:-mx-5";
/** Las mismas filas justo bajo `SectionHead`: su hairline ya es la de arriba. */
const ROWS_TOP = "-mx-4 -mt-4 divide-y divide-line sm:-mx-5";
const ROW = "px-4 py-3 sm:px-5";
/** Un formulario dentro de la tarjeta: lavado sin anillo (no es otra tarjeta). */
const FORM_ZONE = "space-y-3 rounded-lg bg-wash p-3 sm:p-4";

export function ImportDetailView({
  detail,
  stores,
  today,
  aiEnabled = false,
  catalog = [],
}: {
  detail: ImportDetail;
  stores: Store[];
  today: string;
  /** «Leer con IA»: con «Compras» y una clave configurada. */
  aiEnabled?: boolean;
  /** El catálogo de las tiendas para «Agregar producto» (solo llega con «Compras»). */
  catalog?: PickerProduct[];
}) {
  const router = useRouter();
  const [feedback, setFeedback] = useState<ComprasActionState | null>(null);
  const [pending, start] = useTransition();
  const run: Run = (fn, after) =>
    start(async () => {
      const res = await fn();
      setFeedback(res);
      if (!res.error) {
        router.refresh();
        after?.();
      }
    });

  const { imp, items, perms } = detail;
  const money = perms.canMoney;
  const canEdit = perms.canManage;
  // Registrar entregas: «Compras» o «Recepción de compras» (MOM §45.11, §45.14).
  const canCount = perms.canManage || perms.canReceive;
  const fx = imp.fx_pen_per_usd ?? null;
  // Compra local (MOM §45.12): en soles, sin transporte, guía ni aviso a la bodega.
  const local = !hasShipping(imp.kind);
  const [receptionOpen, setReceptionOpen] = useState(false);
  const [editingData, setEditingData] = useState(false);

  // Con el tipo de cambio de la importación: las dos vistas (USD y soles).
  const landed = useMemo(
    () => (money ? landedCosts(items.map(landedItemOf), (detail.costs ?? []).map(landedCostOf), fx) : null),
    [money, items, detail.costs, fx],
  );
  const summary = landed
    ? moneySummary(
        landed,
        items.map((it) => ({ id: it.id, salePricePen: it.sale_price_pen })),
        (detail.payments ?? []).map((p) => ({ amount: p.amount, currency: p.currency })),
      )
    : null;
  const reception = receptionSummary(
    items.map((it) => ({ id: it.id, name: it.name, qty: it.qty, courtesyQty: it.courtesy_qty, receivedQty: it.received_qty, damagedQty: it.damaged_qty })),
  );
  const lastMovement = detail.events.find((e) => MOVEMENT_EVENT_KINDS.includes(e.kind))?.at ?? imp.created_at;
  const alerts = importAlerts({ status: imp.status, kind: imp.kind, eta: imp.eta, reportedAt: imp.reported_to_warehouse_at, lastMovementAt: lastMovement }, today);
  const checklist = importChecklist(detail.documents.map((d) => d.kind), imp.tracking_number, imp.kind);
  const trackingLink = trackingPublicUrl({ carrier: imp.carrier, trackingNumber: imp.tracking_number, trackingUrl: imp.tracking_url });
  const plan =
    landed &&
    costPushPlan({
      status: imp.status,
      fxPenPerUsd: fx,
      items: items.map((it) => ({ id: it.id, name: it.name, sku: it.sku, storeId: it.store_id, receivedQty: it.received_qty, costPushedAt: it.cost_pushed_at })),
      landed,
      trace: traceCodes(imp),
    });
  const storeName = new Map(stores.map((s) => [s.id, s.name]));

  const sections: SectionId[] = [
    "estado",
    ...(canEdit && !local ? (["bodega"] as const) : []),
    "productos",
    "recepcion",
    ...(money && landed ? (["aterrizado", "costos", "pagos"] as const) : []),
    ...(money && plan ? (["pasar"] as const) : []),
    "documentos",
    "historial",
    "datos",
  ];

  const jump = (id: SectionId) => {
    const el = document.getElementById(sectionDomId(id));
    if (!el) return;
    const bar = document.getElementById("compra-indice")?.getBoundingClientRect().height ?? 0;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - bar - 12, behavior: reduce ? "auto" : "smooth" });
    el.focus({ preventScroll: true });
  };

  // La próxima acción: la primera que aplica, solo con lo que ya dicen las
  // alertas, la recepción y el plan de Costos (no hay reglas nuevas aquí).
  const receptionEditable = canCount && imp.status !== "cancelado" && items.length > 0;
  // Toca registrar lo que llega: ya en la bodega (o una parte), en camino con
  // la llegada vencida o, en una compra local, en cualquier momento después de
  // la cotización (la trae el laboratorio).
  const due =
    imp.status === "recibido_parcial" ||
    (local ? isActiveStatus(imp.status) && imp.status !== "cotizacion" : TRAVELING_STATUSES.includes(imp.status) && alerts.daysToEta !== null && alerts.daysToEta <= 0) ||
    RECEIVED_STATUSES.includes(imp.status);
  const next: { title: string; help: string; label: string; onClick: () => void } | null =
    canEdit && alerts.notifyWarehouse
      ? {
          title: "Avisar a la bodega",
          help: `${alerts.late ? "Ya debía llegar" : alerts.daysToEta === 0 ? "Llega hoy" : `Llega en ${alerts.daysToEta} día${alerts.daysToEta === 1 ? "" : "s"}`} y la bodega de Lima no está avisada. Copia el mensaje o ábrelo en WhatsApp y márcala como reportada.`,
          label: "Ir al aviso",
          onClick: () => jump("bodega"),
        }
      : receptionEditable && due && !reception.allArrived
        ? {
            title: detail.deliveries.length ? "Registrar la siguiente entrega" : "Registrar entrega",
            help: detail.deliveries.length
              ? `Faltan ${fmtInt(reception.expected - reception.received > 0 ? reception.expected - reception.received : 0)} u. de lo esperado (pedidas + cortesía).${local ? " Cada entrega lleva su foto." : ""}`
              : `Anota lo que llegó por producto: cuántas llegaron y cuántas dañadas${local ? ", con la foto de lo que llegó" : ""}. Si llegó todo, pasa a Recibido; si no, a Recibido parcial.`,
            label: "Registrar entrega",
            onClick: () => {
              setReceptionOpen(true);
              jump("recepcion");
            },
          }
        : money && plan && !plan.alreadyDone && plan.ready && perms.canPushCosts
          ? {
              title: "Pasar a Costos",
              help: landed?.hasUsd
                ? "La recepción está contada y hay tipo de cambio: ya se puede llevar el costo aterrizado por unidad a Costos de productos."
                : "La recepción está contada: ya se puede llevar el costo aterrizado por unidad, en soles, a Costos de productos.",
              label: "Revisar y pasar",
              onClick: () => jump("pasar"),
            }
          : null;

  const arrival = arrivalFigure(imp.arrived_on, imp.eta, alerts, isActiveStatus(imp.status));
  const lastDelivery = detail.deliveries[detail.deliveries.length - 1] ?? null;
  const figures: { key: string; label: string; value: ReactNode; sub?: ReactNode; tone?: "warn" | "crit" | "ok" }[] = [
    { key: "llegada", label: imp.arrived_on ? "Llegó" : local ? "Entrega estimada" : "Llegada estimada", value: arrival.value, sub: arrival.sub, tone: arrival.tone },
    {
      key: "unidades",
      label: "Unidades",
      value: fmtInt(reception.ordered),
      sub: [
        reception.courtesy ? `+${fmtInt(reception.courtesy)} de cortesía` : null,
        reception.counted ? `${fmtInt(reception.received)} llegaron · ${fmtInt(reception.good)} buenas` : `${items.length} producto${items.length === 1 ? "" : "s"} · sin entregas`,
      ]
        .filter(Boolean)
        .join(" · "),
    },
    ...(summary
      ? [
          // La compra local se lee en soles: sin tipo de cambio si todo está en soles.
          local && summary.totalPen !== null
            ? {
                key: "total",
                label: "Costo total (S/)",
                value: fmtPen(summary.totalPen),
                sub: summary.avgUnitPen != null ? `${fmtPenUnit(summary.avgUnitPen)} por unidad buena` : undefined,
              }
            : summary.totalUsd !== null
            ? {
                key: "total",
                label: "Costo total (USD)",
                value: fmtUsd(summary.totalUsd),
                sub:
                  summary.avgUnitUsd != null
                    ? `${fmtUsdUnit(summary.avgUnitUsd)} por unidad buena`
                    : summary.totalPen !== null && summary.total.pen !== 0
                      ? fmtPen(summary.totalPen)
                      : undefined,
              }
            : {
                // Costos en soles y sin tipo de cambio: cada moneda por separado, nunca una suma a medias.
                key: "total",
                label: "Costo total",
                value: "—",
                sub: `${MISSING_FX} · ${fmtSplit(summary.total)}`,
                tone: "warn" as const,
              },
          balanceFigure(summary, local),
          {
            key: "ganancia",
            label: "Ganancia esperada (S/)",
            value: summary.expectedProfitPen != null ? fmtPen(summary.expectedProfitPen) : "—",
            sub:
              summary.recoveryShare != null
                ? `Recuperas lo invertido al vender el ${Math.min(999, Math.round(summary.recoveryShare * 100))} % de las unidades`
                : fx || (landed && !landed.hasUsd)
                  ? "Falta el precio de venta de algún producto"
                  : "Falta el tipo de cambio",
          },
        ]
      : local
        ? [
            {
              key: "entregas",
              label: "Entregas",
              value: fmtInt(detail.deliveries.length),
              sub: lastDelivery ? `La última, ${formatDmy(lastDelivery.delivered_on)}` : "Ninguna todavía",
            },
            {
              key: "faltan",
              label: "Faltan",
              value: fmtInt(Math.max(0, reception.expected - reception.received)),
              sub: reception.allArrived ? "Llegó todo lo esperado" : "u. de lo esperado",
              tone: reception.counted && !reception.allArrived ? ("warn" as const) : undefined,
            },
          ]
        : [
            {
              key: "guia",
              label: "Guía",
              value: <span className="font-mono text-base">{imp.tracking_number ?? "—"}</span>,
              sub: imp.carrier ?? undefined,
            },
            {
              key: "bodega",
              label: "Bodega",
              value: imp.reported_to_warehouse_at ? "Reportada" : "Sin avisar",
              sub: imp.reported_to_warehouse_at ? fmtDateTime(imp.reported_to_warehouse_at) : undefined,
              tone: alerts.notifyWarehouse ? ("warn" as const) : undefined,
            },
          ]),
  ];

  return (
    <div className="space-y-6 pb-8">
      <DetailHeader
        detail={detail}
        alerts={alerts}
        checklist={checklist}
        canEdit={canEdit}
        onEdit={
          canEdit && !editingData
            ? () => {
                setEditingData(true);
                jump("datos");
              }
            : undefined
        }
      />

      <FigureFrame className={figures.length === 5 ? "lg:grid-cols-5" : "lg:grid-cols-4"}>
        {figures.map((f, i) => (
          <FigureCell
            key={f.key}
            label={f.label}
            value={f.value}
            sub={f.sub}
            tone={f.tone}
            // Con un número impar de celdas, la última ocupa la fila entera en el teléfono.
            className={cn(figures.length % 2 === 1 && i === figures.length - 1 && "col-span-2 lg:col-span-1")}
          />
        ))}
      </FigureFrame>

      <SectionIndex sections={sections} onJump={jump} code={imp.code} status={imp.status} feedback={feedback} onDismiss={() => setFeedback(null)} />

      {next && (
        <section aria-labelledby="compra-siguiente" className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-lg bg-white p-4 shadow-control ring-2 ring-brand-600 sm:p-5">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="compra-siguiente" className="text-base font-semibold leading-6 text-ink-900">
                {next.title}
              </h2>
              <Badge tone="brand">Siguiente</Badge>
            </div>
            <p className="mt-0.5 max-w-[68ch] text-[13px] leading-5 text-ink-600">{next.help}</p>
          </div>
          <button type="button" className={cn(BTN_PRIMARY, "w-full sm:w-auto")} onClick={next.onClick}>
            {next.label}
            <IconChevronRight aria-hidden />
          </button>
        </section>
      )}

      <div className="grid gap-4 sm:gap-6 xl:grid-cols-[minmax(0,1fr)_22rem] xl:grid-rows-[auto_1fr] xl:items-start">
        <div className="grid gap-4 sm:gap-6 lg:grid-cols-2 xl:col-start-2 xl:row-start-1 xl:grid-cols-1">
          <StatusBox detail={detail} canEdit={canEdit} run={run} pending={pending} />
          {canEdit && !local && <WarehouseBox detail={detail} trackingLink={trackingLink} notify={alerts.notifyWarehouse} run={run} pending={pending} />}
        </div>

        <div className="min-w-0 space-y-4 sm:space-y-6 xl:col-start-1 xl:row-span-2 xl:row-start-1">
          <ItemsBox detail={detail} stores={stores} storeName={storeName} landed={landed} fx={fx} canEdit={canEdit} aiEnabled={aiEnabled && canEdit} catalog={catalog} run={run} pending={pending} />

          <DeliveriesBox
            detail={detail}
            summary={reception}
            canRegister={canCount}
            canCorrect={canEdit}
            today={today}
            open={receptionOpen}
            setOpen={setReceptionOpen}
            run={run}
            pending={pending}
          />

          {money && landed && <LandedBox detail={detail} landed={landed} fx={fx} canEdit={canEdit} run={run} pending={pending} />}

          {money && <CostsBox detail={detail} fx={fx} canEdit={canEdit} run={run} pending={pending} />}
          {money && <PaymentsBox detail={detail} summary={summary} fx={fx} canEdit={canEdit} run={run} pending={pending} />}

          {money && plan && (
            <Section id="pasar">
              <SectionHead
                id={`${sectionDomId("pasar")}-t`}
                title="Pasar a Costos"
                badge={
                  plan.alreadyDone ? (
                    <Badge tone="ok">Ya en Costos</Badge>
                  ) : plan.blockers.length ? (
                    <Badge tone="warn">
                      {plan.blockers.length} pendiente{plan.blockers.length === 1 ? "" : "s"}
                    </Badge>
                  ) : plan.ready ? (
                    <Badge tone="info">Lista</Badge>
                  ) : undefined
                }
                help={
                  <>
                    Lleva el costo aterrizado por unidad, en soles, de cada producto con SKU a Costos de productos: lote{" "}
                    <span className="font-mono text-xs">{imp.code}</span>, vigente desde la llegada ({formatDmy(imp.arrived_on ?? limaToday())}). Cada
                    producto se pasa una sola vez.{local && landed && !landed.hasUsd ? " Todo está en soles: no hace falta el tipo de cambio." : ""}
                  </>
                }
              />
              {plan.blockers.length > 0 && (
                <Banner tone="warn" title="Antes de pasar">
                  <ul className="mt-1 list-disc space-y-0.5 pl-5">
                    {plan.blockers.map((b) => (
                      <li key={b}>{b}</li>
                    ))}
                  </ul>
                </Banner>
              )}
              {plan.lines.length > 0 && (
                <ul className={plan.blockers.length ? ROWS : ROWS_TOP}>
                  {plan.lines.map((l) => (
                    <li key={l.itemId} className={cn(ROW, "flex flex-wrap items-center justify-between gap-x-4 gap-y-1")}>
                      <span className="min-w-0">
                        <span className="block truncate text-sm leading-5 text-ink-900">{l.name}</span>
                        <span className="block truncate text-[13px] leading-5 text-ink-500">
                          SKU <span className="font-mono text-xs">{l.sku}</span> · {l.storeId ? (storeName.get(l.storeId) ?? "tienda") : "todas las tiendas"}
                        </span>
                      </span>
                      <span className="text-[13px] leading-5 tabular-nums">
                        {l.state === "push" && <span className="text-sm font-semibold text-ink-900">{fmtPen(l.unitCostPen)} por unidad</span>}
                        {l.state === "already" && <span className="text-ok-fg">Ya se pasó ({fmtDateTime(l.pushedAt)})</span>}
                        {l.state === "skip" && <span className="text-ink-500">{l.reason}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <div className={cn(CARD_ZONE, "flex flex-wrap items-center gap-3")}>
                {plan.alreadyDone ? (
                  <p className="text-sm font-medium text-ok-fg">Ya se pasó a Costos.</p>
                ) : perms.canPushCosts ? (
                  <button type="button" className={BTN_PRIMARY} disabled={pending || !plan.ready} onClick={() => run(() => pushImportCosts(imp.id))}>
                    Pasar a Costos
                  </button>
                ) : (
                  <p className="text-[13px] leading-5 text-ink-500">Pasar a Costos pide además el permiso «Editar costos».</p>
                )}
              </div>
            </Section>
          )}

          <DocumentsBox
            detail={detail}
            stores={stores}
            canEdit={canEdit}
            aiEnabled={aiEnabled && canEdit}
            run={run}
            pending={pending}
            setFeedback={setFeedback}
          />

          <HistoryBox detail={detail} />
        </div>

        <div className="xl:col-start-2 xl:row-start-2">
          <DataBox detail={detail} canEdit={canEdit} trackingLink={trackingLink} editing={editingData} setEditing={setEditingData} />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cabecera, cifras e índice
// ---------------------------------------------------------------------------

type Summary = ReturnType<typeof moneySummary>;

/**
 * «Pagado / Falta pagar» sin mezclar monedas (MOM §45.3): en la base (USD) si se
 * puede convertir; todo en soles y sin tipo de cambio, en soles; mezcladas y sin
 * tipo de cambio, cada moneda por separado y el aviso.
 */
function balanceFigure(s: Summary, preferPen = false): { key: string; label: string; value: ReactNode; sub?: ReactNode; tone?: "warn" | "ok" } {
  // Una compra local se lee en soles si se puede (MOM §45.12); una importación, en USD.
  const usd = s.pendingUsd !== null && !(preferPen && s.pendingPen !== null);
  const pending = usd ? s.pendingUsd : s.pendingPen;
  const total = usd ? s.totalUsd : s.totalPen;
  if (pending === null || total === null) {
    return { key: "pagado", label: "Pagado", value: "—", sub: `Pagado ${fmtSplit(s.paid)} · ${MISSING_FX} para el saldo`, tone: "warn" };
  }
  const fmt = usd ? fmtUsd : fmtPen;
  return {
    key: "pagado",
    label: usd ? "Pagado (USD)" : "Pagado (S/)",
    value: fmt(usd ? s.paidUsd : s.paidPen),
    // Sin nada que pagar todavía, «Pagado completo» se leería como un hecho.
    sub: pending > 0 ? `Falta pagar ${fmt(pending)}` : total > 0 ? "Pagado completo" : "Sin costos todavía",
    tone: pending > 0 ? "warn" : total > 0 ? "ok" : undefined,
  };
}

function arrivalFigure(
  arrivedOn: string | null,
  eta: string | null,
  alerts: ReturnType<typeof importAlerts>,
  active: boolean,
): { value: string; sub?: string; tone?: "warn" | "crit" | "ok" } {
  if (arrivedOn) return { value: formatDmy(arrivedOn), sub: eta ? `Estimada ${formatDmy(eta)}` : undefined };
  if (!eta) return { value: "—", sub: "Sin llegada estimada" };
  const days = alerts.daysToEta;
  if (!active || days == null) return { value: formatDmy(eta) };
  if (alerts.late) return { value: formatDmy(eta), sub: `${fmtInt(-days)} d de atraso`, tone: "crit" };
  if (days === 0) return { value: formatDmy(eta), sub: "Llega hoy", tone: alerts.notifyWarehouse ? "warn" : undefined };
  return { value: formatDmy(eta), sub: `En ${fmtInt(days)} día${days === 1 ? "" : "s"}`, tone: alerts.notifyWarehouse ? "warn" : undefined };
}

function DetailHeader({
  detail,
  alerts,
  checklist,
  canEdit,
  onEdit,
}: {
  detail: ImportDetail;
  alerts: ReturnType<typeof importAlerts>;
  checklist: ReturnType<typeof importChecklist>;
  canEdit: boolean;
  /** «Editar datos»: abre el formulario en la tarjeta «Datos». */
  onEdit?: () => void;
}) {
  const { imp, supplier } = detail;
  const local = !hasShipping(imp.kind);
  const flags: { key: string; tone: "warn" | "crit" | "neutral"; label: string }[] = [];
  if (alerts.late) flags.push({ key: "late", tone: "crit", label: local ? "Atrasada: la entrega estimada ya pasó" : "Atrasada: la llegada estimada ya pasó" });
  if (alerts.notifyWarehouse) flags.push({ key: "notify", tone: "warn", label: "Avisar a la bodega" });
  if (alerts.stale) flags.push({ key: "stale", tone: "warn", label: `Sin novedades hace ${alerts.daysSinceMovement} días` });
  if (!checklist.invoice) flags.push({ key: "invoice", tone: "neutral", label: local ? "Falta la factura del laboratorio" : "Falta la factura comercial" });
  // Los códigos de trazabilidad de una importación (MOM §45.15): un aviso mientras falte alguno.
  const codes = traceCodes(imp);
  if (codes.applies && codes.missing.length) {
    flags.push({ key: "codes", tone: "warn", label: `Códigos ${codes.filled} de 3 · falta ${codes.missing.map((id) => TRACE_CODES.find((c) => c.id === id)!.short).join(", ")}` });
  }
  if (detail.traceDuplicates.proforma.length || detail.traceDuplicates.alibaba.length) {
    flags.push({ key: "dup", tone: "warn", label: `Posible duplicado: ${[...new Set([...detail.traceDuplicates.proforma, ...detail.traceDuplicates.alibaba])].join(", ")}` });
  }
  // Una compra local no tiene guía (`tracking` null).
  if (checklist.tracking === false) flags.push({ key: "tracking", tone: "neutral", label: "Falta el tracking" });
  return (
    <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
      <div className="flex min-w-0 items-start gap-2">
        <a href="/dashboard/compras" aria-label="Volver a Compras" title="Volver a Compras" className="-ml-2 mt-0.5 grid size-8 shrink-0 place-items-center rounded-md text-ink-500 transition-colors duration-150 hover:bg-wash hover:text-ink-900 pointer-coarse:size-11">
          <IconArrowLeft aria-hidden className="size-4" />
        </a>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h1 className="text-[28px] font-bold leading-9 tracking-[-0.01em] text-ink-900">{imp.code}</h1>
            <Badge tone={importStatusTone(imp.status)}>{IMPORT_STATUS_LABEL[imp.status]}</Badge>
            {local && <Badge tone="info">{importKindLabel(imp.kind)}</Badge>}
          </div>
          <p className="mt-1 text-sm text-ink-500">
            <span className="font-medium text-ink-700">{supplier?.name ?? (local ? "Sin laboratorio" : "Sin proveedor")}</span>
            {canEdit && supplier?.whatsapp ? (
              <>
                {" · "}
                <a href={whatsappShareUrl("", supplier.whatsapp)} target="_blank" rel="noopener noreferrer" className="font-medium text-brand-700 hover:underline">
                  WhatsApp
                </a>
              </>
            ) : null}
            {" · "}
            {imp.origin ?? "Origen sin indicar"} → bodega de Kapta, Lima · {local ? "en soles, la entrega el laboratorio" : transportLabel(imp.transport)}
          </p>
          {flags.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Lo que pide atención">
              {flags.map((f) => (
                <Badge key={f.key} tone={f.tone}>
                  {f.label}
                </Badge>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {/* El Excel vuelve a pedir el permiso; sin «Montos de compras» sale sin dinero (MOM §45.9). */}
        <a href={`/api/compras/excel/${imp.id}`} className={BTN_SECONDARY} download>
          <IconDownload aria-hidden />
          Excel
        </a>
        {onEdit && (
          <button type="button" className={BTN_SECONDARY} onClick={onEdit}>
            Editar datos
          </button>
        )}
      </div>
    </header>
  );
}

/**
 * El índice de la página, pegajoso sobre el lienzo (DESIGN.md › Ficha del
 * pedido › Índice): las secciones en el orden en que se leen, la que se está
 * leyendo en `brand-50`. Al bajar, el código y su chapa vuelven aquí. El aviso
 * de la última acción vive dentro, con su «x».
 */
function SectionIndex({
  sections,
  onJump,
  code,
  status,
  feedback,
  onDismiss,
}: {
  sections: SectionId[];
  onJump: (id: SectionId) => void;
  code: string;
  status: ImportDetail["imp"]["status"];
  feedback: ComprasActionState | null;
  onDismiss: () => void;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState<SectionId | null>(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const onScroll = () => {
      const el = bar.current;
      if (!el) return;
      const top = el.getBoundingClientRect();
      setStuck(top.top <= 0.5);
      const line = top.bottom + 16;
      let cur: SectionId | null = null;
      for (const id of sections) {
        const s = document.getElementById(sectionDomId(id));
        if (s && s.getBoundingClientRect().top <= line) cur = id;
      }
      // Al llegar al fondo, la última.
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) cur = sections[sections.length - 1] ?? cur;
      setCurrent(cur);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [sections]);
  const message = feedback?.error || feedback?.notice;
  return (
    <div
      ref={bar}
      id="compra-indice"
      className={cn(
        "sticky top-0 z-20 -mx-4 bg-slate-50 px-4 sm:-mx-5 sm:px-5 lg:-mx-8 lg:px-8",
        stuck && "shadow-[inset_0_-1px_0_var(--color-line)]",
      )}
    >
      <div className="flex items-center gap-3 py-2">
        <span className={cn("hidden shrink-0 items-center gap-2 lg:flex", !stuck && "lg:hidden")}>
          <span className="text-sm font-semibold tabular-nums text-ink-900">{code}</span>
          <Badge tone={importStatusTone(status)}>{IMPORT_STATUS_LABEL[status]}</Badge>
          <span aria-hidden className="h-4 w-px bg-line-strong" />
        </span>
        <nav aria-label="En esta página" className="-my-1 min-w-0 flex-1 overflow-x-auto py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <ul className="flex w-max gap-1">
            {sections.map((id) => (
              <li key={id}>
                <button
                  type="button"
                  onClick={() => onJump(id)}
                  aria-current={current === id ? "location" : undefined}
                  className={cn(
                    "inline-flex h-7 items-center whitespace-nowrap rounded-md px-2.5 text-[13px] font-medium transition-colors duration-150 pointer-coarse:h-11",
                    current === id ? "bg-brand-50 text-brand-700" : "text-ink-600 hover:bg-wash hover:text-ink-900",
                  )}
                >
                  {SECTION_LABEL[id]}
                </button>
              </li>
            ))}
          </ul>
        </nav>
      </div>
      {message && (
        <div className="pb-2">
          <div
            role={feedback?.error ? "alert" : "status"}
            className={cn("flex items-start gap-3 rounded-lg py-2.5 pl-4 pr-2 text-sm text-ink-700", feedback?.error ? "bg-crit-wash" : "bg-ok-wash")}
          >
            <p className="min-w-0 flex-1 py-0.5">
              <span className={cn("font-semibold", feedback?.error ? "text-crit-fg" : "text-ok-fg")}>{feedback?.error ? "No se pudo. " : "Hecho. "}</span>
              {message}
            </p>
            <button type="button" onClick={onDismiss} aria-label="Cerrar aviso" className="grid size-7 shrink-0 place-items-center rounded-md text-ink-500 transition-colors duration-150 hover:bg-white/60 hover:text-ink-900 pointer-coarse:size-11">
              <IconX aria-hidden className="size-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Riel: estado, bodega y datos
// ---------------------------------------------------------------------------

function StatusBox({ detail, canEdit, run, pending }: { detail: ImportDetail; canEdit: boolean; run: Run; pending: boolean }) {
  const [status, setStatus] = useState<string>(detail.imp.status);
  const [note, setNote] = useState("");
  // Antes de intentarlo: lo que el servidor va a pedir para ese estado (MOM §45.15).
  const blocked =
    status !== detail.imp.status && IMPORT_STATUSES.some((s) => s.id === status)
      ? statusTraceBlocker(detail.imp, status as ImportDetail["imp"]["status"])
      : null;
  return (
    <Section id="estado">
      <SectionHead
        id={`${sectionDomId("estado")}-t`}
        title="Estado"
        badge={<Badge tone={importStatusTone(detail.imp.status)}>{IMPORT_STATUS_LABEL[detail.imp.status]}</Badge>}
        help={canEdit ? "Cambia el estado o deja una nota de novedad del envío: queda en el historial." : "Lo cambia quien tiene el permiso «Compras»."}
      />
      {canEdit && (
        <div className="space-y-3">
          <Field label="Nuevo estado">
            <select className={FIELD} value={status} onChange={(e) => setStatus(e.target.value)}>
              {IMPORT_STATUSES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Nota (opcional)">
            <textarea className={TEXTAREA} rows={2} placeholder="Novedad del envío, motivo…" value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          {blocked && (
            <Banner tone="warn" title="Faltan códigos de trazabilidad">
              <p>{blocked.message} Complétalos en «Datos».</p>
            </Banner>
          )}
          <button
            type="button"
            className={BTN_PRIMARY}
            disabled={pending || Boolean(blocked)}
            onClick={() => run(() => setImportStatus(detail.imp.id, status, note), () => setNote(""))}
          >
            {status === detail.imp.status ? "Registrar nota" : "Cambiar estado"}
          </button>
        </div>
      )}
    </Section>
  );
}

function WarehouseBox({
  detail,
  trackingLink,
  notify,
  run,
  pending,
}: {
  detail: ImportDetail;
  trackingLink: string | null;
  notify: boolean;
  run: Run;
  pending: boolean;
}) {
  const { imp } = detail;
  const { state: copyState, copy } = useCopyToClipboard(2000);
  const message = warehouseMessage({
    code: imp.code,
    supplierName: detail.supplier?.name ?? null,
    carrier: imp.carrier,
    trackingNumber: imp.tracking_number,
    trackingLink,
    eta: imp.eta,
    items: detail.items.map((it) => ({ qty: it.qty, name: it.name, sku: it.sku })),
  });
  return (
    <Section id="bodega">
      <SectionHead
        id={`${sectionDomId("bodega")}-t`}
        title="Aviso a la bodega de Lima"
        badge={imp.reported_to_warehouse_at ? <Badge tone="ok">Reportada</Badge> : notify ? <Badge tone="warn">Sin avisar</Badge> : undefined}
        help={
          imp.reported_to_warehouse_at
            ? `Reportada ${fmtDateTime(imp.reported_to_warehouse_at)}${detail.reportedByName ? ` por ${detail.reportedByName}` : ""}.`
            : "El mensaje con la guía, la llegada y los productos, listo para mandar."
        }
      />
      <textarea className={cn(TEXTAREA, "bg-wash font-mono text-xs leading-5 text-ink-700 shadow-none ring-line")} rows={7} readOnly value={message} aria-label="Mensaje para la bodega" />
      <div className="flex flex-wrap gap-2">
        <button type="button" className={BTN_SECONDARY} onClick={() => copy(message)} aria-live="polite">
          <IconCopy aria-hidden />
          {copyState === "ok" ? "Copiado" : copyState === "fail" ? "No se pudo copiar" : "Copiar mensaje"}
        </button>
        <a href={whatsappShareUrl(message)} target="_blank" rel="noopener noreferrer" className={BTN_SECONDARY}>
          <IconWhatsApp aria-hidden />
          Abrir WhatsApp
        </a>
      </div>
      <div className={cn(CARD_ZONE)}>
        {imp.reported_to_warehouse_at ? (
          <button type="button" className={BTN_GHOST} disabled={pending} onClick={() => run(() => setWarehouseReported(imp.id, false))}>
            Quitar marca
          </button>
        ) : (
          <button type="button" className={cn(BTN_PRIMARY, "w-full sm:w-auto")} disabled={pending} onClick={() => run(() => setWarehouseReported(imp.id, true))}>
            Marcar como reportada
          </button>
        )}
      </div>
    </Section>
  );
}

function DataBox({
  detail,
  canEdit,
  trackingLink,
  editing,
  setEditing,
}: {
  detail: ImportDetail;
  canEdit: boolean;
  trackingLink: string | null;
  editing: boolean;
  setEditing: (editing: boolean) => void;
}) {
  const { imp, supplier } = detail;
  const local = !hasShipping(imp.kind);
  const shippingRows: { label: string; value: ReactNode; wide?: boolean }[] = local
    ? []
    : [
        { label: "Transporte", value: transportLabel(imp.transport) },
        {
          label: "Guía de envío",
      value: imp.tracking_number ? (
        <>
          {imp.carrier ? `${imp.carrier} ` : ""}
          {trackingLink ? (
            <a href={trackingLink} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 font-mono text-xs text-brand-700 hover:underline">
              {imp.tracking_number}
              <IconArrowUpRight aria-hidden className="size-3.5" />
            </a>
          ) : (
            <span className="font-mono text-xs">{imp.tracking_number}</span>
          )}
        </>
      ) : (
        <span className="font-medium text-warn-fg">Falta{imp.carrier ? ` · ${imp.carrier}` : ""}</span>
      ),
        },
      ];
  const codes = traceCodes(imp);
  const dup = detail.traceDuplicates;
  const codeValue = (v: string | null | undefined, others: string[]) =>
    v ? (
      <>
        <span className="font-mono text-xs">{v}</span>
        {others.length ? <span className="block text-[13px] font-medium text-warn-fg">También en {others.join(", ")}: ¿duplicado?</span> : null}
      </>
    ) : (
      <span className="font-medium text-warn-fg">Falta</span>
    );
  const rows: { label: string; value: ReactNode; wide?: boolean }[] = [
    { label: "Tipo", value: local ? "Compra local (laboratorio o maquila), en soles" : "Importación" },
    { label: local ? "Laboratorio" : "Proveedor", value: supplier?.name ?? "Sin proveedor" },
    { label: "Origen", value: imp.origin ?? "Sin indicar" },
    ...(codes.applies
      ? [
          {
            label: "Códigos",
            value: (
              <Badge tone={codes.missing.length ? "warn" : "ok"} className="tabular-nums">
                {codes.filled} de 3 de trazabilidad
              </Badge>
            ),
          },
          { label: "Proforma invoice", value: codeValue(imp.proforma_number, dup.proforma) },
          { label: "Orden de Alibaba", value: codeValue(imp.platform_order, dup.alibaba) },
        ]
      : []),
    ...shippingRows,
    ...(codes.applies ? [] : [{ label: "N.º de orden", value: imp.platform_order ? <span className="font-mono text-xs">{imp.platform_order}</span> : "—" }]),
    { label: "Pedido", value: formatDmy(imp.ordered_on) },
    { label: imp.arrived_on ? "Llegó" : "Llegada estimada", value: formatDmy(imp.arrived_on ?? imp.eta) },
    ...(imp.arrived_on && imp.eta ? [{ label: "Estimada", value: formatDmy(imp.eta) }] : []),
    ...(imp.notes ? [{ label: "Notas", value: <span className="whitespace-pre-line">{imp.notes}</span>, wide: true }] : []),
  ];
  return (
    <Section id="datos">
      <SectionHead
        id={`${sectionDomId("datos")}-t`}
        title="Datos"
        aside={
          canEdit && !editing ? (
            <button type="button" className={BTN_SECONDARY_SM} onClick={() => setEditing(true)}>
              Editar datos
            </button>
          ) : undefined
        }
      />
      {editing ? (
        <ImportHeaderForm orgId={imp.org_id} suppliers={detail.suppliers} imp={imp} onDone={() => setEditing(false)} narrow />
      ) : (
        <dl className="-mt-1 divide-y divide-line">
          {rows.map((r) => (
            <div key={r.label} className={cn("grid gap-x-4 gap-y-0.5 py-2 text-sm leading-5", r.wide ? "grid-cols-1" : "grid-cols-[8rem_minmax(0,1fr)]")}>
              <dt className="text-[13px] text-ink-500">{r.label}</dt>
              <dd className="min-w-0 break-words tabular-nums text-ink-900">{r.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Productos
// ---------------------------------------------------------------------------

/** `unitCost`: en la moneda base de la compra (USD la importación, soles la compra local). */
type ItemDraft = { name: string; sku: string; storeId: string; qty: string; courtesyQty: string; unitWeightKg: string; unitCost: string; salePricePen: string };

const EMPTY_ITEM: ItemDraft = { name: "", sku: "", storeId: "", qty: "", courtesyQty: "", unitWeightKg: "", unitCost: "", salePricePen: "" };

function itemDraft(it: ItemRow): ItemDraft {
  const cost = it.unit_cost_currency === "PEN" ? it.unit_cost_pen : it.unit_cost_usd;
  return {
    name: it.name,
    sku: it.sku ?? "",
    storeId: it.store_id ?? "",
    qty: String(it.qty),
    courtesyQty: it.courtesy_qty ? String(it.courtesy_qty) : "",
    unitWeightKg: it.unit_weight_kg == null ? "" : String(it.unit_weight_kg),
    unitCost: cost == null ? "" : String(cost),
    salePricePen: it.sale_price_pen == null ? "" : String(it.sale_price_pen),
  };
}

const FILE_INPUT =
  "block w-full min-w-0 text-[13px] text-ink-600 file:mr-3 file:h-8 file:cursor-pointer file:rounded-md file:border-0 file:bg-white file:px-3 file:text-[13px] file:font-semibold file:text-ink-700 file:shadow-control file:ring-1 file:ring-inset file:ring-line-strong hover:file:bg-wash";

function ItemForm({
  importId,
  stores,
  money,
  base = "USD",
  item,
  catalog = [],
  run,
  pending,
  onDone,
}: {
  importId: string;
  stores: Store[];
  money: boolean;
  /** La moneda del costo por unidad: USD (importación) o soles (compra local). */
  base?: Currency;
  item?: ItemRow;
  /** Al agregar: el catálogo de las tiendas; vacío, solo «Producto nuevo». */
  catalog?: PickerProduct[];
  run: Run;
  pending: boolean;
  onDone: () => void;
}) {
  const [d, setD] = useState<ItemDraft>(item ? itemDraft(item) : EMPTY_ITEM);
  // «Del catálogo» llena nombre, SKU y la tienda (si el SKU se vio siempre en la
  // misma); «Producto nuevo» es el de siempre, todo a mano. Se guarda igual.
  const withCatalog = !item && catalog.length > 0;
  const [mode, setMode] = useState<"catalogo" | "nuevo">(withCatalog ? "catalogo" : "nuevo");
  const [picked, setPicked] = useState<PickerProduct | null>(null);
  const storeIds = new Set(stores.map((s) => s.id));
  const storeName = new Map(stores.map((s) => [s.id, s.name]));
  const fromCatalog = withCatalog && mode === "catalogo";
  const [photo, setPhoto] = useState<File | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const set = (k: keyof ItemDraft) => (e: { target: { value: string } }) => setD((x) => ({ ...x, [k]: e.target.value }));
  // Sin «Montos de compras» el formulario no manda costo ni precio (y el servidor no los leería).
  const payload = () => {
    const fields = { name: d.name, sku: d.sku, storeId: d.storeId, qty: d.qty, courtesyQty: d.courtesyQty, unitWeightKg: d.unitWeightKg };
    if (!money) return fields;
    return { ...fields, ...(base === "PEN" ? { unitCostPen: d.unitCost } : { unitCostUsd: d.unitCost }), salePricePen: d.salePricePen };
  };
  return (
    <div className={FORM_ZONE}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] font-semibold text-ink-900">{item ? `Editar «${item.name}»` : "Nuevo producto"}</p>
        {withCatalog && (
          <div role="radiogroup" aria-label="De dónde sale el producto" className="flex flex-wrap gap-2">
            {(
              [
                ["catalogo", "De las tiendas"],
                ["nuevo", "Producto nuevo"],
              ] as const
            ).map(([m, label]) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                className={choiceChipClass(mode === m)}
                onClick={() => {
                  setMode(m);
                  if (m === "nuevo" && picked) {
                    setPicked(null);
                    setD((x) => ({ ...x, name: "", sku: "", storeId: "" }));
                  }
                }}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
      {fromCatalog && !picked && (
        <ProductPicker
          products={catalog}
          storeName={storeName}
          autoFocus
          onPick={(p) => {
            setPicked(p);
            setD((x) => ({ ...x, name: p.name ?? p.sku, sku: p.sku, storeId: p.storeId && storeIds.has(p.storeId) ? p.storeId : "" }));
          }}
        />
      )}
      {fromCatalog && picked && (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-md bg-white px-3 py-2 ring-1 ring-inset ring-line">
          <span className="min-w-0">
            <span className="block text-sm font-medium leading-5 text-ink-900">{d.name}</span>
            <span className="block text-[13px] leading-5 text-ink-500">
              SKU <span className="font-mono text-xs text-ink-700">{d.sku}</span>
              {picked.orderCount > 0 ? <span className="tabular-nums"> · en {picked.orderCount.toLocaleString("es-PE")} pedido{picked.orderCount === 1 ? "" : "s"}</span> : null}
            </span>
          </span>
          <button
            type="button"
            className={BTN_GHOST}
            onClick={() => {
              setPicked(null);
              setD((x) => ({ ...x, name: "", sku: "", storeId: "" }));
            }}
          >
            Cambiar
          </button>
        </div>
      )}
      <div className={cn("grid gap-3 sm:grid-cols-2 lg:grid-cols-4", fromCatalog && !picked && "hidden")}>
        {!fromCatalog && (
          <>
            <Field label="Producto" className="sm:col-span-2">
              <input className={FIELD} value={d.name} onChange={set("name")} />
            </Field>
            <Field label="SKU (para Costos)">
              <input className={cn(FIELD, "font-mono")} value={d.sku} onChange={set("sku")} />
            </Field>
          </>
        )}
        <Field
          label="Tienda"
          hint={fromCatalog && picked && !picked.storeId ? "Este SKU se vio en más de una tienda o sin tienda: elige una si el costo es solo de ella." : undefined}
        >
          <select className={FIELD} value={d.storeId} onChange={set("storeId")}>
            <option value="">Todas las tiendas</option>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Cantidad">
          <input className={cn(FIELD, "tabular-nums")} inputMode="numeric" value={d.qty} onChange={set("qty")} />
        </Field>
        <Field label="Cortesía (gratis)" hint="Las que regala el laboratorio: no suben el costo y bajan el costo por unidad.">
          <input className={cn(FIELD, "tabular-nums")} inputMode="numeric" placeholder="0" value={d.courtesyQty} onChange={set("courtesyQty")} />
        </Field>
        <Field label="Peso por unidad (kg)">
          <input className={cn(FIELD, "tabular-nums")} inputMode="decimal" value={d.unitWeightKg} onChange={set("unitWeightKg")} />
        </Field>
        {money && (
          <>
            <Field label={base === "PEN" ? "Costo por unidad (S/)" : "Costo por unidad (USD)"}>
              <input className={cn(FIELD, "tabular-nums")} inputMode="decimal" value={d.unitCost} onChange={set("unitCost")} />
            </Field>
            <Field label="Precio de venta (S/)">
              <input className={cn(FIELD, "tabular-nums")} inputMode="decimal" value={d.salePricePen} onChange={set("salePricePen")} />
            </Field>
          </>
        )}
        {!item && (
          <Field label="Foto (opcional)" className="sm:col-span-2">
            <input type="file" accept="image/jpeg,image/png,image/webp" className={FILE_INPUT} onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} />
          </Field>
        )}
      </div>
      <Feedback error={uploadError} />
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={BTN_PRIMARY}
          disabled={pending || (fromCatalog && !picked)}
          onClick={() =>
            run(async () => {
              if (item) return updateImportItem(item.id, payload());
              let imagePath: string | null = null;
              if (photo) {
                const up = await uploadImportFile(importId, "item_photo", photo);
                if ("error" in up) {
                  setUploadError(up.error);
                  return { error: up.error };
                }
                imagePath = up.path;
              }
              return addImportItem(importId, { ...payload(), imagePath });
            }, onDone)
          }
        >
          {item ? "Guardar producto" : "Agregar producto"}
        </button>
        <button type="button" className={BTN_GHOST} onClick={onDone}>
          Cancelar
        </button>
      </div>
    </div>
  );
}

function ItemsBox({
  detail,
  stores,
  storeName,
  landed,
  fx,
  canEdit,
  aiEnabled,
  catalog,
  run,
  pending,
}: {
  detail: ImportDetail;
  stores: Store[];
  storeName: Map<string, string>;
  landed: ReturnType<typeof landedCosts> | null;
  fx: number | null;
  canEdit: boolean;
  aiEnabled: boolean;
  catalog: PickerProduct[];
  run: Run;
  pending: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const money = detail.perms.canMoney;
  const base = baseCurrencyOf(detail.imp.kind);
  const editable = canEdit && detail.imp.status !== "cancelado";
  const units = detail.items.reduce((a, it) => a + it.qty, 0);
  const courtesy = detail.items.reduce((a, it) => a + (it.courtesy_qty ?? 0), 0);
  const delivered = new Set(detail.deliveries.flatMap((d) => d.lines.map((l) => l.item_id)));
  return (
    <Section id="productos">
      <SectionHead
        id={`${sectionDomId("productos")}-t`}
        title="Productos"
        badge={<Badge className="tabular-nums">{detail.items.length}</Badge>}
        help={detail.items.length ? `${fmtInt(units)} unidades pedidas${courtesy ? ` + ${fmtInt(courtesy)} de cortesía` : ""}.` : undefined}
        aside={
          editable && !adding ? (
            <button type="button" className={BTN_SECONDARY_SM} onClick={() => setAdding(true)}>
              <IconPlus aria-hidden />
              Agregar producto
            </button>
          ) : undefined
        }
      />
      {adding && <ItemForm importId={detail.imp.id} stores={stores} money={money} base={base} catalog={catalog} run={run} pending={pending} onDone={() => setAdding(false)} />}
      {!detail.items.length && !adding && (
        <p className="text-sm text-ink-500">
          Sin productos todavía.
          {editable ? (aiEnabled ? " Agrégalos a mano o súbelos en Documentos y usa «Leer con IA» en la factura comercial, la proforma o el packing list." : " Agrégalos con «Agregar producto».") : ""}
        </p>
      )}
      {detail.items.length > 0 && (
        <ul className={cn(adding ? ROWS : ROWS_TOP, "-mb-4 sm:-mb-5")}>
          {detail.items.map((it) => {
            const line = landed?.byItem.get(it.id);
            // El margen con el costo en soles (los costos en soles, tal cual): sin tipo de cambio, no hay.
            const margin = line && money ? marginOf(line.pen?.unitCost, it.sale_price_pen, line.good) : null;
            if (editing === it.id) {
              return (
                <li key={it.id} className={ROW}>
                  <ItemForm importId={detail.imp.id} stores={stores} money={money} base={base} item={it} run={run} pending={pending} onDone={() => setEditing(null)} />
                </li>
              );
            }
            return (
              <li key={it.id} className={cn(ROW, "flex items-start gap-3")}>
                <div className="flex w-14 shrink-0 flex-col items-center gap-1">
                  {it.image_path ? (
                    // `?v=`: al cambiar la foto cambia la URL y no sale la vieja de la caché.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={photoUrl(it)} alt="" className="size-12 rounded-md object-cover ring-1 ring-line" />
                  ) : (
                    <div aria-hidden className="grid size-12 place-items-center rounded-md bg-wash text-ink-300">
                      <IconPackage className="size-5" />
                    </div>
                  )}
                  {editable && <ItemPhotoControls importId={detail.imp.id} item={it} run={run} pending={pending} />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
                    <p className="min-w-0 text-sm font-semibold leading-5 text-ink-900">{it.name}</p>
                    <p className="shrink-0 text-sm leading-5 tabular-nums text-ink-900">
                      {fmtInt(it.qty)} <span className="text-ink-500">u.</span>
                      {it.courtesy_qty > 0 && <span className="text-[13px] text-ok-fg"> +{fmtInt(it.courtesy_qty)} cortesía</span>}
                    </p>
                  </div>
                  <p className="text-[13px] leading-5 text-ink-500">
                    {it.sku ? (
                      <>
                        SKU <span className="font-mono text-xs text-ink-700">{it.sku}</span>
                      </>
                    ) : (
                      "Sin SKU"
                    )}{" "}
                    · {it.store_id ? (storeName.get(it.store_id) ?? "Tienda") : "Todas las tiendas"}
                    {it.unit_weight_kg != null ? <span className="tabular-nums"> · {it.unit_weight_kg} kg/u</span> : ""}
                  </p>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] leading-5 tabular-nums text-ink-700">
                    {it.received_qty != null ? (
                      <ProgressText it={it} />
                    ) : (
                      <span className="text-ink-500">Sin entregas · se esperan {fmtInt(expectedUnits({ qty: it.qty, courtesyQty: it.courtesy_qty }))}</span>
                    )}
                    {it.cost_pushed_at ? <Badge tone="ok">En Costos</Badge> : null}
                    {margin?.low ? <Badge tone="crit">Margen bajo</Badge> : null}
                  </div>
                  {money && (
                    <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[13px] leading-5 tabular-nums sm:grid-cols-4">
                      <div>
                        <dt className="text-ink-500">{base === "PEN" ? "Laboratorio" : "Proveedor"}</dt>
                        <dd className="text-ink-900">{fmtUnit(it.unit_cost_currency === "PEN" ? it.unit_cost_pen : it.unit_cost_usd, it.unit_cost_currency)}/u</dd>
                      </div>
                      <div>
                        <dt className="text-ink-500">Aterrizado</dt>
                        <dd
                          className="font-semibold text-ink-900"
                          title={
                            line?.usd
                              ? `Producto ${fmtUsdUnit(line.usd.perUnit.product)} + envío ${fmtUsdUnit(line.usd.perUnit.envio)} + importación ${fmtUsdUnit(line.usd.perUnit.importacion)} + adicional ${fmtUsdUnit(line.usd.perUnit.adicional)}`
                              : undefined
                          }
                        >
                          {line ? <LandedUnit line={line} preferPen={base === "PEN"} /> : "—"}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-ink-500">Venta</dt>
                        <dd className="text-ink-900">{it.sale_price_pen != null ? fmtPen(it.sale_price_pen) : "—"}</dd>
                      </div>
                      <div>
                        <dt className="text-ink-500">Margen</dt>
                        <dd className={margin ? (margin.low ? "font-semibold text-crit-fg" : "text-ok-fg") : line && !line.pen && it.sale_price_pen ? "font-medium text-warn-fg" : "text-ink-500"}>
                          {margin ? `${fmtPen(margin.unit)} (${fmtPct(margin.pct)})` : line && !line.pen && it.sale_price_pen ? MISSING_FX : "—"}
                        </dd>
                      </div>
                    </dl>
                  )}
                  {it.reception_note && <p className="mt-1 text-[13px] leading-5 text-ink-600">Recepción: {it.reception_note}</p>}
                  {editable && (
                    <div className="-ml-2.5 mt-1.5 flex gap-1">
                      <button type="button" className={BTN_GHOST} onClick={() => setEditing(it.id)}>
                        Editar
                      </button>
                      {/* Con entregas no se quita: lo que llegó de él es evidencia (MOM §45.14). */}
                      {!delivered.has(it.id) && (
                        <button
                          type="button"
                          className={BTN_REMOVE}
                          disabled={pending}
                          onClick={() => {
                            if (window.confirm(`¿Quitar «${it.name}» de la compra?`)) run(() => removeImportItem(it.id));
                          }}
                        >
                          Quitar
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

/** «Llegaron 400 de 600 (+50 cortesía) · faltan 250», con lo dañado aparte. */
function ProgressText({ it }: { it: Pick<ItemRow, "qty" | "courtesy_qty" | "received_qty" | "damaged_qty"> }) {
  const p = lineProgress({ qty: it.qty, courtesyQty: it.courtesy_qty, receivedQty: it.received_qty, damagedQty: it.damaged_qty });
  return (
    <span className={cn(p.missing > 0 ? "text-ink-700" : p.extra > 0 ? "text-warn-fg" : "text-ok-fg")}>
      {lineProgressText(p)}
      {p.damaged ? <span className="text-warn-fg"> · {fmtInt(p.damaged)} dañada{p.damaged === 1 ? "" : "s"}</span> : null}
    </span>
  );
}

function photoUrl(it: ItemRow): string {
  const v = (it.image_path ?? "").split("/").pop() ?? "";
  return `/api/compras/foto/${it.id}${v ? `?v=${encodeURIComponent(v)}` : ""}`;
}

/** Agregar, cambiar o quitar la foto de un producto ya creado (`setImportItemPhoto`). */
function ItemPhotoControls({ importId, item, run, pending }: { importId: string; item: ItemRow; run: Run; pending: boolean }) {
  const [inputKey, setInputKey] = useState(0);
  const pick = (file: File | undefined) => {
    if (!file) return;
    run(
      async () => {
        const up = await uploadImportFile(importId, "item_photo", file);
        if ("error" in up) return { error: up.error };
        return setImportItemPhoto(item.id, up.path);
      },
      () => setInputKey((k) => k + 1),
    );
    setInputKey((k) => k + 1);
  };
  return (
    <div className="flex flex-col items-center text-xs leading-4">
      <label
        className={cn(
          "cursor-pointer rounded px-1 py-0.5 font-medium text-brand-700 hover:underline focus-within:outline focus-within:outline-2 focus-within:outline-brand-500 pointer-coarse:py-2",
          pending && "pointer-events-none opacity-50",
        )}
      >
        {item.image_path ? "Cambiar" : "Foto"}
        <input
          key={inputKey}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="sr-only"
          disabled={pending}
          onChange={(e) => pick(e.target.files?.[0])}
          aria-label={item.image_path ? `Cambiar la foto de ${item.name}` : `Agregar foto a ${item.name}`}
        />
      </label>
      {item.image_path && (
        <button
          type="button"
          className="rounded px-1 py-0.5 text-ink-500 hover:text-crit-fg hover:underline disabled:opacity-50 pointer-coarse:py-2"
          disabled={pending}
          onClick={() => {
            if (window.confirm(`¿Quitar la foto de «${item.name}»?`)) run(() => setImportItemPhoto(item.id, null));
          }}
        >
          Quitar
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Entregas (MOM §45.14): cada una con su fecha, quién, unidades y fotos
// ---------------------------------------------------------------------------

const PHOTO_ACCEPT = ".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp";

/** Sube las fotos elegidas (tipo «Foto») y devuelve sus rutas, o el primer error. */
async function uploadPhotos(importId: string, files: readonly File[]): Promise<{ paths: { path: string; filename: string }[] } | { error: string }> {
  const paths: { path: string; filename: string }[] = [];
  for (const file of files) {
    const up = await uploadImportFile(importId, "photo", file);
    if ("error" in up) return { error: up.error };
    paths.push({ path: up.path, filename: file.name });
  }
  return { paths };
}

function DeliveriesBox({
  detail,
  summary,
  canRegister,
  canCorrect,
  today,
  open,
  setOpen,
  run,
  pending,
}: {
  detail: ImportDetail;
  summary: ReturnType<typeof receptionSummary>;
  /** Registrar entregas y agregarles fotos: «Compras» o «Recepción de compras». */
  canRegister: boolean;
  /** Corregir o quitar una entrega: solo «Compras». */
  canCorrect: boolean;
  today: string;
  open: boolean;
  setOpen: (open: boolean) => void;
  run: Run;
  pending: boolean;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const needsPhoto = deliveryNeedsPhoto(detail.imp.kind);
  const active = detail.imp.status !== "cancelado";
  const editable = canRegister && active && detail.items.length > 0;
  const deliveries = [...detail.deliveries].reverse();
  const missing = Math.max(0, summary.expected - summary.received);
  const cells: { label: string; value: number; tone?: "warn" }[] = [
    { label: "Pedidas", value: summary.ordered },
    ...(summary.courtesy ? [{ label: "Cortesía", value: summary.courtesy }] : []),
    { label: "Llegaron", value: summary.received },
    { label: "Faltan", value: missing, tone: summary.counted && missing > 0 ? ("warn" as const) : undefined },
    { label: "Sobran", value: summary.extra, tone: summary.extra > 0 ? ("warn" as const) : undefined },
    { label: "Dañadas", value: summary.damaged, tone: summary.damaged > 0 ? ("warn" as const) : undefined },
    { label: "Buenas", value: summary.good },
  ];
  return (
    <Section id="recepcion">
      <SectionHead
        id={`${sectionDomId("recepcion")}-t`}
        title="Entregas en la bodega de Lima"
        badge={
          !detail.deliveries.length ? (
            <Badge>Sin entregas</Badge>
          ) : summary.allArrived ? (
            <Badge tone="ok">Llegó todo</Badge>
          ) : (
            <Badge tone="warn" className="tabular-nums">
              Faltan {fmtInt(missing)} u.
            </Badge>
          )
        }
        help={
          <>
            Cada entrega con su fecha, quién la recibió, lo que llegó por producto y sus fotos. Si llega todo lo esperado (pedidas + cortesía), la compra
            pasa a Recibido; si llega una parte, a Recibido parcial.{needsPhoto ? " En una compra local cada entrega lleva al menos una foto." : ""}
          </>
        }
        aside={
          editable && !open ? (
            <button type="button" className={BTN_SECONDARY_SM} onClick={() => setOpen(true)}>
              <IconPlus aria-hidden />
              Registrar entrega
            </button>
          ) : undefined
        }
      />
      <dl className={cn("grid grid-cols-3 gap-px overflow-hidden rounded-lg bg-line ring-1 ring-line", cells.length === 7 ? "sm:grid-cols-7" : "sm:grid-cols-6")}>
        {cells.map((c) => (
          <div key={c.label} className="bg-white px-3 py-2">
            <dt className="text-xs font-medium leading-4 text-ink-500">{c.label}</dt>
            <dd className={cn("mt-0.5 text-base font-semibold leading-6 tabular-nums", c.tone === "warn" ? "text-warn-fg" : "text-ink-900")}>{fmtInt(c.value)}</dd>
          </div>
        ))}
      </dl>
      {detail.items.length > 0 && detail.deliveries.length > 0 && (
        <ul className="space-y-1 text-[13px] leading-5 tabular-nums" aria-label="Avance por producto">
          {detail.items.map((it) => (
            <li key={it.id} className="flex flex-wrap justify-between gap-x-3">
              <span className="min-w-0 truncate text-ink-900">{it.name}</span>
              {it.received_qty != null ? <ProgressText it={it} /> : <span className="text-ink-500">Sin entregas · se esperan {fmtInt(expectedUnits({ qty: it.qty, courtesyQty: it.courtesy_qty }))}</span>}
            </li>
          ))}
        </ul>
      )}
      {open && (
        <DeliveryForm
          detail={detail}
          needsPhoto={needsPhoto}
          today={today}
          run={run}
          pending={pending}
          onDone={() => setOpen(false)}
        />
      )}
      {deliveries.length > 0 ? (
        <ol className={cn(ROWS, "-mb-4 sm:-mb-5")} aria-label="Entregas, la más reciente arriba">
          {deliveries.map((d) =>
            editingId === d.id ? (
              <li key={d.id} className={ROW}>
                <DeliveryForm
                  detail={detail}
                  delivery={d}
                  needsPhoto={needsPhoto}
                  today={today}
                  run={run}
                  pending={pending}
                  onDone={() => setEditingId(null)}
                />
              </li>
            ) : (
              <DeliveryItem
                key={d.id}
                detail={detail}
                delivery={d}
                canAddPhoto={canRegister && active}
                canCorrect={canCorrect && active}
                onEdit={() => setEditingId(d.id)}
                run={run}
                pending={pending}
              />
            ),
          )}
        </ol>
      ) : (
        !open && (
          <p className="text-sm text-ink-500">
            Todavía no llegó nada.{editable ? " Cuando llegue mercadería, «Registrar entrega» con lo que vino por producto y sus fotos." : ""}
          </p>
        )
      )}
    </Section>
  );
}

function DeliveryItem({
  detail,
  delivery: d,
  canAddPhoto,
  canCorrect,
  onEdit,
  run,
  pending,
}: {
  detail: ImportDetail;
  delivery: DeliveryRow;
  canAddPhoto: boolean;
  canCorrect: boolean;
  onEdit: () => void;
  run: Run;
  pending: boolean;
}) {
  const [inputKey, setInputKey] = useState(0);
  const itemName = new Map(detail.items.map((it) => [it.id, it.name]));
  const units = d.lines.reduce((a, l) => a + l.received, 0);
  const addPhotos = (files: File[]) => {
    if (!files.length) return;
    run(
      async () => {
        const up = await uploadPhotos(detail.imp.id, files.slice(0, 10));
        if ("error" in up) return { error: up.error };
        for (const p of up.paths) {
          const res = await registerImportDocument(detail.imp.id, { kind: "photo", path: p.path, filename: p.filename, deliveryId: d.id });
          if (res.error) return res;
        }
        return { notice: `${up.paths.length} foto${up.paths.length === 1 ? "" : "s"} agregada${up.paths.length === 1 ? "" : "s"} a la entrega.` };
      },
      () => setInputKey((k) => k + 1),
    );
    setInputKey((k) => k + 1);
  };
  return (
    <li className={cn(ROW, "space-y-2")}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-sm font-semibold leading-5 text-ink-900">
            <span className="tabular-nums">{formatDmy(d.delivered_on)}</span>
            <span className="font-normal tabular-nums text-ink-500">· {fmtInt(units)} u.</span>
            {d.legacy && <Badge>Recepción anterior</Badge>}
          </p>
          <p className="text-[13px] leading-5 text-ink-500">
            {d.legacy ? "Registrada antes de las entregas parciales" : `Registró ${d.by_name ?? "Kapta"} · ${fmtDateTime(d.created_at)}`}
          </p>
        </div>
        {canCorrect && (
          <span className="-mr-2.5 flex gap-1">
            <button type="button" className={BTN_GHOST} onClick={onEdit}>
              Corregir
            </button>
            <button
              type="button"
              className={BTN_REMOVE}
              disabled={pending}
              onClick={() => {
                if (window.confirm(`¿Quitar la entrega del ${formatDmy(d.delivered_on)}? Sus unidades dejan de contar; sus fotos se quedan en Documentos.`)) {
                  run(() => removeDelivery(d.id));
                }
              }}
            >
              Quitar
            </button>
          </span>
        )}
      </div>
      <ul className="space-y-0.5 text-[13px] leading-5 tabular-nums text-ink-700">
        {d.lines.map((l) => (
          <li key={l.id}>
            <span className="font-medium text-ink-900">{fmtInt(l.received)}</span> × {itemName.get(l.item_id) ?? "Producto"}
            {l.damaged ? <span className="text-warn-fg"> · {fmtInt(l.damaged)} dañada{l.damaged === 1 ? "" : "s"}</span> : null}
            {l.note ? <span className="text-ink-500"> · {l.note}</span> : null}
          </li>
        ))}
      </ul>
      {d.note && <p className="max-w-[68ch] whitespace-pre-line text-[13px] leading-5 text-ink-600">{d.note}</p>}
      {(d.photos.length > 0 || canAddPhoto) && (
        <div className="flex flex-wrap items-center gap-2">
          {d.photos.map((p) => (
            <a
              key={p.id}
              href={`/api/compras/documento/${p.id}`}
              target="_blank"
              rel="noopener noreferrer"
              title={p.filename ?? "Foto de la entrega"}
              className="block rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500"
            >
              {/* La ruta vuelve a pedir el permiso y responde con un enlace firmado de 10 minutos. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/api/compras/documento/${p.id}`} alt={p.filename ?? "Foto de la entrega"} loading="lazy" className="size-14 rounded-md object-cover ring-1 ring-line" />
            </a>
          ))}
          {canAddPhoto && (
            <label
              className={cn(
                "inline-flex h-8 cursor-pointer items-center gap-1 rounded-md px-2.5 text-[13px] font-semibold text-brand-700 hover:bg-wash focus-within:outline focus-within:outline-2 focus-within:outline-brand-500 pointer-coarse:h-11",
                pending && "pointer-events-none opacity-50",
              )}
            >
              <IconPlus aria-hidden className="size-4" />
              {d.photos.length ? "Agregar foto" : "Agregar fotos"}
              <input
                key={inputKey}
                type="file"
                multiple
                accept={PHOTO_ACCEPT}
                className="sr-only"
                disabled={pending}
                onChange={(e) => addPhotos(Array.from(e.target.files ?? []))}
                aria-label={`Agregar fotos a la entrega del ${formatDmy(d.delivered_on)}`}
              />
            </label>
          )}
        </div>
      )}
    </li>
  );
}

type LineDraft = { received: string; damaged: string; note: string };

/**
 * Registrar una entrega nueva o corregir una (`delivery`). Solo se guardan los
 * productos que llegaron (vacío o 0 = no vino en esta entrega). En una compra
 * local hace falta al menos una foto (el servidor lo vuelve a pedir).
 */
function DeliveryForm({
  detail,
  delivery,
  needsPhoto,
  today,
  run,
  pending,
  onDone,
}: {
  detail: ImportDetail;
  delivery?: DeliveryRow;
  needsPhoto: boolean;
  today: string;
  run: Run;
  pending: boolean;
  onDone: () => void;
}) {
  const byItem = new Map((delivery?.lines ?? []).map((l) => [l.item_id, l]));
  const [date, setDate] = useState(delivery?.delivered_on ?? today);
  const [note, setNote] = useState(delivery?.note ?? "");
  const [draft, setDraft] = useState<Record<string, LineDraft>>(() =>
    Object.fromEntries(
      detail.items.map((it) => {
        const l = byItem.get(it.id);
        return [it.id, { received: l ? String(l.received) : "", damaged: l?.damaged ? String(l.damaged) : "", note: l?.note ?? "" }];
      }),
    ),
  );
  const [photos, setPhotos] = useState<File[]>([]);
  const [localError, setLocalError] = useState<string | null>(null);
  const keptPhotos = delivery?.photos.length ?? 0;
  const set = (id: string, patch: Partial<LineDraft>) => setDraft((d) => ({ ...d, [id]: { ...d[id]!, ...patch } }));
  // Lo que falta de cada producto sin contar esta entrega (al corregir, la suya vuelve a estar disponible).
  const missingOf = (it: ItemRow) => {
    const p = lineProgress({ qty: it.qty, courtesyQty: it.courtesy_qty, receivedQty: it.received_qty, damagedQty: it.damaged_qty });
    return p.missing + (byItem.get(it.id)?.received ?? 0);
  };
  const submit = () => {
    if (needsPhoto && !photos.length && !keptPhotos) {
      setLocalError(DELIVERY_PHOTO_REQUIRED);
      return;
    }
    setLocalError(null);
    run(async () => {
      const up = await uploadPhotos(detail.imp.id, photos);
      if ("error" in up) return { error: up.error };
      const input = {
        deliveredOn: date,
        note,
        lines: detail.items.map((it) => ({ itemId: it.id, received: draft[it.id]?.received, damaged: draft[it.id]?.damaged, note: draft[it.id]?.note })),
        photos: up.paths,
      };
      return delivery ? updateDelivery(delivery.id, input) : registerDelivery(detail.imp.id, input);
    }, onDone);
  };
  return (
    <div className={FORM_ZONE}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] font-semibold text-ink-900">{delivery ? `Corregir la entrega del ${formatDmy(delivery.delivered_on)}` : "Lo que llegó en esta entrega"}</p>
        <button
          type="button"
          className={BTN_GHOST}
          onClick={() =>
            setDraft((cur) => Object.fromEntries(detail.items.map((it) => [it.id, { ...cur[it.id]!, received: String(missingOf(it) || "") }])))
          }
        >
          Llenar con lo que falta
        </button>
      </div>
      <div className="grid gap-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
        <Field label="Fecha de la entrega">
          <input type="date" className={FIELD} max={today} value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Nota (opcional)">
          <input className={FIELD} placeholder="Quién la trajo, guía de remisión, estado de las cajas…" value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
      <div aria-hidden className="hidden gap-3 text-xs font-semibold text-ink-600 sm:grid sm:grid-cols-[minmax(0,2fr)_6rem_6rem_minmax(0,2fr)]">
        <span>Producto</span>
        <span>Llegaron</span>
        <span>Dañadas</span>
        <span>Nota</span>
      </div>
      <ul className="divide-y divide-line-strong/60">
        {detail.items.map((it) => {
          const p = lineProgress({ qty: it.qty, courtesyQty: it.courtesy_qty, receivedQty: it.received_qty, damagedQty: it.damaged_qty });
          return (
            <li key={it.id} className="grid grid-cols-2 gap-x-3 gap-y-2 py-2.5 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,2fr)_6rem_6rem_minmax(0,2fr)] sm:items-center">
              <p className="col-span-2 text-sm leading-5 text-ink-900 sm:col-span-1">
                {it.name}{" "}
                <span className="block text-[13px] tabular-nums text-ink-500">
                  {lineProgressText(p)}
                </span>
              </p>
              <label className={LABEL}>
                <span className="sm:sr-only">Llegaron</span>
                <input
                  className={cn(FIELD, "tabular-nums")}
                  inputMode="numeric"
                  placeholder="0"
                  aria-label={`Llegaron de ${it.name}`}
                  value={draft[it.id]?.received ?? ""}
                  onChange={(e) => set(it.id, { received: e.target.value })}
                />
              </label>
              <label className={LABEL}>
                <span className="sm:sr-only">Dañadas</span>
                <input
                  className={cn(FIELD, "tabular-nums")}
                  inputMode="numeric"
                  placeholder="0"
                  aria-label={`Dañadas de ${it.name}`}
                  value={draft[it.id]?.damaged ?? ""}
                  onChange={(e) => set(it.id, { damaged: e.target.value })}
                />
              </label>
              <label className={cn(LABEL, "col-span-2 sm:col-span-1")}>
                <span className="sm:sr-only">Nota</span>
                <input className={FIELD} aria-label={`Nota de ${it.name}`} value={draft[it.id]?.note ?? ""} onChange={(e) => set(it.id, { note: e.target.value })} />
              </label>
            </li>
          );
        })}
      </ul>
      <Field
        label={needsPhoto && !keptPhotos ? "Fotos de lo que llegó (al menos una)" : delivery ? "Fotos nuevas (opcional)" : "Fotos de lo que llegó (opcional)"}
        hint={`JPG, PNG o WEBP, hasta 25 MB; hasta 10 por vez.${keptPhotos ? ` Ya tiene ${keptPhotos} foto${keptPhotos === 1 ? "" : "s"}.` : ""}`}
      >
        <input type="file" multiple accept={PHOTO_ACCEPT} className={cn(FILE_INPUT, "py-0.5")} onChange={(e) => setPhotos(Array.from(e.target.files ?? []).slice(0, 10))} />
      </Field>
      <Feedback error={localError} />
      <div className="flex flex-wrap gap-2">
        <button type="button" className={BTN_PRIMARY} disabled={pending} onClick={submit}>
          {delivery ? "Guardar corrección" : "Registrar entrega"}
        </button>
        <button type="button" className={BTN_GHOST} onClick={onDone}>
          Cancelar
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dinero
// ---------------------------------------------------------------------------

type Landed = ReturnType<typeof landedCosts>;
type LandedLineT = Landed["lines"][number];

/**
 * El costo aterrizado por unidad de una línea: en USD y, debajo, en soles. Sin
 * tipo de cambio, la vista que lo necesita dice «Falta el tipo de cambio» (nunca
 * una cifra a medias).
 */
function LandedUnit({ line, preferPen = false }: { line: LandedLineT; preferPen?: boolean }) {
  // Una compra local, en soles primero (MOM §45.12).
  if (preferPen && line.pen) {
    return (
      <>
        {fmtPenUnit(line.pen.unitCost)}/u
        {line.usd ? <span className="block font-normal text-ink-500">{fmtUsdUnit(line.usd.unitCost)}</span> : null}
      </>
    );
  }
  if (line.usd) {
    return (
      <>
        {fmtUsdUnit(line.usd.unitCost)}/u
        {line.pen ? <span className="block font-normal text-ink-500">{fmtPen(line.pen.unitCost)}</span> : null}
      </>
    );
  }
  if (line.pen) return <>{fmtPen(line.pen.unitCost)}/u</>;
  return <span className="font-medium text-warn-fg">{MISSING_FX}</span>;
}

function LandedBox({
  detail,
  landed,
  fx,
  canEdit,
  run,
  pending,
}: {
  detail: ImportDetail;
  landed: Landed;
  fx: number | null;
  canEdit: boolean;
  run: Run;
  pending: boolean;
}) {
  const [fxDraft, setFxDraft] = useState(fx == null ? "" : String(fx));
  // Compra local (MOM §45.12): la vista principal es en soles y el tipo de
  // cambio solo hace falta si algún monto está en US$.
  const local = !hasShipping(detail.imp.kind);
  const rows = detail.items.map((it) => ({ it, l: landed.byItem.get(it.id) })).filter((r): r is { it: ItemRow; l: NonNullable<typeof r.l> } => Boolean(r.l));
  // En la tabla los montos van sin «US$»: la cabecera dice la moneda una vez y
  // así cada cifra cabe en una línea.
  const TH = "whitespace-nowrap py-2 pl-3 text-right text-xs font-semibold text-ink-600";
  const TD = "whitespace-nowrap py-2.5 pl-3 text-right text-[13px] leading-5 tabular-nums text-ink-700";
  const n4 = (v: number | undefined) => (v == null ? "—" : (local ? fmtPenUnit(v).replace("S/ ", "") : fmtUsdUnit(v).replace("US$ ", "")));
  const usd = landed.usd;
  const pen = landed.pen;
  // Sin tipo de cambio: costos en soles en una importación, o algún US$ en una compra local.
  const missingFx = !fx && (local ? landed.hasUsd : landed.hasPenCosts);
  const showFx = !local || landed.hasUsd || fx != null;
  const view = (l: LandedLineT) => (local ? l.pen : l.usd);
  return (
    <Section id="aterrizado" className="@container">
      <SectionHead
        id={`${sectionDomId("aterrizado")}-t`}
        title="Costo aterrizado por unidad"
        help={
          local && pen ? (
            <>
              Productos <span className="tabular-nums">{fmtPen(pen.productTotal)}</span> + costos <span className="tabular-nums">{fmtPen(pen.costsTotal)}</span> ={" "}
              <span className="font-semibold tabular-nums text-ink-900">{fmtPen(pen.total)}</span>
              {usd && landed.hasUsd ? <span className="tabular-nums"> ({fmtUsd(usd.total)})</span> : null}. Los costos se reparten sobre lo pedido; la
              cortesía no suma costo y el costo por unidad se divide entre las unidades buenas.
            </>
          ) : usd ? (
            <>
              Productos <span className="tabular-nums">{fmtUsd(usd.productTotal)}</span> + costos <span className="tabular-nums">{fmtUsd(usd.costsTotal)}</span> ={" "}
              <span className="font-semibold tabular-nums text-ink-900">{fmtUsd(usd.total)}</span>
              {landed.pen && landed.hasPenCosts ? <span className="tabular-nums"> ({fmtPen(landed.pen.total)})</span> : null}. Los costos se reparten sobre lo
              pedido y el costo por unidad se divide entre las unidades buenas.
            </>
          ) : (
            <>
              Productos <span className="tabular-nums">{fmtUsd(landed.split.product.usd)}</span> + costos{" "}
              <span className="tabular-nums">{fmtSplit(landed.split.costs)}</span>: sin tipo de cambio no se pueden sumar. Los costos se reparten sobre lo pedido
              y el costo por unidad se divide entre las unidades buenas.
            </>
          )
        }
      />
      {showFx && (
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Tipo de cambio (S/ por 1 USD)" hint={local ? "Solo hace falta si algún monto está en US$." : undefined}>
            <input
              className={cn(fieldBox("w-32"), "tabular-nums", missingFx && "ring-2 ring-warn-fg")}
              inputMode="decimal"
              value={fxDraft}
              onChange={(e) => setFxDraft(e.target.value)}
              disabled={!canEdit}
            />
          </Field>
          {canEdit && (
            <button type="button" className={BTN_SECONDARY} disabled={pending} onClick={() => run(() => setImportFx(detail.imp.id, fxDraft))}>
              Guardar tipo de cambio
            </button>
          )}
        </div>
      )}
      {missingFx && (
        <Banner tone="warn" title={MISSING_FX}>
          <p>
            {local
              ? "Hay montos en US$: con el tipo de cambio de la compra se ve el costo aterrizado en soles y se puede pasar a Costos."
              : "Hay costos en soles: con el tipo de cambio de la importación se ve el costo aterrizado en USD y en soles, y el margen."}
          </p>
        </Banner>
      )}
      {landed.warnings.length > 0 && (
        <Banner tone="warn">
          <ul className="list-disc space-y-0.5 pl-4">
            {landed.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Banner>
      )}
      {rows.length > 0 && (
        <>
          <p className="hidden text-xs leading-4 text-ink-500 @2xl:block">
            {local
              ? "Soles por unidad buena (los montos en US$ × el tipo de cambio); la última columna, en USD."
              : "USD por unidad buena (los costos en soles ÷ el tipo de cambio); la última columna, en soles (los costos en soles, tal cual)."}
          </p>
          <table className="-mt-2 hidden w-full table-fixed @2xl:table">
            <thead className="border-b border-line">
              <tr>
                <th className="w-[24%] py-2 text-left text-xs font-semibold text-ink-600">Producto</th>
                <th className={TH}>Buenas</th>
                <th className={TH}>Proveedor</th>
                <th className={TH}>Envío</th>
                <th className={TH}>Importación</th>
                <th className={TH}>Adicional</th>
                <th className={cn(TH, "text-ink-900")}>Total</th>
                <th className={TH}>{local ? "En US$" : "En S/"}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map(({ it, l }) => (
                <tr key={it.id}>
                  <td className="py-2.5 text-left text-sm leading-5 text-ink-900">
                    <span className="line-clamp-2" title={it.name}>{it.name}</span>
                    {l.loss ? <Badge tone="crit">Pérdida</Badge> : null}
                  </td>
                  <td className={TD}>{fmtInt(l.good)}</td>
                  <td className={TD}>{n4(view(l)?.perUnit.product)}</td>
                  <td className={TD}>{n4(view(l)?.perUnit.envio)}</td>
                  <td className={TD}>{n4(view(l)?.perUnit.importacion)}</td>
                  <td className={TD}>{n4(view(l)?.perUnit.adicional)}</td>
                  <td className={cn(TD, "font-semibold text-ink-900", !view(l) && "whitespace-normal font-medium text-warn-fg")}>{view(l) ? n4(view(l)!.unitCost) : MISSING_FX}</td>
                  {local ? (
                    <td className={TD}>{l.usd ? fmtUsdUnit(l.usd.unitCost).replace("US$ ", "") : "—"}</td>
                  ) : (
                    <td className={TD} title={l.pen ? undefined : MISSING_FX}>{l.pen ? fmtPen(l.pen.unitCost).replace("S/ ", "") : "—"}</td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          <ul className={cn(ROWS, "-mb-4 sm:-mb-5 @2xl:hidden")}>
            {rows.map(({ it, l }) => {
              // El desglose en la vista que se pueda (la de la moneda base primero).
              const v = local ? (l.pen ?? l.usd) : (l.usd ?? l.pen);
              const fmt = v === l.usd ? fmtUsdUnit : fmtPenUnit;
              return (
                <li key={it.id} className={ROW}>
                  <div className="flex items-start justify-between gap-3">
                    <p className="min-w-0 text-sm leading-5 text-ink-900">
                      {it.name} {l.loss ? <Badge tone="crit">Pérdida</Badge> : null}
                    </p>
                    <p className="shrink-0 text-right text-sm font-semibold leading-5 tabular-nums text-ink-900">
                      <LandedUnit line={l} preferPen={local} />
                    </p>
                  </div>
                  <dl className="mt-1 grid gap-x-6 text-[13px] leading-5 tabular-nums sm:grid-cols-2">
                    {(
                      [
                        ["Buenas", fmtInt(l.good)],
                        [local ? "Laboratorio" : "Proveedor", v ? fmt(v.perUnit.product) : "—"],
                        ["Envío", v ? fmt(v.perUnit.envio) : "—"],
                        ["Importación", v ? fmt(v.perUnit.importacion) : "—"],
                        ["Adicional", v ? fmt(v.perUnit.adicional) : "—"],
                      ] as const
                    ).map(([k, v]) => (
                      <div key={k} className="flex justify-between gap-2">
                        <dt className="text-ink-500">{k}</dt>
                        <dd className="text-ink-700">{v}</dd>
                      </div>
                    ))}
                  </dl>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Section>
  );
}

/** El equivalente en la otra moneda con el tipo de cambio (línea secundaria); sin él, nada. */
function equivalent(amount: number, currency: Currency, fx: number | null): string | null {
  if (!fx) return null;
  const m = moneyOf(amount, currency);
  return currency === "PEN" ? `≈ ${fmtUsd(moneyInUsd(m, fx))}` : `≈ ${fmtPen(moneyInPen(m, fx))}`;
}

/** Monto con su moneda (US$ / S/) al lado: los dos controles en una fila, también en el teléfono. */
function AmountField({
  label,
  currency,
  onCurrency,
  amount,
  onAmount,
  hint,
}: {
  label: string;
  currency: Currency;
  onCurrency: (c: Currency) => void;
  amount: string;
  onAmount: (v: string) => void;
  hint?: ReactNode;
}) {
  return (
    <div className={LABEL}>
      <span>{label}</span>
      <div className="flex min-w-0 gap-2">
        <select className={fieldBox("w-[5.5rem] shrink-0")} value={currency} onChange={(e) => onCurrency(e.target.value as Currency)} aria-label={`${label}: moneda`}>
          {CURRENCIES.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
        <input
          className={cn(fieldBox("min-w-0 flex-1"), "tabular-nums")}
          inputMode="decimal"
          placeholder="0,00"
          value={amount}
          onChange={(e) => onAmount(e.target.value)}
          aria-label={`${label} en ${currency === "PEN" ? "soles" : "dólares"}`}
        />
      </div>
      {hint && <span className="text-xs font-normal text-ink-500">{hint}</span>}
    </div>
  );
}

/** «con IGV S/ 504.16 → S/ 427.25» o «inafecto a IGV» de un costo guardado (MOM §45.3). */
function costIgvNote(c: CostRow): string | null {
  if (c.igv_treatment === "inafecto") return "Inafecto a IGV";
  return c.includes_igv && c.gross_amount != null ? `Con IGV ${fmtMoney(c.gross_amount, c.currency)} → ${fmtMoney(c.amount, c.currency)} sin IGV` : null;
}

/**
 * «Agregar un costo» y «Editar» (MOM §45.3): tipo, nombre, moneda y monto, el
 * IGV (sin IGV, incluye IGV o inafecto), reparto y, «a un producto», cuál. Las
 * mismas reglas en el servidor para las dos (`cleanCost`).
 */
function CostForm({ detail, cost, run, pending, onDone }: { detail: ImportDetail; cost?: CostRow; run: Run; pending: boolean; onDone?: () => void }) {
  const [kind, setKind] = useState<string>(cost?.kind ?? "envio");
  const [label, setLabel] = useState(cost?.label ?? "");
  // Al editar, el monto como se escribió: con IGV si se cargó con IGV.
  const [amount, setAmount] = useState(cost ? String(cost.igv_treatment === "con_igv" && cost.gross_amount != null ? cost.gross_amount : cost.amount) : "");
  // En la moneda de la compra por defecto: S/ en una compra local (MOM §45.12).
  const [currency, setCurrency] = useState<Currency>(cost?.currency ?? baseCurrencyOf(detail.imp.kind));
  const [igvTreatment, setIgvTreatment] = useState<IgvTreatment>(cost?.igv_treatment ?? "neto");
  const [allocation, setAllocation] = useState<string>(cost?.allocation ?? "units");
  const [itemId, setItemId] = useState(cost?.item_id ?? "");
  // La vista previa de «Incluye IGV»: lo que entra al costo, sin IGV.
  const typed = parseDecimal(amount);
  const igvPreview = igvTreatment === "con_igv" && typed !== null && typed > 0 ? { net: netOfIgv(typed), igv: igvOf(typed) } : null;
  const reset = () => {
    setLabel("");
    setAmount("");
    setIgvTreatment("neto");
  };
  return (
    <div className={cn(cost ? FORM_ZONE : cn(CARD_ZONE, "space-y-3"))}>
      <p className="text-[13px] font-semibold text-ink-900">{cost ? `Editar «${cost.label}»` : "Agregar un costo"}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Tipo">
          <select className={FIELD} value={kind} onChange={(e) => setKind(e.target.value)}>
            {COST_KINDS.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Nombre">
          <input className={FIELD} placeholder="Flete DHL, aforo físico…" value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <AmountField
          label="Monto"
          currency={currency}
          onCurrency={setCurrency}
          amount={amount}
          onAmount={setAmount}
          hint={currency === "PEN" ? "En soles, tal como dice la factura: no se convierte al guardar." : undefined}
        />
        <Field label="Reparto">
          <select className={FIELD} value={allocation} onChange={(e) => setAllocation(e.target.value)}>
            {ALLOCATIONS.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </Field>
        <div className="space-y-1 sm:col-span-2">
          <Field label="IGV">
            <select className={FIELD} value={igvTreatment} onChange={(e) => setIgvTreatment(e.target.value as IgvTreatment)}>
              {IGV_TREATMENTS.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </Field>
          <p className="text-xs leading-4 text-ink-500">{IGV_HELP}</p>
          {igvPreview && (
            <p className="text-[13px] leading-5 tabular-nums text-ink-700">
              Entra al costo: <span className="font-semibold text-ink-900">{fmtMoney(igvPreview.net, currency)} sin IGV</span> (IGV {fmtMoney(igvPreview.igv, currency)}).
            </p>
          )}
        </div>
        {allocation === "item" && (
          <Field label="Producto" className="sm:col-span-2">
            <select className={FIELD} value={itemId} onChange={(e) => setItemId(e.target.value)}>
              <option value="">Elige el producto</option>
              {detail.items.map((it) => (
                <option key={it.id} value={it.id}>
                  {it.name}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={BTN_PRIMARY}
          disabled={pending}
          onClick={() =>
            cost
              ? run(() => updateImportCost(cost.id, { kind, label, amount, currency, igvTreatment, allocation, itemId }), onDone)
              : run(() => addImportCost(detail.imp.id, { kind, label, amount, currency, igvTreatment, allocation, itemId }), reset)
          }
        >
          {cost ? "Guardar costo" : "Agregar costo"}
        </button>
        {cost && (
          <button type="button" className={BTN_GHOST} onClick={onDone}>
            Cancelar
          </button>
        )}
      </div>
    </div>
  );
}

function CostsBox({ detail, fx, canEdit, run, pending }: { detail: ImportDetail; fx: number | null; canEdit: boolean; run: Run; pending: boolean }) {
  const [editing, setEditing] = useState<string | null>(null);
  const costs = detail.costs ?? [];
  const itemName = new Map(detail.items.map((it) => [it.id, it.name]));
  const sum = (list: CostRow[]) => list.reduce((a, c) => ({ usd: a.usd + (c.currency === "USD" ? c.amount : 0), pen: a.pen + (c.currency === "PEN" ? c.amount : 0) }), { usd: 0, pen: 0 });
  const byKind = COST_KINDS.map((k) => ({ ...k, total: sum(costs.filter((c) => c.kind === k.id)) }));
  const total = sum(costs);
  const mixed = total.usd !== 0 && total.pen !== 0;
  const totalUsd = moneyInUsd(total, fx);
  // Editar: el mismo permiso que agregar, y no en una compra cancelada.
  const editable = canEdit && detail.imp.status !== "cancelado";
  return (
    <Section id="costos">
      <SectionHead
        id={`${sectionDomId("costos")}-t`}
        title="Costos a repartir"
        badge={costs.length ? <Badge className="tabular-nums">{fmtSplit(total)}</Badge> : undefined}
        help={
          <span className="tabular-nums">
            {byKind.map((k) => `${k.label} ${fmtSplit(k.total)}`).join(" · ")}
            {mixed ? (totalUsd !== null ? ` · En USD: ${fmtUsd(totalUsd)}` : ` · ${MISSING_FX} para sumarlos en USD`) : ""}
          </span>
        }
      />
      {costs.length ? (
        <ul className={ROWS_TOP}>
          {costs.map((c) => {
            if (editing === c.id) {
              return (
                <li key={c.id} className={ROW}>
                  <CostForm detail={detail} cost={c} run={run} pending={pending} onDone={() => setEditing(null)} />
                </li>
              );
            }
            const igvNote = costIgvNote(c);
            const eq = equivalent(c.amount, c.currency, fx);
            return (
              <li key={c.id} className={cn(ROW, "flex items-start justify-between gap-3")}>
                <span className="min-w-0">
                  <span className="block text-sm leading-5 text-ink-900">{c.label}</span>
                  <span className="block text-[13px] leading-5 text-ink-500">
                    {costKindLabel(c.kind)} · {c.allocation === "item" ? (c.item_id ? `a ${itemName.get(c.item_id) ?? "un producto"}` : "su producto ya no está: por valor") : allocationLabel(c.allocation).toLowerCase()}
                  </span>
                  {igvNote && <span className="block text-[13px] leading-5 tabular-nums text-ink-500">{igvNote}</span>}
                </span>
                <span className="flex shrink-0 items-start gap-1">
                  <span className="pt-1.5 text-right text-sm font-medium leading-5 tabular-nums text-ink-900 pointer-coarse:pt-3">
                    {fmtMoney(c.amount, c.currency)}
                    {eq && <span className="block text-[13px] font-normal text-ink-500">{eq}</span>}
                  </span>
                  {editable && (
                    <button type="button" className={BTN_GHOST} onClick={() => setEditing(c.id)} aria-label={`Editar ${c.label}`}>
                      Editar
                    </button>
                  )}
                  {canEdit && (
                    <button type="button" className={BTN_REMOVE} disabled={pending} onClick={() => run(() => removeImportCost(c.id))} aria-label={`Quitar ${c.label}`}>
                      Quitar
                    </button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm text-ink-500">
          Sin costos todavía.{canEdit ? " Agrega el flete, los aranceles y los demás cargos, en dólares o en soles: se reparten entre los productos según el reparto que elijas." : ""}
        </p>
      )}
      {canEdit && <CostForm detail={detail} run={run} pending={pending} />}
    </Section>
  );
}

/**
 * «Registrar un pago» y «Editar» (MOM §45.3): monto y moneda, fecha, método,
 * comprobante y nota. Al editar, el comprobante se queda si no se cambia; en
 * una compra local siempre hace falta uno (el servidor lo vuelve a pedir).
 */
function PaymentForm({ detail, payment, run, pending, onDone }: { detail: ImportDetail; payment?: PaymentRow; run: Run; pending: boolean; onDone?: () => void }) {
  const [amount, setAmount] = useState(payment ? String(payment.amount) : "");
  const [currency, setCurrency] = useState<Currency>(payment?.currency ?? baseCurrencyOf(detail.imp.kind));
  const [paidOn, setPaidOn] = useState(payment?.paid_on ?? limaToday());
  const [method, setMethod] = useState<string>(payment?.method ?? "transferencia");
  const [note, setNote] = useState(payment?.note ?? "");
  const [documentId, setDocumentId] = useState(payment?.document_id ?? "");
  // La captura del pago, en el mismo formulario: obligatoria en una compra local (MOM §45.12).
  const [voucher, setVoucher] = useState<File | null>(null);
  const [voucherKey, setVoucherKey] = useState(0);
  const [localError, setLocalError] = useState<string | null>(null);
  const voucherRequired = paymentNeedsVoucher(detail.imp.kind);
  const vouchers = detail.documents.filter((d) => d.kind === "payment");
  return (
    <div className={payment ? FORM_ZONE : cn(CARD_ZONE, "space-y-3")}>
      <p className="text-[13px] font-semibold text-ink-900">{payment ? `Editar el pago del ${formatDmy(payment.paid_on)}` : "Registrar un pago"}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <AmountField label="Monto" currency={currency} onCurrency={setCurrency} amount={amount} onAmount={setAmount} />
        <Field label="Fecha del pago">
          <input type="date" className={FIELD} value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
        </Field>
        <Field label="Método">
          <select className={FIELD} value={method} onChange={(e) => setMethod(e.target.value)}>
            {PAYMENT_METHODS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label={payment ? "Cambiar la captura (opcional)" : voucherRequired ? "Captura del pago (obligatoria)" : "Adjuntar comprobante (opcional)"}
          hint="Imagen o PDF de la transferencia o del recibo, hasta 25 MB."
        >
          <input
            key={voucherKey}
            type="file"
            accept=".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp"
            className={cn(FILE_INPUT, "py-0.5")}
            onChange={(e) => {
              setVoucher(e.target.files?.[0] ?? null);
              if (e.target.files?.[0]) setDocumentId("");
            }}
          />
        </Field>
        {vouchers.length > 0 && (
          <Field label={payment ? "Comprobante" : "O un comprobante ya subido"}>
            <select className={FIELD} value={documentId} onChange={(e) => setDocumentId(e.target.value)} disabled={Boolean(voucher)}>
              <option value="">{voucherRequired ? "Elige uno" : "Sin comprobante"}</option>
              {vouchers.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.filename ?? "Comprobante"}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Nota" className="sm:col-span-2">
          <input className={FIELD} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
      <Feedback error={localError} />
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={BTN_PRIMARY}
          disabled={pending}
          onClick={() => {
            if (voucherRequired && !voucher && !documentId) {
              setLocalError(PAYMENT_VOUCHER_REQUIRED);
              return;
            }
            setLocalError(null);
            run(
              async () => {
                let uploaded: { path: string; filename: string } | null = null;
                if (voucher) {
                  const up = await uploadImportFile(detail.imp.id, "payment", voucher);
                  if ("error" in up) return { error: up.error };
                  uploaded = { path: up.path, filename: voucher.name };
                }
                return payment
                  ? updateImportPayment(payment.id, { amount, currency, paidOn, method, note, documentId: uploaded ? "" : documentId, voucher: uploaded })
                  : addImportPayment(detail.imp.id, { amount, currency, paidOn, method, note, documentId: uploaded ? "" : documentId, voucher: uploaded });
              },
              payment
                ? onDone
                : () => {
                    setAmount("");
                    setNote("");
                    setDocumentId("");
                    setVoucher(null);
                    setVoucherKey((k) => k + 1);
                  },
            );
          }}
        >
          {payment ? "Guardar pago" : "Registrar pago"}
        </button>
        {payment && (
          <button type="button" className={BTN_GHOST} onClick={onDone}>
            Cancelar
          </button>
        )}
      </div>
    </div>
  );
}

function PaymentsBox({
  detail,
  summary,
  fx,
  canEdit,
  run,
  pending,
}: {
  detail: ImportDetail;
  summary: Summary | null;
  fx: number | null;
  canEdit: boolean;
  run: Run;
  pending: boolean;
}) {
  const local = !hasShipping(detail.imp.kind);
  const [editing, setEditing] = useState<string | null>(null);
  const voucherRequired = paymentNeedsVoucher(detail.imp.kind);
  const payments = detail.payments ?? [];
  const editable = canEdit && detail.imp.status !== "cancelado";
  const fig = summary ? balanceFigure(summary, local) : null;
  // La misma moneda que la cifra: soles en una compra local si se puede.
  const inPen = summary ? summary.pendingUsd === null || (local && summary.pendingPen !== null) : false;
  const pending$ = summary ? (inPen ? summary.pendingPen : summary.pendingUsd) : null;
  const fmtBase = inPen ? fmtPen : fmtUsd;
  return (
    <Section id="pagos">
      <SectionHead
        id={`${sectionDomId("pagos")}-t`}
        title="Pagos"
        badge={
          summary && fig && (summary.total.usd > 0 || summary.total.pen > 0) ? (
            summary.needsFx ? (
              <Badge tone="warn">{MISSING_FX}</Badge>
            ) : pending$ && pending$ > 0 ? (
              <Badge tone="warn" className="tabular-nums">
                Falta pagar {fmtBase(pending$)}
              </Badge>
            ) : (
              <Badge tone="ok">Pagado completo</Badge>
            )
          ) : undefined
        }
        help={
          summary ? (
            <span className="tabular-nums">
              {summary.needsFx
                ? `Pagado ${fmtSplit(summary.paid)} de ${fmtSplit(summary.total)}: con monedas mezcladas, el saldo necesita el tipo de cambio.`
                : !inPen
                  ? `Pagado ${fmtUsd(summary.paidUsd)} de ${fmtUsd(summary.totalUsd)}${summary.paid.pen !== 0 || summary.total.pen !== 0 ? " (los soles ÷ el tipo de cambio)" : ""}.`
                  : `Pagado ${fmtPen(summary.paidPen)} de ${fmtPen(summary.totalPen)}${summary.paid.usd !== 0 || summary.total.usd !== 0 ? " (los US$ × el tipo de cambio)" : ""}.`}
              {voucherRequired ? " Cada pago lleva la captura del comprobante." : ""}
            </span>
          ) : undefined
        }
      />
      {payments.length ? (
        <ul className={ROWS_TOP}>
          {payments.map((p) => {
            if (editing === p.id) {
              return (
                <li key={p.id} className={ROW}>
                  <PaymentForm detail={detail} payment={p} run={run} pending={pending} onDone={() => setEditing(null)} />
                </li>
              );
            }
            const eq = equivalent(p.amount, p.currency, fx);
            return (
              <li key={p.id} className={cn(ROW, "flex items-start justify-between gap-3")}>
                <span className="min-w-0">
                  <span className="block text-sm leading-5 tabular-nums text-ink-900">
                    {formatDmy(p.paid_on)} · {paymentMethodLabel(p.method)}
                  </span>
                  {(p.note || p.document_id) && (
                    <span className="block text-[13px] leading-5 text-ink-500">
                      {p.note}
                      {p.note && p.document_id ? " · " : null}
                      {p.document_id ? (
                        <a href={`/api/compras/documento/${p.document_id}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 font-medium text-brand-700 hover:underline">
                          Ver comprobante
                          <IconArrowUpRight aria-hidden className="size-3.5" />
                        </a>
                      ) : null}
                    </span>
                  )}
                </span>
                <span className="flex shrink-0 items-start gap-1">
                  <span className="pt-1.5 text-right text-sm font-medium leading-5 tabular-nums text-ink-900 pointer-coarse:pt-3">
                    {fmtMoney(p.amount, p.currency)}
                    {eq && <span className="block text-[13px] font-normal text-ink-500">{eq}</span>}
                  </span>
                  {editable && (
                    <button type="button" className={BTN_GHOST} onClick={() => setEditing(p.id)} aria-label={`Editar el pago del ${formatDmy(p.paid_on)}`}>
                      Editar
                    </button>
                  )}
                  {canEdit && (
                    <button type="button" className={BTN_REMOVE} disabled={pending} onClick={() => run(() => removeImportPayment(p.id))} aria-label={`Quitar el pago del ${formatDmy(p.paid_on)}`}>
                      Quitar
                    </button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm text-ink-500">
          Sin pagos todavía.
          {canEdit
            ? voucherRequired
              ? " Registra cada pago al laboratorio con su fecha y la captura de lo que le pagaste."
              : " Registra cada pago, en dólares o en soles, con su fecha y, si lo tienes, su comprobante."
            : ""}
        </p>
      )}
      {canEdit && <PaymentForm detail={detail} run={run} pending={pending} />}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Documentos e historial
// ---------------------------------------------------------------------------

function DocumentsBox({
  detail,
  stores,
  canEdit,
  aiEnabled,
  run,
  pending,
  setFeedback,
}: {
  detail: ImportDetail;
  stores: Store[];
  canEdit: boolean;
  aiEnabled: boolean;
  run: Run;
  pending: boolean;
  setFeedback: (f: ComprasActionState) => void;
}) {
  // El servidor ya mandó solo lo que se puede ver (`canSeeDocKind`); se sube
  // lo que `canUploadDocKind` deja: con solo «Recepción de compras», fotos.
  const uploadKinds = DOC_KINDS.filter((k) => canUploadDocKind(k.id, detail.perms));
  const photosOnly = uploadKinds.length > 0 && uploadKinds.every((k) => k.id === "photo");
  const [kind, setKind] = useState<string>(uploadKinds.some((k) => k.id === "invoice") ? "invoice" : (uploadKinds[0]?.id ?? "photo"));
  const [files, setFiles] = useState<File[]>([]);
  const [inputKey, setInputKey] = useState(0);
  const [aiReading, setAiReading] = useState<string | null>(null);
  const [proposal, setProposal] = useState<Exclude<AiReadState, { error: string }> | null>(null);
  const groups = DOC_KINDS.map((k) => ({ ...k, docs: detail.documents.filter((d) => d.kind === k.id) })).filter((g) => g.docs.length);
  const editable = canEdit && detail.imp.status !== "cancelado";
  const readWithAi = (documentId: string) => {
    setAiReading(documentId);
    setProposal(null);
    run(async () => {
      try {
        const res = await readImportDocumentWithAi(documentId);
        if ("error" in res) return { error: res.error };
        setProposal(res);
        return { notice: `La IA propone ${res.lines.length} producto${res.lines.length === 1 ? "" : "s"}${res.money ? ` y ${res.charges.length} cargo${res.charges.length === 1 ? "" : "s"}` : ""}. Revísalos antes de agregar.` };
      } finally {
        setAiReading(null);
      }
    });
  };
  return (
    <Section id="documentos">
      <SectionHead
        id={`${sectionDomId("documentos")}-t`}
        title="Documentos"
        badge={detail.documents.length ? <Badge className="tabular-nums">{detail.documents.length}</Badge> : undefined}
        help={
          aiEnabled && editable
            ? "La factura comercial, la proforma y el packing list en PDF o imagen se pueden «Leer con IA»: propone los productos y los cargos, y no guarda nada hasta que los agregues."
            : undefined
        }
      />
      {proposal && (
        <AiProposalBox importId={detail.imp.id} stores={stores} proposal={proposal} run={run} pending={pending} onClose={() => setProposal(null)} />
      )}
      {!groups.length && (
        <p className="text-sm text-ink-500">
          Sin documentos todavía.
          {uploadKinds.length
            ? photosOnly
              ? " Sube las fotos de la recepción."
              : hasShipping(detail.imp.kind)
                ? " Empieza por la factura comercial y el tracking: son el checklist mínimo de cada importación."
                : " Empieza por la factura del laboratorio. Las fotos de cada entrega y las capturas de los pagos se suben en Entregas y en Pagos."
            : ""}
        </p>
      )}
      {groups.length > 0 && (
        <div className={cn("-mx-4 sm:-mx-5", proposal ? "border-t border-line" : "-mt-4")}>
          {groups.map((g) => (
            <div key={g.id}>
              <p className="border-b border-line bg-wash px-4 py-1.5 text-xs font-semibold text-ink-600 sm:px-5">{g.label}</p>
              <ul className="divide-y divide-line">
                {g.docs.map((d) => (
                  <li key={d.id} className={cn(ROW, "flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5")}>
                    <span className="flex min-w-0 items-center gap-2.5">
                      <IconReceipt aria-hidden className="size-4 shrink-0 text-ink-500" />
                      <span className="min-w-0">
                        <span className="block truncate text-sm leading-5 text-ink-900">{d.filename ?? docKindLabel(d.kind)}</span>
                        <span className="block text-[13px] leading-5 tabular-nums text-ink-500">
                          {fmtBytes(d.size_bytes)} · {fmtDateTime(d.created_at)}
                          {d.delivery_id ? ` · entrega del ${formatDmy(detail.deliveries.find((x) => x.id === d.delivery_id)?.delivered_on)}` : ""}
                        </span>
                      </span>
                    </span>
                    <span className="-mr-2.5 flex flex-wrap items-center gap-1">
                      {aiEnabled && editable && canReadWithAi(d) && (
                        <button type="button" className={BTN_SECONDARY_SM} disabled={pending} onClick={() => readWithAi(d.id)}>
                          {aiReading === d.id ? "Leyendo…" : "Leer con IA"}
                        </button>
                      )}
                      <a href={`/api/compras/documento/${d.id}`} target="_blank" rel="noopener noreferrer" className={BTN_GHOST}>
                        Ver
                      </a>
                      <a href={`/api/compras/documento/${d.id}?dl=1`} className={BTN_GHOST}>
                        Descargar
                      </a>
                      {canEdit && (
                        <button
                          type="button"
                          className={BTN_REMOVE}
                          disabled={pending}
                          onClick={() => {
                            if (window.confirm("¿Quitar este documento?")) run(() => removeImportDocument(d.id));
                          }}
                        >
                          Quitar
                        </button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
      {uploadKinds.length > 0 && (
        <div className={cn(CARD_ZONE, "space-y-3", !groups.length && "border-t-0 pt-0 sm:pt-0")}>
          <div className="grid gap-3 sm:grid-cols-[14rem_minmax(0,1fr)_auto] sm:items-end">
            <Field label="Tipo de documento">
              <select className={FIELD} value={kind} onChange={(e) => setKind(e.target.value)}>
                {uploadKinds.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Archivos">
              <input
                key={inputKey}
                type="file"
                multiple
                accept={
                  kind === "photo"
                    ? ".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
                    : ".pdf,.jpg,.jpeg,.png,.webp,.xlsx,application/pdf,image/jpeg,image/png,image/webp"
                }
                className={cn(FILE_INPUT, "py-0.5")}
                onChange={(e) => setFiles(Array.from(e.target.files ?? []).slice(0, 10))}
              />
            </Field>
            <button
              type="button"
              className={BTN_PRIMARY}
              disabled={pending || !files.length}
              onClick={() =>
                run(
                  async () => {
                    const errors: string[] = [];
                    let ok = 0;
                    for (const file of files) {
                      const up = await uploadImportFile(detail.imp.id, kind, file);
                      if ("error" in up) {
                        errors.push(up.error);
                        continue;
                      }
                      const res = await registerImportDocument(detail.imp.id, { kind, path: up.path, filename: file.name });
                      if (res.error) errors.push(`${file.name}: ${res.error}`);
                      else ok++;
                    }
                    if (errors.length) {
                      setFeedback({ error: errors.join(" ") });
                      return { error: errors.join(" ") };
                    }
                    return { notice: `${ok} documento${ok === 1 ? "" : "s"} subido${ok === 1 ? "" : "s"}.` };
                  },
                  () => {
                    setFiles([]);
                    setInputKey((k) => k + 1);
                  },
                )
              }
            >
              {files.length > 1 ? `Subir ${files.length}` : "Subir"}
            </button>
          </div>
          <p className="text-xs leading-4 text-ink-500">
            {photosOnly ? "Fotos de la recepción: JPG, PNG o WEBP, hasta 25 MB. Hasta 10 por vez." : "PDF, JPG, PNG, WEBP o XLSX, hasta 25 MB. Hasta 10 por vez."}
          </p>
        </div>
      )}
    </Section>
  );
}

const EVENT_ICON: Record<ImportEventKind, ComponentType<SVGProps<SVGSVGElement>>> = {
  status: IconActivity,
  nota: IconChat,
  producto: IconPackage,
  dinero: IconMoney,
  documento: IconReceipt,
  recepcion: IconPackageCheck,
  bodega: IconTruck,
  costos: IconMoney,
  datos: IconClipboard,
};

const EVENT_LABEL: Record<ImportEventKind, string> = {
  status: "Estado",
  nota: "Nota",
  producto: "Productos",
  dinero: "Dinero",
  documento: "Documentos",
  recepcion: "Entregas",
  bodega: "Bodega",
  costos: "Costos",
  datos: "Datos",
};

/** Disco del hito: un cambio de estado lleva el par de su chapa; lo demás, el lavado gris. */
const STATUS_DISC = { ok: "bg-ok-bg text-ok-fg", info: "bg-info-bg text-info-fg", neutral: "bg-line text-ink-600" } as const;

function HistoryBox({ detail }: { detail: ImportDetail }) {
  const events = detail.events;
  return (
    <Section id="historial">
      <SectionHead
        id={`${sectionDomId("historial")}-t`}
        title="Historial"
        badge={<Badge>Solo lectura</Badge>}
        help={`${events.length} movimiento${events.length === 1 ? "" : "s"} · lo más reciente arriba`}
      />
      {events.length ? (
        <ol className="relative space-y-5 pl-10 before:absolute before:bottom-3.5 before:left-[13.5px] before:top-3.5 before:w-px before:bg-line-strong">
          {events.map((e) => {
            const Glyph = EVENT_ICON[e.kind] ?? IconActivity;
            return (
              <li key={e.id} className="relative">
                <span
                  aria-hidden
                  className={cn(
                    "absolute -left-10 -top-1 grid size-7 place-items-center rounded-full ring-[3px] ring-white",
                    e.status ? STATUS_DISC[importStatusTone(e.status)] : "bg-wash text-ink-500",
                  )}
                >
                  <Glyph className="size-4" />
                </span>
                <p className="text-sm font-medium leading-5 text-ink-900">
                  {e.status ? IMPORT_STATUS_LABEL[e.status] : (EVENT_LABEL[e.kind] ?? e.kind)}
                </p>
                {e.note && <p className="mt-0.5 max-w-[68ch] text-sm leading-5 text-ink-700">{e.note}</p>}
                <p className="mt-0.5 text-[13px] leading-5 text-ink-500">
                  <span className="tabular-nums">{fmtDateTime(e.at)}</span> · {e.by_name ?? "Kapta"}
                </p>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="text-sm text-ink-500">Sin movimientos.</p>
      )}
    </Section>
  );
}
