"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { cn } from "@/components/ui";
import { Badge, Banner, FIELD, FIELD_BOX, OpsButton } from "@/components/ops-ui";
import { IconAlert, IconArrowLeft, IconCheck, IconSearch, IconX, IconXCircle } from "@/components/icons";
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
import { firstSwaypDispatchDay, isSwaypDispatchDay } from "@/lib/swayp-dispatch-days";
import { SwaypDispatchDateSelect } from "@/components/swayp-dispatch-date-select";
import { esNumeroDeGuiaSwayp } from "@/lib/swayp-guide";
import { orderPlatformName } from "@/lib/order-admin-url";
import { swaypLotNotice, swaypSuggestedDispatchDay, type SwaypLotNotice } from "@/lib/warehouse-swayp";
import {
  DISTRICT_MISMATCH_BLOCK_REASON,
  DistrictMismatchWarning,
  useDistrictMismatchCheck,
} from "@/components/district-mismatch-warning";

/** El despacho más pronto es mañana (Lima): el Excel del día ya suele estar
 *  enviado, así que una guía de hoy nunca llegaría a Fenix. */
function earliestDispatchDate(): string {
  return limaTodayKey(new Date(Date.now() + 86_400_000));
}

/** El primer día que Swayp despacha: mañana, o el lunes si mañana es domingo. */
function defaultDispatchDate(): string {
  return firstSwaypDispatchDay(limaTodayKey());
}

// El subtítulo dice quién arma la caja (D1, owner 03-11-2026): en Lima y Callao
// nuestro almacén, y Swayp la recoge en la oficina; en provincia, la bodega
// regional de Swayp (el texto de siempre). Antes de elegir el pedido, los dos.
// Decía «stock regional de Swayp» también para Lima, y las guías de Lima se
// creaban sin avisar a quien de verdad arma la caja.
const SUBTITULO_SIN_PEDIDO =
  "Sin guía Aliclik previa. En provincia sale del stock regional de Swayp; en Lima y Callao la caja la arma nuestro almacén.";
const SUBTITULO_LIMA =
  "Lima y Callao: la caja la arma nuestro almacén y Swayp la recoge en la oficina. Sin guía Aliclik previa.";
const SUBTITULO_PROVINCIA = "Despacho desde el stock regional de Swayp (antes Fénix), sin guía Aliclik previa.";

/**
 * El tono del aviso del lote tras crear (MOM §9.1, «Swayp por salir · Lima»):
 * después de las 21:20 de la víspera, el aviso fuerte; después de las 17:00, el
 * suave; si no, solo informa. Nada bloquea (D3): la guía ya está creada.
 */
function lotNoticeTone(notice: SwaypLotNotice): "info" | "warn" | "crit" {
  return notice.afterCutoff ? "crit" : notice.late ? "warn" : "info";
}

/**
 * Crear una guía Fenix DIRECTA desde un pedido (sin guía Aliclik madre). En
 * provincia la caja sale de la bodega regional de Swayp; en Lima y Callao la
 * arma nuestro almacén y Swayp la recoge en la oficina (D1, owner 03-11-2026).
 * Buscar pedido (local + Shopify en vivo) → revisar destino/productos/stock/
 * duplicados → fecha de despacho + N° de guía (vacío: lo emite Swayp) →
 * crear. La guía nace En ruta y entra al Excel de programación de su fecha; con
 * destino de Lima, también al lote «Swayp por salir · Lima» del almacén (MOM §9.1).
 */
