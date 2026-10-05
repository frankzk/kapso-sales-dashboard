"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { cn } from "@/components/ui";
import { Badge, Banner, FIELD, FIELD_BOX, OpsButton } from "@/components/ops-ui";
import { IconArrowLeft, IconCheck, IconSearch, IconX, IconXCircle } from "@/components/icons";
import {
  createDirectFenixGuide,
  previewDirectFenixGuide,
  searchOrdersToLink,
  searchShopifyOrdersForDirectGuide,
  type DirectFenixGuidePreview,
  type ShopifyOrderCandidate,
} from "@/app/dashboard/envios/actions";
import type { OrderLinkCandidate } from "@/lib/shipments-access";
import { limaTodayKey } from "@/lib/shipments";
import { esNumeroDeGuiaSwayp } from "@/lib/swayp-guide";

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
  const [motivo, setMotivo] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [createdNotice, setCreatedNotice] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const panel = useRef<HTMLDivElement>(null);

  // El foco entra al abrir; al cerrar vuelve a quien lo abrió.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.focus({ preventScroll: true });
    return () => {
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

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
  // Vacío es además lo NORMAL desde el 16-09-2026: el número lo emite Swayp y
  // punto. Si Swayp no responde, la guía no se crea — antes se caía a un código
  // nuestro (`#KP…`) que Swayp no reconoce, y por eso se retiró junto con el
  // botón «Autogenerar» que lo acuñaba. Escribir algo aquí solo vale para
  // registrar una guía que YA existe en el panel de Swayp, y entonces tiene que
  // ser su número: solo dígitos.

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
      setMotivo("");
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
        motivoSalidaAdicional: preview.salidaAdicional?.tipo === "pideMotivo" ? motivo : null,
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

  // Otra salida viva: fuera de Lima (o por el límite / la repetición) bloquea;
  // en Lima solo pide el motivo. Lo decide el servidor con la misma regla que
  // Tanders, `puertaDeSalidaAdicional`.
  const blockedByGuide = preview?.salidaAdicional?.tipo === "bloqueo";
  const faltaMotivo = preview?.salidaAdicional?.tipo === "pideMotivo" && !motivo.trim();
  const blockedByOrder = !!preview && (preview.cancelled || preview.refundedTotal);
  const blockedByStock = !!preview && !preview.stockOk;
  // El vínculo con el catálogo de Swayp. En Lima es LA comprobación que dice
  // algo: la ciudad no lleva control de cantidad, así que el stock siempre sale
  // en verde y este panel anunciaba «disponible para todo el pedido» sobre un
  // producto que Swayp no conoce (#KP134541, 15-09-2026).
  const blockedByLink = !!preview && preview.unlinked.length > 0;
  // MISMA función que la reja del servidor: el número escrito a mano tiene que
  // ser uno de Swayp, no uno nuestro.
  const numeroNoEsDeSwayp = !!guideCode.trim() && !esNumeroDeGuiaSwayp(guideCode);
  const canCreate =
    !numeroNoEsDeSwayp &&
    !!preview &&
    !blockedByGuide &&
    !faltaMotivo &&
    !blockedByOrder &&
    !blockedByStock &&
    !blockedByLink &&
    !!dispatchDate &&
    dispatchDate >= earliestDispatchDate();
  // Ojo: NO se exige `guideCode`. Exigirlo era la otra mitad del bloqueo —el
  // botón sólo se activaba con el campo lleno, y el campo lleno apaga la API—.
  // El servidor ya resuelve el código cuando llega vacío.

  const candidateRow =
    "flex w-full items-center gap-3 px-3 py-2 text-left text-[13px] leading-5 transition-colors hover:bg-wash disabled:opacity-50 pointer-coarse:min-h-11";

  return (
    <div
      className="fixed inset-0 z-30 flex items-start justify-center overflow-y-auto bg-ink-900/30 p-4 sm:p-8"
      onClick={onClose}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="guia-directa-titulo"
        tabIndex={-1}
        style={{ outline: "none" }}
        // Escape cierra este modal y no lo que haya detrás (la ficha del pedido
        // también escucha la tecla).
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }}
        className="w-full max-w-xl rounded-lg bg-white shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3 border-b border-line px-5 pb-3 pt-4">
          <div className="min-w-0">
            <h2 id="guia-directa-titulo" className="text-lg font-semibold leading-7 text-ink-900">
              Guía Swayp directa
            </h2>
            <p className="text-[13px] leading-5 text-ink-500">
              Despacho desde el stock regional de Swayp (antes Fénix), sin guía Aliclik previa.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="-mr-1.5 grid size-8 shrink-0 place-items-center rounded-md text-ink-500 transition-colors hover:bg-wash hover:text-ink-900 pointer-coarse:size-11"
          >
            <IconX aria-hidden className="size-4" />
          </button>
        </header>

        <div className="px-5 py-4">
        {createdNotice ? (
          <div className="space-y-4">
            <Banner tone="ok" role="status" title={createdNotice}>
              <p>
                Al cerrar te llevamos a la pestaña <b className="font-semibold">En ruta</b>, donde queda la guía. Para
                enviarla a Swayp, filtra por su fecha de despacho y descarga el Excel de programación.
              </p>
            </Banner>
            <div className="flex justify-end">
              <OpsButton variant="primary" onClick={onClose} className="pointer-coarse:h-11">
                Ver la guía en En ruta
              </OpsButton>
            </div>
          </div>
        ) : !preview && initialOrderId ? (
          <div className="space-y-3">
            <p className="text-sm text-ink-500">Validando cobertura y stock Swayp…</p>
            {msg && (
              <Banner tone="crit" role="alert">
                {msg}
              </Banner>
            )}
          </div>
        ) : !preview ? (
          <div className="space-y-3">
            <label className="grid gap-1.5 text-sm font-semibold text-ink-900">
              Busca el pedido de Shopify
              <span className="relative">
                <IconSearch aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-500" />
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="N° de pedido (#KP…, #AUR…) o celular…"
                  autoFocus
                  className={cn(FIELD_BOX, "h-9 w-full pl-8 pr-3 font-normal pointer-coarse:h-11")}
                />
              </span>
            </label>
            {searching && <p className="text-[13px] text-ink-500">Buscando…</p>}
            {results && results.length === 0 && !searching && (
              <p className="text-[13px] text-ink-500">Sin coincidencias locales.</p>
            )}
            {results && results.length > 0 && (
              <ul className="max-h-56 divide-y divide-line overflow-y-auto rounded-md ring-1 ring-line">
                {results.map((o) => (
                  <li key={o.id}>
                    <button
                      type="button"
                      onClick={() => loadPreview({ orderId: o.id })}
                      disabled={loadingPreview}
                      className={candidateRow}
                    >
                      <span className="font-mono font-medium text-ink-900">{o.name ?? "—"}</span>
                      <span className="tabular-nums text-ink-600">{o.customer_phone ?? "—"}</span>
                      <span className="ml-auto tabular-nums text-ink-500">
                        {o.created_at ? new Date(o.created_at).toLocaleDateString("es-PE") : ""}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <OpsButton
                size="sm"
                onClick={() => void searchShopify()}
                disabled={q.trim().length < 2 || searchingShopify}
                className="pointer-coarse:h-11"
              >
                {searchingShopify ? "Buscando en Shopify…" : "Buscar en Shopify"}
              </OpsButton>
              <span className="text-[13px] leading-5 text-ink-500">Para pedidos que aún no se sincronizaron.</span>
            </div>
            {shopifyResults && shopifyResults.length === 0 && !searchingShopify && (
              <p className="text-[13px] text-ink-500">Sin coincidencias en Shopify.</p>
            )}
            {shopifyResults && shopifyResults.length > 0 && (
              <ul className="max-h-56 divide-y divide-line overflow-y-auto rounded-md ring-1 ring-line">
                {shopifyResults.map((o) => (
                  <li key={o.gid}>
                    <button
                      type="button"
                      onClick={() => loadPreview({ orderGid: o.gid, storeId: o.storeId })}
                      disabled={loadingPreview}
                      className={candidateRow}
                    >
                      <span className="font-mono font-medium text-ink-900">{o.name ?? "—"}</span>
                      <span className="tabular-nums text-ink-600">{o.customer_phone ?? "—"}</span>
                      <span className="ml-auto tabular-nums text-ink-500">
                        {o.created_at ? new Date(o.created_at).toLocaleDateString("es-PE") : ""}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {loadingPreview && <p className="text-[13px] text-ink-500">Cargando pedido…</p>}
            {msg && (
              <Banner tone="crit" role="alert">
                {msg}
              </Banner>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-semibold text-ink-900">Revisa y confirma</p>
              <OpsButton
                size="sm"
                variant="ghost"
                onClick={() => {
                  setPreview(null);
                  setMsg(null);
                }}
                className="-my-1 pointer-coarse:h-11"
              >
                <IconArrowLeft className="text-ink-500" />
                Cambiar pedido
              </OpsButton>
            </div>

            {/* El pedido y adónde va, en el marco de cifras: lo que se revisa
                antes de mandar una caja desde el almacén regional. */}
            <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-md bg-line ring-1 ring-line">
              <div className="bg-wash px-3 py-2.5">
                <dt className="text-[13px] leading-5 text-ink-600">Pedido</dt>
                <dd className="font-mono text-sm font-semibold leading-5 text-ink-900">{preview.orderName ?? "—"}</dd>
              </div>
              <div className="bg-wash px-3 py-2.5">
                <dt className="text-[13px] leading-5 text-ink-600">Cobrar</dt>
                <dd className="text-sm font-semibold leading-5 tabular-nums text-ink-900">
                  {preview.totalAmount != null
                    ? `${preview.currency ?? "PEN"} ${preview.totalAmount.toFixed(2)}`
                    : "—"}
                </dd>
              </div>
              <div className="bg-wash px-3 py-2.5">
                <dt className="text-[13px] leading-5 text-ink-600">Cliente</dt>
                <dd className="text-sm leading-5 text-ink-900">{preview.customerName ?? "—"}</dd>
              </div>
              <div className="bg-wash px-3 py-2.5">
                <dt className="text-[13px] leading-5 text-ink-600">Teléfono</dt>
                <dd className="text-sm leading-5 tabular-nums text-ink-900">{preview.customerPhone ?? "—"}</dd>
              </div>
              <div className="col-span-2 bg-wash px-3 py-2.5">
                <dt className="flex items-center gap-1.5 text-[13px] leading-5 text-ink-600">
                  Destino
                  {preview.address.source && (
                    <Badge>
                      {preview.address.source === "shopify"
                        ? "Shopify"
                        : preview.address.source === "carrito"
                          ? "Carrito COD"
                          : "Lead"}
                    </Badge>
                  )}
                </dt>
                <dd className="text-sm leading-5 text-ink-900">
                  {[preview.address.address1, preview.address.address2].filter(Boolean).join(" · ") ||
                    "Sin dirección registrada"}
                  <span className="block text-[13px] text-ink-600">
                    {[preview.address.district, preview.address.region].filter(Boolean).join(", ") || "—"}
                    {preview.city && <span className="capitalize"> · almacén: {preview.city}</span>}
                  </span>
                </dd>
              </div>
            </dl>
            {preview.schedule && (
              <p className="text-[13px] leading-5 text-ink-600">
                <span className="font-semibold text-ink-900">Horario Swayp: {preview.schedule.hours}</span>
                {preview.schedule.note ? ` · ${preview.schedule.note}` : ""}
              </p>
            )}

            <section aria-labelledby="guia-directa-productos" className="overflow-hidden rounded-md ring-1 ring-line">
              <p id="guia-directa-productos" className="border-b border-line px-3 py-2 text-[13px] font-medium leading-5 text-ink-700">
                Productos y stock Swayp{preview.city ? ` en ${titleCaseCity(preview.city)}` : ""}
              </p>
              <ul className="divide-y divide-line">
                {preview.lineItems.length === 0 && (
                  <li className="px-3 py-2 text-[13px] text-ink-500">Pedido sin productos registrados.</li>
                )}
                {preview.lineItems.map((li, i) => {
                  const missing =
                    preview.stockReason === "sin_stock" &&
                    preview.uncovered.includes(li.title.trim() || "(producto sin nombre)");
                  // Sin vínculo manda sobre el stock: es lo que de verdad
                  // impide la guía, y en Lima lo otro nunca dice que no.
                  const sinVinculo = preview.unlinked.includes(
                    li.title.trim() || (li.sku ?? "").trim() || "(producto sin nombre)",
                  );
                  return (
                    <li key={i} className="flex items-center justify-between gap-3 px-3 py-2 text-sm leading-5">
                      <span className="min-w-0 flex-1 truncate text-ink-900" title={li.title}>
                        {li.title || "—"}
                        {li.quantity > 1 && <span className="text-[13px] tabular-nums text-ink-500"> × {li.quantity}</span>}
                      </span>
                      {sinVinculo ? (
                        <span
                          className="inline-flex shrink-0 items-center gap-1 text-[13px] font-medium text-crit-fg"
                          title="Swayp no tiene este producto en su catálogo: falta vincularlo en Catálogo de productos."
                        >
                          <IconXCircle aria-hidden className="size-3.5" />
                          sin vínculo Swayp
                        </span>
                      ) : preview.stockOk ? (
                        <span className="inline-flex shrink-0 items-center gap-1 text-[13px] font-medium text-ok-fg">
                          <IconCheck aria-hidden className="size-3.5" />
                          stock
                        </span>
                      ) : missing ? (
                        <span className="inline-flex shrink-0 items-center gap-1 text-[13px] font-medium text-crit-fg">
                          <IconXCircle aria-hidden className="size-3.5" />
                          sin stock
                        </span>
                      ) : preview.stockReason === "sin_cobertura" ? (
                        <span className="text-[13px] text-ink-500">—</span>
                      ) : (
                        <span className="inline-flex shrink-0 items-center gap-1 text-[13px] font-medium text-ok-fg">
                          <IconCheck aria-hidden className="size-3.5" />
                          stock
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
              <p
                className={cn(
                  "border-t border-line px-3 py-2 text-[13px] font-medium leading-5",
                  preview.stockOk && !blockedByLink ? "bg-ok-wash text-ok-fg" : "bg-crit-wash text-crit-fg",
                )}
              >
                {/* El vínculo se dice PRIMERO: es lo que bloquea, y manda a otra
                    pantalla que el stock. «Sin stock» se arregla en Stock Swayp;
                    «sin vínculo» en Catálogo de productos. */}
                {blockedByLink
                  ? `Swayp no tiene ${preview.unlinked.length === 1 ? "este producto" : "estos productos"} en su catálogo: ${preview.unlinked.join(", ")}.`
                  : preview.stockOk
                    ? "Stock Swayp disponible para todo el pedido."
                    : preview.stockReason === "sin_cobertura"
                      ? "Swayp no tiene cobertura en este destino."
                      : "Falta stock Swayp para parte del pedido. Actualiza Stock Swayp e intenta de nuevo."}
              </p>
            </section>

            {/* La alerta, aparte del renglón por producto: sin esto el único
                aviso era una columna a la derecha de una lista, y el botón se
                apagaba sin decir por qué. Dice qué falta y dónde se arregla. */}
            {blockedByLink && (
              <Banner
                tone="crit"
                title={
                  preview.unlinked.length === 1
                    ? "Este producto no está en el inventario de Swayp"
                    : "Estos productos no están en el inventario de Swayp"
                }
              >
                <ul className="mt-1 list-disc space-y-0.5 pl-4">
                  {preview.unlinked.map((nombre) => (
                    <li key={nombre}>{nombre}</li>
                  ))}
                </ul>
                <p className="mt-1.5">
                  Sin el vínculo, Swayp no emite la guía y la caja saldría con un número que ellos
                  no conocen.{" "}
                  {preview.unlinked.length === 1 ? "Vincúlalo" : "Vincúlalos"} en Catálogo de
                  productos y vuelve a abrir esta ventana.
                </p>
              </Banner>
            )}
            {blockedByOrder && (
              <Banner tone="crit">
                {preview.cancelled
                  ? "El pedido está cancelado en Shopify; no se puede crear la guía."
                  : "El pedido fue reembolsado por completo en Shopify; no se puede crear la guía."}
              </Banner>
            )}
            {/* El texto lo escribe el servidor y nombra al courier de verdad.
                Antes se armaba aquí con «fenix → Swayp, todo lo demás →
                Aliclik», y una salida de Grupo GF se anunciaba como de Aliclik
                (#KP134416). */}
            {blockedByGuide && preview.salidaAdicional && (
              <Banner tone="crit">{preview.salidaAdicional.texto}</Banner>
            )}
            {preview.salidaAdicional?.tipo === "pideMotivo" && !blockedByOrder && (
              <Banner tone="warn">
                <label className="grid gap-1.5">
                  {preview.salidaAdicional.texto}
                  <textarea
                    value={motivo}
                    onChange={(e) => setMotivo(e.target.value)}
                    rows={2}
                    placeholder="Ej. Grupo GF no lo entregó; sale por Swayp sin esperar su reporte."
                    className={cn(FIELD_BOX, "w-full px-3 py-2 leading-5")}
                  />
                </label>
                <p className="mt-1.5">
                  Queda registrado en el pedido. Si la otra salida termina entregando, hay que
                  cancelar esta.
                </p>
              </Banner>
            )}
            {/* Una salida «por definir» NO bloquea: la guía se le escribe
                encima, sin abrir otra ni gastar una del presupuesto de cinco.
                Se dice en azul y no en rojo porque no hay nada que resolver, y
                se nombra la salida porque quien arma la caja tiene ese rótulo
                delante. */}
            {preview.fillableOutputCode && !blockedByGuide && !blockedByOrder && (
              <Banner tone="info">
                La salida <span className="font-mono font-medium text-ink-900">{preview.fillableOutputCode}</span> está por
                definir: la guía se le escribe encima, sin anularla ni abrir otra.
              </Banner>
            )}
            {preview.warnings.length > 0 && !blockedByGuide && !blockedByOrder && (
              <Banner tone="warn">
                <ul className="list-disc space-y-0.5 pl-4">
                  {preview.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </Banner>
            )}

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <label className="grid gap-1.5 text-[13px] font-medium text-ink-700">
                Fecha de despacho (desde mañana)
                <input
                  type="date"
                  value={dispatchDate}
                  min={earliestDispatchDate()}
                  onChange={(e) => setDispatchDate(e.target.value)}
                  className={cn(FIELD, "font-normal tabular-nums pointer-coarse:h-11")}
                />
              </label>
              <label className="grid gap-1.5 text-[13px] font-medium text-ink-700">
                N° de guía Swayp
                {/* «Autogenerar» estaba aquí y se quitó el 16-09-2026: armaba el
                    número con el pedido y la fecha —`#KP13166415092026`—, que es
                    justo el código que Swayp no reconoce. */}
                <input
                  value={guideCode}
                  onChange={(e) => setGuideCode(e.target.value)}
                  inputMode="numeric"
                  placeholder="Vacío: lo emite Swayp"
                  aria-invalid={numeroNoEsDeSwayp || undefined}
                  className={cn(
                    FIELD,
                    "font-mono font-normal pointer-coarse:h-11",
                    numeroNoEsDeSwayp && "ring-2 ring-crit-fg",
                  )}
                />
                <span className={cn("text-[13px] font-normal leading-5", numeroNoEsDeSwayp ? "text-crit-fg" : "text-ink-500")}>
                  {numeroNoEsDeSwayp
                    ? "Ese número no es de Swayp: los suyos son solo dígitos, como 50000132589."
                    : "Déjalo vacío y el número lo emite Swayp. Escríbelo solo si la guía ya existe en su panel: con el campo lleno no se le pide, para no duplicar el paquete."}
                </span>
              </label>
            </div>
            <label className="grid gap-1.5 text-[13px] font-medium text-ink-700">
              Nota (opcional)
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Queda en el historial…"
                rows={2}
                className={cn(FIELD_BOX, "w-full px-3 py-2 font-normal leading-5")}
              />
            </label>

            {msg && (
              <Banner tone="crit" role="alert">
                {msg}
              </Banner>
            )}
            <div className="flex justify-end gap-2">
              <OpsButton onClick={onClose} className="pointer-coarse:h-11">
                Cancelar
              </OpsButton>
              <OpsButton variant="primary" onClick={create} disabled={pending || !canCreate} className="pointer-coarse:h-11">
                {pending ? "Creando…" : "Crear guía Swayp directa"}
              </OpsButton>
            </div>
          </div>
        )}
        </div>
      </div>
    </div>
  );
}

function titleCaseCity(city: string): string {
  return city.charAt(0).toUpperCase() + city.slice(1);
}
