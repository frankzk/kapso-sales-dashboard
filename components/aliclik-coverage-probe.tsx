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

import { useState, useTransition } from "react";
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
  const [message, setMessage] = useState<string | null>(null);

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
      setMessage(result.error ?? result.notice ?? null);
      if (!result.error) setPreview(null);
    });

  const quoted = preview?.ok ? preview.couriers?.[0] : undefined;

  return (
    <div className="mt-3 space-y-2">
      <button
        type="button"
        onClick={probe}
        disabled={pending}
        className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
      >
        {pending ? "Consultando a Aliclik…" : "Comprobar si Aliclik llega"}
      </button>

      {/* Sin coordenada no hay nada que cotizar: Aliclik responde por punto. */}
      {preview?.needsCoordinate ? (
        <label className="block">
          <span className="text-xs text-slate-600">
            Pega el enlace de Google Maps o la coordenada y vuelve a comprobar.
          </span>
          <input
            value={coordinate}
            onChange={(event) => setCoordinate(event.target.value)}
            placeholder="-13.42, -71.85"
            className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
          />
        </label>
      ) : null}

      {quoted ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
          <p className="font-semibold">
            Aliclik sí llega{district ? ` a ${district}` : ""}
            {typeof quoted.deliveryCost === "number"
              ? ` — S/ ${quoted.deliveryCost.toFixed(2)}`
              : ""}
            .
          </p>
          <p className="mt-1 text-xs leading-5">
            La cotización es de esta coordenada. Marcar el distrito cambia el despacho de{" "}
            <strong>todos</strong> sus pedidos, así que confírmalo solo si Aliclik cubre el
            distrito y no únicamente esta dirección.
          </p>
          <button
            type="button"
            onClick={mark}
            disabled={pending}
            className="mt-2 rounded-lg bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-60"
          >
            Marcar {district ?? "el distrito"} como Provincia COD
          </button>
        </div>
      ) : null}

      {/* Que no llegue también es una respuesta útil: confirma que Agencia
          estaba bien y ahorra la duda la próxima vez. */}
      {preview && !preview.ok && !preview.needsCoordinate ? (
        <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
          {preview.error ?? "Aliclik no cotizó este destino."}
        </p>
      ) : null}

      {message ? (
        <p className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700">
          {message}
        </p>
      ) : null}
    </div>
  );
}
