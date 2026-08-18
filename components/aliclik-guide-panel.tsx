"use client";

// Panel de creación de guía en Aliclik, dentro del detalle del pedido.
//
// El flujo es deliberadamente de DOS pasos, y el primero no escribe nada hacia
// afuera:
//
//   1. Cotizar. Resuelve los EAN, comprueba que todo salga de un solo almacén,
//      y llama a `GET /integration/order/shipping/cost`. Esa llamada hace tres
//      cosas a la vez: da los couriers y sus precios, confirma que hay cobertura
//      y devuelve el ubigeo que Aliclik deduce del pin — que comparado con el
//      nuestro es el mejor detector de direcciones mal ubicadas que tenemos.
//   2. Crear. Solo entonces se escribe en Aliclik, y es irreversible.
//
// LA COORDENADA ES EL CUELLO DE BOTELLA. Aliclik exige lat/lng y Shopify no las
// entrega, así que casi ningún pedido las tiene. El campo acepta lo que la
// operadora ya tiene a mano: el enlace de Google Maps que mandó la clienta.

import { useEffect, useRef, useState, useTransition } from "react";
import { Card } from "@/components/ui";
import {
  createAliclikGuide,
  linkExistingAliclikGuide,
  previewAliclikGuide,
  type ExistingAliclikGuidePreview,
  type AliclikPreview,
} from "@/app/dashboard/pedidos/aliclik-actions";
import { isShortenedMapsLink } from "@/lib/aliclik-geo";
import {
  describeAliclikHealth,
  type AliclikHealthState,
  type HealthTone,
} from "@/lib/aliclik-health";
import {
  PAYMENT_REQUIREMENT_LABEL,
  aliclikRiskGate,
  type PaymentRequirement,
} from "@/lib/order-confirmation-brief";

/**
 * El foco de salud de la API de Aliclik. Solo informa; no bloquea el botón —un
 * pin puntual puede fallar con la API verde y viceversa.
 *
 * Cubre los DOS caminos. Antes solo miraba la sonda de cotización, así que un día
 * en que cotizar iba fino y crear se caía lo pintaba verde: la asesora pulsaba
 * confiando en él y se llevaba el pedido bloqueado. El ámbar es ese caso.
 */
const TONES: Record<HealthTone, { dot: string; text: string }> = {
  verde: { dot: "bg-emerald-500", text: "text-emerald-700" },
  ambar: { dot: "bg-amber-500", text: "text-amber-700" },
  rojo: { dot: "bg-rose-500", text: "text-rose-700" },
  gris: { dot: "bg-slate-300", text: "text-slate-500" },
};

function HealthBadge({ health }: { health: AliclikHealthState }) {
  const copy = describeAliclikHealth(health);
  const tone = TONES[copy.tone];
  return (
    <span
      title={copy.hint}
      className={`inline-flex flex-none items-center gap-1.5 whitespace-nowrap text-[11px] font-medium ${tone.text}`}
    >
      <span className={`h-2 w-2 flex-none rounded-full ${tone.dot}`} aria-hidden />
      {copy.label}
    </span>
  );
}

