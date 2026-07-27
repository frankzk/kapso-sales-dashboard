"use client";

// Pantalla del coordinador: armar la ruta del día, entregarla y cerrarla.
//
// El ciclo que la gobierna tiene tres puertas, y cada una existe por una razón:
//
//   planificada → el motorizado NO la ve. Se puede añadir y quitar paradas.
//   en_curso    → ya está en su teléfono. Lo que él reporta ya no se borra.
//   cerrada     → generó su liquidación. Se acabó.

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, EmptyState, Section, cn } from "@/components/ui";
import { NON_DELIVERY_REASONS, PAYMENT_METHODS, routeTotals } from "@/lib/routes";
import type { RouteRow, StopWithOrder } from "@/lib/routes-access";
import type { RiderRow } from "@/lib/settlements-access";
import {
  addStops,
  closeRoute,
  ensureRoute,
  linkRiderAccount,
  removeStop,
  startRoute,
} from "@/app/dashboard/rutas/actions";

interface StoreOpt {
  id: string;
  name: string;
}

interface Assignable {
  order_id: string;
  store_id: string;
  order_name: string | null;
  customer_name: string | null;
  district: string | null;
  address: string | null;
  order_total: number | null;
}

const money = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : `S/ ${n.toFixed(2)}`;

const ROUTE_STATUS: Record<string, { label: string; style: string }> = {
  planificada: { label: "Armando", style: "bg-slate-100 text-slate-600" },
  en_curso: { label: "En curso", style: "bg-sky-50 text-sky-700" },
  cerrada: { label: "Cerrada", style: "bg-slate-800 text-white" },
};

const reasonLabel = (code: string | null) =>
  NON_DELIVERY_REASONS.find((r) => r.code === code)?.label ?? code ?? "—";
const methodLabel = (code: string | null) =>
  PAYMENT_METHODS.find((m) => m.code === code)?.label ?? code ?? "—";

