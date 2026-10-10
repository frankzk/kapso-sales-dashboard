"use client";

// Comprobar si Aliclik llega a un destino clasificado como Agencia.
//
// POR QUÉ EXISTE. La clasificación decide a dónde va el paquete; hasta ahora
// decidía además si teníamos derecho a PREGUNTARLE a Aliclik si llega. Con la
// pregunta escondida detrás de la respuesta, una clasificación equivocada no se
// podía desmentir: el pedido de Pisac no ofrecía ni el botón de cotizar, aunque
// la operación supiera que Aliclik cubre.
//
// Cotizar es un GET —no crea guía, no reserva stock, no cuesta nada—, así que lo
// peor que puede pasar aquí es enterarse de un precio.
//
// LA GENERALIZACIÓN LA FIRMA UNA PERSONA. La cotización es por coordenada y la
// cobertura es por distrito: que Aliclik llegue a un punto de Pisac no prueba
// que llegue a todo Pisac. Por eso el botón de marcar el distrito es un segundo
// paso explícito y no una consecuencia automática de la cotización.

import { useId, useState, useTransition } from "react";
import { cn } from "@/components/ui";
import { Banner, FIELD, OpsButton } from "@/components/ops-ui";
import {
  markDistrictCoveredByAliclik,
  previewAliclikGuide,
  type AliclikPreview,
} from "@/app/dashboard/pedidos/aliclik-actions";

export function AliclikCoverageProbe({
  orderId,
  district,
  canMark,
}: {
  orderId: string;
  district: string | null;
  /** Sin permiso de Aliclik ni se ofrece: la respuesta no le sirve de nada. */
  canMark: boolean;
}) {
  const [pending, start] = useTransition();
  const [preview, setPreview] = useState<AliclikPreview | null>(null);
  const [coordinate, setCoordinate] = useState("");
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const uid = useId();

  if (!canMark) return null;

  const probe = () =>
    start(async () => {
      setMessage(null);
      const result = await previewAliclikGuide(orderId, {
        coverageProbe: true,
        coordinate: coordinate.trim() || null,
      });
      setPreview(result);
    });

  const mark = () =>
    start(async () => {
      const cost = preview?.couriers?.[0]?.deliveryCost ?? null;
      const result = await markDistrictCoveredByAliclik(orderId, cost ?? null);
      const text = result.error ?? result.notice ?? null;
      setMessage(text ? { kind: result.error ? "error" : "ok", text } : null);
      if (!result.error) setPreview(null);
    });

  const quoted = preview?.ok ? preview.couriers?.[0] : undefined;

  return (
    <div className="space-y-3">
      <OpsButton onClick={probe} disabled={pending} className="pointer-coarse:h-11">
        {pending ? "Consultando a Aliclik…" : "Comprobar si Aliclik llega"}
      </OpsButton>

      {/* Sin coordenada no hay nada que cotizar: Aliclik responde por punto. */}
      {preview?.needsCoordinate ? (
        <label className="grid gap-1.5 text-[13px] font-medium text-ink-700" htmlFor={`${uid}-coord`}>
          Pega el enlace de Google Maps o la coordenada y vuelve a comprobar.
          <input
            id={`${uid}-coord`}
            value={coordinate}
            onChange={(event) => setCoordinate(event.target.value)}
            placeholder="-13.42, -71.85"
            className={cn(FIELD, "font-normal pointer-coarse:h-11")}
          />
        </label>
      ) : null}

      {quoted ? (
        <Banner
          tone="ok"
          title={`Aliclik sí llega${district ? ` a ${district}` : ""}${
            typeof quoted.deliveryCost === "number" ? ` — S/ ${quoted.deliveryCost.toFixed(2)}` : ""
          }.`}
        >
          <p>
            La cotización es de esta coordenada. Marcar el distrito cambia el despacho de{" "}
            <b className="font-semibold text-ink-900">todos</b> sus pedidos, así que confírmalo solo si Aliclik cubre el
            distrito y no únicamente esta dirección.
          </p>
          <OpsButton size="sm" onClick={mark} disabled={pending} className="mt-3 pointer-coarse:h-11">
            Marcar {district ?? "el distrito"} como Provincia COD
          </OpsButton>
        </Banner>
      ) : null}

      {/* Que no llegue también es una respuesta útil: confirma que Agencia
          estaba bien y ahorra la duda la próxima vez. */}
      {preview && !preview.ok && !preview.needsCoordinate ? (
        <p className="rounded-md bg-wash px-3 py-2 text-[13px] leading-5 text-ink-700">
          {preview.error ?? "Aliclik no cotizó este destino."}
        </p>
      ) : null}

      {message ? (
        <Banner tone={message.kind === "ok" ? "ok" : "crit"} role={message.kind === "ok" ? "status" : "alert"}>
          <p>{message.text}</p>
        </Banner>
      ) : null}
    </div>
  );
}
