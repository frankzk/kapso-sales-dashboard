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
// En el mundo de operación (DESIGN.md): título de 28 px con su chapa, el marco
// de cifras, un índice pegajoso con el aviso de la última acción, la próxima
// acción con anillo azul y cada parte en su tarjeta de sección sobre el lienzo.
// Desde 1280 px el estado, el aviso a la bodega y los datos van en un riel a
// la derecha, como el detalle de Stripe.

import { useEffect, useMemo, useRef, useState, useTransition, type ComponentType, type ReactNode, type SVGProps } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/components/ui";
import { Badge, Banner, CARD_ZONE, CHECKBOX, SECTION_CARD, SectionHead, choiceChipClass } from "@/components/ops-ui";
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
  DOC_KINDS,
  IGV_HELP,
  IMPORT_STATUSES,
  IMPORT_STATUS_LABEL,
  MISSING_FX,
  MOVEMENT_EVENT_KINDS,
  PAYMENT_METHODS,
  RECEIVED_STATUSES,
  TRAVELING_STATUSES,
  allocationLabel,
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
  type ImportEventKind,
} from "@/lib/compras";
import type { CostRow, ImportDetail, ItemRow } from "@/lib/compras-server";
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
  removeImportPayment,
  saveReception,
  setImportFx,
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
import { fmtBytes, fmtDateTime, fmtInt, fmtMoney, fmtPct, fmtPen, fmtSplit, fmtUsd, fmtUsdUnit } from "@/components/compras/format";

type Store = { id: string; name: string };
type Run = (fn: () => Promise<ComprasActionState>, after?: () => void) => void;
type SectionId = "estado" | "bodega" | "productos" | "recepcion" | "aterrizado" | "costos" | "pagos" | "pasar" | "documentos" | "historial" | "datos";

