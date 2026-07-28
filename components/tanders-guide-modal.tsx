"use client";

import { useEffect, useState, useTransition } from "react";
import {
  createTandersGuide,
  loadTandersDraft,
  type TandersDraftView,
} from "@/app/dashboard/pedidos/tanders-actions";
import { mapsUrlFor, parseGeoLink } from "@/lib/geo-link";

/**
 * Crear una guía Tanders desde el drawer del Master.
 *
 * El flujo replica el formulario de tanders.app con los datos del pedido ya
 * puestos, salvo por una cosa: el punto del mapa. Tanders lo exige y Shopify no
 * entrega coordenadas, así que o el pedido ya tiene un punto confirmado o el
 * operador pega el enlace de Google Maps. Se muestra siempre el enlace al punto
 * elegido para que se pueda verificar ANTES de despachar.
 *
 * Caja XXS y 100 g son fijos por decisión de la operación (no hay pesos por
 * producto en el catálogo), así que no se piden acá.
 */
export function TandersGuideModal({
  orderId,
  onClose,
  onCreated,
}: {
  orderId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [draft, setDraft] = useState<TandersDraftView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [destination, setDestination] = useState("");
  const [mapLink, setMapLink] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [amount, setAmount] = useState("0");
  const [note, setNote] = useState("");

  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ code: string; labelUrl?: string } | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    let alive = true;
    void (async () => {
      const res = await loadTandersDraft(orderId);
      if (!alive) return;
      if ("error" in res) {
        setLoadError(res.error);
        return;
      }
      const d = res.draft;
      setDraft(d);
      setDestination(d.destination);
      setName(d.recipientName ?? "");
      setPhone(d.recipientPhone ?? "");
      setAmount(String(d.collectionAmount));
      setNote(d.note);
    })();
    return () => {
      alive = false;
    };
  }, [orderId]);

  // El punto vigente: lo pegado gana sobre lo guardado, igual que en el servidor.
  const pasted = mapLink.trim() ? parseGeoLink(mapLink) : null;
  const point =
    pasted?.ok === true
      ? pasted.point
      : draft?.latitude != null && draft.longitude != null
        ? { lat: draft.latitude, lng: draft.longitude }
        : null;
  const pointError = pasted && !pasted.ok ? pasted.error : null;

  const blocked = (draft?.blockers.length ?? 0) > 0;
  const canSubmit = Boolean(draft && !blocked && point && !pointError && !pending && !created);

  function submit() {
    start(async () => {
      const res = await createTandersGuide(orderId, {
        destination,
        mapLink: mapLink.trim() || undefined,
        recipientName: name,
        recipientPhone: phone,
        collectionAmount: Number(amount) || 0,
        note,
      });
      if (res.error) {
        setError(res.error);
        return;
      }
      setError(null);
      setCreated({ code: res.guideCode ?? "", labelUrl: res.labelUrl });
      onCreated();
    });
  }

  return (
    // El modal se monta DENTRO del drawer, que cierra al hacer click en su
    // fondo: sin frenar la propagación, cerrar el modal cerraría también el
    // pedido y el operador perdería el contexto.
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 p-4"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-h-full w-full max-w-lg overflow-y-auto rounded-xl bg-white shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <div>
            <p className="text-sm font-semibold text-slate-900">Crear guía Tanders</p>
            <p className="text-xs text-slate-500">
              {draft?.orderName ?? "Pedido"} · Caja XXS · 100 g
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700">
            ✕
          </button>
        </div>

        {loadError && <p className="m-5 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{loadError}</p>}

        {!draft && !loadError && <p className="p-5 text-sm text-slate-400">Cargando…</p>}

        {draft && (
          <div className="space-y-4 p-5">
            {draft.blockers.map((b) => (
              <p key={b} className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                {b}
              </p>
            ))}
            {draft.warnings.map((w) => (
              <p key={w} className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
                {w}
              </p>
            ))}

            {created ? (
              <div className="space-y-2 rounded-lg bg-emerald-50 px-3 py-3 text-sm text-emerald-800">
                <p>
                  Guía creada: <span className="font-mono">{created.code}</span>
                </p>
                {created.labelUrl ? (
                  <a
                    href={created.labelUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-block font-medium underline"
                  >
                    Abrir etiqueta PDF ↗
                  </a>
                ) : (
                  <p className="text-emerald-700">
                    La etiqueta todavía no está disponible; se puede descargar desde tanders.app.
                  </p>
                )}
                <button onClick={onClose} className="text-emerald-900 underline">
                  Cerrar
                </button>
              </div>
            ) : (
              <>
                <Field label="Origen">
                  <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
                    {draft.originAddress ?? "— sin configurar —"}
                  </p>
                </Field>

                <Field label="Dirección de destino">
                  <input
                    value={destination}
                    onChange={(e) => setDestination(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    placeholder="Av. Ejemplo 123, Ate, Lima, Perú"
                  />
                </Field>

                <Field
                  label="Punto en el mapa"
                  hint="Busca la dirección en Google Maps y pega el enlace. Tanders no acepta solo el texto."
                >
                  <input
                    value={mapLink}
                    onChange={(e) => setMapLink(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    placeholder="https://www.google.com/maps/… o -12.054714, -76.956875"
                  />
                  {pointError && <p className="mt-1 text-xs text-red-600">{pointError}</p>}
                  {!pointError && point && (
                    <p className="mt-1 text-xs text-slate-500">
                      {point.lat.toFixed(6)}, {point.lng.toFixed(6)} ·{" "}
                      <a
                        href={mapsUrlFor(point)}
                        target="_blank"
                        rel="noreferrer"
                        className="text-brand-700 underline"
                      >
                        verificar en el mapa ↗
                      </a>
                      {!mapLink.trim() && draft.geoSource ? ` · fuente: ${draft.geoSource}` : ""}
                    </p>
                  )}
                  {!point && !pointError && (
                    <p className="mt-1 text-xs text-red-600">
                      Sin punto no se puede crear la guía.
                    </p>
                  )}
                </Field>

                <div className="grid grid-cols-2 gap-3">
                  <Field label="Destinatario">
                    <input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    />
                  </Field>
                  <Field label="Teléfono">
                    <input
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                      placeholder="981535978"
                    />
                  </Field>
                </div>

                <Field label="Monto a cobrar al destinatario (S/)">
                  <input
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    inputMode="decimal"
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                </Field>

                <Field
                  label="Nota interna"
                  hint="Referencia de la dirección + la nota del pedido en Shopify, traída al abrir."
                >
                  <textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    rows={2}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    placeholder="Esquina con la av. Urubamba"
                  />
                </Field>

                {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

                <div className="flex justify-end gap-2 pt-1">
                  <button onClick={onClose} className="rounded-lg px-3 py-2 text-sm text-slate-600">
                    Cancelar
                  </button>
                  <button
                    onClick={submit}
                    disabled={!canSubmit}
                    className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
                  >
                    {pending ? "Creando…" : "Crear guía"}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </label>
      {children}
      {hint && <p className="mt-1 text-xs text-slate-400">{hint}</p>}
    </div>
  );
}