export function DirectFenixGuideModal({
  initialOrderId,
  origen,
  onClose,
  onCreated,
}: {
  /** Abre desde el Master sin volver a buscar el pedido. */
  initialOrderId?: string;
  /** El botón de Por confirmar (MOM §11.11): la guía sale sin confirmar. */
  origen?: "por_confirmar";
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

  const [dispatchDate, setDispatchDate] = useState(defaultDispatchDate());
  const [guideCode, setGuideCode] = useState("");
  const [note, setNote] = useState("");
  const [motivo, setMotivo] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [createdNotice, setCreatedNotice] = useState<string | null>(null);
  // «Swayp por salir · Lima» (MOM §9.1, D3 del owner, 03-11-2026). La hora de
  // Lima se lee en el navegador al cargar el pedido y al elegir la fecha, nunca
  // al pintar: el aviso dice si ya pasó el corte del turno noche de la víspera.
  const [clock, setClock] = useState<Date | null>(null);
  const [createdLot, setCreatedLot] = useState<SwaypLotNotice | null>(null);
  // La fecha que eligió la persona no se pisa al cargar otro pedido.
  const dateTouched = useRef(false);
  const [pending, start] = useTransition();
  const panel = useRef<HTMLDivElement>(null);

  /**
   * Al cargar el pedido: la hora de ahora y, si nadie eligió fecha, la que se
   * propone. Con destino de Lima, pasadas las 21:20 de la víspera del próximo
   * día de despacho, el siguiente (D3); provincia sigue en el primero.
   */
  function onPreviewLoaded(p: DirectFenixGuidePreview) {
    const now = new Date();
    setClock(now);
    if (!dateTouched.current) setDispatchDate(swaypSuggestedDispatchDay({ now, lima: p.operation === "lima" }));
  }

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
        onPreviewLoaded(result);
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
      onPreviewLoaded(r);
      setGuideCode("");
      setMotivo("");
    });
  }

  // «Distrito por revisar» (MOM §19.0.3): el distrito es la capital y la
  // dirección nombra otro de la provincia. Avisa antes de crear; corregir
  // vuelve a cargar el pedido para que el destino de arriba diga el nuevo.
  const districtCheck = useDistrictMismatchCheck(preview?.orderId ?? null);

  function create() {
    if (!preview) return;
    start(async () => {
      const r = await createDirectFenixGuide({
        orderId: preview.orderId,
        dispatchDateIso: new Date(dispatchDate).toISOString(),
        guideCode,
        note,
        motivoSalidaAdicional: preview.salidaAdicional?.tipo === "pideMotivo" ? motivo : null,
        origen,
      });
      if (r.error) {
        setMsg(r.error);
        return;
      }
      setMsg(null);
      setCreatedNotice(r.notice ?? "Guía Swayp directa creada.");
      // A qué lote del almacén entró, con la hora de la confirmación (MOM §9.1).
      setCreatedLot(swaypLotNotice({ day: dispatchDate, now: new Date(), lima: limaLot }));
      onCreated(r.shipmentId);
    });
  }

  // El destino es Lima o Callao con certeza: lo dice la operación del pedido,
  // la misma con la que el almacén arma su lote, y no la ciudad de cobertura.
  const limaLot = preview?.operation === "lima";
  // El aviso fuerte bajo la fecha (D3): el día elegido es el próximo día de
  // despacho y ya pasaron las 21:20 de su víspera. Informa; nunca bloquea, así
  // que no entra en `canCreate`.
  const lotBefore = clock && limaLot ? swaypLotNotice({ day: dispatchDate, now: clock, lima: true })?.before ?? null : null;
  // Con el pedido de Lima cargado, la hora se refresca cada minuto: quien abre
  // el modal a las 21:10 y crea a las 21:25 sin tocar la fecha tiene que ver el
  // aviso ANTES de crear, no solo después (revisión del 03-11-2026). La fecha
  // propuesta no se cambia sola: solo el aviso.
  useEffect(() => {
    if (!limaLot) return;
    const id = window.setInterval(() => setClock(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, [limaLot]);

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
    !districtCheck.blocking &&
    !blockedByGuide &&
    !faltaMotivo &&
    !blockedByOrder &&
    !blockedByStock &&
    !blockedByLink &&
    !!dispatchDate &&
    dispatchDate >= earliestDispatchDate() &&
    isSwaypDispatchDay(dispatchDate);
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
              {!preview ? SUBTITULO_SIN_PEDIDO : limaLot ? SUBTITULO_LIMA : SUBTITULO_PROVINCIA}
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
            {/* Lima y Callao: a qué lote del almacén entró (MOM §9.1). La
                frase sale entera de `swaypLotNotice`; el tono solo la acompaña. */}
            {createdLot && (
              <Banner tone={lotNoticeTone(createdLot)} role="status">
                {createdLot.after}
              </Banner>
            )}
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
                      {/* «shopify» es «del pedido» (`raw`): se nombra su tienda (MOM §38.12). */}
                      {preview.address.source === "shopify"
                        ? orderPlatformName(preview.platform)
                        : preview.address.source === "carrito"
                          ? "Carrito COD"
                          : preview.address.source === "manual"
                            ? "Ubicación corregida"
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
            {/* Lo que va a leer Swayp como distrito, antes que nada más. */}
            <DistrictMismatchWarning
              orderId={preview.orderId}
              check={districtCheck}
              onCorrected={() => loadPreview({ orderId: preview.orderId })}
            />
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
                  ? "El pedido está anulado en la tienda; no se puede crear la guía."
                  : `El pedido fue reembolsado por completo en ${orderPlatformName(preview.platform)}; no se puede crear la guía.`}
              </Banner>
            )}
            {/* El texto lo escribe el servidor y nombra al courier de verdad.
                Antes se armaba aquí con «fenix → Swayp, todo lo demás →
                Aliclik», y una salida de Grupo GF se anunciaba como de Aliclik
                (#KP134416). */}
            {blockedByGuide && preview.salidaAdicional && (
              <Banner tone="crit">{preview.salidaAdicional.texto}</Banner>
            )}
            {/* MOM §11.11: que nadie lea este envío como una confirmación. */}
            {origen === "por_confirmar" && (
              <Banner tone="info">
                Sale desde Por confirmar, sin confirmación. Si Swayp no lo entrega, el pedido vuelve a
                «Por confirmar · Swayp no entregó» para llamarlo otra vez.
              </Banner>
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
                Fecha de despacho (lunes a sábado)
                <SwaypDispatchDateSelect
                  value={dispatchDate}
                  onChange={(value) => {
                    dateTouched.current = true;
                    setDispatchDate(value);
                    setClock(new Date());
                  }}
                  className={cn(FIELD, "font-normal tabular-nums pointer-coarse:h-11")}
                />
                {/* Un aviso y no un error: la fecha es válida y la guía se
                    puede crear igual. Por eso el campo no se pinta ni se marca
                    inválido; la frase dice qué pasa y qué hacer. */}
                {lotBefore && (
                  <span role="status" className="flex gap-1.5 text-[13px] font-medium leading-5 text-crit-fg">
                    <IconAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                    {lotBefore.text}
                  </span>
                )}
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
            {districtCheck.blocking && (
              <p className="text-right text-[13px] font-medium leading-5 text-warn-fg">{DISTRICT_MISMATCH_BLOCK_REASON}</p>
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
