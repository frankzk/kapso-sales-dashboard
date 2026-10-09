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

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { cn } from "@/components/ui";
import {
  Badge,
  Banner,
  CARD_ZONE,
  FIELD,
  FIELD_BOX,
  OpsButton,
  OptionTile,
  SectionHead,
  Step,
  type BadgeTone,
} from "@/components/ops-ui";
import { IconAlert, IconChevronDown } from "@/components/icons";
import { AliclikDuplicatePanel } from "@/components/aliclik-duplicate-panel";
import { AliclikOutlookBanner } from "@/components/aliclik-outlook";
import type { AliclikOutlook } from "@/lib/aliclik-outlook";
import type { DuplicateHold } from "@/lib/aliclik-duplicate";
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
 * El foco de salud de la API de Aliclik, como chapa en la cabecera. Solo
 * informa; no bloquea el botón —un pin puntual puede fallar con la API verde y
 * viceversa—.
 *
 * Cubre los DOS caminos. Antes solo miraba la sonda de cotización, así que un día
 * en que cotizar iba fino y crear se caía lo pintaba verde: la asesora pulsaba
 * confiando en él y se llevaba el pedido bloqueado. El ámbar es ese caso, y por
 * eso su explicación se lee en un aviso y no solo al pasar el ratón.
 */
const HEALTH_TONE: Record<HealthTone, BadgeTone> = {
  verde: "ok",
  ambar: "warn",
  rojo: "crit",
  gris: "neutral",
};

const LABEL = "grid gap-1.5 text-[13px] font-medium text-ink-700";
const HELP = "text-[13px] font-normal leading-5 text-ink-500";
const INPUT = cn(FIELD, "font-normal pointer-coarse:h-11");

