"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Card, cn, STICKY_HEAD, TABLE_WRAP_FROM } from "@/components/ui";
import { resolveDistrictAvailability, resolveDistrictTariff } from "@/lib/grupo-gf-courier";
import {
  activateGroupGfCourier,
  saveDistrictTariff,
  setDistrictAvailability,
  takeGroupGfCourierOrders,
  type CourierActionResult,
  type CourierConfigSnapshot,
  type CourierAgreementRow,
  type CourierAvailableOrder,
  type CourierAcceptedOrder,
  type PeruDistrictRow,
} from "@/app/dashboard/courier/actions";

function today(): string {
  const value = new Date();
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function money(value: number): string {
  return `S/ ${value.toFixed(2)}`;
}

export function GrupoGfCourierBoard({
  orgId,
  snapshot,
}: {
  orgId: string;
  snapshot: CourierConfigSnapshot;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [tab, setTab] = useState<"available" | "preparation" | "tariffs">("available");

  function run(action: () => Promise<CourierActionResult>) {
    startTransition(async () => {
      const result = await action();
      setError(result.error ?? null);
      setNotice(result.notice ?? null);
      if (!result.error) router.refresh();
    });
  }

  if (!snapshot.provider) {
    return (
      <div className="mx-auto max-w-4xl space-y-6">
        <header>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
            Operación logística
          </p>
          <h1 className="mt-1 text-xl font-semibold text-slate-950">Grupo GF Courier</h1>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">
            Activa el operador sin cambiar rutas ni inventario actuales. Se crearán los contratos
            de las tiendas activas, Yape 3.5 % y una bolsa de inventario todavía opcional.
          </p>
        </header>
        {error && <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
        <Card className="flex flex-col gap-5 p-6 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-sm font-semibold text-slate-900">Fundación lista para activar</p>
            <ul className="mt-2 space-y-1 text-sm text-slate-600">
              <li>Lima Metropolitana y Callao</li>
              <li>Corte del mismo día: 11:30</li>
              <li>Advertencia S/ 4,000; límite S/ 5,000</li>
            </ul>
          </div>
          <button
            type="button"
            disabled={pending}
            onClick={() => run(() => activateGroupGfCourier(orgId))}
            className="h-10 rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white transition hover:bg-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:opacity-50"
          >
            {pending ? "Activando…" : "Activar Grupo GF Courier"}
          </button>
        </Card>
      </div>
    );
  }

  const provider = snapshot.provider;
  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
            Operación logística
          </p>
          <h1 className="mt-1 text-xl font-semibold text-slate-950">Grupo GF Courier</h1>
          <p className="mt-1 max-w-3xl text-sm text-slate-600">
            Toma pedidos de Aurela y Kenku, prepara una sola caja y conserva el mismo QR hasta la entrega.
          </p>
        </div>
        <div className="grid grid-cols-3 divide-x divide-slate-200 rounded-xl border border-slate-200 bg-white px-1 py-3 text-sm shadow-sm">
          <Summary label="Corte" value={provider.same_day_cutoff.slice(0, 5)} />
          <Summary label="Yape" value={`${snapshot.yapePercentage} %`} />
          <Summary label="Efectivo máximo" value={money(provider.cash_limit_amount)} />
        </div>
      </header>

      <nav aria-label="Secciones de Grupo GF Courier" className="flex gap-1 border-b border-slate-200">
        <CourierTab
          active={tab === "available"}
          onClick={() => setTab("available")}
          label="Pedidos disponibles"
          count={snapshot.operations.available.length}
        />
        <CourierTab
          active={tab === "preparation"}
          onClick={() => setTab("preparation")}
          label="En preparación"
          count={snapshot.operations.accepted.length}
        />
        <CourierTab
          active={tab === "tariffs"}
          onClick={() => setTab("tariffs")}
          label="Tarifario"
        />
      </nav>

      {error && <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
      {notice && <p className="rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</p>}

      {tab === "available" && (
        <AvailableOrders
          orgId={orgId}
          orders={snapshot.operations.available}
          blockedCount={snapshot.operations.blockedCount}
          sourceCount={snapshot.operations.sourceCount}
          pending={pending}
          run={run}
        />
      )}
      {tab === "preparation" && (
        <AcceptedOrders orders={snapshot.operations.accepted} />
      )}
      {tab === "tariffs" && (
        <TariffMatrix
          orgId={orgId}
          snapshot={snapshot}
          pending={pending}
          error={null}
          notice={null}
          onSave={(input) => run(() => saveDistrictTariff(input))}
          onAvailability={(input) => run(() => setDistrictAvailability(input))}
        />
      )}
    </div>
  );
}

function CourierTab({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative min-h-11 px-3 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2",
        active ? "text-brand-700" : "text-slate-500 hover:text-slate-800",
      )}
    >
      {label}
      {count != null && (
        <span className={cn(
          "ml-2 rounded-full px-2 py-0.5 text-xs tabular-nums",
          active ? "bg-brand-50 text-brand-700" : "bg-slate-100 text-slate-600",
        )}>
          {count}
        </span>
      )}
      {active && <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-brand-600" />}
    </button>
  );
}

function AvailableOrders({
  orgId,
  orders,
  blockedCount,
  sourceCount,
  pending,
  run,
}: {
  orgId: string;
  orders: CourierAvailableOrder[];
  blockedCount: number;
  sourceCount: number;
  pending: boolean;
  run: (action: () => Promise<CourierActionResult>) => void;
}) {
  const searchParams = useSearchParams();
  const [query, setQuery] = useState(searchParams.get("pedido") ?? "");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("es");
    if (!needle) return orders;
    return orders.filter((order) =>
      `${order.orderId} ${order.orderName} ${order.customerName} ${order.customerPhone ?? ""} ${order.district} ${order.storeName}`
        .toLocaleLowerCase("es")
        .includes(needle),
    );
  }, [orders, query]);
  const visibleIds = filtered.map((order) => order.orderId);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));

  function toggle(orderId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(orderId)) next.delete(orderId);
      else next.add(orderId);
      return next;
    });
  }

  function take(ids: string[]) {
    if (!ids.length) return;
    setSelected(new Set());
    run(() => takeGroupGfCourierOrders(orgId, ids));
  }

  return (
    <section aria-labelledby="available-orders-title" className="space-y-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <h2 id="available-orders-title" className="text-base font-semibold text-slate-950">
            Pedidos listos para tomar
          </h2>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-600">
            Kapta los coloca aquí al entrar a Preparación. El rótulo y el QR se crean una sola vez cuando los tomas.
          </p>
          {sourceCount > 300 && (
            <p className="mt-1 text-xs text-slate-500">
              Hay {sourceCount.toLocaleString("es-PE")} pedidos en la cola fuente. Se muestran los 300 más recientes; al tomar una tanda entran los siguientes.
            </p>
          )}
          {blockedCount > 0 && (
            <p className="mt-1 text-xs text-amber-700">
              {blockedCount} pedido{blockedCount === 1 ? "" : "s"} no aparece{blockedCount === 1 ? "" : "n"} por tarifa faltante, distrito inválido o servicio pausado.
            </p>
          )}
        </div>
        <label className="text-xs font-medium text-slate-600">
          Buscar
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Pedido, cliente, teléfono o distrito"
            className="mt-1 block h-10 w-full min-w-72 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          />
        </label>
      </div>

      {selected.size > 0 && (
        <div className="sticky top-3 z-20 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-brand-200 bg-brand-50 px-4 py-3 shadow-sm">
          <p className="text-sm font-semibold text-brand-950">
            {selected.size} pedido{selected.size === 1 ? "" : "s"} seleccionado{selected.size === 1 ? "" : "s"}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="h-9 rounded-lg px-3 text-sm font-medium text-slate-600 hover:bg-white"
            >
              Limpiar
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => take([...selected])}
              className="h-9 rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white transition hover:bg-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:opacity-50"
            >
              {pending ? "Tomando pedidos…" : `Tomar ${selected.size} pedido${selected.size === 1 ? "" : "s"}`}
            </button>
          </div>
        </div>
      )}

      <div className={cn(TABLE_WRAP_FROM[980], "rounded-xl border border-slate-200 bg-white shadow-sm")}>
        <table className="w-full min-w-[980px] text-sm">
          <thead className={STICKY_HEAD}>
            <tr className="text-left text-xs text-slate-500">
              <th className="w-12 px-4 py-3">
                <input
                  type="checkbox"
                  aria-label="Seleccionar pedidos visibles"
                  checked={allVisibleSelected}
                  onChange={() => {
                    setSelected((current) => {
                      const next = new Set(current);
                      if (allVisibleSelected) visibleIds.forEach((id) => next.delete(id));
                      else visibleIds.forEach((id) => next.add(id));
                      return next;
                    });
                  }}
                />
              </th>
              <th className="px-3 py-3 font-medium">Pedido</th>
              <th className="px-3 py-3 font-medium">Cliente</th>
              <th className="px-3 py-3 font-medium">Destino</th>
              <th className="px-3 py-3 text-right font-medium">Venta</th>
              <th className="px-3 py-3 text-right font-medium">Tarifa</th>
              <th className="px-3 py-3 font-medium">Salida prevista</th>
              <th className="px-4 py-3 text-right font-medium">Acción</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((order) => (
              <tr key={order.orderId} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/70">
                <td className="px-4 py-3">
                  <input
                    type="checkbox"
                    aria-label={`Seleccionar ${order.orderName}`}
                    checked={selected.has(order.orderId)}
                    onChange={() => toggle(order.orderId)}
                  />
                </td>
                <td className="px-3 py-3">
                  <Link href={`/dashboard/pedidos?q=${encodeURIComponent(order.orderName)}`} className="font-semibold text-slate-950 hover:text-brand-700">
                    {order.orderName}
                  </Link>
                  <p className="mt-0.5 text-xs text-slate-500">{order.storeName}</p>
                </td>
                <td className="px-3 py-3">
                  <p className="font-medium text-slate-800">{order.customerName}</p>
                  <p className="mt-0.5 text-xs text-slate-500">{order.customerPhone ?? "Sin teléfono"}</p>
                </td>
                <td className="px-3 py-3 text-slate-700">{order.district}</td>
                <td className="px-3 py-3 text-right tabular-nums text-slate-700">{money(order.orderTotal)}</td>
                <td className="px-3 py-3 text-right font-semibold tabular-nums text-slate-900">{money(order.tariffAmount)}</td>
                <td className="px-3 py-3 text-slate-700">{formatDate(order.scheduledFor)}</td>
                <td className="px-4 py-3 text-right">
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => take([order.orderId])}
                    className="h-9 rounded-lg bg-slate-950 px-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-50"
                  >
                    Tomar pedido
                  </button>
                </td>
              </tr>
            ))}
            {!filtered.length && (
              <tr>
                <td colSpan={8} className="px-6 py-16 text-center">
                  <p className="font-medium text-slate-800">
                    {orders.length ? "Ningún pedido coincide con la búsqueda." : "No hay pedidos pendientes de admisión."}
                  </p>
                  <p className="mx-auto mt-1 max-w-xl text-sm text-slate-500">
                    Los pedidos Lima de Aurela y Kenku aparecerán aquí automáticamente al entrar a Preparación.
                  </p>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function preparationLabel(order: CourierAcceptedOrder): { label: string; tone: string } {
  if (order.requestStatus === "observed") return { label: "Requiere revisión", tone: "bg-red-50 text-red-700" };
  if (order.preparationState === "listo_despacho") return { label: "Listo para ruta", tone: "bg-emerald-50 text-emerald-700" };
  if (order.preparationState === "en_armado") return { label: "Armando", tone: "bg-sky-50 text-sky-700" };
  return { label: "Por armar", tone: "bg-amber-50 text-amber-700" };
}

function AcceptedOrders({ orders }: { orders: CourierAcceptedOrder[] }) {
  return (
    <section aria-labelledby="accepted-orders-title" className="space-y-4">
      <div>
        <h2 id="accepted-orders-title" className="text-base font-semibold text-slate-950">En preparación</h2>
        <p className="mt-1 text-sm text-slate-600">
          Cada pedido ya tiene solicitud, tarifa congelada y una sola salida física. Almacén continúa por escaneo.
        </p>
      </div>
      <div className={cn(TABLE_WRAP_FROM[980], "rounded-xl border border-slate-200 bg-white shadow-sm")}>
        <table className="w-full min-w-[880px] text-sm">
          <thead className={STICKY_HEAD}>
            <tr className="text-left text-xs text-slate-500">
              <th className="px-4 py-3 font-medium">Pedido</th>
              <th className="px-3 py-3 font-medium">Cliente</th>
              <th className="px-3 py-3 font-medium">Salida</th>
              <th className="px-3 py-3 font-medium">Estado</th>
              <th className="px-3 py-3 text-right font-medium">Tarifa</th>
              <th className="px-4 py-3 text-right font-medium">Siguiente paso</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((order) => {
              const status = preparationLabel(order);
              return (
                <tr key={order.requestId} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-3">
                    <Link href={`/dashboard/pedidos?q=${encodeURIComponent(order.orderName)}`} className="font-semibold text-slate-950 hover:text-brand-700">{order.orderName}</Link>
                    <p className="mt-0.5 text-xs text-slate-500">{order.storeName} · {order.district}</p>
                  </td>
                  <td className="px-3 py-3 text-slate-700">{order.customerName}</td>
                  <td className="px-3 py-3 font-mono text-xs font-semibold text-slate-700">{order.outputCode ?? "Generando…"}</td>
                  <td className="px-3 py-3">
                    <span className={cn("rounded-md px-2 py-1 text-xs font-semibold", status.tone)}>{status.label}</span>
                    {order.observation && <p className="mt-1 max-w-64 text-xs text-red-600">{order.observation}</p>}
                  </td>
                  <td className="px-3 py-3 text-right font-semibold tabular-nums text-slate-900">{money(order.tariffAmount)}</td>
                  <td className="px-4 py-3 text-right">
                    {order.shipmentId ? (
                      <Link href="/dashboard/pedidos/almacen" className="inline-flex h-9 items-center rounded-lg border border-slate-300 px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50">
                        Ir a Almacén
                      </Link>
                    ) : (
                      <span className="text-xs text-slate-500">Revisar solicitud</span>
                    )}
                  </td>
                </tr>
              );
            })}
            {!orders.length && (
              <tr><td colSpan={6} className="px-6 py-16 text-center text-sm text-slate-500">Todavía no hay pedidos tomados.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function TariffMatrix({
  orgId,
  snapshot,
  pending,
  error,
  notice,
  onSave,
  onAvailability,
}: {
  orgId: string;
  snapshot: CourierConfigSnapshot;
  pending: boolean;
  error: string | null;
  notice: string | null;
  onSave: (input: Parameters<typeof saveDistrictTariff>[0]) => void;
  onAvailability: (input: Parameters<typeof setDistrictAvailability>[0]) => void;
}) {
  const provider = snapshot.provider!;
  const [scope, setScope] = useState("general");
  const [query, setQuery] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState(today());
  const agreementId = scope === "general" ? null : scope;
  const districts = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("es");
    if (!needle) return snapshot.districts;
    return snapshot.districts.filter((district) =>
      `${district.district} ${district.province}`.toLocaleLowerCase("es").includes(needle),
    );
  }, [query, snapshot.districts]);
  const configured = snapshot.districts.filter(
    (district) =>
      resolveDistrictTariff(snapshot.tariffs, {
        providerId: provider.id,
        agreementId,
        districtKey: district.district_key,
        day: effectiveFrom,
      }).kind === "found",
  ).length;
  const paused = snapshot.districts.filter(
    (district) =>
      resolveDistrictAvailability(snapshot.availabilityEvents, {
        providerId: provider.id,
        agreementId,
        districtKey: district.district_key,
        day: today(),
      }).status === "paused",
  ).length;

  return (
    <div className="space-y-5">
      {error && <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
      {notice && <p className="rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</p>}

      <section aria-label="Filtros de tarifas" className="flex flex-col gap-3 border-y border-slate-200 py-4 md:flex-row md:items-end">
        <label className="text-xs font-medium text-slate-600">
          Tarifario
          <select
            value={scope}
            onChange={(event) => setScope(event.target.value)}
            className="mt-1 block h-10 min-w-56 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          >
            <option value="general">General de Grupo GF</option>
            {snapshot.agreements.map((agreement) => (
              <option key={agreement.id} value={agreement.id}>{agreement.client_label}</option>
            ))}
          </select>
        </label>
        <label className="min-w-0 flex-1 text-xs font-medium text-slate-600">
          Buscar distrito
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Ej. Miraflores o Callao"
            className="mt-1 block h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          />
        </label>
        <label className="text-xs font-medium text-slate-600">
          Ver y registrar desde
          <input
            type="date"
            value={effectiveFrom}
            onChange={(event) => setEffectiveFrom(event.target.value)}
            className="mt-1 block h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          />
        </label>
        <p className="pb-2 text-xs tabular-nums text-slate-500">
          {configured}/{snapshot.districts.length} configurados
          {paused > 0 && <span className="ml-2 font-medium text-amber-700">· {paused} pausado{paused === 1 ? "" : "s"}</span>}
        </p>
      </section>

      <div className={cn(TABLE_WRAP_FROM[980], "rounded-xl border border-slate-200 bg-white shadow-sm")}>
        <table className="w-full min-w-[980px] text-sm">
          <thead className={STICKY_HEAD}>
            <tr className="text-left text-xs text-slate-500">
              <th className="px-4 py-3 font-medium">Distrito</th>
              <th className="px-3 py-3 font-medium">Servicio</th>
              <th className="px-3 py-3 font-medium">Zona</th>
              <th className="px-3 py-3 text-right font-medium">Entrega o rechazo</th>
              <th className="px-3 py-3 font-medium">Origen</th>
              <th className="px-4 py-3 text-right font-medium">Acción</th>
            </tr>
          </thead>
          <tbody>
            {districts.map((district) => (
              <TariffRow
                key={`${scope}:${district.district_key}:${effectiveFrom}`}
                orgId={orgId}
                providerId={provider.id}
                agreementId={agreementId}
                agreement={snapshot.agreements.find((item) => item.id === agreementId) ?? null}
                district={district}
                tariffs={snapshot.tariffs}
                availabilityEvents={snapshot.availabilityEvents}
                effectiveFrom={effectiveFrom}
                pending={pending}
                onSave={onSave}
                onAvailability={onAvailability}
              />
            ))}
            {!districts.length && (
              <tr><td colSpan={6} className="px-4 py-10 text-center text-sm text-slate-500">Ningún distrito coincide con la búsqueda.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-4">
      <p className="text-[11px] text-slate-500">{label}</p>
      <p className="mt-0.5 whitespace-nowrap font-semibold tabular-nums text-slate-900">{value}</p>
    </div>
  );
}

function TariffRow({
  orgId,
  providerId,
  agreementId,
  agreement,
  district,
  tariffs,
  availabilityEvents,
  effectiveFrom,
  pending,
  onSave,
  onAvailability,
}: {
  orgId: string;
  providerId: string;
  agreementId: string | null;
  agreement: CourierAgreementRow | null;
  district: PeruDistrictRow;
  tariffs: CourierConfigSnapshot["tariffs"];
  availabilityEvents: CourierConfigSnapshot["availabilityEvents"];
  effectiveFrom: string;
  pending: boolean;
  onSave: (input: Parameters<typeof saveDistrictTariff>[0]) => void;
  onAvailability: (input: Parameters<typeof setDistrictAvailability>[0]) => void;
}) {
  const resolution = resolveDistrictTariff(tariffs, {
    providerId,
    agreementId,
    districtKey: district.district_key,
    day: effectiveFrom,
  });
  const tariff = resolution.kind === "found" ? resolution.tariff : null;
  const [zone, setZone] = useState(tariff?.zone ?? "");
  const [delivery, setDelivery] = useState(tariff ? String(tariff.delivery_amount) : "");
  const [showPauseForm, setShowPauseForm] = useState(false);
  const [pauseReason, setPauseReason] = useState("");
  const [pausedUntil, setPausedUntil] = useState("");
  const inherited = agreementId != null && resolution.kind === "found" && resolution.source === "general";
  const availability = resolveDistrictAvailability(availabilityEvents, {
    providerId,
    agreementId,
    districtKey: district.district_key,
    day: today(),
  });
  const inheritedPause =
    agreementId != null && availability.status === "paused" && availability.source === "general";

  return (
    <>
      <tr className={cn(
        "border-b border-slate-100 last:border-0 hover:bg-slate-50/60",
        availability.status === "paused" && "bg-amber-50/40 hover:bg-amber-50/60",
      )}>
        <td className="px-4 py-3">
          <p className="font-medium text-slate-900">{district.district}</p>
          <p className="text-xs text-slate-500">
            {district.province} · {district.order_count.toLocaleString("es-PE")} pedidos Lima
          </p>
        </td>
        <td className="px-3 py-3">
          {availability.status === "paused" ? (
            <div className="min-w-44 space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="rounded-md bg-amber-100 px-2 py-1 text-xs font-semibold text-amber-800">
                  {inheritedPause ? "Pausado general" : "Pausado"}
                </span>
                {!inheritedPause && (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => onAvailability({
                      orgId,
                      providerId,
                      agreementId,
                      districtKey: district.district_key,
                      status: "available",
                    })}
                    className="rounded-md px-1.5 py-1 text-xs font-semibold text-brand-700 transition hover:bg-brand-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-50"
                  >
                    Reactivar
                  </button>
                )}
              </div>
              <p className="max-w-52 truncate text-xs text-amber-800" title={availability.event.reason ?? undefined}>
                {availability.event.reason}
                {availability.event.paused_until && ` · hasta ${formatDate(availability.event.paused_until)}`}
              </p>
            </div>
          ) : (
            <button
              type="button"
              aria-expanded={showPauseForm}
              onClick={() => setShowPauseForm((current) => !current)}
              className="rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-xs font-semibold text-emerald-700 transition hover:border-emerald-300 hover:bg-emerald-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
            >
              Disponible · Pausar
            </button>
          )}
        </td>
        <td className="px-3 py-3">
          <input
            value={zone}
            onChange={(event) => setZone(event.target.value)}
            aria-label={`Zona de ${district.district}`}
            placeholder="Sin zona"
            className="h-9 w-40 rounded-lg border border-slate-200 bg-white px-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          />
        </td>
        <td className="px-3 py-3 text-right">
          <MoneyInput label={`Tarifa de entrega o rechazo en ${district.district}`} value={delivery} onChange={setDelivery} />
        </td>
        <td className="px-3 py-3">
          {resolution.kind === "missing" ? (
            <span className="rounded-md bg-amber-50 px-2 py-1 text-xs font-medium text-amber-700">Sin tarifa</span>
          ) : inherited ? (
            <span className="rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-600">Heredada de general</span>
          ) : (
            <span className="text-xs text-slate-500">{agreement?.client_label ?? "General"}</span>
          )}
        </td>
        <td className="px-4 py-3 text-right">
          <button
            type="button"
            disabled={pending || delivery.trim() === ""}
            onClick={() => onSave({
              orgId,
              providerId,
              agreementId,
              districtKey: district.district_key,
              zone,
              deliveryAmount: delivery,
              effectiveFrom,
            })}
            className="h-9 rounded-lg px-3 text-sm font-semibold text-brand-700 transition hover:bg-brand-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:text-slate-300"
          >
            {tariff && !inherited ? "Cambiar" : inherited ? "Crear excepción" : "Guardar"}
          </button>
        </td>
      </tr>
      {showPauseForm && availability.status === "available" && (
        <tr className="border-b border-amber-100 bg-amber-50/60">
          <td colSpan={6} className="px-4 py-3">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
              <label className="min-w-0 flex-1 text-xs font-medium text-slate-700">
                Motivo para pausar {district.district}
                <input
                  autoFocus
                  value={pauseReason}
                  onChange={(event) => setPauseReason(event.target.value)}
                  placeholder="Ej. Capacidad completa o zona temporalmente restringida"
                  className="mt-1 block h-10 w-full rounded-lg border border-amber-200 bg-white px-3 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-amber-500 focus:ring-2 focus:ring-amber-100"
                />
              </label>
              <label className="text-xs font-medium text-slate-700">
                Reactivar después de esta fecha (opcional)
                <input
                  type="date"
                  min={today()}
                  value={pausedUntil}
                  onChange={(event) => setPausedUntil(event.target.value)}
                  className="mt-1 block h-10 rounded-lg border border-amber-200 bg-white px-3 text-sm text-slate-900 outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-100"
                />
              </label>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={pending || pauseReason.trim().length < 4}
                  onClick={() => {
                    onAvailability({
                      orgId,
                      providerId,
                      agreementId,
                      districtKey: district.district_key,
                      status: "paused",
                      reason: pauseReason,
                      pausedUntil,
                    });
                    setShowPauseForm(false);
                  }}
                  className="h-10 rounded-lg bg-amber-600 px-4 text-sm font-semibold text-white transition hover:bg-amber-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 disabled:opacity-50"
                >
                  Confirmar pausa
                </button>
                <button
                  type="button"
                  onClick={() => setShowPauseForm(false)}
                  className="h-10 rounded-lg px-3 text-sm font-medium text-slate-600 transition hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
                >
                  Cancelar
                </button>
              </div>
            </div>
            <p className="mt-2 text-xs text-slate-600">
              Solo bloquea asignaciones nuevas. Las rutas que ya comenzaron continúan sin cambios.
            </p>
          </td>
        </tr>
      )}
    </>
  );
}

function formatDate(value: string): string {
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
}

function MoneyInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="relative inline-block">
      <span className="sr-only">{label}</span>
      <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-slate-400">S/</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        inputMode="decimal"
        aria-label={label}
        placeholder="0.00"
        className="h-9 w-24 rounded-lg border border-slate-200 bg-white pl-8 pr-2 text-right text-sm tabular-nums outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
      />
    </label>
  );
}