const SECTION_LABEL: Record<SectionId, string> = {
  estado: "Estado",
  bodega: "Bodega",
  productos: "Productos",
  recepcion: "Recepción",
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
  // La recepción: «Compras» o «Recepción de compras» (MOM §45.11).
  const canCount = perms.canManage || perms.canReceive;
  const fx = imp.fx_pen_per_usd ?? null;
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
  const reception = receptionSummary(items.map((it) => ({ id: it.id, name: it.name, qty: it.qty, receivedQty: it.received_qty, damagedQty: it.damaged_qty })));
  const lastMovement = detail.events.find((e) => MOVEMENT_EVENT_KINDS.includes(e.kind))?.at ?? imp.created_at;
  const alerts = importAlerts({ status: imp.status, eta: imp.eta, reportedAt: imp.reported_to_warehouse_at, lastMovementAt: lastMovement }, today);
  const checklist = importChecklist(detail.documents.map((d) => d.kind), imp.tracking_number);
  const trackingLink = trackingPublicUrl({ carrier: imp.carrier, trackingNumber: imp.tracking_number, trackingUrl: imp.tracking_url });
  const plan =
    landed &&
    costPushPlan({
      status: imp.status,
      fxPenPerUsd: fx,
      items: items.map((it) => ({ id: it.id, name: it.name, sku: it.sku, storeId: it.store_id, receivedQty: it.received_qty, costPushedAt: it.cost_pushed_at })),
      landed,
    });
  const storeName = new Map(stores.map((s) => [s.id, s.name]));

  const sections: SectionId[] = [
    "estado",
    ...(canEdit ? (["bodega"] as const) : []),
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
  const due =
    (TRAVELING_STATUSES.includes(imp.status) && alerts.daysToEta !== null && alerts.daysToEta <= 0) || RECEIVED_STATUSES.includes(imp.status);
  const next: { title: string; help: string; label: string; onClick: () => void } | null =
    canEdit && alerts.notifyWarehouse
      ? {
          title: "Avisar a la bodega",
          help: `${alerts.late ? "Ya debía llegar" : alerts.daysToEta === 0 ? "Llega hoy" : `Llega en ${alerts.daysToEta} día${alerts.daysToEta === 1 ? "" : "s"}`} y la bodega de Lima no está avisada. Copia el mensaje o ábrelo en WhatsApp y márcala como reportada.`,
          label: "Ir al aviso",
          onClick: () => jump("bodega"),
        }
      : receptionEditable && due && !reception.complete
        ? {
            title: reception.counted ? "Completar la recepción" : "Registrar recepción",
            help: reception.counted
              ? `Falta contar ${reception.uncounted} producto${reception.uncounted === 1 ? "" : "s"}.`
              : "Cuenta lo que llegó por producto: cuántas llegaron y cuántas dañadas. Al guardar, si estaba en camino, pasa a Recibido.",
            label: reception.counted ? "Seguir contando" : "Registrar recepción",
            onClick: () => {
              setReceptionOpen(true);
              jump("recepcion");
            },
          }
        : money && plan && !plan.alreadyDone && plan.ready && perms.canPushCosts
          ? {
              title: "Pasar a Costos",
              help: "La recepción está contada y hay tipo de cambio: ya se puede llevar el costo aterrizado por unidad a Costos de productos.",
              label: "Revisar y pasar",
              onClick: () => jump("pasar"),
            }
          : null;

  const arrival = arrivalFigure(imp.arrived_on, imp.eta, alerts, isActiveStatus(imp.status));
  const figures: { key: string; label: string; value: ReactNode; sub?: ReactNode; tone?: "warn" | "crit" | "ok" }[] = [
    { key: "llegada", label: imp.arrived_on ? "Llegó" : "Llegada estimada", value: arrival.value, sub: arrival.sub, tone: arrival.tone },
    {
      key: "unidades",
      label: "Unidades",
      value: fmtInt(reception.ordered),
      sub: reception.counted ? `${fmtInt(reception.good)} buenas al recibir` : `${items.length} producto${items.length === 1 ? "" : "s"} · sin contar`,
    },
    ...(summary
      ? [
          summary.totalUsd !== null
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
          balanceFigure(summary),
          {
            key: "ganancia",
            label: "Ganancia esperada (S/)",
            value: summary.expectedProfitPen != null ? fmtPen(summary.expectedProfitPen) : "—",
            sub:
              summary.recoveryShare != null
                ? `Recuperas lo invertido al vender el ${Math.min(999, Math.round(summary.recoveryShare * 100))} % de las unidades`
                : fx
                  ? "Falta el precio de venta de algún producto"
                  : "Falta el tipo de cambio",
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
          {canEdit && <WarehouseBox detail={detail} trackingLink={trackingLink} notify={alerts.notifyWarehouse} run={run} pending={pending} />}
        </div>

        <div className="min-w-0 space-y-4 sm:space-y-6 xl:col-start-1 xl:row-span-2 xl:row-start-1">
          <ItemsBox detail={detail} stores={stores} storeName={storeName} landed={landed} fx={fx} canEdit={canEdit} aiEnabled={aiEnabled && canEdit} catalog={catalog} run={run} pending={pending} />

          <ReceptionBox
            detail={detail}
            summary={reception}
            canEdit={canCount}
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
                    producto se pasa una sola vez.
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
function balanceFigure(s: Summary): { key: string; label: string; value: ReactNode; sub?: ReactNode; tone?: "warn" | "ok" } {
  const usd = s.pendingUsd !== null;
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
  checklist: { invoice: boolean; tracking: boolean };
  canEdit: boolean;
  /** «Editar datos»: abre el formulario en la tarjeta «Datos». */
  onEdit?: () => void;
}) {
  const { imp, supplier } = detail;
  const flags: { key: string; tone: "warn" | "crit" | "neutral"; label: string }[] = [];
  if (alerts.late) flags.push({ key: "late", tone: "crit", label: "Atrasada: la llegada estimada ya pasó" });
  if (alerts.notifyWarehouse) flags.push({ key: "notify", tone: "warn", label: "Avisar a la bodega" });
  if (alerts.stale) flags.push({ key: "stale", tone: "warn", label: `Sin novedades hace ${alerts.daysSinceMovement} días` });
  if (!checklist.invoice) flags.push({ key: "invoice", tone: "neutral", label: "Falta la factura comercial" });
  if (!checklist.tracking) flags.push({ key: "tracking", tone: "neutral", label: "Falta el tracking" });
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
          </div>
          <p className="mt-1 text-sm text-ink-500">
            <span className="font-medium text-ink-700">{supplier?.name ?? "Sin proveedor"}</span>
            {canEdit && supplier?.whatsapp ? (
              <>
                {" · "}
                <a href={whatsappShareUrl("", supplier.whatsapp)} target="_blank" rel="noopener noreferrer" className="font-medium text-brand-700 hover:underline">
                  WhatsApp
                </a>
              </>
            ) : null}
            {" · "}
            {imp.origin ?? "Origen sin indicar"} → bodega de Kapta, Lima · {transportLabel(imp.transport)}
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
          <button
            type="button"
            className={BTN_PRIMARY}
            disabled={pending}
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
  const rows: { label: string; value: ReactNode; wide?: boolean }[] = [
    { label: "Proveedor", value: supplier?.name ?? "Sin proveedor" },
    { label: "Origen", value: imp.origin ?? "Sin indicar" },
    { label: "Transporte", value: transportLabel(imp.transport) },
    {
      label: "Guía",
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
        <span className="text-ink-500">{imp.carrier ?? "—"}</span>
      ),
    },
    { label: "N.º de orden", value: imp.platform_order ? <span className="font-mono text-xs">{imp.platform_order}</span> : "—" },
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

type ItemDraft = { name: string; sku: string; storeId: string; qty: string; unitWeightKg: string; unitCostUsd: string; salePricePen: string };

const EMPTY_ITEM: ItemDraft = { name: "", sku: "", storeId: "", qty: "", unitWeightKg: "", unitCostUsd: "", salePricePen: "" };

function itemDraft(it: ItemRow): ItemDraft {
  return {
    name: it.name,
    sku: it.sku ?? "",
    storeId: it.store_id ?? "",
    qty: String(it.qty),
    unitWeightKg: it.unit_weight_kg == null ? "" : String(it.unit_weight_kg),
    unitCostUsd: it.unit_cost_usd == null ? "" : String(it.unit_cost_usd),
    salePricePen: it.sale_price_pen == null ? "" : String(it.sale_price_pen),
  };
}

const FILE_INPUT =
  "block w-full min-w-0 text-[13px] text-ink-600 file:mr-3 file:h-8 file:cursor-pointer file:rounded-md file:border-0 file:bg-white file:px-3 file:text-[13px] file:font-semibold file:text-ink-700 file:shadow-control file:ring-1 file:ring-inset file:ring-line-strong hover:file:bg-wash";

function ItemForm({
  importId,
  stores,
  money,
  item,
  catalog = [],
  run,
  pending,
  onDone,
}: {
  importId: string;
  stores: Store[];
  money: boolean;
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
    const base = { name: d.name, sku: d.sku, storeId: d.storeId, qty: d.qty, unitWeightKg: d.unitWeightKg };
    return money ? { ...base, unitCostUsd: d.unitCostUsd, salePricePen: d.salePricePen } : base;
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
        <Field label="Peso por unidad (kg)">
          <input className={cn(FIELD, "tabular-nums")} inputMode="decimal" value={d.unitWeightKg} onChange={set("unitWeightKg")} />
        </Field>
        {money && (
          <>
            <Field label="Costo por unidad (USD)">
              <input className={cn(FIELD, "tabular-nums")} inputMode="decimal" value={d.unitCostUsd} onChange={set("unitCostUsd")} />
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
  const editable = canEdit && detail.imp.status !== "cancelado";
  const units = detail.items.reduce((a, it) => a + it.qty, 0);
  return (
    <Section id="productos">
      <SectionHead
        id={`${sectionDomId("productos")}-t`}
        title="Productos"
        badge={<Badge className="tabular-nums">{detail.items.length}</Badge>}
        help={detail.items.length ? `${fmtInt(units)} unidades pedidas.` : undefined}
        aside={
          editable && !adding ? (
            <button type="button" className={BTN_SECONDARY_SM} onClick={() => setAdding(true)}>
              <IconPlus aria-hidden />
              Agregar producto
            </button>
          ) : undefined
        }
      />
      {adding && <ItemForm importId={detail.imp.id} stores={stores} money={money} catalog={catalog} run={run} pending={pending} onDone={() => setAdding(false)} />}
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
                  <ItemForm importId={detail.imp.id} stores={stores} money={money} item={it} run={run} pending={pending} onDone={() => setEditing(null)} />
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
                      <span>
                        Llegaron {fmtInt(it.received_qty)}
                        {it.damaged_qty ? <span className="text-warn-fg"> ({fmtInt(it.damaged_qty)} dañadas)</span> : null}
                      </span>
                    ) : (
                      <span className="text-ink-500">Sin contar</span>
                    )}
                    {it.cost_pushed_at ? <Badge tone="ok">En Costos</Badge> : null}
                    {margin?.low ? <Badge tone="crit">Margen bajo</Badge> : null}
                  </div>
                  {money && (
                    <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[13px] leading-5 tabular-nums sm:grid-cols-4">
                      <div>
                        <dt className="text-ink-500">Proveedor</dt>
                        <dd className="text-ink-900">{fmtUsdUnit(it.unit_cost_usd)}/u</dd>
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
                          {line ? <LandedUnit line={line} /> : "—"}
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
                      <button
                        type="button"
                        className={BTN_REMOVE}
                        disabled={pending}
                        onClick={() => {
                          if (window.confirm(`¿Quitar «${it.name}» de la importación?`)) run(() => removeImportItem(it.id));
                        }}
                      >
                        Quitar
                      </button>
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
// Recepción
// ---------------------------------------------------------------------------

function ReceptionBox({
  detail,
  summary,
  canEdit,
  open,
  setOpen,
  run,
  pending,
}: {
  detail: ImportDetail;
  summary: ReturnType<typeof receptionSummary>;
  canEdit: boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
  run: Run;
  pending: boolean;
}) {
  const initial = () =>
    Object.fromEntries(
      detail.items.map((it) => [
        it.id,
        { received: it.received_qty == null ? "" : String(it.received_qty), damaged: it.damaged_qty ? String(it.damaged_qty) : "", note: it.reception_note ?? "" },
      ]),
    ) as Record<string, { received: string; damaged: string; note: string }>;
  const [draft, setDraft] = useState(initial);
  // Al abrirse desde «La próxima acción», el borrador parte de lo guardado.
  const wasOpen = useRef(open);
  useEffect(() => {
    if (open && !wasOpen.current) setDraft(initial());
    wasOpen.current = open;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const editable = canEdit && detail.imp.status !== "cancelado" && detail.items.length > 0;
  const lastCount = detail.items.map((it) => it.received_at).filter(Boolean).sort().pop() ?? null;
  const cells: { label: string; value: number; tone?: "warn" }[] = [
    { label: "Pedidas", value: summary.ordered },
    { label: "Llegaron", value: summary.received },
    { label: "Faltan", value: summary.missing, tone: summary.missing > 0 ? "warn" : undefined },
    { label: "Sobran", value: summary.extra, tone: summary.extra > 0 ? "warn" : undefined },
    { label: "Dañadas", value: summary.damaged, tone: summary.damaged > 0 ? "warn" : undefined },
    { label: "Buenas", value: summary.good },
  ];
  return (
    <Section id="recepcion">
      <SectionHead
        id={`${sectionDomId("recepcion")}-t`}
        title="Recepción en la bodega de Lima"
        badge={
          summary.counted === 0 ? (
            <Badge>Sin contar</Badge>
          ) : summary.complete ? (
            <Badge tone="ok">Contada</Badge>
          ) : (
            <Badge tone="warn">
              Faltan {summary.uncounted} por contar
            </Badge>
          )
        }
        help={
          <>
            {summary.counted === 0
              ? "Todavía no se contó nada."
              : summary.complete
                ? `Contada completa${lastCount ? ` · ${fmtDateTime(lastCount)}` : ""}.`
                : `Falta contar ${summary.uncounted} producto${summary.uncounted === 1 ? "" : "s"}.`}
            {summary.withDifferences.length ? ` ${summary.withDifferences.length} con diferencias.` : ""} Al guardar, si la importación estaba en camino
            pasa a Recibido.
          </>
        }
        aside={
          editable && !open ? (
            <button type="button" className={BTN_SECONDARY_SM} onClick={() => setOpen(true)}>
              {summary.counted ? "Editar recepción" : "Registrar recepción"}
            </button>
          ) : undefined
        }
      />
      <dl className="grid grid-cols-3 gap-px overflow-hidden rounded-lg bg-line ring-1 ring-line sm:grid-cols-6">
        {cells.map((c) => (
          <div key={c.label} className="bg-white px-3 py-2">
            <dt className="text-xs font-medium leading-4 text-ink-500">{c.label}</dt>
            <dd className={cn("mt-0.5 text-base font-semibold leading-6 tabular-nums", c.tone === "warn" ? "text-warn-fg" : "text-ink-900")}>{fmtInt(c.value)}</dd>
          </div>
        ))}
      </dl>
      {open && (
        <div className={FORM_ZONE}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[13px] font-semibold text-ink-900">Lo que llegó, por producto</p>
            <button
              type="button"
              className={BTN_GHOST}
              onClick={() =>
                setDraft((cur) =>
                  Object.fromEntries(detail.items.map((it) => [it.id, { ...cur[it.id]!, received: String(it.qty), damaged: cur[it.id]?.damaged ?? "" }])),
                )
              }
            >
              Llenar con lo pedido
            </button>
          </div>
          <div aria-hidden className="hidden gap-3 text-xs font-semibold text-ink-600 sm:grid sm:grid-cols-[minmax(0,2fr)_6rem_6rem_minmax(0,2fr)]">
            <span>Producto</span>
            <span>Llegaron</span>
            <span>Dañadas</span>
            <span>Nota</span>
          </div>
          <ul className="divide-y divide-line-strong/60">
            {detail.items.map((it) => (
              <li key={it.id} className="grid grid-cols-2 gap-x-3 gap-y-2 py-2.5 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,2fr)_6rem_6rem_minmax(0,2fr)] sm:items-center">
                <p className="col-span-2 text-sm leading-5 text-ink-900 sm:col-span-1">
                  {it.name} <span className="text-[13px] tabular-nums text-ink-500">· {fmtInt(it.qty)} pedidas</span>
                </p>
                <label className={LABEL}>
                  <span className="sm:sr-only">Llegaron</span>
                  <input
                    className={cn(FIELD, "tabular-nums")}
                    inputMode="numeric"
                    aria-label={`Llegaron de ${it.name}`}
                    value={draft[it.id]?.received ?? ""}
                    onChange={(e) => setDraft((d) => ({ ...d, [it.id]: { ...d[it.id]!, received: e.target.value } }))}
                  />
                </label>
                <label className={LABEL}>
                  <span className="sm:sr-only">Dañadas</span>
                  <input
                    className={cn(FIELD, "tabular-nums")}
                    inputMode="numeric"
                    aria-label={`Dañadas de ${it.name}`}
                    value={draft[it.id]?.damaged ?? ""}
                    onChange={(e) => setDraft((d) => ({ ...d, [it.id]: { ...d[it.id]!, damaged: e.target.value } }))}
                  />
                </label>
                <label className={cn(LABEL, "col-span-2 sm:col-span-1")}>
                  <span className="sm:sr-only">Nota</span>
                  <input
                    className={FIELD}
                    aria-label={`Nota de ${it.name}`}
                    value={draft[it.id]?.note ?? ""}
                    onChange={(e) => setDraft((d) => ({ ...d, [it.id]: { ...d[it.id]!, note: e.target.value } }))}
                  />
                </label>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={BTN_PRIMARY}
              disabled={pending}
              onClick={() =>
                run(
                  () =>
                    saveReception(
                      detail.imp.id,
                      detail.items.map((it) => ({ itemId: it.id, received: draft[it.id]?.received, damaged: draft[it.id]?.damaged, note: draft[it.id]?.note })),
                    ),
                  () => setOpen(false),
                )
              }
            >
              Guardar recepción
            </button>
            <button type="button" className={BTN_GHOST} onClick={() => setOpen(false)}>
              Cancelar
            </button>
          </div>
        </div>
      )}
    </Section>
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
function LandedUnit({ line }: { line: LandedLineT }) {
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
  const rows = detail.items.map((it) => ({ it, l: landed.byItem.get(it.id) })).filter((r): r is { it: ItemRow; l: NonNullable<typeof r.l> } => Boolean(r.l));
  // En la tabla los montos van sin «US$»: la cabecera dice la moneda una vez y
  // así cada cifra cabe en una línea.
  const TH = "whitespace-nowrap py-2 pl-3 text-right text-xs font-semibold text-ink-600";
  const TD = "whitespace-nowrap py-2.5 pl-3 text-right text-[13px] leading-5 tabular-nums text-ink-700";
  const n4 = (v: number | undefined) => (v == null ? "—" : fmtUsdUnit(v).replace("US$ ", ""));
  const usd = landed.usd;
  // Costos en soles y sin tipo de cambio: el total en USD no se puede decir.
  const missingFx = landed.hasPenCosts && !fx;
  return (
    <Section id="aterrizado" className="@container">
      <SectionHead
        id={`${sectionDomId("aterrizado")}-t`}
        title="Costo aterrizado por unidad"
        help={
          usd ? (
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
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Tipo de cambio (S/ por 1 USD)">
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
      {missingFx && (
        <Banner tone="warn" title={MISSING_FX}>
          <p>Hay costos en soles: con el tipo de cambio de la importación se ve el costo aterrizado en USD y en soles, y el margen.</p>
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
            USD por unidad buena (los costos en soles ÷ el tipo de cambio); la última columna, en soles (los costos en soles, tal cual).
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
                <th className={TH}>En S/</th>
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
                  <td className={TD}>{n4(l.usd?.perUnit.product)}</td>
                  <td className={TD}>{n4(l.usd?.perUnit.envio)}</td>
                  <td className={TD}>{n4(l.usd?.perUnit.importacion)}</td>
                  <td className={TD}>{n4(l.usd?.perUnit.adicional)}</td>
                  <td className={cn(TD, "font-semibold text-ink-900", !l.usd && "whitespace-normal font-medium text-warn-fg")}>{l.usd ? n4(l.usd.unitCost) : MISSING_FX}</td>
                  <td className={TD} title={l.pen ? undefined : MISSING_FX}>{l.pen ? fmtPen(l.pen.unitCost).replace("S/ ", "") : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <ul className={cn(ROWS, "-mb-4 sm:-mb-5 @2xl:hidden")}>
            {rows.map(({ it, l }) => {
              // El desglose en la vista que se pueda (USD primero).
              const view = l.usd ?? l.pen;
              const fmt = l.usd ? fmtUsdUnit : fmtPen;
              return (
                <li key={it.id} className={ROW}>
                  <div className="flex items-start justify-between gap-3">
                    <p className="min-w-0 text-sm leading-5 text-ink-900">
                      {it.name} {l.loss ? <Badge tone="crit">Pérdida</Badge> : null}
                    </p>
                    <p className="shrink-0 text-right text-sm font-semibold leading-5 tabular-nums text-ink-900">
                      <LandedUnit line={l} />
                    </p>
                  </div>
                  <dl className="mt-1 grid gap-x-6 text-[13px] leading-5 tabular-nums sm:grid-cols-2">
                    {(
                      [
                        ["Buenas", fmtInt(l.good)],
                        ["Proveedor", view ? fmt(view.perUnit.product) : "—"],
                        ["Envío", view ? fmt(view.perUnit.envio) : "—"],
                        ["Importación", view ? fmt(view.perUnit.importacion) : "—"],
                        ["Adicional", view ? fmt(view.perUnit.adicional) : "—"],
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

/** «S/ 504.16 con IGV → S/ 427.25 sin IGV» de un costo guardado. */
function costIgvNote(c: CostRow): string | null {
  return c.includes_igv && c.gross_amount != null ? `${fmtMoney(c.gross_amount, c.currency)} con IGV → ${fmtMoney(c.amount, c.currency)} sin IGV` : null;
}

function CostsBox({ detail, fx, canEdit, run, pending }: { detail: ImportDetail; fx: number | null; canEdit: boolean; run: Run; pending: boolean }) {
  const [kind, setKind] = useState<string>("envio");
  const [label, setLabel] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState<Currency>("USD");
  const [includesIgv, setIncludesIgv] = useState(false);
  const [allocation, setAllocation] = useState<string>("units");
  const [itemId, setItemId] = useState("");
  const costs = detail.costs ?? [];
  const itemName = new Map(detail.items.map((it) => [it.id, it.name]));
  const sum = (list: CostRow[]) => list.reduce((a, c) => ({ usd: a.usd + (c.currency === "USD" ? c.amount : 0), pen: a.pen + (c.currency === "PEN" ? c.amount : 0) }), { usd: 0, pen: 0 });
  const byKind = COST_KINDS.map((k) => ({ ...k, total: sum(costs.filter((c) => c.kind === k.id)) }));
  const total = sum(costs);
  const mixed = total.usd !== 0 && total.pen !== 0;
  const totalUsd = moneyInUsd(total, fx);
  // La vista previa de «Incluye IGV»: lo que entra al costo, sin IGV.
  const typed = parseDecimal(amount);
  const igvPreview = includesIgv && typed !== null && typed > 0 ? { net: netOfIgv(typed), igv: igvOf(typed) } : null;
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
      {canEdit && (
        <div className={cn(CARD_ZONE, "space-y-3")}>
          <p className="text-[13px] font-semibold text-ink-900">Agregar un costo</p>
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
              <label className="inline-flex cursor-pointer items-center gap-2 text-[13px] font-medium leading-5 text-ink-700 pointer-coarse:min-h-11">
                <input type="checkbox" className={CHECKBOX} checked={includesIgv} onChange={(e) => setIncludesIgv(e.target.checked)} />
                Incluye IGV (18 %)
              </label>
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
          <button
            type="button"
            className={BTN_PRIMARY}
            disabled={pending}
            onClick={() =>
              run(
                () => addImportCost(detail.imp.id, { kind, label, amount, currency, includesIgv, allocation, itemId }),
                () => {
                  setLabel("");
                  setAmount("");
                  setIncludesIgv(false);
                },
              )
            }
          >
            Agregar costo
          </button>
        </div>
      )}
    </Section>
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
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState<Currency>("USD");
  const [paidOn, setPaidOn] = useState(limaToday());
  const [method, setMethod] = useState<string>("transferencia");
  const [note, setNote] = useState("");
  const [documentId, setDocumentId] = useState("");
  const payments = detail.payments ?? [];
  const vouchers = detail.documents.filter((d) => d.kind === "payment");
  const fig = summary ? balanceFigure(summary) : null;
  const pending$ = summary ? (summary.pendingUsd ?? summary.pendingPen) : null;
  const fmtBase = summary && summary.pendingUsd !== null ? fmtUsd : fmtPen;
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
                : summary.pendingUsd !== null
                  ? `Pagado ${fmtUsd(summary.paidUsd)} de ${fmtUsd(summary.totalUsd)}${summary.paid.pen !== 0 || summary.total.pen !== 0 ? " (los soles ÷ el tipo de cambio)" : ""}.`
                  : `Pagado ${fmtPen(summary.paidPen)} de ${fmtPen(summary.totalPen)}.`}
            </span>
          ) : undefined
        }
      />
      {payments.length ? (
        <ul className={ROWS_TOP}>
          {payments.map((p) => {
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
                          Comprobante
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
        <p className="text-sm text-ink-500">Sin pagos todavía.{canEdit ? " Registra cada pago, en dólares o en soles, con su fecha y, si lo tienes, su comprobante." : ""}</p>
      )}
      {canEdit && (
        <div className={cn(CARD_ZONE, "space-y-3")}>
          <p className="text-[13px] font-semibold text-ink-900">Registrar un pago</p>
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
            <Field label="Comprobante" hint={vouchers.length ? undefined : "Súbelo en Documentos como «Comprobante de pago» para elegirlo aquí."}>
              <select className={FIELD} value={documentId} onChange={(e) => setDocumentId(e.target.value)}>
                <option value="">Sin comprobante</option>
                {vouchers.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.filename ?? "Comprobante"}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Nota" className="sm:col-span-2">
              <input className={FIELD} value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
          </div>
          <button
            type="button"
            className={BTN_PRIMARY}
            disabled={pending}
            onClick={() =>
              run(
                () => addImportPayment(detail.imp.id, { amount, currency, paidOn, method, note, documentId }),
                () => {
                  setAmount("");
                  setNote("");
                  setDocumentId("");
                },
              )
            }
          >
            Registrar pago
          </button>
        </div>
      )}
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
          {uploadKinds.length ? (photosOnly ? " Sube las fotos de la recepción." : " Empieza por la factura comercial y el tracking: son el checklist mínimo de cada importación.") : ""}
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
  recepcion: "Recepción",
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
