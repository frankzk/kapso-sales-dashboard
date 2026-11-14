"use client";

// Detalle de una importación (MOM §45). Todo lo de dinero (costos por unidad,
// costos repartidos, pagos, costo aterrizado, margen, tipo de cambio y «Pasar
// a Costos») solo se dibuja con «Montos de compras»; sin ese permiso el
// servidor ni siquiera lo manda (lib/compras-server.ts).

import { useMemo, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Card, cn } from "@/components/ui";
import {
  ALLOCATIONS,
  COST_KINDS,
  DOC_KINDS,
  IMPORT_STATUSES,
  IMPORT_STATUS_LABEL,
  MONEY_DOC_KINDS,
  MOVEMENT_EVENT_KINDS,
  PAYMENT_METHODS,
  allocationLabel,
  costKindLabel,
  costPushPlan,
  docKindLabel,
  formatDmy,
  importAlerts,
  importChecklist,
  landedCosts,
  limaToday,
  marginOf,
  moneySummary,
  paymentMethodLabel,
  receptionSummary,
  trackingPublicUrl,
  transportLabel,
  warehouseMessage,
  whatsappShareUrl,
  type CostKind,
  type Allocation,
} from "@/lib/compras";
import type { ImportDetail, ItemRow } from "@/lib/compras-server";
import {
  addImportCost,
  addImportItem,
  addImportPayment,
  pushImportCosts,
  registerImportDocument,
  removeImportCost,
  removeImportDocument,
  removeImportItem,
  removeImportPayment,
  saveReception,
  setImportFx,
  setImportStatus,
  setWarehouseReported,
  updateImportItem,
  type ComprasActionState,
} from "@/app/dashboard/compras/actions";
import { BTN_DANGER, BTN_GHOST, BTN_PRIMARY, BTN_SECONDARY, FIELD, Feedback, ImportHeaderForm, LABEL } from "@/components/compras/header-form";
import { uploadImportFile } from "@/components/compras/upload";
import { useCopyToClipboard } from "@/components/copy-button";
import { fmtBytes, fmtDateTime, fmtInt, fmtPct, fmtPen, fmtUsd, fmtUsdUnit } from "@/components/compras/format";

type Store = { id: string; name: string };
type Run = (fn: () => Promise<ComprasActionState>, after?: () => void) => void;

function Box({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        {right}
      </div>
      {children}
    </Card>
  );
}

function Metric({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "warn" | "bad" | "ok" }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <p className="text-xs text-slate-500">{label}</p>
      <p className={cn("mt-0.5 text-base font-semibold", tone === "bad" ? "text-red-700" : tone === "warn" ? "text-amber-700" : tone === "ok" ? "text-emerald-700" : "text-slate-900")}>
        {value}
      </p>
      {sub && <p className="text-xs text-slate-500">{sub}</p>}
    </div>
  );
}

