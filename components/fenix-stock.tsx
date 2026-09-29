"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { Card, cn, OVER_TABLE_Z, STICKY_HEAD, TABLE_WRAP } from "@/components/ui";
import { FENIX_CITIES } from "@/lib/shipments";
import type { DemandRow } from "@/lib/fenix-demand";
import type { FenixStockRowDb, StoreSummary } from "@/lib/types";
import type { BodegaSwaypResumen } from "@/lib/swayp-guide";
import { ciudadSinControl, sinControlDeCantidad } from "@/lib/fenix";
import {
  deleteFenixStock,
  getFenixStockMovements,
  importarInventarioSwayp,
  recomputeFenixEligibility,
  recordFenixStockMovement,
  searchStockProducts,
  swaypInventoryDryRun,
  swaypInventoryEstado,
  swaypInventorySync,
  type SwaypSyncEstado,
  upsertFenixStock,
  type DryRunResult,
} from "@/app/dashboard/envios/actions";
import { STOCK_MOVEMENT_LABEL, type StockMovementKind } from "@/lib/fenix-ledger";
import type { SyncResult } from "@/lib/swayp-inventory-sync";

type ProductResult = Awaited<ReturnType<typeof searchStockProducts>>[number];

export function FenixStockEditor({
  rows,
  canEdit,
  stores,
  demand = [],
  bodegas = [],
}: {
  rows: FenixStockRowDb[];
  canEdit: boolean;
  stores: StoreSummary[];
  demand?: DemandRow[];
  bodegas?: BodegaSwaypResumen[];
}) {
  const router = useRouter();
  const [storeId, setStoreId] = useState<string>(stores[0]?.id ?? "");
  const [city, setCity] = useState<string>(FENIX_CITIES[0] ?? "cusco");
  const [product, setProduct] = useState("");
  const [sku, setSku] = useState<string | null>(null);
  const [quantity, setQuantity] = useState("0");
  // Sin control de cantidad (Lima): el producto existe en la bodega y no se
  // cuenta. Se recuerda entre altas porque se cargan de a muchos.
  const [unlimited, setUnlimited] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [cityFilter, setCityFilter] = useState<string | null>(null); // null = todas
  const [kardexRow, setKardexRow] = useState<FenixStockRowDb | null>(null);

  // Provincias presentes en el inventario, para el filtro.
  const cityOptions = Array.from(new Set(rows.map((r) => r.city))).sort((a, b) => a.localeCompare(b));
  const visibleRows = cityFilter ? rows.filter((r) => r.city === cityFilter) : rows;

  function add() {
    start(async () => {
      const libre = unlimited || ciudadSinControl(city);
      const r = await upsertFenixStock({
        city,
        product,
        quantity: libre ? 0 : Number(quantity) || 0,
        sku,
        unlimited: libre,
      });
      setMsg(r.error ?? r.notice ?? null);
      if (!r.error) {
        setProduct("");
        setSku(null);
        setQuantity("0");
        router.refresh();
      }
    });
  }

  function remove(id: string) {
    start(async () => {
      await deleteFenixStock(id);
      router.refresh();
    });
  }

  function recompute() {
    start(async () => {
      const r = await recomputeFenixEligibility();
      setMsg("error" in r ? r.error : r.notice);
      if (!("error" in r)) router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold text-slate-900">Stock Fenix por ciudad</h1>
        <div className="flex items-center gap-3">
          {canEdit && (
            <button
              onClick={recompute}
              disabled={pending}
              className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50"
            >
              Recalcular elegibilidad
            </button>
          )}
          <a href="/dashboard/envios" className="text-sm text-brand-700 hover:underline">
            ← Volver a Repro Provincia
          </a>
        </div>
      </div>

      <DemandReport demand={demand} />

      {!canEdit && (
        <Card>
          <p className="text-sm text-amber-700">
            Solo un administrador puede editar el stock. Lo ves en modo lectura.
          </p>
        </Card>
      )}

      {canEdit && <BodegasSwayp bodegas={bodegas} />}

      {canEdit && <ImportarDeSwayp onDone={(m) => setMsg(m)} />}
      {canEdit && <DryRunSwayp />}

      {canEdit && (
        <Card className="space-y-3">
          <p className="text-sm font-medium text-slate-800">Agregar / actualizar</p>
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <label className="block text-xs text-slate-400">Tienda</label>
              <select
                value={storeId}
                onChange={(e) => {
                  setStoreId(e.target.value);
                  setProduct(""); // catalog changes → reset the picked product
                  setSku(null);
                }}
                className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm"
              >
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-400">Ciudad</label>
              <select
                value={city}
                onChange={(e) => setCity(e.target.value)}
                className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm capitalize"
              >
                {FENIX_CITIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div className="min-w-[16rem] flex-1">
              <label className="block text-xs text-slate-400">Producto</label>
              <ProductCombobox
                storeId={storeId}
                value={product}
                onChange={(p, s) => {
                  setProduct(p);
                  setSku(s);
                }}
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400">Cantidad</label>
              <input
                type="number"
                min={0}
                value={unlimited || ciudadSinControl(city) ? "" : quantity}
                placeholder={unlimited || ciudadSinControl(city) ? "∞" : undefined}
                disabled={unlimited || ciudadSinControl(city)}
                onChange={(e) => setQuantity(e.target.value)}
                className="w-24 rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm disabled:bg-slate-50 disabled:text-slate-400"
              />
            </div>
            <label
              className="flex items-center gap-1.5 self-end pb-1.5 text-xs text-slate-600"
              title={
                ciudadSinControl(city)
                  ? `${city} no lleva control de cantidad: todo producto anotado vale como disponible.`
                  : "El producto existe en la bodega y no se cuenta: siempre disponible, la entrega no descuenta y el Excel no lo toca."
              }
            >
              <input
                type="checkbox"
                checked={unlimited || ciudadSinControl(city)}
                disabled={ciudadSinControl(city)}
                onChange={(e) => setUnlimited(e.target.checked)}
                className="rounded border-slate-300"
              />
              {ciudadSinControl(city) ? "Sin control de cantidad (regla de la ciudad)" : "Sin control de cantidad"}
            </label>
            <button
              onClick={add}
              disabled={pending || !product.trim()}
              className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
            >
              Guardar
            </button>
          </div>
          {ciudadSinControl(city) && (
            <p className="text-xs text-amber-700">
              <span className="capitalize">{city}</span> no usa esta tabla: todo producto pasa la reja de
              stock, y el vínculo en Catálogo de productos se exige al crear la guía. Anotar renglones acá
              es opcional y sólo informativo.
            </p>
          )}
          {msg && <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">{msg}</p>}
        </Card>
      )}

      <Card className="p-0">
        {rows.length === 0 ? (
          <p className="p-5 text-sm text-slate-400">Sin stock registrado.</p>
        ) : (
          <>
            {cityOptions.length > 1 && (
              <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-200 px-4 py-2.5">
                <span className="text-xs text-slate-400">Provincia:</span>
                <button
                  type="button"
                  onClick={() => setCityFilter(null)}
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-xs font-medium capitalize transition",
                    cityFilter === null
                      ? "border-brand-200 bg-brand-50 text-brand-700"
                      : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50",
                  )}
                >
                  Todas
                </button>
                {cityOptions.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setCityFilter(c)}
                    className={cn(
                      "rounded-full border px-2.5 py-1 text-xs font-medium capitalize transition",
                      cityFilter === c
                        ? "border-brand-200 bg-brand-50 text-brand-700"
                        : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50",
                    )}
                  >
                    {c}
                  </button>
                ))}
                <span className="ml-auto text-xs text-slate-400">
                  {visibleRows.length} producto(s) ·{" "}
                  {visibleRows.filter((r) => !sinControlDeCantidad(r)).reduce((n, r) => n + r.quantity, 0)} u.
                  {visibleRows.some(sinControlDeCantidad) &&
                    ` · ${visibleRows.filter(sinControlDeCantidad).length} sin control`}
                </span>
              </div>
            )}
          <div className={TABLE_WRAP}>
            <table className="w-full text-sm">
              <thead className={STICKY_HEAD}>
                <tr className="text-xs text-slate-500">
                  <th className="px-4 py-2.5 text-left font-medium">Ciudad</th>
                  <th className="px-4 py-2.5 text-left font-medium">Producto</th>
                  <th className="px-4 py-2.5 text-right font-medium">Saldo</th>
                  <th className="px-4 py-2.5"></th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((r) => (
                  <tr key={r.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-4 py-2.5 capitalize text-slate-700">{r.city}</td>
                    <td className="px-4 py-2.5 text-slate-700">{r.product}</td>
                    <td
                      className={cn(
                        "px-4 py-2.5 text-right font-medium tabular-nums",
                        sinControlDeCantidad(r) ? "text-slate-400" : r.quantity < 0 ? "text-rose-600" : "text-slate-700",
                      )}
                      title={sinControlDeCantidad(r) ? "Sin control de cantidad" : undefined}
                    >
                      {sinControlDeCantidad(r) ? "∞" : r.quantity}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <div className="flex justify-end gap-3">
                        {!sinControlDeCantidad(r) && (
                          <button
                            onClick={() => setKardexRow(r)}
                            className="text-xs text-brand-700 hover:underline"
                          >
                            Movimientos
                          </button>
                        )}
                        {canEdit && (
                          <button
                            onClick={() => remove(r.id)}
                            disabled={pending}
                            className="text-xs text-rose-600 hover:underline"
                          >
                            Eliminar
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </>
        )}
      </Card>

      {kardexRow && (
        <StockKardexModal row={kardexRow} canEdit={canEdit} onClose={() => setKardexRow(null)} onChanged={() => router.refresh()} />
      )}
    </div>
  );
}

const DEMAND_BADGE: Record<string, string> = {
  sin_stock: "bg-rose-50 text-rose-700",
  reponer: "bg-amber-50 text-amber-700",
  ok: "bg-emerald-50 text-emerald-700",
};
const DEMAND_LABEL: Record<string, string> = {
  sin_stock: "Sin stock",
  reponer: "Reponer",
  ok: "OK",
};

/**
 * Demand-vs-stock report: what pending guides need in each province vs. what's
 * in stock. Rows needing action (shortfall > 0) float to the top, so the list
 * doubles as the "prepare & send" checklist. Recomputed on every page load, so
 * it tracks the queue as order states change.
 */
/**
 * Qué bodegas ve la app en `SWAYP_SENDERS`, ciudad por ciudad.
 *
 * La variable es Secret en Vercel —de sólo escritura— y una ciudad mal escrita
 * se descarta en silencio. Sin este cuadro, la única forma de saber qué había
 * configurado era editar a ciegas y ver si Arequipa seguía emitiendo. Muestra
 * los datos completos porque son los de nuestras bodegas, no credenciales: es
 * exactamente lo que hay que copiar para reescribir la variable sin perder
 * nada.
 */
function BodegasSwayp({ bodegas }: { bodegas: BodegaSwaypResumen[] }) {
  if (!bodegas.length) return null;
  const porApi = bodegas.filter((b) => b.porApi).length;
  return (
    <Card className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-medium text-slate-800">Bodegas Swayp configuradas</p>
        <p className="text-xs text-slate-500">
          {porApi} de {bodegas.length} ciudades emiten por API
        </p>
      </div>
      <div className={TABLE_WRAP}>
        <table className="w-full text-xs">
          <thead className={STICKY_HEAD}>
            <tr className="text-left text-slate-500">
              <th className="py-1 pr-3 font-medium">Ciudad</th>
              <th className="py-1 pr-3 font-medium">Estado</th>
              <th className="py-1 pr-3 font-medium">Nombre</th>
              <th className="py-1 pr-3 font-medium">Dirección</th>
              <th className="py-1 pr-3 font-medium">Teléfono</th>
              <th className="py-1 pr-3 font-medium">Email</th>
              <th className="py-1 pr-3 font-medium">RUC</th>
              <th className="py-1 font-medium">idWarehouse</th>
            </tr>
          </thead>
          <tbody>
            {bodegas.map((b) => (
              <tr key={b.city} className="border-t border-slate-100">
                <td className="py-1 pr-3 font-medium capitalize text-slate-800">{b.city}</td>
                <td className="py-1 pr-3">
                  {b.porApi ? (
                    <span className="text-emerald-700">por API</span>
                  ) : b.configurada ? (
                    <span className="text-amber-700">configurada, sin ubigeo</span>
                  ) : (
                    <span className="text-slate-400">sin bodega → Excel</span>
                  )}
                </td>
                <td className="py-1 pr-3 text-slate-700">{b.nombre ?? "—"}</td>
                <td className="py-1 pr-3 text-slate-700">{b.direccion ?? "—"}</td>
                <td className="py-1 pr-3 font-mono text-slate-700">{b.telefono ?? "—"}</td>
                <td className="py-1 pr-3 text-slate-700">{b.email ?? "—"}</td>
                <td className="py-1 pr-3 font-mono text-slate-700">
                  {b.nit === null ? "—" : b.nit === "" ? <span className="text-slate-400">vacío</span> : b.nit}
                </td>
                <td className="py-1 font-mono text-slate-700">{b.idWarehouse ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/**
 * Subir el "Inventario por bodega" que exporta Swayp y dejar esa ciudad igual
 * que allá.
 *
 * VA ARRIBA DEL FORMULARIO MANUAL a propósito: el conteo de Swayp es la verdad
 * y la carga a mano el parche. Cuando el orden era al revés, la tabla se llenaba
 * a mano y nadie importaba nada.
 *
 * La ciudad NO se elige acá: sale de la columna «Bodega» del propio archivo.
 * Un selector sería una forma de equivocarse —importar Trujillo sobre Juliaca
 * pone a cero toda una ciudad— y el dato ya viene en el Excel.
 */
function ImportarDeSwayp({ onDone }: { onDone: (msg: string | null) => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [archivo, setArchivo] = useState<File | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  function subir() {
    if (!archivo) return;
    start(async () => {
      const fd = new FormData();
      fd.set("archivo", archivo);
      const r = await importarInventarioSwayp(fd);
      onDone(r.error ?? r.notice ?? null);
      if (!r.error) {
        setArchivo(null);
        if (inputRef.current) inputRef.current.value = "";
        router.refresh();
      }
    });
  }

  return (
    <Card className="space-y-3">
      <div>
        <p className="text-sm font-medium text-slate-800">Importar el conteo de Swayp</p>
        <p className="mt-0.5 text-xs text-slate-500">
          En Swayp: <span className="font-medium">Stock → Inventario</span>, elige la bodega y
          «Enviar a Excel». Un archivo por bodega. La ciudad sale del propio archivo.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          type="file"
          accept=".xlsx,.csv"
          onChange={(e) => setArchivo(e.target.files?.[0] ?? null)}
          className="text-xs text-slate-600 file:mr-2 file:rounded-lg file:border file:border-slate-200 file:bg-white file:px-2.5 file:py-1.5 file:text-xs file:text-slate-700 hover:file:bg-slate-50"
        />
        <button
          onClick={subir}
          disabled={pending || !archivo}
          className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {pending ? "Importando…" : "Importar"}
        </button>
      </div>
      <p className="text-xs text-amber-700">
        Los productos que Swayp no lista quedan en 0: si esa bodega no lo tiene, no se puede
        prometer. Sólo se toca la ciudad del archivo.
      </p>
    </Card>
  );
}

const nf = new Intl.NumberFormat("es-PE");

/** Chevron de disclosure, dibujado con el mismo trazo que los íconos de la barra. */
function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("shrink-0 text-slate-400 transition-transform duration-200", open && "rotate-180")}
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

/** Una cifra con su palabra: «6 bajan». El color acompaña, nunca es la única señal. */
function Cifra({ n, label, tone }: { n: number; label: string; tone: "down" | "up" | "new" | "warn" | "muted" }) {
  if (!n) return null;
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-xs font-medium tabular-nums",
        tone === "down" && "bg-rose-50 text-rose-700",
        tone === "up" && "bg-emerald-50 text-emerald-700",
        tone === "new" && "bg-sky-50 text-sky-700",
        tone === "warn" && "bg-amber-50 text-amber-800",
        tone === "muted" && "bg-slate-100 text-slate-600",
      )}
    >
      {nf.format(n)} {label}
    </span>
  );
}

const CATALOGO_HREF = "/dashboard/envios/aliclik";

/**
 * Sync del inventario de Swayp por API, en dos pasos: «Leer» trae todas las
 * bodegas y muestra qué cambiaría por ciudad SIN escribir; «Aplicar» vuelve a
 * leer en el servidor y escribe las ciudades marcadas, por el kardex, igual que
 * el importador de Excel. El token se pega a mano y no se guarda (dura ~1 h).
 * Correo, RUC e idCompany vienen precargados con los de la organización.
 */
function DryRunSwayp() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [accion, setAccion] = useState<"leer" | "aplicar" | null>(null);
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [email, setEmail] = useState("fkc@monono.pe");
  const [ruc, setRuc] = useState("20610091823");
  const [idCompany, setIdCompany] = useState("IsjvRm8cEqQBFP4r0TxF");
  const [res, setRes] = useState<DryRunResult | null>(null);
  const [aplicado, setAplicado] = useState<Extract<SyncResult, { ok: true }> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [marcadas, setMarcadas] = useState<Set<string>>(new Set());
  const [diag, setDiag] = useState<
    { label: string; host: string; method: string; status: number; ok: boolean; body: string }[] | null
  >(null);
  const [estado, setEstado] = useState<SwaypSyncEstado | null>(null);

  // Si pegan «Bearer <token>», se le quita el prefijo: el código ya lo agrega,
  // y con doble «Bearer» el panel rechaza (403).
  const limpio = token.trim().replace(/^Bearer\s+/i, "");
  // Sin token pegado, el servidor usa la credencial guardada (la del cron).
  const puedeLeer = !!limpio || !!estado?.credencialGuardada;

  function cargarEstado() {
    swaypInventoryEstado()
      .then((r) => setEstado("error" in r ? null : r))
      .catch(() => setEstado(null));
  }

  useEffect(() => {
    if (open && !estado) cargarEstado();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  function leer() {
    if (!puedeLeer) return;
    setErr(null);
    setAplicado(null);
    setRes(null);
    setDiag(null);
    setAccion("leer");
    start(async () => {
      const r = await swaypInventoryDryRun({ token: limpio, email, user: ruc, idCompany });
      if ("error" in r) {
        setErr(r.error);
        setDiag(r.diagnostico ?? null);
        return;
      }
      setRes(r);
      // Se marcan de entrada las ciudades donde algo cambiaría.
      setMarcadas(new Set(r.ciudades.filter((c) => c.ajustes.length || c.altas.length).map((c) => c.ciudad)));
    });
  }

  function aplicar() {
    if (!puedeLeer || !marcadas.size) return;
    const lista = [...marcadas].map(capitalizar).join(", ");
    if (
      !confirm(
        `${lista}: el stock de Kapta quedará igual al de Swayp y cada cambio se registra en el kardex.\n\nSwayp se vuelve a leer ahora, así que el resultado puede variar un poco de lo que ves. ¿Aplicar?`,
      )
    )
      return;
    setErr(null);
    setAccion("aplicar");
    start(async () => {
      const r = await swaypInventorySync({ token: limpio, email, user: ruc, idCompany, ciudades: [...marcadas] });
      if ("error" in r) {
        setErr(r.error);
        return;
      }
      setAplicado(r);
      // El diff ya no vale: lo que mostraba acaba de aplicarse.
      setRes(null);
      cargarEstado();
      router.refresh();
    });
  }

  function alternar(ciudad: string) {
    setMarcadas((prev) => {
      const next = new Set(prev);
      if (next.has(ciudad)) next.delete(ciudad);
      else next.add(ciudad);
      return next;
    });
  }

  const leyendo = pending && accion === "leer";
  const aplicando = pending && accion === "aplicar";
  const bodegasEnSync = res?.bodegas.filter((b) => b.enSync).length ?? 0;
  const filasHuerfanas = res?.bodegasSinCiudad.filter((b) => !res.bodegas.some((w) => w.id === b.idWarehouse)) ?? [];

  return (
    <Card className="p-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-4 rounded-2xl px-5 py-4 text-left hover:bg-slate-50"
      >
        <span>
          <span className="block text-sm font-semibold text-slate-900">Sincronizar stock desde Swayp</span>
          <span className="mt-0.5 block text-xs text-slate-500">
            Lee el inventario de todas las bodegas y deja cada ciudad igual a Swayp.
          </span>
        </span>
        <Chevron open={open} />
      </button>

      {open && (
        <div className="border-t border-slate-200">
          {/* Conexión */}
          <div className="space-y-3 px-5 py-4">
            {estado && <EstadoAutomatico estado={estado} />}

            <label className="block">
              <span className="text-sm font-medium text-slate-800">
                Token del panel de Swayp{estado?.credencialGuardada && " (opcional)"}
              </span>
              <span className="mt-0.5 block text-xs text-slate-500">
                {estado?.credencialGuardada
                  ? "Déjalo vacío para usar la credencial guardada de Kapta, la misma del sync automático. "
                  : ""}
                Con tu sesión abierta en Swayp: DevTools → Red → cualquier petición → valor de
                «Authorization». Dura una hora y no se guarda.
              </span>
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && leer()}
                placeholder="Pega el token (con o sin «Bearer»)"
                autoComplete="off"
                className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm placeholder:text-slate-400"
              />
            </label>

            <details className="group text-xs text-slate-600">
              <summary className="cursor-pointer select-none text-slate-500 hover:text-slate-700">
                Cuenta Swayp: {email} · RUC {ruc}
              </summary>
              <div className="mt-2 grid gap-2 sm:grid-cols-3">
                <label className="block">
                  Correo
                  <input
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="mt-0.5 w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs"
                  />
                </label>
                <label className="block">
                  RUC
                  <input
                    value={ruc}
                    onChange={(e) => setRuc(e.target.value)}
                    className="mt-0.5 w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs"
                  />
                </label>
                <label className="block">
                  Id de empresa
                  <input
                    value={idCompany}
                    onChange={(e) => setIdCompany(e.target.value)}
                    className="mt-0.5 w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs"
                  />
                </label>
              </div>
            </details>

            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={leer}
                disabled={pending || !puedeLeer}
                className="min-h-10 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
              >
                {leyendo ? "Leyendo Swayp…" : res ? "Volver a leer" : "Leer inventario"}
              </button>
              <span className="text-xs text-slate-500">Leer no cambia nada en Kapta.</span>
            </div>
          </div>

          {/* Error */}
          {err && (
            <div role="alert" className="mx-5 mb-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm text-rose-800">
              <p>{err}</p>
              {diag && (
                <details className="mt-2 text-xs text-rose-900/80">
                  <summary className="cursor-pointer select-none">Detalle técnico</summary>
                  <ul className="mt-1.5 space-y-1.5">
                    {diag.map((d, i) => (
                      <li key={i}>
                        <span className="font-medium">
                          {d.method} {d.label}: {d.status === 0 ? "sin conexión" : d.status}
                        </span>
                        {d.body && <span className="block break-all">{d.body}</span>}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}

          {/* Resultado de aplicar */}
          {aplicado && <ResultadoSync r={aplicado} />}

          {/* Diff */}
          {res && (
            <div className="border-t border-slate-200">
              <div className="flex flex-wrap items-baseline justify-between gap-2 bg-slate-50 px-5 py-3">
                <p className="text-sm text-slate-700">
                  <span className="font-medium text-slate-900">{nf.format(res.totalFilasInventario)} filas</span>{" "}
                  en {res.bodegas.length} bodegas · {bodegasEnSync} se sincronizan
                  {res.conCredencialGuardada && (
                    <span className="text-slate-500"> · leído con la credencial guardada</span>
                  )}
                </p>
                <details className="w-full text-xs text-slate-600">
                  <summary className="cursor-pointer select-none text-slate-500 hover:text-slate-700">
                    Ver bodegas y su ciudad
                  </summary>
                  <table className="mt-2 w-full max-w-xl text-xs">
                    <thead className="text-left text-slate-500">
                      <tr>
                        <th className="py-1 font-normal">Bodega</th>
                        <th className="py-1 font-normal">Ciudad</th>
                        <th className="py-1 text-right font-normal">Filas</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                      {res.bodegas.map((b) => (
                        <tr key={b.id}>
                          <td className="py-1 pr-3 text-slate-800">{b.name}</td>
                          <td className="py-1 pr-3">
                            <span className="capitalize">{b.city ?? "Sin ciudad"}</span>
                            {!b.enSync && <span className="text-amber-800"> · no se sincroniza</span>}
                          </td>
                          <td className="py-1 text-right tabular-nums text-slate-600">{b.filas}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {filasHuerfanas.length > 0 && (
                    <p className="mt-2 text-amber-800">
                      Filas de bodegas que Swayp no listó (se saltan):{" "}
                      {filasHuerfanas.map((b) => `${b.idWarehouse || "sin id"} (${b.filas})`).join(", ")}.
                    </p>
                  )}
                </details>
              </div>

              <ul className="divide-y divide-slate-200">
                {res.ciudades.map((c) => (
                  <CiudadDiff
                    key={c.ciudad}
                    c={c}
                    marcada={marcadas.has(c.ciudad)}
                    onToggle={() => alternar(c.ciudad)}
                  />
                ))}
              </ul>

              <div className="flex flex-wrap items-center gap-3 border-t border-slate-200 bg-slate-50 px-5 py-4">
                <button
                  onClick={aplicar}
                  disabled={pending || !marcadas.size || !puedeLeer}
                  className="min-h-10 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
                >
                  {aplicando
                    ? "Aplicando…"
                    : marcadas.size
                      ? `Aplicar a ${marcadas.size} ${marcadas.size === 1 ? "ciudad" : "ciudades"}`
                      : "Marca una ciudad para aplicar"}
                </button>
                <span className="text-xs text-slate-500">
                  Vuelve a leer Swayp al aplicar y registra cada cambio en el kardex.
                </span>
              </div>

              <details className="px-5 pb-4 text-xs text-slate-500">
                <summary className="cursor-pointer select-none hover:text-slate-700">Detalle técnico: muestra cruda</summary>
                <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all">
                  {JSON.stringify(res.muestra, null, 2)}
                </pre>
              </details>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

/** «hace 12 min», «hace 3 h», «hace 2 días». */
function haceCuanto(iso: string): string {
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (min < 1) return "hace un momento";
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.round(h / 24);
  return `hace ${d} ${d === 1 ? "día" : "días"}`;
}

/**
 * Si el sync automático está activo y cómo le fue la última vez. Un fallo o una
 * ciudad retenida se ven aquí, en vez de perderse en los logs del cron.
 */
function EstadoAutomatico({ estado }: { estado: SwaypSyncEstado }) {
  const ultima = estado.corridas[0];
  const ultimaAuto = estado.corridas.find((c) => c.source === "cron");
  const retenidas = ultimaAuto?.ok ? (ultimaAuto.resumen.retenidas ?? []) : [];
  const conCambios = (c: typeof ultima) => c?.resumen.ciudades?.length ?? 0;

  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs text-slate-600">
      <p>
        <span className="font-medium text-slate-800">Sync automático: </span>
        {estado.credencialGuardada ? (
          ultimaAuto && !ultimaAuto.ok ? (
            <span className="text-rose-700">configurado, pero fallando</span>
          ) : (
            <span className="text-emerald-700">activo, cada hora</span>
          )
        ) : (
          <span>
            apagado. Necesita una credencial de API de Swayp con acceso al inventario; mientras
            tanto, sincroniza con el botón pegando un token del panel.
          </span>
        )}
      </p>
      {ultima && (
        <p className="mt-1">
          Última sincronización {haceCuanto(ultima.created_at)} ·{" "}
          {ultima.source === "cron" ? "automática" : "manual"} ·{" "}
          {ultima.ok ? (
            conCambios(ultima) ? (
              `${conCambios(ultima)} ${conCambios(ultima) === 1 ? "ciudad con cambios" : "ciudades con cambios"}`
            ) : (
              "sin cambios"
            )
          ) : (
            <span className="text-rose-700">falló</span>
          )}
        </p>
      )}
      {estado.credencialGuardada && ultimaAuto && !ultimaAuto.ok && (
        <p className="mt-1 text-rose-700">
          El último intento automático ({haceCuanto(ultimaAuto.created_at)}) falló: {ultimaAuto.error}
        </p>
      )}
      {retenidas.length > 0 && (
        <div className="mt-1.5 text-amber-900">
          <p className="font-medium">El sync automático no aplicó estas ciudades. Léelas y revísalas antes de aplicar:</p>
          <ul className="mt-0.5 space-y-0.5">
            {retenidas.map((r) => (
              <li key={r.ciudad}>
                <span className="capitalize">{r.ciudad}</span>: {r.motivo}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function capitalizar(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/** Una ciudad del diff: qué cambia, con el detalle a un clic. */
function CiudadDiff({
  c,
  marcada,
  onToggle,
}: {
  c: DryRunResult["ciudades"][number];
  marcada: boolean;
  onToggle: () => void;
}) {
  const sinControl = ciudadSinControl(c.ciudad);
  const bajan = c.ajustes.filter((a) => a.cantidadNueva < a.cantidadAnterior);
  const aCero = bajan.filter((a) => a.cantidadNueva === 0);
  const suben = c.ajustes.length - bajan.length;
  const sinVincular = c.huerfanos.filter((h) => h.motivo === "sin_vinculo");
  const sinEtiqueta = c.huerfanos.filter((h) => h.motivo === "sin_etiqueta");
  const hayCambios = c.ajustes.length > 0 || c.altas.length > 0;
  // Bajan primero (lo que más duele si está mal), y dentro, los que van a 0.
  const ordenados = [...c.ajustes].sort(
    (x, y) => x.cantidadNueva - x.cantidadAnterior - (y.cantidadNueva - y.cantidadAnterior),
  );
  const id = `ciudad-${c.ciudad}`;

  return (
    <li className="px-5 py-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <input
          id={id}
          type="checkbox"
          checked={marcada}
          onChange={onToggle}
          disabled={!hayCambios}
          className="h-4 w-4 rounded border-slate-300 accent-brand-600"
        />
        <label htmlFor={id} className="text-sm font-semibold capitalize text-slate-900">
          {c.ciudad}
        </label>
        <div className="flex flex-wrap gap-1.5">
          {hayCambios ? (
            <>
              <Cifra n={bajan.length} label="bajan" tone="down" />
              <Cifra n={suben} label="suben" tone="up" />
              <Cifra n={c.altas.length} label={c.altas.length === 1 ? "alta" : "altas"} tone="new" />
            </>
          ) : (
            <span className="text-xs text-slate-500">Ya coincide con Swayp</span>
          )}
          <Cifra n={sinVincular.length} label="sin vincular" tone="warn" />
        </div>
        <span className="ml-auto text-xs tabular-nums text-slate-500">
          {sinControl ? (
            "Sin control de cantidad: solo altas"
          ) : (
            <>
              {nf.format(c.totalNuestro)} → <span className="font-medium text-slate-800">{nf.format(c.totalSwayp)}</span> u.
            </>
          )}
        </span>
      </div>

      {sinVincular.length > 0 && aCero.length > 0 && (
        <p className="mt-2.5 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
          {aCero.length} {aCero.length === 1 ? "producto pasaría" : "productos pasarían"} a 0, y Swayp tiene{" "}
          {sinVincular.length} {sinVincular.length === 1 ? "código" : "códigos"} sin vincular. Si es el mismo producto,
          vincúlalo en{" "}
          <a href={CATALOGO_HREF} className="font-medium underline underline-offset-2">
            Catálogo de productos
          </a>{" "}
          y vuelve a leer antes de aplicar.
        </p>
      )}

      {(c.ajustes.length > 0 || c.altas.length > 0 || c.huerfanos.length > 0) && (
        <details className="mt-2.5">
          <summary className="cursor-pointer select-none text-xs text-slate-500 hover:text-slate-700">
            Ver detalle
          </summary>
          <div className="mt-2 space-y-3">
            {ordenados.length > 0 && (
              <div>
                <table className="w-full table-fixed text-xs">
                  <thead className="text-left text-slate-500">
                    <tr>
                      <th className="py-1 pr-3 font-normal">Producto</th>
                      <th className="w-12 py-1 pr-2 text-right font-normal sm:w-16 sm:pr-3">Kapta</th>
                      <th className="w-12 py-1 pr-2 text-right font-normal sm:w-16 sm:pr-3">Swayp</th>
                      <th className="w-14 py-1 text-right font-normal sm:w-16">Cambio</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {ordenados.map((a) => {
                      const d = a.cantidadNueva - a.cantidadAnterior;
                      return (
                        <tr key={a.id}>
                          <td className="py-1 pr-3 text-slate-800">
                            <div className="flex min-w-0 gap-1.5" title={a.product}>
                              {a.codbar && <span className="shrink-0 tabular-nums text-slate-500">{a.codbar}</span>}
                              <span className="truncate">{a.product}</span>
                            </div>
                          </td>
                          <td className="py-1 pr-2 text-right tabular-nums text-slate-500 sm:pr-3">{a.cantidadAnterior}</td>
                          <td className="py-1 pr-2 text-right tabular-nums font-medium text-slate-800 sm:pr-3">
                            {a.cantidadNueva}
                          </td>
                          <td
                            className={cn(
                              "py-1 text-right tabular-nums font-medium",
                              d < 0 ? "text-rose-700" : "text-emerald-700",
                            )}
                          >
                            {a.cantidadNueva === 0 ? "a 0" : `${d > 0 ? "+" : "−"}${Math.abs(d)}`}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {c.altas.length > 0 && (
              <div className="text-xs">
                <p className="font-medium text-slate-700">Se dan de alta</p>
                <ul className="mt-1 space-y-0.5 text-slate-600">
                  {c.altas.map((a) => (
                    <li key={a.codbar + a.sku}>
                      <span className="mr-1.5 tabular-nums text-slate-500">{a.codbar}</span>
                      {a.product} · <span className="tabular-nums">{nf.format(a.cantidad)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {sinVincular.length > 0 && (
              <div className="text-xs">
                <p className="font-medium text-amber-900">
                  No se cargan: sin vincular en{" "}
                  <a href={CATALOGO_HREF} className="underline underline-offset-2">
                    Catálogo de productos
                  </a>
                </p>
                <ul className="mt-1 space-y-0.5 text-slate-600">
                  {sinVincular.map((h) => (
                    <li key={h.codbar}>
                      <span className="mr-1.5 tabular-nums text-slate-500">{h.codbar}</span>
                      {h.nombre} · <span className="tabular-nums">{nf.format(h.disponible)}</span> en Swayp
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {sinEtiqueta.length > 0 && (
              <div className="text-xs">
                <p className="font-medium text-slate-700">No se cargan: vinculados, pero ninguna ciudad tiene ese SKU</p>
                <ul className="mt-1 space-y-0.5 text-slate-600">
                  {sinEtiqueta.map((h) => (
                    <li key={h.codbar}>
                      <span className="mr-1.5 tabular-nums text-slate-500">{h.codbar}</span>
                      {h.nombre} · <span className="tabular-nums">{nf.format(h.disponible)}</span> en Swayp
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </details>
      )}
    </li>
  );
}

/** Lo que dejó «Aplicar», ciudad por ciudad. */
function ResultadoSync({ r }: { r: Extract<SyncResult, { ok: true }> }) {
  const pendientes = r.ciudades.flatMap((c) => c.sinVincular);
  const unicos = [...new Set(pendientes)];
  return (
    <div role="status" className="mx-5 mb-4 rounded-lg border border-emerald-200 bg-emerald-50/60 px-4 py-3">
      <p className="text-sm font-semibold text-emerald-900">Stock sincronizado con Swayp</p>
      <ul className="mt-2 space-y-1.5 text-sm text-slate-700">
        {r.ciudades.map((c) => {
          const sinControl = ciudadSinControl(c.ciudad);
          const partes = [
            c.bajan ? `${c.bajan} bajan${c.aCero ? ` (${c.aCero} a 0)` : ""}` : null,
            c.suben ? `${c.suben} suben` : null,
            c.altas ? `${c.altas} ${c.altas === 1 ? "alta" : "altas"}` : null,
          ].filter(Boolean);
          return (
            <li key={c.ciudad} className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium capitalize text-slate-900">{c.ciudad}</span>
              <span>{partes.length ? partes.join(" · ") : "sin cambios"}</span>
              {!sinControl && (
                <span className="text-xs tabular-nums text-slate-500">
                  {nf.format(c.unidadesAntes)} → {nf.format(c.unidadesDespues)} u.
                </span>
              )}
              {c.fallidos > 0 && <span className="text-xs text-rose-700">{c.fallidos} no se pudieron aplicar</span>}
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-xs text-slate-600">
        {r.guias !== null
          ? `${nf.format(r.guias)} guías recalculadas con el stock nuevo.`
          : `El stock quedó aplicado, pero no se pudieron recalcular las guías: ${r.errorGuias ?? "error desconocido"}.`}
        {r.noVinieron.length > 0 && ` Sin datos de Swayp, no se tocaron: ${r.noVinieron.map(capitalizar).join(", ")}.`}
      </p>
      {unicos.length > 0 && (
        <p className="mt-2 text-xs text-amber-900">
          Quedaron sin cargar {unicos.length} {unicos.length === 1 ? "código" : "códigos"} ({unicos.join(", ")}):
          vincúlalos en{" "}
          <a href={CATALOGO_HREF} className="font-medium underline underline-offset-2">
            Catálogo de productos
          </a>{" "}
          y vuelve a sincronizar.
        </p>
      )}
    </div>
  );
}

function DemandReport({ demand }: { demand: DemandRow[] }) {
  const [deptFilter, setDeptFilter] = useState<string | null>(null); // null = todos

  // Departamentos presentes, ordenados por faltante desc (los más urgentes primero).
  const deptOrder = useMemo(() => {
    const short = new Map<string, number>();
    for (const d of demand) short.set(d.department, (short.get(d.department) ?? 0) + d.shortfall);
    return [...new Set(demand.map((d) => d.department))].sort(
      (a, b) => (short.get(b) ?? 0) - (short.get(a) ?? 0) || a.localeCompare(b),
    );
  }, [demand]);

  const rows = deptFilter ? demand.filter((d) => d.department === deptFilter) : demand;
  const toSend = rows.filter((d) => d.shortfall > 0);
  const cities = new Set(toSend.map((d) => d.city)).size;
  const units = toSend.reduce((n, d) => n + d.shortfall, 0);

  return (
    <Card className="p-0">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-5 py-3">
        <p className="text-sm font-medium text-slate-800">Demanda por departamento (guías pendientes)</p>
        {toSend.length > 0 ? (
          <span className="rounded-full bg-rose-50 px-2.5 py-1 text-xs font-medium text-rose-700">
            ⚠ {toSend.length} producto(s) por reponer · {units} unidad(es) · {cities} ciudad(es)
          </span>
        ) : (
          <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">
            Stock cubre la demanda actual
          </span>
        )}
      </div>
      {deptOrder.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-200 px-5 py-2.5">
          <span className="mr-1 text-xs text-slate-400">Departamento:</span>
          <button
            onClick={() => setDeptFilter(null)}
            className={cn(
              "rounded-full px-2.5 py-1 text-xs font-medium",
              deptFilter === null ? "bg-slate-800 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200",
            )}
          >
            Todos
          </button>
          {deptOrder.map((dept) => (
            <button
              key={dept}
              onClick={() => setDeptFilter(dept)}
              className={cn(
                "rounded-full px-2.5 py-1 text-xs font-medium",
                deptFilter === dept ? "bg-slate-800 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200",
              )}
            >
              {dept}
            </button>
          ))}
        </div>
      )}
      {demand.length === 0 ? (
        <p className="p-5 text-sm text-slate-400">Sin guías pendientes en ciudades Fenix.</p>
      ) : (
        <div className={TABLE_WRAP}>
          <table className="w-full text-sm">
            <thead className={STICKY_HEAD}>
              <tr className="text-xs text-slate-500">
                <th className="px-4 py-2.5 text-left font-medium">Departamento</th>
                <th className="px-4 py-2.5 text-left font-medium">Ciudad</th>
                <th className="px-4 py-2.5 text-left font-medium">Producto</th>
                <th className="px-4 py-2.5 text-right font-medium">Pendientes</th>
                <th className="px-4 py-2.5 text-right font-medium">Stock</th>
                <th className="px-4 py-2.5 text-right font-medium">Faltante</th>
                <th className="px-4 py-2.5 text-left font-medium">Estado</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d, i) => (
                <tr key={`${d.city}-${d.product}-${i}`} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-2.5 text-slate-700">{d.department}</td>
                  <td className="px-4 py-2.5 capitalize text-slate-700">{d.city}</td>
                  <td className="px-4 py-2.5 text-slate-700">{d.product}</td>
                  <td className="px-4 py-2.5 text-right text-slate-700">{d.demand}</td>
                  <td className="px-4 py-2.5 text-right text-slate-700">{d.stock}</td>
                  <td
                    className={cn(
                      "px-4 py-2.5 text-right font-medium",
                      d.shortfall > 0 ? "text-rose-600" : "text-slate-400",
                    )}
                  >
                    {d.shortfall > 0 ? d.shortfall : "—"}
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className={cn(
                        "inline-flex rounded-full px-2 py-0.5 text-xs font-medium",
                        DEMAND_BADGE[d.status] ?? "bg-slate-100 text-slate-600",
                      )}
                    >
                      {DEMAND_LABEL[d.status] ?? d.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/**
 * Product typeahead sourced from the selected store's Shopify catalog (mirrors
 * the leads ProductPicker). Empty query → active products, so focusing the field
 * shows the catalog as a dropdown. Picking a product also carries its SKU; free
 * typing keeps working (and clears the SKU) when read_products isn't granted.
 */
function ProductCombobox({
  storeId,
  value,
  onChange,
}: {
  storeId: string;
  value: string;
  onChange: (product: string, sku: string | null) => void;
}) {
  const [results, setResults] = useState<ProductResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  // search on (value, store) change, debounced; empty value lists active products
  useEffect(() => {
    if (!storeId) {
      setResults(null);
      return;
    }
    setSearching(true);
    let alive = true;
    const t = setTimeout(async () => {
      const r = await searchStockProducts(storeId, value.trim());
      if (alive) {
        setResults(r);
        setSearching(false);
      }
    }, 280);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [value, storeId]);

  // close the dropdown on outside click
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  return (
    <div ref={boxRef} className="relative">
      <input
        value={value}
        onChange={(e) => {
          onChange(e.target.value, null); // typing clears the picked SKU
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder="Buscar producto…"
        className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm"
      />
      {open && (results !== null || searching) && (
        <div className={cn("absolute mt-1 w-full rounded-lg border border-slate-200 bg-white shadow-lg", OVER_TABLE_Z)}>
          {searching && <p className="px-2.5 py-1.5 text-xs text-slate-400">Buscando…</p>}
          {results && results.length === 0 && !searching && (
            <p className="px-2.5 py-1.5 text-xs text-slate-400">
              Sin resultados (o falta el permiso read_products). Puedes escribir el nombre.
            </p>
          )}
          {results && results.length > 0 && (
            <ul className="max-h-56 overflow-y-auto py-1">
              {results.map((p) => (
                <li key={p.variantId}>
                  <button
                    type="button"
                    onClick={() => {
                      onChange(p.title, p.sku ?? null);
                      setOpen(false);
                    }}
                    className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-slate-50"
                  >
                    <span className="flex-1 text-sm text-slate-800">{p.title}</span>
                    <span
                      className={cn(
                        "text-xs",
                        (p.inventory ?? 0) > 0 ? "text-slate-400" : "text-amber-600",
                      )}
                    >
                      {p.inventory != null ? `stock ${p.inventory}` : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

const MOVEMENT_TONE: Record<string, string> = {
  entrada: "text-emerald-700",
  salida_entrega: "text-slate-600",
  salida_merma: "text-rose-600",
  ajuste: "text-sky-700",
};

type KardexMovement = {
  id: string;
  kind: StockMovementKind;
  delta: number;
  balance_after: number;
  note: string | null;
  shipment_id: string | null;
  created_at: string;
  by: string | null;
};

/**
 * Kardex de un producto: historial de movimientos + formularios de Entrada /
 * Merma / Ajuste (conteo Fénix). Las salidas por entrega aparecen en el
 * historial pero se registran solas al entregar cada guía.
 */
function StockKardexModal({
  row,
  canEdit,
  onClose,
  onChanged,
}: {
  row: FenixStockRowDb;
  canEdit: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [moves, setMoves] = useState<KardexMovement[] | null>(null);
  const [kind, setKind] = useState<"entrada" | "salida_merma" | "ajuste">("entrada");
  const [qty, setQty] = useState("");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const reload = () =>
    getFenixStockMovements(row.id).then((m) => setMoves(m as KardexMovement[]));
  useEffect(() => {
    let alive = true;
    getFenixStockMovements(row.id).then((m) => {
      if (alive) setMoves(m as KardexMovement[]);
    });
    return () => {
      alive = false;
    };
  }, [row.id]);

  function submit() {
    const n = Number(qty);
    if (!Number.isFinite(n)) {
      setMsg(kind === "ajuste" ? "Ingresa el conteo real de Fénix." : "Ingresa la cantidad.");
      return;
    }
    start(async () => {
      const r = await recordFenixStockMovement({ stockId: row.id, kind, quantity: n, note });
      setMsg(r.error ?? r.notice ?? null);
      if (!r.error) {
        setQty("");
        setNote("");
        await reload();
        onChanged();
      }
    });
  }

  const qtyLabel =
    kind === "ajuste" ? "Conteo real de Fénix" : kind === "salida_merma" ? "Unidades que salieron" : "Unidades que llegaron";

  return (
    <div className="fixed inset-0 z-30 grid place-items-center bg-slate-900/30 p-4" onClick={onClose}>
      <div
        className="max-h-[85vh] w-full max-w-lg overflow-auto rounded-2xl bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900">Movimientos de stock</h2>
            <p className="text-xs text-slate-500 capitalize">
              {row.city} · <span className="normal-case">{row.product}</span>
            </p>
          </div>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600">
            ✕
          </button>
        </div>

        {canEdit && (
          <div className="mt-3 space-y-2 rounded-xl border border-slate-200 p-3">
            <div className="flex flex-wrap gap-1.5">
              {(["entrada", "salida_merma", "ajuste"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setKind(k)}
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-xs font-medium transition",
                    kind === k
                      ? "border-brand-200 bg-brand-50 text-brand-700"
                      : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50",
                  )}
                >
                  {STOCK_MOVEMENT_LABEL[k]}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <div>
                <label className="block text-xs text-slate-400">{qtyLabel}</label>
                <input
                  type="number"
                  min={0}
                  value={qty}
                  onChange={(e) => setQty(e.target.value)}
                  className="w-40 rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm"
                />
              </div>
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={kind === "salida_merma" ? "Motivo (obligatorio)" : "Nota (opcional)"}
                className="min-w-[10rem] flex-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm"
              />
              <button
                onClick={submit}
                disabled={pending}
                className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
              >
                Registrar
              </button>
            </div>
            {kind === "ajuste" && (
              <p className="text-[11px] text-slate-400">
                El sistema calcula la diferencia contra el saldo actual y la deja registrada como ajuste.
              </p>
            )}
            {msg && <p className="rounded-lg bg-slate-50 px-2.5 py-1.5 text-sm text-slate-700">{msg}</p>}
          </div>
        )}

        <p className="mt-4 mb-1 text-xs font-semibold tracking-wide text-slate-400 uppercase">Historial</p>
        {moves === null ? (
          <p className="text-sm text-slate-400">Cargando…</p>
        ) : moves.length === 0 ? (
          <p className="text-sm text-slate-400">Sin movimientos todavía.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {moves.map((m) => (
              <li key={m.id} className="flex items-baseline gap-2 py-1.5 text-sm">
                <span className={cn("w-40 shrink-0 font-medium", MOVEMENT_TONE[m.kind] ?? "text-slate-600")}>
                  {STOCK_MOVEMENT_LABEL[m.kind]}
                </span>
                <span className={cn("w-12 shrink-0 text-right tabular-nums", m.delta < 0 ? "text-rose-600" : "text-emerald-700")}>
                  {m.delta > 0 ? `+${m.delta}` : m.delta}
                </span>
                <span className="w-16 shrink-0 text-right tabular-nums text-slate-500">= {m.balance_after}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-slate-400">
                  {new Date(m.created_at).toLocaleString("es-PE", {
                    day: "2-digit",
                    month: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                  {m.by ? ` · ${m.by}` : ""}
                  {m.note ? ` · ${m.note}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