export function AliclikGuidePanel({
  orderId,
  hasCoordinate,
  health,
  riskRequirement = "ninguno",
  paymentState = null,
  riskReasons = [],
  duplicateHold,
  outlook,
  storeName,
  onDuplicateChanged,
  onCreated,
}: {
  orderId: string;
  hasCoordinate: boolean;
  health: AliclikHealthState;
  riskRequirement?: PaymentRequirement;
  paymentState?: string | null;
  riskReasons?: string[];
  duplicateHold?: DuplicateHold | null;
  /** Cuántas guías de Aliclik se entregan según los días del pedido (09-10-2026). */
  outlook?: AliclikOutlook | null;
  storeName?: string | null;
  onDuplicateChanged?: () => void;
  onCreated: () => void;
}) {
  const [coordinate, setCoordinate] = useState("");
  const [duplicateAllowed, setDuplicateAllowed] = useState(false);
  const [preview, setPreview] = useState<AliclikPreview | null>(null);
  const [transportId, setTransportId] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [riskExceptionReason, setRiskExceptionReason] = useState("");
  const [pinExceptionReason, setPinExceptionReason] = useState("");
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string; at: "quote" | "create" } | null>(null);
  const [pending, startTransition] = useTransition();
  const uid = useId();
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
      const res = await previewAliclikGuide(orderId, {
        coordinate: coordinate || null,
        pinExceptionReason: pinExceptionReason || null,
      });
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
      if (!res.ok && res.error) setMessage({ kind: "error", text: res.error, at: "quote" });
      } finally {
        setBusy(null);
      }
    });
  };

  const create = () => {
    if (transportId === null || !duplicateAllowed) return;
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
        pinExceptionReason: pinExceptionReason || null,
      });
      if (res.error) setMessage({ kind: "error", text: res.error, at: "create" });
      else {
        setMessage({ kind: "ok", text: res.notice ?? "Guía creada.", at: "create" });
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

  const healthCopy = describeAliclikHealth(health);
  // El motivo por el que «Crear» está apagado, en texto y al lado del botón: un
  // botón deshabilitado sin explicación se lee como roto. El servidor vuelve a
  // comprobar todas las llaves; esto es para no descubrirlo al pulsar.
  const createBlockReason = !preview?.ok
    ? null
    : preview.writeBlocked
      ? preview.writeBlocked
      : !duplicateAllowed
        ? "Resuelve primero la retención por posible duplicado, arriba."
        : !riskGate.allowed
          ? "Justifica la excepción de pago, arriba."
          : transportId === null
            ? "Elige una transportadora."
            : null;
  const cheapestId = (preview?.couriers ?? [])
    .filter((c) => c.selectable)
    .sort((a, b) => a.deliveryCost - b.deliveryCost)[0]?.transportId;
  const roundedDown =
    preview?.ok &&
    preview.orderTotal != null &&
    Math.abs((preview.collectTotal ?? 0) - preview.orderTotal) > 0.005;
  const place = (parts: (string | null | undefined)[]) => parts.filter(Boolean).join(", ");

  // `@container`: el mismo panel vive en la tarjeta de la ficha (~790 px) y en
  // la media columna del cajón de Leads (~400 px); las rejillas miran su ancho,
  // no el de la ventana.
  return (
    <div className="@container">
      <SectionHead
        title="Crear guía en Aliclik"
        help="Cotiza primero: la cotización no crea nada y sirve para confirmar cobertura y ubicación."
        aside={
          <Badge tone={HEALTH_TONE[healthCopy.tone]} title={healthCopy.hint}>
            {healthCopy.label}
          </Badge>
        }
      />

      <div className="space-y-5 pt-4 sm:pt-5">
        {/* LO QUE PARA LA ESCRITURA, ANTES DE LOS PASOS. Riesgo de pago (§8),
            posible duplicado (§8.3) y la API de creación caída: se leen antes
            de cotizar, no al pie después de pulsar. `empty:hidden` porque el
            panel de duplicado no dibuja nada cuando no hay caso. */}
        <div className="space-y-3 empty:hidden">
          {(healthCopy.tone === "ambar" || healthCopy.tone === "rojo") && (
            <Banner tone={healthCopy.tone === "rojo" ? "crit" : "warn"} title={healthCopy.label}>
              <p>{healthCopy.hint}</p>
            </Banner>
          )}

          {riskGate.requiresException && (
            <Banner tone="warn" title={PAYMENT_REQUIREMENT_LABEL[riskRequirement]}>
              <p>
                Aliclik cobra el intento no entregado. Valida el pago exigido o registra por qué autorizas esta
                excepción.
              </p>
              {riskReasons.length > 0 && (
                <ul className="mt-2 list-disc space-y-0.5 pl-4 text-[13px] leading-5">
                  {riskReasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              )}
              <label className={cn(LABEL, "mt-3")}>
                Justificación de la excepción
                <textarea
                  value={riskExceptionReason}
                  onChange={(event) => setRiskExceptionReason(event.target.value)}
                  rows={2}
                  placeholder="Ej. Cliente recurrente; confirmó que recibe hoy."
                  className={cn(FIELD_BOX, "w-full px-3 py-2 font-normal leading-5")}
                />
              </label>
            </Banner>
          )}

          <AliclikDuplicatePanel
            key={orderId}
            orderId={orderId}
            initialHold={duplicateHold}
            onGateChange={setDuplicateAllowed}
            onChanged={onDuplicateChanged}
          />

          {/* Un aviso, no un bloqueo: va después de lo que sí para la
              escritura. Solo con entrega baja; si no, no dice nada. */}
          <AliclikOutlookBanner outlook={outlook} storeName={storeName} />
        </div>

        {/* Creada la guía, la cotización se borra y con ella el paso 3: el
            aviso de éxito (o el error que la dejó sin cotización) va aquí. */}
        {message?.at === "create" && !preview?.ok && (
          <Banner tone={message.kind === "ok" ? "ok" : "crit"} role={message.kind === "ok" ? "status" : "alert"}>
            <p className="whitespace-pre-line">{message.text}</p>
          </Banner>
        )}

        <ol aria-label="Pasos para crear la guía">
          <Step
            n={1}
            title="Ubicación y cotización"
            done={Boolean(preview?.ok)}
            badge={
              hasCoordinate ? (
                <Badge tone="ok">El pedido ya tiene coordenada</Badge>
              ) : (
                <Badge tone="warn">Obligatoria: el pedido no la tiene</Badge>
              )
            }
          >
            {/* Esperando a Shopify: ni campo de coordenada ni botón de cotizar.
                Ambos pedirían a la vendedora un trabajo que el webhook hace solo. */}
            {waiting && (
              <div role="status" className="rounded-lg bg-wash px-4 py-3 text-sm text-ink-700">
                <p className="flex items-center gap-2 font-semibold text-ink-900">
                  <Spinner />
                  Preparando el pedido…
                </p>
                <p className="mt-0.5 text-[13px] leading-5 text-ink-600">
                  Shopify todavía no nos ha devuelto la dirección. Tarda unos segundos y no hay que hacer nada.
                </p>
                {retries > MAX_RETRIES && (
                  <OpsButton size="sm" onClick={quote} disabled={pending} className="mt-3 pointer-coarse:h-11">
                    {pending ? "Comprobando…" : "Está tardando más de lo normal · reintentar"}
                  </OpsButton>
                )}
              </div>
            )}

            <div className={waiting ? "hidden" : "space-y-3"}>
              <label className={LABEL} htmlFor={`${uid}-coord`}>
                Ubicación
                <input
                  id={`${uid}-coord`}
                  value={coordinate}
                  onChange={(e) => setCoordinate(e.target.value)}
                  placeholder="Enlace de Google Maps o coordenada"
                  aria-describedby={`${uid}-coord-help`}
                  className={INPUT}
                />
                <span id={`${uid}-coord-help`} className={HELP}>
                  Pega el enlace que mandó la clienta o la coordenada, por ejemplo -12.04318, -77.02824.
                </span>
              </label>
              {shortened && (
                <p className="text-[13px] leading-5 text-warn-fg">
                  Ese enlace es acortado (maps.app.goo.gl) y no contiene las coordenadas. Ábrelo en el navegador y
                  copia la URL larga que resulta.
                </p>
              )}
              {/* Hasta tener cotización, cotizar es lo que toca y va en azul; con
                  ella, el azul pasa a «Crear guía» y esto queda para recotizar. */}
              <OpsButton
                variant={preview?.ok ? "secondary" : "primary"}
                onClick={quote}
                disabled={busy !== null}
                className="pointer-coarse:h-11"
              >
                {busy === "quote" && <Spinner />}
                {busy === "quote" ? "Cotizando…" : "Cotizar envío"}
              </OpsButton>
            </div>

            {/* El pin sin respaldo ya trae su propio aviso: el error genérico
                lo repetía justo encima. */}
            {message?.at === "quote" && !preview?.pinSinCorroborar && (
              <Banner tone={message.kind === "ok" ? "ok" : "crit"} role="alert">
                <p className="whitespace-pre-line">{message.text}</p>
              </Banner>
            )}

            {/* EL PIN CONTRADICHO POR EL PEDIDO (§10). Es el único bloqueo que va
                dentro de un paso y no sobre ellos: es la respuesta de la propia
                cotización, así que se lee junto a «Cotizar envío». Va fuera de
                la revisión porque cuando salta la cotización devuelve `ok: false`. No es el
                aviso de ubigeo, que es ámbar y sale en la mitad de los pedidos:
                aquí el destino entero está en discusión, así que cierra la
                emisión hasta que alguien escriba por qué el pin es el correcto. */}
            {preview?.pinSinCorroborar && (
              <Banner tone="crit" role="alert" title="El pedido no respalda este pin">
                <p>{preview.pinSinCorroborar}</p>
                {preview.ok ? (
                  <p className="mt-2 font-semibold text-ink-900">
                    Vas a emitir con la excepción que escribiste. Queda registrada en el pedido.
                  </p>
                ) : (
                  <>
                    <label className={cn(LABEL, "mt-3")}>
                      Si el pin es el correcto, escribe por qué
                      <textarea
                        value={pinExceptionReason}
                        onChange={(event) => setPinExceptionReason(event.target.value)}
                        rows={2}
                        placeholder="Ej. La clienta eligió mal el departamento; confirmó por WhatsApp que vive en Pucallpa."
                        className={cn(FIELD_BOX, "w-full px-3 py-2 font-normal leading-5")}
                      />
                    </label>
                    <p className="mt-1.5 text-[13px] leading-5">Queda registrado en el pedido. Vuelve a cotizar para continuar.</p>
                  </>
                )}
              </Banner>
            )}
          </Step>

          <Step
            n={2}
            title="Revisa antes de crear"
            done={false}
            help={preview?.ok ? undefined : "Al cotizar: el pedido, lo que se cobra en la puerta, el recojo y dónde cae el pin."}
          >
            {preview?.ok && (
              <>
                {/* SOBRE QUÉ PEDIDO Y POR CUÁNTO. Primero y en grande porque son
                    las dos cosas que, si están mal, no tienen vuelta atrás: la
                    guía queda enganchada al pedido equivocado, o se le cobra de
                    más a la clienta en la puerta. */}
                <div className="overflow-hidden rounded-md ring-1 ring-line">
                <dl className="grid grid-cols-2 gap-px bg-line">
                  <div className="bg-wash px-3 py-2.5">
                    <dt className="text-[13px] leading-5 text-ink-500">Pedido</dt>
                    <dd className="mt-0.5 font-mono text-base font-semibold leading-6 text-ink-900">
                      {preview.orderName ?? "—"}
                    </dd>
                  </div>
                  <div className="bg-wash px-3 py-2.5">
                    <dt className="text-[13px] leading-5 text-ink-500">A cobrar en la puerta</dt>
                    <dd className="mt-0.5 text-lg font-semibold leading-6 tabular-nums text-ink-900">
                      S/ {(preview.collectTotal ?? 0).toFixed(2)}
                    </dd>
                  </div>
                </dl>
                {/* Una nota de la operación, no un bloqueo: va pegada a la cifra
                    que explica, en el lavado del marco. */}
                {roundedDown && (
                  <p className="border-t border-line bg-wash px-3 py-2 text-[13px] leading-5 text-ink-600">
                    En Shopify el pedido son S/ {preview.orderTotal!.toFixed(2)}. Aliclik solo cobra importes enteros, y
                    con esta cantidad de unidades el total exacto no se puede formar, así que se cobra{" "}
                    <b className="font-semibold text-ink-900">
                      S/ {Math.abs((preview.orderTotal ?? 0) - (preview.collectTotal ?? 0)).toFixed(2)} menos
                    </b>
                    . Nunca de más. Si quieres cobrar el importe exacto, ajústalo en el panel de Aliclik después de crear
                    la guía.
                  </p>
                )}
                </div>

                {/* El recojo se enseña siempre —la asesora se lo dice a la
                    clienta—; el pin de Aliclik contra el nuestro es el detector
                    de pines mal puestos. */}
                <dl className="divide-y divide-line rounded-md ring-1 ring-line">
                  {preview.dispatch && (
                    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-3 py-2">
                      <dt className="text-[13px] leading-5 text-ink-500">Recojo</dt>
                      <dd className={cn("text-sm", preview.dispatch.fallsOnSunday ? "font-semibold text-warn-fg" : "text-ink-900")}>
                        {formatDispatchDate(preview.dispatch.date)}
                      </dd>
                    </div>
                  )}
                  {preview.aliclikUbigeo && (
                    <>
                      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-3 py-2">
                        <dt className="text-[13px] leading-5 text-ink-500">Aliclik ubica el pin en</dt>
                        <dd className={cn("text-sm", preview.ubigeoMismatch ? "font-semibold text-warn-fg" : "text-ink-900")}>
                          {place([preview.aliclikUbigeo.district, preview.aliclikUbigeo.province, preview.aliclikUbigeo.department])}
                        </dd>
                      </div>
                      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-3 py-2">
                        <dt className="text-[13px] leading-5 text-ink-500">Nosotros teníamos</dt>
                        <dd className="text-sm text-ink-900">
                          {place([preview.ourUbigeo?.district, preview.ourUbigeo?.province, preview.ourUbigeo?.region]) || "sin datos"}
                        </dd>
                      </div>
                    </>
                  )}
                  {preview.warehouseName && (
                    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-3 py-2">
                      <dt className="text-[13px] leading-5 text-ink-500">Almacén de salida</dt>
                      <dd className="text-sm text-ink-900">
                        {preview.warehouseName}
                        {preview.items?.length ? (
                          <span className="text-ink-500"> · {preview.items.length} producto(s)</span>
                        ) : null}
                      </dd>
                    </div>
                  )}
                </dl>

                {/* Se marca cuando Aliclik va a fecharlo en domingo, el día que
                    no recogen y el que provoca la discusión con el motorizado. */}
                {preview.dispatch?.fallsOnSunday && (
                  <Banner tone="warn" title="Aliclik lo fechará en domingo">
                    <p>
                      Ya pasó la hora de corte, así que a Aliclik le toca fecharlo en <b className="font-semibold text-ink-900">domingo</b>,
                      que no recogen. Su regla dice que lo mueva al lunes, pero se les ha visto no hacerlo:{" "}
                      <b className="font-semibold text-ink-900">revisa la fecha en su portal</b> al terminar, o el lunes el
                      motorizado no se lo lleva.
                    </p>
                  </Banner>
                )}
                {preview.ubigeoMismatch && (
                  <Banner tone="warn" title="No coinciden">
                    <p>Comprueba la ubicación antes de crear: el reparto irá a donde apunta el pin, no a la dirección escrita.</p>
                  </Banner>
                )}
                {/* Los avisos de la cotización van después: el domingo y el pin
                    explican la fila de arriba y tienen que quedar pegados a ella. */}
                {preview.warnings?.length ? (
                  <ul className="space-y-1 text-[13px] leading-5 text-warn-fg">
                    {preview.warnings.map((w) => (
                      <li key={w} className="flex gap-1.5">
                        <IconAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                        {w}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </>
            )}
          </Step>

          <Step
            n={3}
            title="Transportadora y creación"
            done={false}
            last
            help={preview?.ok ? undefined : "Al cotizar: las transportadoras que llegan, con su precio."}
          >
            {preview?.ok && (
              <>
                {/* El título del paso ya dice «Transportadora»: aquí solo el
                    nombre del grupo para el lector de pantalla. */}
                <div role="group" aria-label="Transportadora">
                  <div className="grid gap-2 @lg:grid-cols-2">
                    {preview.couriers?.map((c) => (
                      <OptionTile
                        key={c.transportId}
                        label={c.transportName ?? `Transporte ${c.transportId}`}
                        badge={
                          <>
                            {c.selectable && c.transportId === cheapestId && <Badge tone="ok">Más barata</Badge>}
                            {c.flagDeliveryExpress && <Badge tone="brand">Express</Badge>}
                          </>
                        }
                        aside={`S/ ${c.deliveryCost.toFixed(2)}`}
                        description={
                          c.selectable ? (
                            `Devolución S/ ${c.returnCost.toFixed(2)}${c.addDays ? ` · +${c.addDays} día(s)` : ""}`
                          ) : (
                            // Apagada, lo primero es por qué no se puede elegir.
                            <>
                              <span className="block text-warn-fg">{c.reason ?? "No se puede elegir para este pedido."}</span>
                              Devolución S/ {c.returnCost.toFixed(2)}
                              {c.addDays ? ` · +${c.addDays} día(s)` : ""}
                            </>
                          )
                        }
                        active={transportId === c.transportId}
                        disabled={!c.selectable}
                        onClick={() => setTransportId(c.transportId)}
                      />
                    ))}
                  </div>
                </div>

                <label className={LABEL} htmlFor={`${uid}-note`}>
                  Nota para el courier (opcional)
                  <input id={`${uid}-note`} value={note} onChange={(e) => setNote(e.target.value)} className={INPUT} />
                </label>

                {/* Mientras se crea, la espera puede pasar de unos segundos:
                    Aliclik va lento a ratos y el cliente reintenta hasta tres
                    veces. Un botón gris y quieto se lee como "se colgó", y la
                    reacción natural es recargar o volver a pulsar — sobre una
                    acción irreversible. */}
                {creating && (
                  <Banner tone="info" role="status" title="Enviando el pedido a Aliclik">
                    <p>
                      Puede tardar unos segundos si su servidor va lento.{" "}
                      <b className="font-semibold text-ink-900">No cierres ni recargues esta pantalla.</b>
                    </p>
                  </Banner>
                )}
                {message?.at === "create" && (
                  <Banner tone={message.kind === "ok" ? "ok" : "crit"} role={message.kind === "ok" ? "status" : "alert"}>
                    <p className="whitespace-pre-line">{message.text}</p>
                  </Banner>
                )}

                {/* El servidor vuelve a comprobar las llaves antes de escribir:
                    esto es aviso, no seguridad. Pero evita que alguien pulse un
                    botón irreversible para descubrir que estaba cerrado. */}
                <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2 pt-1">
                  <p
                    id={`${uid}-create-why`}
                    className={cn("mr-auto max-w-md text-[13px] leading-5", createBlockReason ? "text-warn-fg" : "text-ink-500")}
                  >
                    {createBlockReason ??
                      "Crear el pedido en Aliclik es irreversible y solo se puede cancelar en una ventana corta."}
                  </p>
                  <OpsButton
                    variant="primary"
                    onClick={create}
                    disabled={busy !== null || createBlockReason !== null}
                    aria-describedby={`${uid}-create-why`}
                    className="pointer-coarse:h-11"
                  >
                    {creating && <Spinner />}
                    {creating ? "Creando la guía…" : "Crear guía en Aliclik"}
                  </OpsButton>
                </div>
              </>
            )}
          </Step>
        </ol>
      </div>

      {/* La excepción, no el camino normal: la guía que alguien ya creó en el
          portal se vincula desde el pie de la tarjeta. */}
      <div className={cn(CARD_ZONE, "mt-5")}>
        <ExistingGuideLinkPanel orderId={orderId} onLinked={onCreated} />
      </div>
    </div>
  );
}

/**
 * Vincular una guía que alguien ya creó en el portal de Aliclik (§10.1): la
 * busca, valida duplicados y activa el seguimiento en una sola acción.
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
  const uid = useId();

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
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={`${uid}-link`}
        className="-mx-2 flex w-[calc(100%+1rem)] items-center justify-between gap-4 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-wash pointer-coarse:min-h-11"
      >
        <span className="min-w-0">
          <span className="block text-sm font-semibold leading-5 text-ink-900">Vincular una guía ya creada en Aliclik</span>
          <span className="mt-0.5 block text-[13px] leading-5 text-ink-500">
            La busca, valida duplicados y activa el seguimiento en un solo paso.
          </span>
        </span>
        <IconChevronDown
          aria-hidden
          className={cn("size-4 shrink-0 text-ink-500 transition-transform motion-reduce:transition-none", open && "rotate-180")}
        />
      </button>

      {open && (
        <div id={`${uid}-link`} className="space-y-3 pt-3">
          <div className="flex flex-wrap gap-2">
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
              className={cn(FIELD_BOX, "h-9 min-w-0 flex-1 basis-56 px-3 font-mono uppercase pointer-coarse:h-11")}
            />
            <OpsButton onClick={findAndLink} disabled={!guideCode.trim() || pending} className="pointer-coarse:h-11">
              {busy && <Spinner />}
              {busy ? "Buscando y vinculando…" : "Buscar y vincular guía"}
            </OpsButton>
          </div>

          <p className={HELP}>Si no existe, pertenece a otro pedido o ya está vinculada, no se modifica nada.</p>

          {message && (
            <Banner tone={message.kind === "ok" ? "ok" : "crit"} role={message.kind === "ok" ? "status" : "alert"}>
              <p>{message.text}</p>
            </Banner>
          )}

          {/* El detalle del flujo anterior (vista previa y confirmación del
              portal). Hoy el servidor resuelve y vincula en una sola acción y
              `preview` nunca se asigna; se conserva vestido igual por si vuelve. */}
          {preview?.ok ? (
            <div className="space-y-3 rounded-lg p-3 ring-1 ring-line">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-mono text-sm font-semibold text-ink-900">{preview.guideCode}</p>
                  {preview.orderNumber && preview.orderNumber !== preview.guideCode ? (
                    <p className="mt-0.5 text-[13px] leading-5 text-ink-500">Pedido técnico Aliclik: {preview.orderNumber}</p>
                  ) : null}
                  <p className="mt-0.5 text-[13px] leading-5 text-ink-500">{preview.statusLabel ?? "Sin estado"}</p>
                </div>
                {preview.total != null ? (
                  <p className="text-sm font-semibold tabular-nums text-ink-900">S/ {preview.total.toFixed(2)}</p>
                ) : null}
              </div>

              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-line pt-2 text-[13px] leading-5">
                <div>
                  <dt className="text-ink-500">
                    {preview.verificationMode === "manual_portal" ? "Cliente del pedido" : "Cliente en Aliclik"}
                  </dt>
                  <dd className="mt-0.5 font-medium text-ink-900">{preview.customerName ?? "No informado"}</dd>
                </div>
                <div>
                  <dt className="text-ink-500">Teléfono</dt>
                  <dd className="mt-0.5 font-medium text-ink-900">{preview.customerPhone ?? "No informado"}</dd>
                </div>
                <div className="col-span-2">
                  <dt className="text-ink-500">Destino</dt>
                  <dd className="mt-0.5 text-ink-900">
                    {[preview.shippingAddress, preview.shippingDistrict, preview.shippingProvince, preview.shippingDepartment]
                      .filter(Boolean)
                      .join(" · ") || "No informado"}
                  </dd>
                </div>
                {preview.productDetail ? (
                  <div className="col-span-2">
                    <dt className="text-ink-500">Producto</dt>
                    <dd className="mt-0.5 text-ink-900">{preview.productDetail}</dd>
                  </div>
                ) : null}
              </dl>

              {preview.matchExplanation ? (
                <Banner tone="info">
                  <p>
                    {preview.verificationMode === "manual_portal"
                      ? `El código de guía coincide por ${preview.matchExplanation}.`
                      : `Coincidencia validada por ${preview.matchExplanation}. Aliclik no expone el código ` +
                        "impreso AUR5X por API; el pedido técnico mostrado arriba sí fue validado."}
                  </p>
                </Banner>
              ) : null}

              {preview.verificationMode === "manual_portal" ? (
                <Banner
                  tone="warn"
                  title={preview.codeMatchesOrder ? "Vinculación excepcional auditada" : "Vinculación bajo tu responsabilidad"}
                >
                  <p>
                    La API oficial solo lista pedidos creados por la integración con código ALC. Esta guía creada en el
                    portal AURELA/KENKU no puede aparecer allí.{" "}
                    {preview.codeMatchesOrder ? (
                      <>
                        El código sí termina en el número de {preview.expectedOrderName}; también se comprobará que no
                        esté vinculado a otro pedido.
                      </>
                    ) : (
                      <>
                        Y su código{" "}
                        <b className="font-semibold text-ink-900">no lleva dentro el número de {preview.expectedOrderName}</b>,
                        así que nada corrobora que sea de este pedido salvo lo que afirmes aquí. Se comprobará que no
                        esté vinculada a otro pedido, pero eso no dice que sea de este. Si te equivocas, este pedido
                        cargará el desenlace de un paquete ajeno y el dueño real quedará figurando sin salida.
                      </>
                    )}
                  </p>
                  {preview.apiCandidateCount != null ? (
                    <p className="mt-1 text-[13px] leading-5">
                      Consulta API: {preview.apiCandidateCount} pedidos ALC revisados
                      {preview.apiMatchSummary ? `; mejor coincidencia auxiliar: ${preview.apiMatchSummary}.` : "."}
                    </p>
                  ) : null}
                  <label className={cn(LABEL, "mt-3")}>
                    Confirma el pedido escribiendo {preview.expectedOrderName}
                    <input
                      value={confirmedOrderName}
                      onChange={(event) => setConfirmedOrderName(event.target.value)}
                      placeholder={preview.expectedOrderName ?? "Código del pedido"}
                      className={cn(INPUT, "uppercase")}
                    />
                  </label>
                  <label className={cn(LABEL, "mt-3")}>
                    Motivo de la vinculación
                    <textarea
                      value={manualReason}
                      onChange={(event) => setManualReason(event.target.value)}
                      placeholder="Ej.: Guía creada directamente en el portal Aliclik."
                      rows={2}
                      className={cn(FIELD_BOX, "w-full resize-none px-3 py-2 font-normal leading-5")}
                    />
                  </label>
                </Banner>
              ) : null}

              {preview.phoneMatches === false || preview.totalMatches === false ? (
                <Banner tone="warn" title="Revisa antes de vincular">
                  {preview.phoneMatches === false ? <p>El teléfono de Aliclik no coincide con el del pedido.</p> : null}
                  {preview.totalMatches === false ? <p>El monto de Aliclik no coincide con el total del pedido.</p> : null}
                </Banner>
              ) : null}

              {preview.alreadyLinked ? (
                <Banner tone="ok">
                  <p>Esta guía ya está vinculada a este pedido y su seguimiento está activo.</p>
                </Banner>
              ) : (
                <OpsButton
                  variant="primary"
                  onClick={link}
                  disabled={
                    pending ||
                    (preview.verificationMode === "manual_portal" &&
                      (!confirmedOrderName.trim() || manualReason.trim().length < 8))
                  }
                  className="w-full pointer-coarse:h-11"
                >
                  {busy && <Spinner />}
                  {busy ? "Vinculando…" : "Vincular y activar seguimiento"}
                </OpsButton>
              )}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * "2026-09-07" → "lunes 7 de septiembre". Se construye con UTC a propósito: la
 * fecha ya viene resuelta en hora de Lima, así que interpretarla en la zona del
 * navegador la correría un día para quien mire desde otro huso.
 */
function formatDispatchDate(dateKey: string): string {
  const d = new Date(`${dateKey}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return dateKey;
  return new Intl.DateTimeFormat("es-PE", {
    timeZone: "UTC",
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(d);
}

/**
 * Indicador de actividad. Existe porque un botón deshabilitado y quieto no
 * distingue "trabajando" de "roto", y aquí la espera puede pasar de unos
 * segundos: Aliclik va lento a ratos y el cliente reintenta hasta tres veces.
 */
function Spinner() {
  return (
    <svg className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" opacity="0.25" />
      <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
    </svg>
  );
}
