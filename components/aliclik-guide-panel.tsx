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

import { useState, useTransition } from "react";
import { Card } from "@/components/ui";
import {
  createAliclikGuide,
  previewAliclikGuide,
  type AliclikPreview,
} from "@/app/dashboard/pedidos/aliclik-actions";
import { isShortenedMapsLink } from "@/lib/aliclik-geo";

export function AliclikGuidePanel({
  orderId,
  hasCoordinate,
  onCreated,
}: {
  orderId: string;
  hasCoordinate: boolean;
  onCreated: () => void;
}) {
  const [coordinate, setCoordinate] = useState("");
  const [preview, setPreview] = useState<AliclikPreview | null>(null);
  const [transportId, setTransportId] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const shortened = isShortenedMapsLink(coordinate);

  const quote = () => {
    setMessage(null);
    startTransition(async () => {
      const res = await previewAliclikGuide(orderId, { coordinate: coordinate || null });
      setPreview(res);
      // Preselecciona el courier más barato entre los seleccionables: es lo que
      // la operadora elige el 90 % de las veces.
      const cheapest = (res.couriers ?? [])
        .filter((c) => c.selectable)
        .sort((a, b) => a.deliveryCost - b.deliveryCost)[0];
      setTransportId(cheapest?.transportId ?? null);
      if (!res.ok && res.error) setMessage({ kind: "error", text: res.error });
    });
  };

  const create = () => {
    if (transportId === null) return;
    setMessage(null);
    startTransition(async () => {
      const res = await createAliclikGuide(orderId, {
        transportId,
        coordinate: coordinate || null,
        note: note || null,
      });
      if (res.error) setMessage({ kind: "error", text: res.error });
      else {
        setMessage({ kind: "ok", text: res.notice ?? "Guía creada." });
        setPreview(null);
        onCreated();
      }
    });
  };

  return (
    <Card>
      <div className="space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">Crear guía en Aliclik</h3>
          <p className="mt-1 text-xs text-slate-500">
            Cotiza primero: la cotización no crea nada y sirve para confirmar cobertura y ubicación.
          </p>
        </div>

        {/* Coordenada */}
        <div>
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

        <div className="flex gap-2">
          <button
            type="button"
            onClick={quote}
            disabled={pending}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {pending ? "Cotizando…" : "Cotizar envío"}
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
              disabled={pending || transportId === null || Boolean(preview.writeBlocked)}
              className="w-full rounded-lg bg-brand-700 px-3 py-2 text-sm font-medium text-white hover:bg-brand-800 disabled:opacity-50"
            >
              {pending ? "Creando…" : "Crear guía en Aliclik"}
            </button>
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
    </Card>
  );
}