export function ImportDetailView({ detail, stores, today }: { detail: ImportDetail; stores: Store[]; today: string }) {
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
  const fx = imp.fx_pen_per_usd ?? null;

  const landed = useMemo(
    () =>
      money
        ? landedCosts(
            items.map((it) => ({
              id: it.id,
              name: it.name,
              qty: it.qty,
              unitCostUsd: it.unit_cost_usd ?? 0,
              unitWeightKg: it.unit_weight_kg,
              receivedQty: it.received_qty,
              damagedQty: it.damaged_qty,
            })),
            (detail.costs ?? []).map((c) => ({
              id: c.id,
              kind: c.kind as CostKind,
              label: c.label,
              amountUsd: c.amount_usd,
              allocation: c.allocation as Allocation,
              itemId: c.item_id,
            })),
          )
        : null,
    [money, items, detail.costs],
  );
  const summary = landed
    ? moneySummary(
        landed,
        items.map((it) => ({ id: it.id, salePricePen: it.sale_price_pen })),
        (detail.payments ?? []).map((p) => ({ amountUsd: p.amount_usd })),
        fx,
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

  return (
    <div className="space-y-4 pb-24">
      <HeaderBox detail={detail} canEdit={canEdit} trackingLink={trackingLink} />

      {(alerts.late || alerts.notifyWarehouse || alerts.stale || !checklist.invoice || !checklist.tracking) && (
        <div className="flex flex-wrap gap-2 text-xs">
          {alerts.late && <span className="rounded-full bg-red-100 px-2.5 py-1 font-semibold text-red-700">Atrasada: la llegada estimada ya pasó</span>}
          {alerts.notifyWarehouse && <span className="rounded-full bg-amber-100 px-2.5 py-1 font-semibold text-amber-800">Avisar a la bodega</span>}
          {alerts.stale && <span className="rounded-full bg-amber-100 px-2.5 py-1 font-semibold text-amber-800">Sin novedades hace {alerts.daysSinceMovement} días</span>}
          {!checklist.invoice && <span className="rounded-full bg-slate-100 px-2.5 py-1 font-medium text-slate-600">Falta la factura comercial</span>}
          {!checklist.tracking && <span className="rounded-full bg-slate-100 px-2.5 py-1 font-medium text-slate-600">Falta el tracking</span>}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Metric
          label="Productos"
          value={`${fmtInt(reception.ordered)} u.`}
          sub={reception.counted ? `${fmtInt(reception.good)} buenas al recibir` : `${items.length} productos`}
        />
        {summary ? (
          <>
            <Metric label="Costo total" value={fmtUsd(summary.totalUsd)} sub={summary.avgUnitUsd != null ? `${fmtUsdUnit(summary.avgUnitUsd)} por unidad buena` : undefined} />
            <Metric
              label="Pagado"
              value={fmtUsd(summary.paidUsd)}
              sub={summary.pendingUsd > 0 ? `Falta pagar ${fmtUsd(summary.pendingUsd)}` : "Pagado completo"}
              tone={summary.pendingUsd > 0 ? "warn" : "ok"}
            />
            <Metric
              label="Ganancia esperada"
              value={summary.expectedProfitPen != null ? fmtPen(summary.expectedProfitPen) : "—"}
              sub={
                summary.recoveryShare != null
                  ? `Recuperas lo invertido al vender el ${Math.min(999, Math.round(summary.recoveryShare * 100))} % de las unidades`
                  : fx
                    ? "Falta el precio de venta de algún producto"
                    : "Falta el tipo de cambio"
              }
            />
          </>
        ) : (
          <>
            <Metric label="Llegada" value={formatDmy(imp.arrived_on ?? imp.eta)} sub={imp.arrived_on ? "Llegó" : "Estimada"} tone={alerts.late ? "bad" : undefined} />
            <Metric label="Guía" value={imp.tracking_number ?? "—"} sub={imp.carrier ?? undefined} />
            <Metric label="Bodega" value={imp.reported_to_warehouse_at ? "Reportada" : "Sin avisar"} tone={alerts.notifyWarehouse ? "warn" : undefined} />
          </>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <StatusBox detail={detail} canEdit={canEdit} run={run} pending={pending} />
        {canEdit && <WarehouseBox detail={detail} trackingLink={trackingLink} run={run} pending={pending} />}
      </div>

      <ItemsBox detail={detail} stores={stores} storeName={storeName} landed={landed} fx={fx} canEdit={canEdit} run={run} pending={pending} />

      <ReceptionBox detail={detail} summary={reception} canEdit={canEdit} run={run} pending={pending} />

      {money && landed && (
        <LandedBox detail={detail} landed={landed} fx={fx} canEdit={canEdit} run={run} pending={pending} />
      )}

      {money && (
        <div className="grid gap-4 lg:grid-cols-2">
          <CostsBox detail={detail} canEdit={canEdit} run={run} pending={pending} />
          <PaymentsBox detail={detail} canEdit={canEdit} run={run} pending={pending} />
        </div>
      )}

      {money && plan && (
        <Box title="Pasar a Costos">
          <p className="text-xs text-slate-500">
            Lleva el costo aterrizado por unidad, en soles, de cada producto con SKU a Costos de productos: lote {imp.code}, vigente desde
            la llegada ({formatDmy(imp.arrived_on ?? limaToday())}). Cada producto se pasa una sola vez.
          </p>
          {plan.blockers.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-5 text-sm text-amber-800">
              {plan.blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          )}
          {plan.lines.length > 0 && (
            <ul className="divide-y divide-slate-100 text-sm">
              {plan.lines.map((l) => (
                <li key={l.itemId} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                  <span className="min-w-0 truncate text-slate-700">
                    {l.name} <span className="text-xs text-slate-400">SKU {l.sku} · {l.storeId ? (storeName.get(l.storeId) ?? "tienda") : "todas las tiendas"}</span>
                  </span>
                  <span className="text-xs">
                    {l.state === "push" && <span className="font-semibold text-slate-900">{fmtPen(l.unitCostPen)} por unidad</span>}
                    {l.state === "already" && <span className="text-emerald-700">Ya se pasó ({fmtDateTime(l.pushedAt)})</span>}
                    {l.state === "skip" && <span className="text-slate-500">{l.reason}</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {plan.alreadyDone ? (
            <p className="text-sm font-medium text-emerald-700">Ya se pasó a Costos.</p>
          ) : perms.canPushCosts ? (
            <button type="button" className={BTN_PRIMARY} disabled={pending || !plan.ready} onClick={() => run(() => pushImportCosts(imp.id))}>
              Pasar a Costos
            </button>
          ) : (
            <p className="text-xs text-slate-500">Pasar a Costos pide además el permiso «Editar costos».</p>
          )}
        </Box>
      )}

      <DocumentsBox detail={detail} canEdit={canEdit} run={run} pending={pending} setFeedback={setFeedback} />

      <Box title="Historial">
        {detail.events.length ? (
          <ol className="space-y-2">
            {detail.events.map((e) => (
              <li key={e.id} className="text-sm">
                <p className="text-xs text-slate-500">
                  {fmtDateTime(e.at)} · {e.by_name ?? "Kapta"}
                </p>
                <p className="text-slate-800">
                  {e.status ? <span className="font-semibold">{IMPORT_STATUS_LABEL[e.status]}</span> : null}
                  {e.status && e.note ? " · " : null}
                  {e.note}
                </p>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-slate-400">Sin movimientos.</p>
        )}
      </Box>

      {feedback && (feedback.error || feedback.notice) && (
        <div className="fixed inset-x-4 bottom-4 z-40 sm:left-auto sm:right-4 sm:w-96">
          <button type="button" className="w-full text-left" onClick={() => setFeedback(null)} aria-label="Cerrar aviso">
            <Feedback error={feedback.error} notice={feedback.notice} />
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function HeaderBox({ detail, canEdit, trackingLink }: { detail: ImportDetail; canEdit: boolean; trackingLink: string | null }) {
  const [editing, setEditing] = useState(false);
  const { imp, supplier } = detail;
  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-xs text-slate-500">
            <a href="/dashboard/compras" className="hover:underline">
              Compras
            </a>{" "}
            › Importación
          </p>
          <h1 className="flex flex-wrap items-center gap-2 text-lg font-semibold text-slate-900">
            {imp.code}
            <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">{IMPORT_STATUS_LABEL[imp.status]}</span>
          </h1>
          <p className="text-sm text-slate-700">
            {supplier?.name ?? "Sin proveedor"}
            {canEdit && supplier?.whatsapp ? (
              <>
                {" · "}
                <a href={whatsappShareUrl("", supplier.whatsapp)} target="_blank" rel="noopener noreferrer" className="text-brand-700 hover:underline">
                  WhatsApp
                </a>
              </>
            ) : null}
          </p>
          <p className="text-xs text-slate-500">
            {imp.origin ?? "Origen sin indicar"} → bodega de Kapta, Lima · {transportLabel(imp.transport)}
          </p>
        </div>
        {canEdit && !editing && (
          <button type="button" className={BTN_SECONDARY} onClick={() => setEditing(true)}>
            Editar datos
          </button>
        )}
      </div>
      {editing ? (
        <ImportHeaderForm orgId={imp.org_id} suppliers={detail.suppliers} imp={imp} onDone={() => setEditing(false)} />
      ) : (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-slate-500">Guía</dt>
            <dd className="truncate text-slate-800">
              {imp.carrier ? `${imp.carrier} ` : ""}
              {imp.tracking_number ? (
                trackingLink ? (
                  <a href={trackingLink} target="_blank" rel="noopener noreferrer" className="text-brand-700 hover:underline">
                    {imp.tracking_number}
                  </a>
                ) : (
                  imp.tracking_number
                )
              ) : (
                "—"
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">N.º de orden</dt>
            <dd className="truncate text-slate-800">{imp.platform_order ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Pedido</dt>
            <dd className="text-slate-800">{formatDmy(imp.ordered_on)}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">{imp.arrived_on ? "Llegó" : "Llegada estimada"}</dt>
            <dd className="text-slate-800">{formatDmy(imp.arrived_on ?? imp.eta)}</dd>
          </div>
          {imp.notes && (
            <div className="col-span-2 sm:col-span-4">
              <dt className="text-xs text-slate-500">Notas</dt>
              <dd className="whitespace-pre-line text-slate-800">{imp.notes}</dd>
            </div>
          )}
        </dl>
      )}
    </Card>
  );
}

function StatusBox({ detail, canEdit, run, pending }: { detail: ImportDetail; canEdit: boolean; run: Run; pending: boolean }) {
  const [status, setStatus] = useState<string>(detail.imp.status);
  const [note, setNote] = useState("");
  return (
    <Box title="Estado">
      <p className="text-sm text-slate-700">
        Ahora: <span className="font-semibold">{IMPORT_STATUS_LABEL[detail.imp.status]}</span>
      </p>
      {canEdit && (
        <div className="space-y-2">
          <select className={FIELD} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Nuevo estado">
            {IMPORT_STATUSES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
          <textarea className={FIELD} rows={2} placeholder="Nota (opcional): novedad del envío, motivo…" value={note} onChange={(e) => setNote(e.target.value)} />
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
    </Box>
  );
}

function WarehouseBox({ detail, trackingLink, run, pending }: { detail: ImportDetail; trackingLink: string | null; run: Run; pending: boolean }) {
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
    <Box
      title="Aviso a la bodega de Lima"
      right={
        imp.reported_to_warehouse_at ? (
          <span className="rounded bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">Reportada</span>
        ) : null
      }
    >
      <textarea className={cn(FIELD, "font-mono text-xs")} rows={7} readOnly value={message} aria-label="Mensaje para la bodega" />
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={BTN_SECONDARY}
          onClick={() => copy(message)}
        >
          {copyState === "ok" ? "Copiado" : copyState === "fail" ? "No se pudo copiar" : "Copiar mensaje"}
        </button>
        <a href={whatsappShareUrl(message)} target="_blank" rel="noopener noreferrer" className={BTN_SECONDARY}>
          Abrir WhatsApp
        </a>
        {imp.reported_to_warehouse_at ? (
          <button type="button" className={BTN_GHOST} disabled={pending} onClick={() => run(() => setWarehouseReported(imp.id, false))}>
            Quitar marca
          </button>
        ) : (
          <button type="button" className={BTN_PRIMARY} disabled={pending} onClick={() => run(() => setWarehouseReported(imp.id, true))}>
            Marcar como reportada
          </button>
        )}
      </div>
      {imp.reported_to_warehouse_at && (
        <p className="text-xs text-slate-500">
          Reportada {fmtDateTime(imp.reported_to_warehouse_at)}
          {detail.reportedByName ? ` por ${detail.reportedByName}` : ""}.
        </p>
      )}
    </Box>
  );
}

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

function ItemForm({
  importId,
  stores,
  money,
  item,
  run,
  pending,
  onDone,
}: {
  importId: string;
  stores: Store[];
  money: boolean;
  item?: ItemRow;
  run: Run;
  pending: boolean;
  onDone: () => void;
}) {
  const [d, setD] = useState<ItemDraft>(item ? itemDraft(item) : EMPTY_ITEM);
  const [photo, setPhoto] = useState<File | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const set = (k: keyof ItemDraft) => (e: { target: { value: string } }) => setD((x) => ({ ...x, [k]: e.target.value }));
  // Sin «Montos de compras» el formulario no manda costo ni precio (y el servidor no los leería).
  const payload = () => {
    const base = { name: d.name, sku: d.sku, storeId: d.storeId, qty: d.qty, unitWeightKg: d.unitWeightKg };
    return money ? { ...base, unitCostUsd: d.unitCostUsd, salePricePen: d.salePricePen } : base;
  };
  return (
    <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1 sm:col-span-2">
          <label className={LABEL}>Producto</label>
          <input className={FIELD} value={d.name} onChange={set("name")} />
        </div>
        <div className="space-y-1">
          <label className={LABEL}>SKU (para Costos)</label>
          <input className={FIELD} value={d.sku} onChange={set("sku")} />
        </div>
        <div className="space-y-1">
          <label className={LABEL}>Tienda</label>
          <select className={FIELD} value={d.storeId} onChange={set("storeId")}>
            <option value="">Todas las tiendas</option>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <label className={LABEL}>Cantidad</label>
          <input className={FIELD} inputMode="numeric" value={d.qty} onChange={set("qty")} />
        </div>
        <div className="space-y-1">
          <label className={LABEL}>Peso por unidad (kg)</label>
          <input className={FIELD} inputMode="decimal" value={d.unitWeightKg} onChange={set("unitWeightKg")} />
        </div>
        {money && (
          <>
            <div className="space-y-1">
              <label className={LABEL}>Costo por unidad (USD)</label>
              <input className={FIELD} inputMode="decimal" value={d.unitCostUsd} onChange={set("unitCostUsd")} />
            </div>
            <div className="space-y-1">
              <label className={LABEL}>Precio de venta (S/)</label>
              <input className={FIELD} inputMode="decimal" value={d.salePricePen} onChange={set("salePricePen")} />
            </div>
          </>
        )}
        {!item && (
          <div className="space-y-1 sm:col-span-2">
            <label className={LABEL}>Foto (opcional)</label>
            <input type="file" accept="image/jpeg,image/png,image/webp" className="block w-full text-sm" onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} />
          </div>
        )}
      </div>
      <Feedback error={uploadError} />
      <div className="flex gap-2">
        <button
          type="button"
          className={BTN_PRIMARY}
          disabled={pending}
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
  run,
  pending,
}: {
  detail: ImportDetail;
  stores: Store[];
  storeName: Map<string, string>;
  landed: ReturnType<typeof landedCosts> | null;
  fx: number | null;
  canEdit: boolean;
  run: Run;
  pending: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const money = detail.perms.canMoney;
  const editable = canEdit && detail.imp.status !== "cancelado";
  return (
    <Box
      title={`Productos (${detail.items.length})`}
      right={
        editable && !adding ? (
          <button type="button" className={BTN_SECONDARY} onClick={() => setAdding(true)}>
            Agregar producto
          </button>
        ) : null
      }
    >
      {adding && <ItemForm importId={detail.imp.id} stores={stores} money={money} run={run} pending={pending} onDone={() => setAdding(false)} />}
      {!detail.items.length && !adding && <p className="text-sm text-slate-400">Sin productos todavía.</p>}
      <ul className="divide-y divide-slate-100">
        {detail.items.map((it) => {
          const line = landed?.byItem.get(it.id);
          const margin = line && money ? marginOf(line.unitCost, fx, it.sale_price_pen, line.good) : null;
          if (editing === it.id) {
            return (
              <li key={it.id} className="py-2">
                <ItemForm importId={detail.imp.id} stores={stores} money={money} item={it} run={run} pending={pending} onDone={() => setEditing(null)} />
              </li>
            );
          }
          return (
            <li key={it.id} className="flex flex-wrap items-start gap-3 py-2.5">
              {it.image_path ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={`/api/compras/foto/${it.id}`} alt="" className="h-12 w-12 shrink-0 rounded-md border border-slate-200 object-cover" />
              ) : (
                <div className="h-12 w-12 shrink-0 rounded-md border border-dashed border-slate-200 bg-slate-50" />
              )}
              <div className="min-w-0 flex-1 space-y-0.5">
                <p className="text-sm font-medium text-slate-900">{it.name}</p>
                <p className="text-xs text-slate-500">
                  {it.sku ? `SKU ${it.sku}` : "Sin SKU"} · {it.store_id ? (storeName.get(it.store_id) ?? "Tienda") : "Todas las tiendas"}
                  {it.unit_weight_kg != null ? ` · ${it.unit_weight_kg} kg/u` : ""}
                </p>
                <p className="text-xs text-slate-600">
                  {fmtInt(it.qty)} u. pedidas
                  {it.received_qty != null ? ` · llegaron ${fmtInt(it.received_qty)}${it.damaged_qty ? ` (${fmtInt(it.damaged_qty)} dañadas)` : ""}` : " · sin contar"}
                  {it.cost_pushed_at ? <span className="text-emerald-700"> · en Costos</span> : null}
                </p>
                {money && (
                  <p className="text-xs text-slate-600">
                    Proveedor {fmtUsdUnit(it.unit_cost_usd)}/u
                    {line ? (
                      <>
                        {" · "}
                        <span className="font-semibold text-slate-900" title={`Producto ${fmtUsdUnit(line.perUnit.product)} + envío ${fmtUsdUnit(line.perUnit.envio)} + importación ${fmtUsdUnit(line.perUnit.importacion)} + adicional ${fmtUsdUnit(line.perUnit.adicional)}`}>
                          aterrizado {fmtUsdUnit(line.unitCost)}/u
                        </span>
                        {fx ? ` (${fmtPen(line.unitCost * fx)})` : ""}
                      </>
                    ) : null}
                    {it.sale_price_pen != null ? ` · venta ${fmtPen(it.sale_price_pen)}` : ""}
                    {margin ? (
                      <span className={margin.low ? "font-semibold text-red-700" : "text-emerald-700"}>
                        {" "}
                        · margen {fmtPen(margin.unit)} ({fmtPct(margin.pct)}){margin.low ? " · margen bajo" : ""}
                      </span>
                    ) : null}
                  </p>
                )}
                {it.reception_note && <p className="text-xs italic text-slate-500">Recepción: {it.reception_note}</p>}
              </div>
              {editable && (
                <div className="flex gap-1">
                  <button type="button" className={BTN_GHOST} onClick={() => setEditing(it.id)}>
                    Editar
                  </button>
                  <button
                    type="button"
                    className={BTN_DANGER}
                    disabled={pending}
                    onClick={() => {
                      if (window.confirm(`¿Quitar «${it.name}» de la importación?`)) run(() => removeImportItem(it.id));
                    }}
                  >
                    Quitar
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </Box>
  );
}

function ReceptionBox({
  detail,
  summary,
  canEdit,
  run,
  pending,
}: {
  detail: ImportDetail;
  summary: ReturnType<typeof receptionSummary>;
  canEdit: boolean;
  run: Run;
  pending: boolean;
}) {
  const [open, setOpen] = useState(false);
  const initial = () =>
    Object.fromEntries(
      detail.items.map((it) => [
        it.id,
        { received: it.received_qty == null ? "" : String(it.received_qty), damaged: it.damaged_qty ? String(it.damaged_qty) : "", note: it.reception_note ?? "" },
      ]),
    ) as Record<string, { received: string; damaged: string; note: string }>;
  const [draft, setDraft] = useState(initial);
  const editable = canEdit && detail.imp.status !== "cancelado" && detail.items.length > 0;
  const lastCount = detail.items.map((it) => it.received_at).filter(Boolean).sort().pop() ?? null;
  return (
    <Box
      title="Recepción en la bodega de Lima"
      right={
        editable && !open ? (
          <button
            type="button"
            className={BTN_SECONDARY}
            onClick={() => {
              setDraft(initial());
              setOpen(true);
            }}
          >
            {summary.counted ? "Editar recepción" : "Registrar recepción"}
          </button>
        ) : null
      }
    >
      <div className="grid grid-cols-3 gap-2 text-center sm:grid-cols-6">
        {[
          ["Pedidas", summary.ordered],
          ["Llegaron", summary.received],
          ["Faltan", summary.missing],
          ["Sobran", summary.extra],
          ["Dañadas", summary.damaged],
          ["Buenas", summary.good],
        ].map(([label, value]) => (
          <div key={label as string} className="rounded-lg bg-slate-50 px-2 py-1.5">
            <p className="text-[11px] text-slate-500">{label}</p>
            <p className="text-sm font-semibold text-slate-900">{fmtInt(value as number)}</p>
          </div>
        ))}
      </div>
      <p className="text-xs text-slate-500">
        {summary.counted === 0
          ? "Todavía no se contó nada."
          : summary.complete
            ? `Contada completa${lastCount ? ` · ${fmtDateTime(lastCount)}` : ""}.`
            : `Falta contar ${summary.uncounted} producto${summary.uncounted === 1 ? "" : "s"}.`}
        {summary.withDifferences.length ? ` ${summary.withDifferences.length} con diferencias.` : ""} Al guardar, si la importación estaba en
        camino pasa a Recibido.
      </p>
      {open && (
        <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
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
          {detail.items.map((it) => (
            <div key={it.id} className="grid gap-2 border-t border-slate-200 pt-2 sm:grid-cols-[minmax(0,2fr)_6rem_6rem_minmax(0,2fr)]">
              <p className="text-sm text-slate-800">
                {it.name} <span className="text-xs text-slate-500">· {fmtInt(it.qty)} pedidas</span>
              </p>
              <input
                className={FIELD}
                inputMode="numeric"
                placeholder="Llegaron"
                aria-label={`Llegaron de ${it.name}`}
                value={draft[it.id]?.received ?? ""}
                onChange={(e) => setDraft((d) => ({ ...d, [it.id]: { ...d[it.id]!, received: e.target.value } }))}
              />
              <input
                className={FIELD}
                inputMode="numeric"
                placeholder="Dañadas"
                aria-label={`Dañadas de ${it.name}`}
                value={draft[it.id]?.damaged ?? ""}
                onChange={(e) => setDraft((d) => ({ ...d, [it.id]: { ...d[it.id]!, damaged: e.target.value } }))}
              />
              <input
                className={FIELD}
                placeholder="Nota"
                aria-label={`Nota de ${it.name}`}
                value={draft[it.id]?.note ?? ""}
                onChange={(e) => setDraft((d) => ({ ...d, [it.id]: { ...d[it.id]!, note: e.target.value } }))}
              />
            </div>
          ))}
          <div className="flex gap-2">
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
    </Box>
  );
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
  landed: ReturnType<typeof landedCosts>;
  fx: number | null;
  canEdit: boolean;
  run: Run;
  pending: boolean;
}) {
  const [fxDraft, setFxDraft] = useState(fx == null ? "" : String(fx));
  return (
    <Box title="Costo aterrizado por unidad">
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <label className={LABEL}>Tipo de cambio (S/ por 1 USD)</label>
          <input className={cn(FIELD, "w-32")} inputMode="decimal" value={fxDraft} onChange={(e) => setFxDraft(e.target.value)} disabled={!canEdit} />
        </div>
        {canEdit && (
          <button type="button" className={BTN_SECONDARY} disabled={pending} onClick={() => run(() => setImportFx(detail.imp.id, fxDraft))}>
            Guardar tipo de cambio
          </button>
        )}
      </div>
      {landed.warnings.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-amber-800">
          {landed.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
              <th className="py-1.5 font-medium">Producto</th>
              <th className="py-1.5 text-right font-medium">Buenas</th>
              <th className="py-1.5 text-right font-medium">Proveedor/u</th>
              <th className="py-1.5 text-right font-medium">Envío/u</th>
              <th className="py-1.5 text-right font-medium">Importación/u</th>
              <th className="py-1.5 text-right font-medium">Adicional/u</th>
              <th className="py-1.5 text-right font-medium">Total/u</th>
              <th className="py-1.5 text-right font-medium">En soles</th>
            </tr>
          </thead>
          <tbody>
            {detail.items.map((it) => {
              const l = landed.byItem.get(it.id);
              if (!l) return null;
              return (
                <tr key={it.id} className="border-b border-slate-100 last:border-0">
                  <td className="py-1.5 text-slate-800">
                    {it.name}
                    {l.loss ? <span className="ml-1 text-xs text-red-700">pérdida</span> : null}
                  </td>
                  <td className="py-1.5 text-right">{fmtInt(l.good)}</td>
                  <td className="py-1.5 text-right">{fmtUsdUnit(l.perUnit.product)}</td>
                  <td className="py-1.5 text-right">{fmtUsdUnit(l.perUnit.envio)}</td>
                  <td className="py-1.5 text-right">{fmtUsdUnit(l.perUnit.importacion)}</td>
                  <td className="py-1.5 text-right">{fmtUsdUnit(l.perUnit.adicional)}</td>
                  <td className="py-1.5 text-right font-semibold text-slate-900">{fmtUsdUnit(l.unitCost)}</td>
                  <td className="py-1.5 text-right">{fx ? fmtPen(l.unitCost * fx) : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-500">
        Productos {fmtUsd(landed.productTotal)} + costos {fmtUsd(landed.costsTotal)} = {fmtUsd(landed.total)}. Los costos se reparten sobre lo
        pedido y el costo por unidad se divide entre las unidades buenas.
      </p>
    </Box>
  );
}

function CostsBox({ detail, canEdit, run, pending }: { detail: ImportDetail; canEdit: boolean; run: Run; pending: boolean }) {
  const [kind, setKind] = useState<string>("envio");
  const [label, setLabel] = useState("");
  const [amount, setAmount] = useState("");
  const [allocation, setAllocation] = useState<string>("units");
  const [itemId, setItemId] = useState("");
  const costs = detail.costs ?? [];
  const itemName = new Map(detail.items.map((it) => [it.id, it.name]));
  const byKind = COST_KINDS.map((k) => ({ ...k, total: costs.filter((c) => c.kind === k.id).reduce((a, c) => a + c.amount_usd, 0) }));
  return (
    <Box title="Costos a repartir (USD)">
      <p className="text-xs text-slate-500">{byKind.map((k) => `${k.label} ${fmtUsd(k.total)}`).join(" · ")}</p>
      <ul className="divide-y divide-slate-100 text-sm">
        {costs.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
            <span className="min-w-0">
              <span className="text-slate-800">{c.label}</span>{" "}
              <span className="text-xs text-slate-500">
                {costKindLabel(c.kind)} · {c.allocation === "item" ? (c.item_id ? `a ${itemName.get(c.item_id) ?? "un producto"}` : "su producto ya no está: por valor") : allocationLabel(c.allocation).toLowerCase()}
              </span>
            </span>
            <span className="flex items-center gap-2">
              <span className="font-medium">{fmtUsd(c.amount_usd)}</span>
              {canEdit && (
                <button type="button" className={BTN_GHOST} disabled={pending} onClick={() => run(() => removeImportCost(c.id))}>
                  Quitar
                </button>
              )}
            </span>
          </li>
        ))}
        {!costs.length && <li className="py-1.5 text-slate-400">Sin costos todavía.</li>}
      </ul>
      {canEdit && (
        <div className="grid gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 sm:grid-cols-2">
          <select className={FIELD} value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Tipo de costo">
            {COST_KINDS.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
          </select>
          <input className={FIELD} placeholder="Nombre (Flete DHL, aranceles…)" value={label} onChange={(e) => setLabel(e.target.value)} />
          <input className={FIELD} inputMode="decimal" placeholder="Monto USD" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <select className={FIELD} value={allocation} onChange={(e) => setAllocation(e.target.value)} aria-label="Reparto">
            {ALLOCATIONS.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
          {allocation === "item" && (
            <select className={cn(FIELD, "sm:col-span-2")} value={itemId} onChange={(e) => setItemId(e.target.value)} aria-label="Producto">
              <option value="">Elige el producto</option>
              {detail.items.map((it) => (
                <option key={it.id} value={it.id}>
                  {it.name}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            className={cn(BTN_PRIMARY, "sm:col-span-2")}
            disabled={pending}
            onClick={() =>
              run(
                () => addImportCost(detail.imp.id, { kind, label, amountUsd: amount, allocation, itemId }),
                () => {
                  setLabel("");
                  setAmount("");
                },
              )
            }
          >
            Agregar costo
          </button>
        </div>
      )}
    </Box>
  );
}

function PaymentsBox({ detail, canEdit, run, pending }: { detail: ImportDetail; canEdit: boolean; run: Run; pending: boolean }) {
  const [amount, setAmount] = useState("");
  const [paidOn, setPaidOn] = useState(limaToday());
  const [method, setMethod] = useState<string>("transferencia");
  const [note, setNote] = useState("");
  const [documentId, setDocumentId] = useState("");
  const payments = detail.payments ?? [];
  const vouchers = detail.documents.filter((d) => d.kind === "payment");
  return (
    <Box title="Pagos (USD)">
      <ul className="divide-y divide-slate-100 text-sm">
        {payments.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
            <span className="min-w-0 text-slate-800">
              {formatDmy(p.paid_on)} · {paymentMethodLabel(p.method)}
              {p.note ? <span className="text-xs text-slate-500"> · {p.note}</span> : null}
              {p.document_id ? (
                <a href={`/api/compras/documento/${p.document_id}`} target="_blank" rel="noopener noreferrer" className="ml-1 text-xs text-brand-700 hover:underline">
                  comprobante
                </a>
              ) : null}
            </span>
            <span className="flex items-center gap-2">
              <span className="font-medium">{fmtUsd(p.amount_usd)}</span>
              {canEdit && (
                <button type="button" className={BTN_GHOST} disabled={pending} onClick={() => run(() => removeImportPayment(p.id))}>
                  Quitar
                </button>
              )}
            </span>
          </li>
        ))}
        {!payments.length && <li className="py-1.5 text-slate-400">Sin pagos todavía.</li>}
      </ul>
      {canEdit && (
        <div className="grid gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 sm:grid-cols-2">
          <input className={FIELD} inputMode="decimal" placeholder="Monto USD" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <input type="date" className={FIELD} value={paidOn} onChange={(e) => setPaidOn(e.target.value)} aria-label="Fecha del pago" />
          <select className={FIELD} value={method} onChange={(e) => setMethod(e.target.value)} aria-label="Método">
            {PAYMENT_METHODS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          <select className={FIELD} value={documentId} onChange={(e) => setDocumentId(e.target.value)} aria-label="Comprobante">
            <option value="">Sin comprobante</option>
            {vouchers.map((d) => (
              <option key={d.id} value={d.id}>
                {d.filename ?? "Comprobante"}
              </option>
            ))}
          </select>
          <input className={cn(FIELD, "sm:col-span-2")} placeholder="Nota" value={note} onChange={(e) => setNote(e.target.value)} />
          <button
            type="button"
            className={cn(BTN_PRIMARY, "sm:col-span-2")}
            disabled={pending}
            onClick={() =>
              run(
                () => addImportPayment(detail.imp.id, { amountUsd: amount, paidOn, method, note, documentId }),
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
    </Box>
  );
}

function DocumentsBox({
  detail,
  canEdit,
  run,
  pending,
  setFeedback,
}: {
  detail: ImportDetail;
  canEdit: boolean;
  run: Run;
  pending: boolean;
  setFeedback: (f: ComprasActionState) => void;
}) {
  const money = detail.perms.canMoney;
  const kinds = DOC_KINDS.filter((k) => money || !MONEY_DOC_KINDS.includes(k.id));
  const [kind, setKind] = useState<string>("invoice");
  const [files, setFiles] = useState<File[]>([]);
  const [inputKey, setInputKey] = useState(0);
  const groups = kinds.map((k) => ({ ...k, docs: detail.documents.filter((d) => d.kind === k.id) })).filter((g) => g.docs.length);
  return (
    <Box title="Documentos">
      {!groups.length && <p className="text-sm text-slate-400">Sin documentos todavía.</p>}
      {groups.map((g) => (
        <div key={g.id} className="space-y-1">
          <p className="text-xs font-semibold text-slate-600">{g.label}</p>
          <ul className="space-y-1">
            {g.docs.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="min-w-0 truncate text-slate-800">
                  {d.filename ?? docKindLabel(d.kind)} <span className="text-xs text-slate-400">· {fmtBytes(d.size_bytes)} · {fmtDateTime(d.created_at)}</span>
                </span>
                <span className="flex items-center gap-1">
                  <a href={`/api/compras/documento/${d.id}`} target="_blank" rel="noopener noreferrer" className={BTN_GHOST}>
                    Ver
                  </a>
                  <a href={`/api/compras/documento/${d.id}?dl=1`} className={BTN_GHOST}>
                    Descargar
                  </a>
                  {canEdit && (
                    <button
                      type="button"
                      className={BTN_GHOST}
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
      {canEdit && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
          <select className={cn(FIELD, "sm:w-56")} value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Tipo de documento">
            {kinds.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
          </select>
          <input
            key={inputKey}
            type="file"
            multiple
            accept=".pdf,.jpg,.jpeg,.png,.webp,.xlsx,application/pdf,image/jpeg,image/png,image/webp"
            className="block min-w-0 flex-1 text-sm"
            onChange={(e) => setFiles(Array.from(e.target.files ?? []).slice(0, 10))}
          />
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
            Subir
          </button>
          <p className="w-full text-xs text-slate-500">PDF, JPG, PNG, WEBP o XLSX, hasta 25 MB. Hasta 10 por vez.</p>
        </div>
      )}
    </Box>
  );
}