export function RoutesBoard({
  stores,
  riders,
  routes,
  detail,
  assignable,
  day,
}: {
  stores: StoreOpt[];
  riders: RiderRow[];
  routes: RouteRow[];
  detail: { route: RouteRow; stops: StopWithOrder[] } | null;
  assignable: Assignable[];
  day: string;
}) {
  const router = useRouter();
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const run = (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>) =>
    start(async () => {
      setErr(null);
      const res = await fn();
      if (!res.ok) setErr(res.error ?? "No se pudo completar.");
      else {
        setMsg(res.message ?? "Listo.");
        router.refresh();
      }
    });

  const riderName = (id: string) => riders.find((r) => r.id === id)?.full_name ?? "—";
  // Una ruta mezcla tiendas (0057), así que cada parada y cada pedido asignable
  // dicen de cuál son: sin eso el coordinador no sabe qué está cargando.
  const storeName = (id: string | null) => stores.find((s) => s.id === id)?.name ?? "—";

  return (
    <div className="space-y-6">
      <Section title="Rutas de reparto">
        <p className="text-sm text-slate-500">
          Arma la ruta del día de cada motorizado y entrégasela: le aparece en su teléfono, reporta
          cada entrega con su foto, y al cerrar el día la liquidación sale sola y ya cuadrada.
        </p>
      </Section>

      {msg && <Card className="border-brand-200 bg-brand-50 p-3 text-sm text-brand-800">{msg}</Card>}
      {err && <Card className="border-red-200 bg-red-50 p-3 text-sm text-red-700">{err}</Card>}

      <NewRoute stores={stores} riders={riders} day={day} disabled={pending} onRun={run} />

      <RidersAccess riders={riders} disabled={pending} onRun={run} />

      <Card className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
              <tr>
                <th className="px-4 py-2.5 font-medium">Fecha</th>
                <th className="px-4 py-2.5 font-medium">Motorizado</th>
                <th className="px-4 py-2.5 font-medium">Estado</th>
                <th className="px-4 py-2.5 font-medium">Liquidación</th>
              </tr>
            </thead>
            <tbody>
              {routes.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-10">
                    <EmptyState title="Todavía no hay rutas">
                      Arma la primera arriba, eligiendo motorizado y día.
                    </EmptyState>
                  </td>
                </tr>
              )}
              {routes.map((r) => {
                const open = detail?.route.id === r.id;
                const st = ROUTE_STATUS[r.status] ?? ROUTE_STATUS.planificada!;
                return (
                  <tr
                    key={r.id}
                    onClick={() =>
                      router.push(open ? "/dashboard/rutas" : `/dashboard/rutas?id=${r.id}&dia=${r.route_date}`)
                    }
                    className={cn(
                      "cursor-pointer border-b border-slate-100 hover:bg-slate-50",
                      open && "bg-slate-50",
                    )}
                  >
                    <td className="px-4 py-2.5 font-medium text-slate-800">{r.route_date}</td>
                    <td className="px-4 py-2.5 text-slate-700">{riderName(r.rider_id)}</td>
                    <td className="px-4 py-2.5">
                      <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", st.style)}>
                        {st.label}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-slate-500">
                      {r.settlement_id ? "Creada" : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {detail && (
        <RouteDetail
          detail={detail}
          assignable={assignable}
          riderName={riderName(detail.route.rider_id)}
          storeName={storeName}
          disabled={pending}
          onRun={run}
        />
      )}
    </div>
  );
}

function NewRoute({
  stores,
  riders,
  day,
  disabled,
  onRun,
}: {
  stores: StoreOpt[];
  riders: RiderRow[];
  day: string;
  disabled: boolean;
  onRun: (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>) => void;
}) {
  const router = useRouter();
  const [storeId, setStoreId] = useState(stores[0]?.id ?? "");
  const [riderId, setRiderId] = useState(riders[0]?.id ?? "");
  const [date, setDate] = useState(day);

  return (
    <Card className="space-y-3 p-4">
      <h3 className="text-sm font-semibold text-slate-800">Armar la ruta del día</h3>
      <p className="text-xs text-slate-500">
        Una ruta por motorizado y día. Puede llevar pedidos de varias tiendas en el mismo viaje: al
        cerrarla sale una liquidación por cada tienda, porque el dinero se cuadra por separado.
      </p>
      {riders.length === 0 ? (
        <p className="text-sm text-slate-500">
          Primero da de alta a tus motorizados en Liquidaciones; luego aquí les armas la ruta.
        </p>
      ) : (
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
          <button
            disabled={disabled || !storeId || !riderId}
            onClick={() =>
              onRun(async () => {
                const res = await ensureRoute({ storeId, riderId, routeDate: date });
                if (res.ok && res.routeId) {
                  router.push(`/dashboard/rutas?id=${res.routeId}&dia=${date}`);
                }
                return res;
              })
            }
            className="rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
          >
            Abrir ruta
          </button>
        </div>
      )}
    </Card>
  );
}

/** Alta de acceso web: el motorizado necesita un correo para entrar a /reparto. */
function RidersAccess({
  riders,
  disabled,
  onRun,
}: {
  riders: RiderRow[];
  disabled: boolean;
  onRun: (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>) => void;
}) {
  const [riderId, setRiderId] = useState("");
  const [email, setEmail] = useState("");
  if (!riders.length) return null;

  return (
    <Card className="space-y-2 p-4">
      <h3 className="text-sm font-semibold text-slate-800">Dar acceso a un motorizado</h3>
      <p className="text-xs text-slate-500">
        Con su correo entra a <strong className="text-slate-700">/reparto</strong> con enlace
        mágico, igual que el equipo. Solo ve sus propias rutas, y solo cuando se las entregas.
      </p>
      <div className="flex flex-wrap gap-2">
        <select
          value={riderId}
          onChange={(e) => setRiderId(e.target.value)}
          className="rounded-lg border border-slate-300 px-2 py-2 text-sm"
        >
          <option value="">Elige el motorizado</option>
          {riders.map((r) => (
            <option key={r.id} value={r.id}>
              {r.full_name}
            </option>
          ))}
        </select>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="correo@ejemplo.com"
          className="w-56 rounded-lg border border-slate-300 px-2 py-2 text-sm"
        />
        <button
          disabled={disabled || !riderId || !email.trim()}
          onClick={() =>
            onRun(async () => {
              const res = await linkRiderAccount(riderId, email);
              if (res.ok) setEmail("");
              return res;
            })
          }
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          Dar acceso
        </button>
      </div>
    </Card>
  );
}

function RouteDetail({
  detail,
  assignable,
  riderName,
  storeName,
  disabled,
  onRun,
}: {
  detail: { route: RouteRow; stops: StopWithOrder[] };
  assignable: Assignable[];
  riderName: string;
  storeName: (id: string | null) => string;
  disabled: boolean;
  onRun: (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>) => void;
}) {
  const { route, stops } = detail;
  const totals = useMemo(() => routeTotals(stops), [stops]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");

  const planning = route.status === "planificada";
  const closed = route.status === "cerrada";

  const visible = assignable.filter((o) => {
    if (!filter.trim()) return true;
    const q = filter.toLowerCase();
    return (
      (o.customer_name ?? "").toLowerCase().includes(q) ||
      (o.district ?? "").toLowerCase().includes(q) ||
      (o.order_name ?? "").toLowerCase().includes(q)
    );
  });

  return (
    <Card className="space-y-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-800">
          {riderName} · {route.route_date}
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          {planning && (
            <button
              disabled={disabled || !stops.length}
              onClick={() => onRun(() => startRoute(route.id))}
              className="rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-50"
            >
              Entregar la ruta
            </button>
          )}
          {route.status === "en_curso" && (
            <>
              <button
                disabled={disabled}
                onClick={() => onRun(() => closeRoute(route.id))}
                className="rounded-lg bg-slate-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-900 disabled:opacity-50"
              >
                Cerrar y liquidar
              </button>
              {totals.pendientes > 0 && (
                <button
                  disabled={disabled}
                  onClick={() => {
                    if (
                      !confirm(
                        `Quedan ${totals.pendientes} parada(s) sin reportar. Se cerrará igual y esas paradas no entrarán en la liquidación. ¿Seguro?`,
                      )
                    )
                      return;
                    onRun(() => closeRoute(route.id, { force: true }));
                  }}
                  className="text-xs text-red-600 underline hover:text-red-700 disabled:opacity-50"
                >
                  Cerrar con paradas sin reportar
                </button>
              )}
            </>
          )}
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Tile label="Paradas" value={String(totals.total)} />
        <Tile label="Entregadas" value={String(totals.entregados)} tone="good" />
        <Tile label="No entregadas" value={String(totals.noEntregados)} tone="bad" />
        <Tile label="Sin reportar" value={String(totals.pendientes)} />
        <Tile label="Efectivo" value={money(totals.efectivo)} />
        <Tile label="Yape / POS" value={`${money(totals.yape)} / ${money(totals.pos)}`} />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="border-b border-slate-200 text-left text-xs text-slate-500">
            <tr>
              <th className="px-3 py-2 font-medium">#</th>
              <th className="px-3 py-2 font-medium">Cliente</th>
              <th className="px-3 py-2 font-medium">Tienda</th>
              <th className="px-3 py-2 font-medium">Distrito</th>
              <th className="px-3 py-2 font-medium">Pedido</th>
              <th className="px-3 py-2 font-medium">Resultado</th>
              <th className="px-3 py-2 font-medium">Cobró</th>
              <th className="px-3 py-2 font-medium">Respaldo</th>
              {planning && <th className="px-3 py-2 font-medium" />}
            </tr>
          </thead>
          <tbody>
            {stops.map((s) => (
              <tr key={s.id} className="border-b border-slate-100">
                <td className="px-3 py-2 text-slate-400">{s.seq}</td>
                <td className="px-3 py-2 text-slate-700">{s.order?.customer_name ?? "—"}</td>
                <td className="px-3 py-2 text-slate-500">{storeName(s.store_id)}</td>
                <td className="px-3 py-2 text-slate-500">{s.order?.district ?? "—"}</td>
                <td className="px-3 py-2 text-slate-500">{s.order?.name ?? "—"}</td>
                <td className="px-3 py-2">
                  {s.status === "pendiente" ? (
                    <span className="text-xs text-slate-400">Sin reportar</span>
                  ) : s.status === "entregado" ? (
                    <span className="text-xs font-medium text-emerald-700">
                      Entregado · {methodLabel(s.payment_method)}
                    </span>
                  ) : (
                    <span className="text-xs font-medium text-red-700">
                      No entregado · {reasonLabel(s.outcome_reason)}
                    </span>
                  )}
                  {s.note && <p className="text-[11px] text-slate-400">{s.note}</p>}
                </td>
                <td className="px-3 py-2 text-slate-700">
                  {s.status === "entregado" ? money(s.collected_amount) : "—"}
                </td>
                <td className="px-3 py-2 text-xs text-slate-500">
                  {s.photo_path ? "📷" : "—"} {s.voucher_path ? "🧾" : ""}
                </td>
                {planning && (
                  <td className="px-3 py-2 text-right">
                    <button
                      disabled={disabled}
                      onClick={() => onRun(() => removeStop(s.id))}
                      className="text-xs text-slate-500 underline hover:text-red-600 disabled:opacity-50"
                    >
                      Quitar
                    </button>
                  </td>
                )}
              </tr>
            ))}
            {stops.length === 0 && (
              <tr>
                <td colSpan={9} className="px-3 py-6 text-center text-sm text-slate-500">
                  Esta ruta no tiene paradas. Añádelas abajo.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {!closed && (
        <div className="space-y-2 border-t border-slate-100 pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-medium text-slate-700">Añadir paradas</h4>
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filtrar por cliente, distrito o pedido"
              className="flex-1 rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
            />
            <button
              disabled={disabled || picked.size === 0}
              onClick={() =>
                onRun(async () => {
                  const res = await addStops(route.id, [...picked]);
                  if (res.ok) setPicked(new Set());
                  return res;
                })
              }
              className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
            >
              Añadir {picked.size > 0 ? `(${picked.size})` : ""}
            </button>
          </div>
          <div className="max-h-72 overflow-y-auto rounded-lg border border-slate-200">
            {visible.length === 0 && (
              <p className="p-4 text-center text-sm text-slate-500">
                No hay pedidos sin asignar para ese día.
              </p>
            )}
            {visible.map((o) => (
              <label
                key={o.order_id}
                className="flex cursor-pointer items-center gap-2 border-b border-slate-100 px-3 py-2 text-sm last:border-0 hover:bg-slate-50"
              >
                <input
                  type="checkbox"
                  checked={picked.has(o.order_id)}
                  onChange={(e) => {
                    const next = new Set(picked);
                    if (e.target.checked) next.add(o.order_id);
                    else next.delete(o.order_id);
                    setPicked(next);
                  }}
                />
                <span className="flex-1 truncate text-slate-700">
                  {o.customer_name ?? "Sin nombre"}
                  <span className="ml-1.5 text-xs text-slate-400">
                    {storeName(o.store_id)} · {o.district ?? "—"} · {o.order_name ?? "—"}
                  </span>
                </span>
                <span className="text-slate-600">{money(o.order_total)}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      {closed && (
        <p className="border-t border-slate-100 pt-3 text-xs text-slate-500">
          Ruta cerrada. Su liquidación está en{" "}
          <a href="/dashboard/liquidaciones" className="font-medium text-brand-700 underline">
            Liquidaciones
          </a>
          , ya con todas las líneas vinculadas.
        </p>
      )}
    </Card>
  );
}

function Tile({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" }) {
  return (
    <div className="rounded-lg border border-slate-200 p-2.5">
      <p className="text-[11px] text-slate-500">{label}</p>
      <p
        className={cn(
          "mt-0.5 text-sm font-semibold",
          tone === "good" ? "text-emerald-700" : tone === "bad" ? "text-red-600" : "text-slate-800",
        )}
      >
        {value}
      </p>
    </div>
  );
}