export function AliclikGuidePanel({
  orderId,
  hasCoordinate,
  health,
  riskRequirement = "ninguno",
  paymentState = null,
  riskReasons = [],
  onCreated,
}: {
  orderId: string;
  hasCoordinate: boolean;
  health: AliclikHealthState;
  riskRequirement?: PaymentRequirement;
  paymentState?: string | null;
  riskReasons?: string[];
  onCreated: () => void;
}) {
  const [coordinate, setCoordinate] = useState("");
  const [preview, setPreview] = useState<AliclikPreview | null>(null);
  const [transportId, setTransportId] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [riskExceptionReason, setRiskExceptionReason] = useState("");
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  /** Cuántas veces se ha reintentado por "pedido todavía sin dirección". */
  const [retries, setRetries] = useState(0);
  /**
   * CUÁL de las dos acciones está corriendo, no solo "hay algo corriendo".
   *
   * Las dos compartían el `pending` de un único `useTransition`, así que
   * recotizar un pedido ya cotizado ponía el botón de crear en "Creando…" — la
   * asesora leía que se estaba creando una guía que nadie pidió, sobre una
   * acción que el propio panel describe como irreversible. Susto gratis.
   */
  const [busy, setBusy] = useState<null | "quote" | "create">(null);

  const shortened = isShortenedMapsLink(coordinate);
  const waiting = Boolean(preview?.notReady);
  const creating = busy === "create";
  const riskGate = aliclikRiskGate(riskRequirement, paymentState, riskExceptionReason);

  const quote = () => {
    setMessage(null);
    setBusy("quote");
    startTransition(async () => {
      try {
      const res = await previewAliclikGuide(orderId, { coordinate: coordinate || null });
      setPreview(res);
      // Pedido recién creado desde Leads: la dirección viene del webhook de
      // Shopify unos segundos después. Se reintenta solo en vez de dejar a la
      // vendedora pulsando "Cotizar" a ciegas, y sin tocar `message` para no
      // pintar en rojo algo que no es un fallo.
      if (res.notReady) {
        setRetries((n) => n + 1);
        return;
      }
      setRetries(0);
      // Preselecciona el courier más barato entre los seleccionables: es lo que
      // la operadora elige el 90 % de las veces.
      const cheapest = (res.couriers ?? [])
        .filter((c) => c.selectable)
        .sort((a, b) => a.deliveryCost - b.deliveryCost)[0];
      setTransportId(cheapest?.transportId ?? null);
      if (!res.ok && res.error) setMessage({ kind: "error", text: res.error });
      } finally {
        setBusy(null);
      }
    });
  };

  const create = () => {
    if (transportId === null) return;
    setMessage(null);
    setBusy("create");
    startTransition(async () => {
      try {
      const res = await createAliclikGuide(orderId, {
        transportId,
        coordinate: coordinate || null,
        note: note || null,
        // Se devuelve el monto que se acaba de ENSEÑAR: el servidor lo recalcula
        // y aborta si cambió entre cotizar y pulsar.
        expectedCollectTotal: preview?.collectTotal ?? null,
        riskExceptionReason: riskExceptionReason || null,
      });
      if (res.error) setMessage({ kind: "error", text: res.error });
      else {
        setMessage({ kind: "ok", text: res.notice ?? "Guía creada." });
        setPreview(null);
        onCreated();
      }
      } finally {
        setBusy(null);
      }
    });
  };

  // Cerrar la pestaña mientras se crea NO cancela nada: la petición ya va de
  // camino a Aliclik y la guía se creará igual, solo que la asesora no verá el
  // código y creerá que no se hizo. El aviso del navegador evita ese descuadre.
  useEffect(() => {
    if (!creating) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [creating]);

  // Reintento acotado mientras Shopify nos devuelve la dirección. Se para a los
  // 6 intentos (~30 s): si a esas alturas sigue sin llegar, ya no es la carrera
  // normal y hay que dejar de girar en vacío y que alguien lo mire.
  const MAX_RETRIES = 6;
  const quoteRef = useRef(quote);
  quoteRef.current = quote;
  useEffect(() => {
    if (!waiting || retries === 0 || retries > MAX_RETRIES) return;
    const t = setTimeout(() => quoteRef.current(), 5000);
    return () => clearTimeout(t);
  }, [waiting, retries]);

  return (
    <Card>
      <div className="space-y-4">
        <ExistingGuideLinkPanel orderId={orderId} onLinked={onCreated} />
        <div className="border-t border-slate-200 pt-4">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">Crear guía en Aliclik</h3>
              <p className="mt-1 text-xs text-slate-500">
                Cotiza primero: la cotización no crea nada y sirve para confirmar cobertura y ubicación.
              </p>
            </div>

            <HealthBadge health={health} />
          </div>

          {riskGate.requiresException && (
            <div className="mt-3 rounded-lg bg-amber-50 px-3 py-3 text-sm text-amber-950 ring-1 ring-amber-200">
              <p className="font-semibold">{PAYMENT_REQUIREMENT_LABEL[riskRequirement]}</p>
              <p className="mt-1 text-xs leading-5">
                Aliclik cobra el intento no entregado. Valida el pago exigido o registra por qué
                autorizas esta excepción.
              </p>
              {riskReasons.length > 0 && (
                <ul className="mt-2 list-disc space-y-0.5 pl-4 text-xs">
                  {riskReasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              )}
              <label className="mt-3 block">
                <span className="text-xs font-semibold">Justificación de la excepción</span>
                <textarea
                  value={riskExceptionReason}
                  onChange={(event) => setRiskExceptionReason(event.target.value)}
                  rows={2}
                  placeholder="Ej. Cliente recurrente; confirmó que recibe hoy."
                  className="mt-1 w-full rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm text-slate-900"
                />
              </label>
              {!riskGate.allowed && (
                <p className="mt-1 text-xs text-amber-800">{riskGate.message}</p>
              )}
            </div>
          )}

        {/* Esperando a Shopify: ni campo de coordenada ni botón de cotizar. Ambos
            pedirían a la vendedora un trabajo que el webhook hace solo. */}
        {waiting ? (
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-600">
            <p className="font-medium text-slate-700">Preparando el pedido…</p>
            <p className="mt-0.5 text-xs">
              Shopify todavía no nos ha devuelto la dirección. Tarda unos segundos y no hay que hacer
              nada.
            </p>
            {retries > MAX_RETRIES ? (
              <button
                type="button"
                onClick={quote}
                disabled={pending}
                className="mt-2 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                {pending ? "Comprobando…" : "Está tardando más de lo normal · reintentar"}
              </button>
            ) : null}
          </div>
        ) : null}

        {/* Coordenada */}
        <div className={waiting ? "hidden" : undefined}>
          <label className="mb-1 block text-xs font-medium text-slate-600" htmlFor="alc-coord">
            Ubicación{" "}
            {hasCoordinate ? (
              <span className="text-emerald-600">· el pedido ya tiene coordenada</span>
            ) : (
              <span className="text-amber-600">· obligatoria, el pedido no la tiene</span>
            )}
          </label>
          <input
            id="alc-coord"
            value={coordinate}
            onChange={(e) => setCoordinate(e.target.value)}
            placeholder="Pega el enlace de Google Maps o -12.04318, -77.02824"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
          {shortened ? (
            <p className="mt-1 text-xs text-amber-700">
              Ese enlace es acortado (maps.app.goo.gl) y no contiene las coordenadas. Ábrelo en el
              navegador y copia la URL larga que resulta.
            </p>
          ) : null}
        </div>

        <div className={waiting ? "hidden" : "flex gap-2"}>
          <button
            type="button"
            onClick={quote}
            disabled={busy !== null}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {busy === "quote" ? <Spinner /> : null}
            {busy === "quote" ? "Cotizando…" : "Cotizar envío"}
          </button>
        </div>

        {message ? (
          <p
            className={`whitespace-pre-line rounded-lg border px-3 py-2 text-sm ${
              message.kind === "ok"
                ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                : "border-rose-200 bg-rose-50 text-rose-700"
            }`}
          >
            {message.text}
          </p>
        ) : null}

        {preview?.ok ? (
          <div className="space-y-3 border-t border-slate-200 pt-3">
            {/* SOBRE QUÉ PEDIDO Y POR CUÁNTO. Va lo primero y en grande porque son
                las dos cosas que, si están mal, no tienen vuelta atrás: la guía
                queda enganchada al pedido equivocado, o se le cobra de más a la
                clienta en la puerta. Una clienta puede tener varios pedidos a lo
                largo del tiempo, así que ver el número concreto es lo único que
                permite a la operadora darse cuenta antes de pulsar. */}
            <div className="rounded-lg border border-slate-300 bg-white px-3 py-2.5">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-xs text-slate-500">Pedido</span>
                <span className="font-mono text-sm font-semibold text-slate-900">
                  {preview.orderName ?? "—"}
                </span>
              </div>
              <div className="mt-1.5 flex items-baseline justify-between gap-3 border-t border-slate-100 pt-1.5">
                <span className="text-xs text-slate-500">A cobrar en la puerta</span>
                <span className="text-base font-semibold text-slate-900">
                  S/ {(preview.collectTotal ?? 0).toFixed(2)}
                </span>
              </div>
              {preview.orderTotal != null &&
              Math.abs((preview.collectTotal ?? 0) - preview.orderTotal) > 0.005 ? (
                <p className="mt-1.5 text-xs text-amber-700">
                  En Shopify el pedido son S/ {preview.orderTotal.toFixed(2)}. Aliclik solo cobra
                  importes enteros, y con esta cantidad de unidades el total exacto no se puede
                  formar, así que se cobra{" "}
                  <strong>
                    S/ {Math.abs((preview.orderTotal ?? 0) - (preview.collectTotal ?? 0)).toFixed(2)}{" "}
                    menos
                  </strong>
                  . Nunca de más. Si quieres cobrar el importe exacto, ajústalo en el panel de
                  Aliclik después de crear la guía.
                </p>
              ) : null}
            </div>

            {/* Ubigeo: el contraste es el detector de pines mal puestos */}
            {preview.aliclikUbigeo ? (
              <div
                className={`rounded-lg border px-3 py-2 text-xs ${
                  preview.ubigeoMismatch
                    ? "border-amber-300 bg-amber-50 text-amber-900"
                    : "border-slate-200 bg-slate-50 text-slate-600"
                }`}
              >
                <p>
                  <span className="font-medium">Aliclik ubica el pin en:</span>{" "}
                  {[preview.aliclikUbigeo.district, preview.aliclikUbigeo.province, preview.aliclikUbigeo.department]
                    .filter(Boolean)
                    .join(", ")}
                </p>
                <p className="mt-0.5">
                  <span className="font-medium">Nosotros teníamos:</span>{" "}
                  {[preview.ourUbigeo?.district, preview.ourUbigeo?.province, preview.ourUbigeo?.region]
                    .filter(Boolean)
                    .join(", ") || "sin datos"}
                </p>
                {preview.ubigeoMismatch ? (
                  <p className="mt-1 font-medium">
                    ⚠ No coinciden. Comprueba la ubicación antes de crear: el reparto irá a donde
                    apunta el pin, no a la dirección escrita.
                  </p>
                ) : null}
              </div>
            ) : null}

            {preview.warehouseName ? (
              <p className="text-xs text-slate-500">
                Almacén de salida: <span className="font-medium">{preview.warehouseName}</span>
                {preview.items?.length ? ` · ${preview.items.length} producto(s)` : null}
              </p>
            ) : null}

            {preview.warnings?.map((w) => (
              <p key={w} className="text-xs text-amber-700">
                ⚠ {w}
              </p>
            ))}

            {/* Couriers */}
            <div className="space-y-1">
              <p className="text-xs font-medium text-slate-600">Transportadora</p>
              {preview.couriers?.map((c) => (
                <label
                  key={c.transportId}
                  className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
                    c.selectable
                      ? "cursor-pointer border-slate-200 hover:bg-slate-50"
                      : "border-slate-100 bg-slate-50 text-slate-400"
                  }`}
                >
                  <input
                    type="radio"
                    name="alc-courier"
                    disabled={!c.selectable}
                    checked={transportId === c.transportId}
                    onChange={() => setTransportId(c.transportId)}
                  />
                  <span className="flex-1">
                    {c.transportName ?? `Transporte ${c.transportId}`}
                    {c.flagDeliveryExpress ? (
                      <span className="ml-1 text-xs text-brand-700">express</span>
                    ) : null}
                    <span className="ml-2 text-xs text-slate-500">
                      S/ {c.deliveryCost} · devolución S/ {c.returnCost}
                      {c.addDays ? ` · +${c.addDays} día(s)` : ""}
                    </span>
                    {c.reason ? <span className="block text-xs text-amber-700">{c.reason}</span> : null}
                  </span>
                </label>
              ))}
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600" htmlFor="alc-note">
                Nota para el courier (opcional)
              </label>
              <input
                id="alc-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>

            <button
              type="button"
              onClick={create}
              disabled={
                busy !== null ||
                transportId === null ||
                Boolean(preview.writeBlocked) ||
                !riskGate.allowed
              }
              className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-brand-700 px-3 py-2 text-sm font-medium text-white hover:bg-brand-800 disabled:opacity-70"
            >
              {creating ? <Spinner /> : null}
              {creating ? "Creando la guía…" : "Crear guía en Aliclik"}
            </button>
            {/* Mientras se crea, la espera puede pasar de unos segundos: Aliclik
                va lento a ratos y el cliente reintenta hasta tres veces. Un botón
                gris y quieto se lee como "se colgó", y la reacción natural es
                recargar o volver a pulsar — sobre una acción irreversible. Se
                dice explícitamente qué está pasando y qué no hay que hacer. */}
            {creating ? (
              <p className="rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-center text-xs text-brand-800">
                Enviando el pedido a Aliclik. Puede tardar unos segundos si su
                servidor va lento. <strong>No cierres ni recargues esta pantalla.</strong>
              </p>
            ) : null}
            {/* El servidor vuelve a comprobar las dos llaves antes de escribir:
                esto es aviso, no seguridad. Pero evita que alguien pulse un
                botón irreversible para descubrir que estaba cerrado. */}
            <p className="text-center text-xs text-slate-500">
              {preview.writeBlocked ??
                "Crear el pedido en Aliclik es irreversible y solo se puede cancelar en una ventana corta."}
            </p>
          </div>
        ) : null}
        </div>
      </div>
    </Card>
  );
}

/**
 * Indicador de actividad. Existe porque un botón deshabilitado y quieto no
 * distingue "trabajando" de "roto", y aquí la espera puede pasar de unos
 * segundos: Aliclik va lento a ratos y el cliente reintenta hasta tres veces.
 */
function ExistingGuideLinkPanel({
  orderId,
  onLinked,
}: {
  orderId: string;
  onLinked: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [guideCode, setGuideCode] = useState("");
  // Se conserva el tipo del detalle anterior durante la transición al flujo
  // atómico. Nunca se asigna: el servidor resuelve y vincula en una sola acción.
  const [preview] = useState<ExistingAliclikGuidePreview | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [confirmedOrderName, setConfirmedOrderName] = useState("");
  const [manualReason, setManualReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, startTransition] = useTransition();

  const findAndLink = () => {
    setMessage(null);
    setBusy(true);
    startTransition(async () => {
      try {
        const result = await linkExistingAliclikGuide(orderId, guideCode);
        if (result.error) {
          setMessage({ kind: "error", text: result.error });
          return;
        }
        setMessage({
          kind: "ok",
          text: result.notice ?? "Guía vinculada y seguimiento activado.",
        });
        setGuideCode("");
        onLinked();
      } finally {
        setBusy(false);
      }
    });
  };
  const link = findAndLink;

  return (
    <div className="rounded-xl border border-sky-200 bg-sky-50/60">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between gap-4 px-3 py-3 text-left"
        aria-expanded={open}
      >
        <span>
          <span className="block text-sm font-semibold text-slate-900">
            Vincular una guía ya creada en Aliclik
          </span>
          <span className="mt-0.5 block text-xs text-slate-600">
            La busca, valida duplicados y activa el seguimiento en un solo paso.
          </span>
        </span>
        <span className="text-base text-sky-700" aria-hidden="true">
          {open ? "−" : "+"}
        </span>
      </button>

      {open ? (
        <div className="space-y-3 border-t border-sky-200 px-3 py-3">
          <div className="flex gap-2">
            <input
              value={guideCode}
              onChange={(event) => {
                setGuideCode(event.target.value);
                setMessage(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && guideCode.trim() && !pending) findAndLink();
              }}
              placeholder="Número de guía Aliclik"
              aria-label="Número de guía Aliclik existente"
              className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm uppercase"
            />
            <button
              type="button"
              onClick={findAndLink}
              disabled={!guideCode.trim() || pending}
              className="inline-flex items-center gap-2 rounded-lg bg-sky-700 px-3 py-2 text-sm font-medium text-white hover:bg-sky-800 disabled:opacity-50"
            >
              {busy ? <Spinner /> : null}
              {busy ? "Buscando y vinculando…" : "Buscar y vincular guía"}
            </button>
          </div>

          <p className="text-xs leading-5 text-slate-600">
            Si no existe, pertenece a otro pedido o ya está vinculada, no se modifica nada.
          </p>

          {message ? (
            <p
              className={`rounded-lg border px-3 py-2 text-sm ${
                message.kind === "ok"
                  ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                  : "border-rose-200 bg-rose-50 text-rose-700"
              }`}
            >
              {message.text}
            </p>
          ) : null}

          {preview?.ok ? (
            <div className="space-y-3 rounded-lg border border-slate-200 bg-white p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-mono text-sm font-semibold text-slate-900">
                    {preview.guideCode}
                  </p>
                  {preview.orderNumber && preview.orderNumber !== preview.guideCode ? (
                    <p className="mt-0.5 text-xs text-slate-500">
                      Pedido técnico Aliclik: {preview.orderNumber}
                    </p>
                  ) : null}
                  <p className="mt-0.5 text-xs text-slate-500">{preview.statusLabel ?? "Sin estado"}</p>
                </div>
                {preview.total != null ? (
                  <p className="text-sm font-semibold text-slate-900">
                    S/ {preview.total.toFixed(2)}
                  </p>
                ) : null}
              </div>

              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-slate-100 pt-2 text-xs">
                <div>
                  <dt className="text-slate-500">
                    {preview.verificationMode === "manual_portal"
                      ? "Cliente del pedido"
                      : "Cliente en Aliclik"}
                  </dt>
                  <dd className="mt-0.5 font-medium text-slate-800">
                    {preview.customerName ?? "No informado"}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500">Teléfono</dt>
                  <dd className="mt-0.5 font-medium text-slate-800">
                    {preview.customerPhone ?? "No informado"}
                  </dd>
                </div>
                <div className="col-span-2">
                  <dt className="text-slate-500">Destino</dt>
                  <dd className="mt-0.5 text-slate-800">
                    {[
                      preview.shippingAddress,
                      preview.shippingDistrict,
                      preview.shippingProvince,
                      preview.shippingDepartment,
                    ]
                      .filter(Boolean)
                      .join(" · ") || "No informado"}
                  </dd>
                </div>
                {preview.productDetail ? (
                  <div className="col-span-2">
                    <dt className="text-slate-500">Producto</dt>
                    <dd className="mt-0.5 text-slate-800">{preview.productDetail}</dd>
                  </div>
                ) : null}
              </dl>

              {preview.matchExplanation ? (
                <p className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900">
                  {preview.verificationMode === "manual_portal"
                    ? `El código de guía coincide por ${preview.matchExplanation}.`
                    : `Coincidencia validada por ${preview.matchExplanation}. Aliclik no expone el código ` +
                      "impreso AUR5X por API; el pedido técnico mostrado arriba sí fue validado."}
                </p>
              ) : null}

              {preview.verificationMode === "manual_portal" ? (
                <div className="space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
                  <div>
                    <p className="font-semibold">
                      {preview.codeMatchesOrder
                        ? "Vinculación excepcional auditada"
                        : "Vinculación bajo tu responsabilidad"}
                    </p>
                    <p className="mt-1 text-xs leading-5">
                      La API oficial solo lista pedidos creados por la integración con código ALC.
                      Esta guía creada en el portal AURELA/KENKU no puede aparecer allí.{" "}
                      {preview.codeMatchesOrder ? (
                        <>
                          El código sí termina en el número de {preview.expectedOrderName}; también
                          se comprobará que no esté vinculado a otro pedido.
                        </>
                      ) : (
                        <>
                          Y su código <strong>no lleva dentro el número de{" "}
                          {preview.expectedOrderName}</strong>, así que nada corrobora que sea de
                          este pedido salvo lo que afirmes aquí. Se comprobará que no esté vinculada
                          a otro pedido, pero eso no dice que sea de este. Si te equivocas, este
                          pedido cargará el desenlace de un paquete ajeno y el dueño real quedará
                          figurando sin salida.
                        </>
                      )}
                    </p>
                    {preview.apiCandidateCount != null ? (
                      <p className="mt-1 text-xs">
                        Consulta API: {preview.apiCandidateCount} pedidos ALC revisados
                        {preview.apiMatchSummary
                          ? `; mejor coincidencia auxiliar: ${preview.apiMatchSummary}.`
                          : "."}
                      </p>
                    ) : null}
                  </div>
                  <label className="block">
                    <span className="text-xs font-medium">
                      Confirma el pedido escribiendo {preview.expectedOrderName}
                    </span>
                    <input
                      value={confirmedOrderName}
                      onChange={(event) => setConfirmedOrderName(event.target.value)}
                      placeholder={preview.expectedOrderName ?? "Código del pedido"}
                      className="mt-1 w-full rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm uppercase"
                    />
                  </label>
                  <label className="block">
                    <span className="text-xs font-medium">Motivo de la vinculación</span>
                    <textarea
                      value={manualReason}
                      onChange={(event) => setManualReason(event.target.value)}
                      placeholder="Ej.: Guía creada directamente en el portal Aliclik."
                      rows={2}
                      className="mt-1 w-full resize-none rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm"
                    />
                  </label>
                </div>
              ) : null}

              {preview.phoneMatches === false || preview.totalMatches === false ? (
                <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  <p className="font-semibold">Revisa antes de vincular</p>
                  {preview.phoneMatches === false ? (
                    <p className="mt-0.5">El teléfono de Aliclik no coincide con el del pedido.</p>
                  ) : null}
                  {preview.totalMatches === false ? (
                    <p className="mt-0.5">El monto de Aliclik no coincide con el total del pedido.</p>
                  ) : null}
                </div>
              ) : null}

              {preview.alreadyLinked ? (
                <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                  Esta guía ya está vinculada a este pedido y su seguimiento está activo.
                </p>
              ) : (
                <button
                  type="button"
                  onClick={link}
                  disabled={
                    pending ||
                    (preview.verificationMode === "manual_portal" &&
                      (!confirmedOrderName.trim() || manualReason.trim().length < 8))
                  }
                  className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-sky-700 px-3 py-2 text-sm font-medium text-white hover:bg-sky-800 disabled:opacity-60"
                >
                  {busy ? <Spinner /> : null}
                  {busy ? "Vinculando…" : "Vincular y activar seguimiento"}
                </button>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Spinner() {
  return (
    <svg
      className="h-3.5 w-3.5 animate-spin"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" opacity="0.25" />
      <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
    </svg>
  );
}
