"use client";

import { useEffect, useState, useTransition } from "react";
import { cn } from "@/components/ui";
import {
  createDirectFenixGuide,
  previewDirectFenixGuide,
  searchOrdersToLink,
  searchShopifyOrdersForDirectGuide,
  type DirectFenixGuidePreview,
  type ShopifyOrderCandidate,
} from "@/app/dashboard/envios/actions";
import type { OrderLinkCandidate } from "@/lib/shipments-access";
import { limaTodayKey, rescheduleGuideCode } from "@/lib/shipments";

/** El despacho más pronto es mañana (Lima): el Excel del día ya suele estar
 *  enviado, así que una guía de hoy nunca llegaría a Fenix. */
function earliestDispatchDate(): string {
  return limaTodayKey(new Date(Date.now() + 86_400_000));
}

/**
 * Crear una guía Fenix DIRECTA desde un pedido (sin guía Aliclik madre), para
 * urgencias que salen del almacén regional de Fénix. Buscar pedido (local +
 * Shopify en vivo) → revisar destino/productos/stock/duplicados → fecha de
 * despacho + código autogenerado editable → crear. La guía nace En ruta y entra
 * al Excel de programación de su fecha.
 */
export function DirectFenixGuideModal({
  initialOrderId,
  onClose,
  onCreated,
}: {
  /** Abre desde el Master sin volver a buscar el pedido. */
  initialOrderId?: string;
  onClose: () => void;
  /** Recibe el id de la guía creada para que el tablero salte a "En ruta" y la resalte. */
  onCreated: (shipmentId?: string) => void;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<OrderLinkCandidate[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [shopifyResults, setShopifyResults] = useState<ShopifyOrderCandidate[] | null>(null);
  const [searchingShopify, setSearchingShopify] = useState(false);

  const [preview, setPreview] = useState<DirectFenixGuidePreview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);

  const [dispatchDate, setDispatchDate] = useState(earliestDispatchDate());
  const [guideCode, setGuideCode] = useState("");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [createdNotice, setCreatedNotice] = useState<string | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    if (!initialOrderId) return;
    setLoadingPreview(true);
    void previewDirectFenixGuide({ orderId: initialOrderId }).then((result) => {
      setLoadingPreview(false);
      if ("error" in result) setMsg(result.error);
      else {
        setPreview(result);
        // Un código escrito para OTRO pedido no puede sobrevivir al cambio: se
        // lo llevaría puesto y apagaría la API para el pedido nuevo.
        setGuideCode("");
      }
    });
  }, [initialOrderId]);

  // debounced local search (mirror of OrderLinkPicker)
  useEffect(() => {
    setShopifyResults(null);
    const term = q.trim();
    if (term.length < 2) {
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    let alive = true;
    const t = setTimeout(async () => {
      const r = await searchOrdersToLink(term);
      if (alive) {
        setResults(r);
        setSearching(false);
      }
    }, 280);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [q]);

  // EL CAMPO ARRANCA VACÍO, Y ES DELIBERADO.
  //
  // Antes se autogeneraba el código al abrir el modal. Parecía una comodidad y
  // era el bloqueo de toda la integración: el servidor sólo pide la guía a la
  // API cuando el campo llega VACÍO —si trae algo, entiende que el operador ya
  // la creó en el panel de Swayp y pedir otra duplicaría el paquete—. Con el
  // autorrelleno, ese campo nunca llegaba vacío, así que la guía por API era
  // inalcanzable desde esta pantalla: se creó en el #294 y nunca se ejecutó.
  //
  // Vacío no significa quedarse sin código: si Swayp responde, manda SU número;
  // y si la integración está apagada, el servidor genera el mismo código local
  // que se generaba acá (rescheduleGuideCode, con los mismos argumentos). El
  // botón «Autogenerar» sigue disponible para el caso que lo justifica: que
  // Swayp haya entregado un código propio y haya que escribirlo.

  async function searchShopify() {
    const term = q.trim();
    if (term.length < 2) return;
    setSearchingShopify(true);
    const r = await searchShopifyOrdersForDirectGuide(term);
    setShopifyResults(r);
    setSearchingShopify(false);
  }

  function loadPreview(input: { orderId?: string; orderGid?: string; storeId?: string }) {
    setLoadingPreview(true);
    setMsg(null);
    void previewDirectFenixGuide(input).then((r) => {
      setLoadingPreview(false);
      if ("error" in r) {
        setMsg(r.error);
        return;
      }
      setPreview(r);
      setGuideCode("");
    });
  }

  function create() {
    if (!preview) return;
    start(async () => {
      const r = await createDirectFenixGuide({
        orderId: preview.orderId,
        dispatchDateIso: new Date(dispatchDate).toISOString(),
        guideCode,
        note,
      });
      if (r.error) {
        setMsg(r.error);
        return;
      }
      setMsg(null);
      setCreatedNotice(r.notice ?? "Guía Swayp directa creada.");
      onCreated(r.shipmentId);
    });
  }

  const blockedByGuide = !!preview && preview.activeGuides.length > 0;
  const blockedByOrder = !!preview && (preview.cancelled || preview.refundedTotal);
  const blockedByStock = !!preview && !preview.stockOk;
  const canCreate =
    !!preview &&
    !blockedByGuide &&
    !blockedByOrder &&
    !blockedByStock &&
    !!dispatchDate &&
    dispatchDate >= earliestDispatchDate();
  // Ojo: NO se exige `guideCode`. Exigirlo era la otra mitad del bloqueo —el
  // botón sólo se activaba con el campo lleno, y el campo lleno apaga la API—.
  // El servidor ya resuelve el código cuando llega vacío.

  return (
    <div className="fixed inset-0 z-30 flex items-start justify-center overflow-y-auto bg-slate-900/30 p-4 sm:p-8" onClick={onClose}>
      <div
        className="w-full max-w-xl rounded-2xl bg-white p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 pb-2.5">
          <div>
            <p className="text-sm font-semibold text-slate-900">Guía Swayp directa</p>
            <p className="text-xs text-slate-500">
              Despacho desde el stock regional de Swayp (antes Fénix), sin guía Aliclik previa.
            </p>
          </div>
          <button onClick={onClose} className="text-sm text-slate-400 hover:text-slate-700">
            Cerrar
          </button>
        </div>

        {createdNotice ? (
          <div className="space-y-3 pt-3">
            <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
              {createdNotice}
            </p>
            <p className="text-xs text-slate-500">
              Al cerrar te llevamos a la pestaña <b>En ruta</b>, donde queda la guía. Para enviarla a
              Swayp, filtra por su fecha de despacho y descarga el Excel de programación.
            </p>
            <button
              onClick={onClose}
              className="w-full rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
            >
              Ver la guía en En ruta
            </button>
          </div>
        ) : !preview && initialOrderId ? (
          <div className="pt-4">
            <p className="text-sm text-slate-500">Validando cobertura y stock Swayp…</p>
            {msg && <p className="mt-3 rounded-lg bg-rose-50 px-2.5 py-1.5 text-xs text-rose-700">{msg}</p>}
          </div>
        ) : !preview ? (
          <div className="space-y-2 pt-3">
            <label className="block text-xs text-slate-500">
              Paso 1 · Busca el pedido de Shopify
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="N° de pedido (#KP…, #AUR…) o celular…"
                autoFocus
                className="mt-0.5 w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm"
              />
            </label>
            {searching && <p className="text-xs text-slate-400">Buscando…</p>}
            {results && results.length === 0 && !searching && (
              <p className="text-xs text-slate-400">Sin coincidencias locales.</p>
            )}
            {results && results.length > 0 && (
              <ul className="max-h-48 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200">
                {results.map((o) => (
                  <li key={o.id}>
                    <button
                      type="button"
                      onClick={() => loadPreview({ orderId: o.id })}
                      disabled={loadingPreview}
                      className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-sm hover:bg-slate-50 disabled:opacity-50"
                    >
                      <span className="font-mono text-xs text-slate-700">{o.name ?? "—"}</span>
                      <span className="text-xs text-slate-500">{o.customer_phone ?? "—"}</span>
                      <span className="text-xs text-slate-400">
                        {o.created_at ? new Date(o.created_at).toLocaleDateString("es-PE") : ""}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void searchShopify()}
                disabled={q.trim().length < 2 || searchingShopify}
                className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              >
                {searchingShopify ? "Buscando en Shopify…" : "Buscar en Shopify"}
              </button>
              <span className="text-xs text-slate-400">Para pedidos que aún no se sincronizaron.</span>
            </div>
            {shopifyResults && shopifyResults.length === 0 && !searchingShopify && (
              <p className="text-xs text-slate-400">Sin coincidencias en Shopify.</p>
            )}
            {shopifyResults && shopifyResults.length > 0 && (
              <ul className="max-h-48 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200">
                {shopifyResults.map((o) => (
                  <li key={o.gid}>
                    <button
                      type="button"
                      onClick={() => loadPreview({ orderGid: o.gid, storeId: o.storeId })}
                      disabled={loadingPreview}
                      className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-sm hover:bg-slate-50 disabled:opacity-50"
                    >
                      <span className="font-mono text-xs text-slate-700">{o.name ?? "—"}</span>
                      <span className="text-xs text-slate-500">{o.customer_phone ?? "—"}</span>
                      <span className="text-xs text-slate-400">
                        {o.created_at ? new Date(o.created_at).toLocaleDateString("es-PE") : ""}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {loadingPreview && <p className="text-xs text-slate-400">Cargando pedido…</p>}
            {msg && <p className="rounded-lg bg-rose-50 px-2.5 py-1.5 text-xs text-rose-700">{msg}</p>}
          </div>
        ) : (
          <div className="space-y-2.5 pt-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Paso 2 · Revisa y confirma
              </p>
              <button
                type="button"
                onClick={() => {
                  setPreview(null);
                  setMsg(null);
                }}
                className="text-xs text-slate-500 hover:underline"
              >
                ← Cambiar pedido
              </button>
            </div>

            <section className="rounded-xl border border-sky-200 bg-white">
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 px-3 py-2 text-sm">
                <div>
                  <dt className="text-[11px] text-slate-400">Pedido</dt>
                  <dd className="font-mono text-xs text-slate-800">{preview.orderName ?? "—"}</dd>
                </div>
                <div>
                  <dt className="text-[11px] text-slate-400">Cobrar</dt>
                  <dd className="text-slate-800">
                    {preview.totalAmount != null
                      ? `${preview.currency ?? "PEN"} ${preview.totalAmount.toFixed(2)}`
                      : "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] text-slate-400">Cliente</dt>
                  <dd className="text-slate-800">{preview.customerName ?? "—"}</dd>
                </div>
                <div>
                  <dt className="text-[11px] text-slate-400">Teléfono</dt>
                  <dd className="text-slate-800">{preview.customerPhone ?? "—"}</dd>
                </div>
                <div className="col-span-2 border-t border-slate-100 pt-1">
                  <dt className="text-[11px] text-slate-400">
                    Destino
                    {preview.address.source && (
                      <span className="ml-1 rounded bg-slate-100 px-1 text-[10px] text-slate-500">
                        {preview.address.source === "shopify"
                          ? "Shopify"
                          : preview.address.source === "carrito"
                            ? "Carrito COD"
                            : "Lead"}
                      </span>
                    )}
                  </dt>
                  <dd className="text-slate-800">
                    {[preview.address.address1, preview.address.address2].filter(Boolean).join(" · ") ||
                      "Sin dirección registrada"}
                    <span className="block text-xs text-slate-500">
                      {[preview.address.district, preview.address.region].filter(Boolean).join(", ") || "—"}
                      {preview.city && <span className="capitalize"> · almacén: {preview.city}</span>}
                    </span>
                  </dd>
                </div>
              </dl>
              {preview.schedule && (
                <p className="border-t border-amber-100 bg-amber-50/70 px-3 py-1.5 text-xs text-amber-800">
                  Horario Swayp: {preview.schedule.hours}
                  {preview.schedule.note ? ` · ${preview.schedule.note}` : ""}
                </p>
              )}
            </section>

            <section className="rounded-xl border border-slate-200">
              <p className="border-b border-slate-100 px-3 py-1.5 text-xs font-medium text-slate-600">
                Productos y stock Swayp{preview.city ? ` en ${titleCaseCity(preview.city)}` : ""}
              </p>
              <ul className="divide-y divide-slate-100">
                {preview.lineItems.length === 0 && (
                  <li className="px-3 py-1.5 text-xs text-slate-400">Pedido sin productos registrados.</li>
                )}
                {preview.lineItems.map((li, i) => {
                  const missing =
                    preview.stockReason === "sin_stock" &&
                    preview.uncovered.includes(li.title.trim() || "(producto sin nombre)");
                  return (
                    <li key={i} className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm">
                      <span className="min-w-0 flex-1 truncate text-slate-700" title={li.title}>
                        {li.title || "—"}
                        {li.quantity > 1 && <span className="text-xs text-slate-400"> ×{li.quantity}</span>}
                      </span>
                      {preview.stockOk ? (
                        <span className="text-xs font-medium text-emerald-600">✓ stock</span>
                      ) : missing ? (
                        <span className="text-xs font-medium text-rose-600">✗ sin stock</span>
                      ) : preview.stockReason === "sin_cobertura" ? (
                        <span className="text-xs text-slate-400">—</span>
                      ) : (
                        <span className="text-xs font-medium text-emerald-600">✓ stock</span>
                      )}
                    </li>
                  );
                })}
              </ul>
              <p
                className={cn(
                  "border-t px-3 py-1.5 text-xs font-medium",
                  preview.stockOk
                    ? "border-emerald-100 bg-emerald-50/70 text-emerald-700"
                    : "border-rose-100 bg-rose-50/70 text-rose-700",
                )}
              >
                {preview.stockOk
                  ? "Stock Swayp disponible para todo el pedido."
                  : preview.stockReason === "sin_cobertura"
                    ? "Swayp no tiene cobertura en este destino."
                    : "Falta stock Swayp para parte del pedido. Actualiza Stock Swayp e intenta de nuevo."}
              </p>
            </section>

            {blockedByOrder && (
              <p className="rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-xs text-rose-700">
                {preview.cancelled
                  ? "El pedido está cancelado en Shopify; no se puede crear la guía."
                  : "El pedido fue reembolsado por completo en Shopify; no se puede crear la guía."}
              </p>
            )}
            {blockedByGuide && (
              <div className="rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-xs text-rose-700">
                <p className="font-medium">Este pedido ya tiene una guía activa:</p>
                {preview.activeGuides.map((g) => (
                  <p key={g.id} className="mt-0.5 font-mono">
                    {g.guide_code}{" "}
                    <span className="font-sans">
                      ({g.courier === "fenix" ? "Swayp" : "Aliclik"} · {g.delivery_status})
                    </span>
                  </p>
                ))}
                <p className="mt-1 font-sans">Gestiónala o anúlala antes de crear una guía directa.</p>
              </div>
            )}
            {preview.warnings.length > 0 && !blockedByGuide && !blockedByOrder && (
              <ul className="space-y-1 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800">
                {preview.warnings.map((w, i) => (
                  <li key={i}>• {w}</li>
                ))}
              </ul>
            )}

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <label className="block text-xs text-slate-500">
                Fecha de despacho (desde mañana)
                <input
                  type="date"
                  value={dispatchDate}
                  min={earliestDispatchDate()}
                  onChange={(e) => setDispatchDate(e.target.value)}
                  className="mt-0.5 w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm text-slate-800"
                />
              </label>
              <label className="block text-xs text-slate-500">
                N° de guía Swayp
                <div className="mt-0.5 flex gap-2">
                  <input
                    value={guideCode}
                    onChange={(e) => setGuideCode(e.target.value)}
                    placeholder="Vacío: lo asigna Swayp"
                    className="w-full flex-1 rounded-lg border border-slate-200 px-2.5 py-1.5 font-mono text-xs"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      setGuideCode(
                        rescheduleGuideCode(
                          preview.orderName,
                          dispatchDate ? new Date(dispatchDate).toISOString() : null,
                        ),
                      );
                    }}
                    disabled={!preview.orderName}
                    className="rounded-lg border border-slate-200 px-2 py-1.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                  >
                    Autogenerar
                  </button>
                </div>
                <span className="mt-1 block text-[11px] text-slate-400">
                  Déjalo vacío y el número lo emite Swayp. Escribe uno solo si la guía
                  <strong> ya existe</strong> en el panel de Swayp: con el campo lleno no se le pide,
                  para no duplicar el paquete.
                </span>
              </label>
            </div>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Nota (opcional, queda en el historial)…"
              rows={2}
              className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm"
            />

            {msg && <p className="rounded-lg bg-rose-50 px-2.5 py-1.5 text-xs text-rose-700">{msg}</p>}
            <button
              onClick={create}
              disabled={pending || !canCreate}
              className="w-full rounded-lg border border-orange-300 bg-orange-50 px-3 py-1.5 text-sm font-medium text-orange-800 hover:bg-orange-100 disabled:opacity-50"
            >
              {pending ? "Creando…" : "Crear guía Swayp directa"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function titleCaseCity(city: string): string {
  return city.charAt(0).toUpperCase() + city.slice(1);
}
