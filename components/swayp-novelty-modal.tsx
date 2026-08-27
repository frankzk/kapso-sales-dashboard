"use client";

import { useState, useTransition } from "react";
import { solveSwaypNovelty } from "@/app/dashboard/envios/actions";
import { NOVELTY_ACTIONS, type NoveltyAction } from "@/lib/swayp-novelty";
import { limaTodayKey } from "@/lib/shipments";

/**
 * Responder una novedad de Swayp desde el drawer del envío.
 *
 * Una novedad es el mensajero parado frente a una puerta que no se abrió,
 * esperando que alguien le diga qué hacer. Hasta ahora eso se contestaba
 * entrando al panel de Swayp; acá se contesta sin salir del pedido.
 *
 * El comentario es obligatorio porque Swayp se lo MUESTRA AL MENSAJERO: es lo
 * único que va a leer antes de decidir. Y la fecha sólo aparece al reprogramar,
 * que es la única acción que la admite.
 */
export function SwaypNoveltyModal({
  shipmentId,
  guideCode,
  swaypGuide,
  swaypState,
  canReturn,
  onClose,
  onSolved,
}: {
  shipmentId: string;
  guideCode: string | null;
  swaypGuide: string | null;
  swaypState: number | null;
  /** ¿Tiene `closure.return`? Sin él, devolver al remitente no se ofrece. */
  canReturn: boolean;
  onClose: () => void;
  onSolved: () => void;
}) {
  const [accion, setAccion] = useState<NoveltyAction | null>(null);
  const [comentario, setComentario] = useState("");
  const [fecha, setFecha] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const meta = accion ? NOVELTY_ACTIONS[accion] : null;
  const needsDate = meta?.needsDate ?? false;
  // Mismo corte que la creación de guía: Swayp arma sus rutas 16:00–17:00 para
  // el día siguiente, así que la fecha más temprana posible es mañana.
  const minDate = nextDayKey(limaTodayKey());

  const canSubmit = Boolean(
    accion && comentario.trim() && (!needsDate || fecha) && !pending && !done,
  );

  function submit() {
    if (!accion) return;
    setError(null);
    start(async () => {
      const res = await solveSwaypNovelty({
        shipmentId,
        accion,
        comentario,
        fechaEntregaIso: needsDate ? fecha : null,
      });
      if (res.error) {
        setError(res.error);
        return;
      }
      setDone(res.notice ?? "Novedad resuelta.");
      onSolved();
    });
  }

  return (
    // Igual que el modal de Tanders: se monta dentro del drawer, que cierra al
    // click en su fondo. Sin frenar la propagación se cerraría también el envío.
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
            <p className="text-sm font-semibold text-slate-900">Resolver novedad de Swayp</p>
            <p className="text-xs text-slate-500">
              {guideCode ?? "Envío"}
              {swaypGuide ? ` · guía ${swaypGuide}` : ""}
              {swaypState === 8 ? " · el mensajero marcó devolución" : ""}
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700">
            ✕
          </button>
        </div>

        <div className="space-y-4 p-5">
          {done ? (
            <div className="space-y-2 rounded-lg bg-emerald-50 px-3 py-3 text-sm text-emerald-800">
              <p>{done}</p>
              <p className="text-emerald-700">
                El estado del envío lo va a confirmar Swayp por su cuenta; puede tardar unos minutos
                en reflejarse.
              </p>
              <button onClick={onClose} className="text-emerald-900 underline">
                Cerrar
              </button>
            </div>
          ) : (
            <>
              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Qué hacer
                </label>
                <div className="space-y-2">
                  {(Object.keys(NOVELTY_ACTIONS) as NoveltyAction[]).map((key) => {
                    const option = NOVELTY_ACTIONS[key];
                    const blocked = option.isReturn && !canReturn;
                    return (
                      <button
                        key={key}
                        type="button"
                        disabled={blocked}
                        onClick={() => setAccion(key)}
                        className={`w-full rounded-lg border px-3 py-2 text-left text-sm disabled:opacity-40 ${
                          accion === key
                            ? "border-slate-900 bg-slate-50"
                            : "border-slate-300 hover:bg-slate-50"
                        }`}
                      >
                        <span className="font-medium text-slate-900">{option.label}</span>
                        <span className="block text-xs text-slate-500">
                          {blocked
                            ? "Necesitas el permiso de retornos y devoluciones."
                            : option.hint}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {needsDate && (
                <div>
                  <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Nueva fecha de entrega
                  </label>
                  <input
                    type="date"
                    value={fecha}
                    min={minDate}
                    onChange={(e) => setFecha(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                  <p className="mt-1 text-xs text-slate-400">
                    Desde mañana: Swayp arma la ruta del día siguiente entre las 16:00 y las 17:00.
                  </p>
                </div>
              )}

              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Comentario para el mensajero
                </label>
                <textarea
                  value={comentario}
                  onChange={(e) => setComentario(e.target.value)}
                  rows={3}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  placeholder="La clienta pidió que vuelvan por la tarde, hay portero."
                />
                <p className="mt-1 text-xs text-slate-400">
                  Swayp se lo muestra al mensajero: es lo único que va a leer antes de decidir.
                </p>
              </div>

              {error && (
                <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
              )}

              <div className="flex justify-end gap-2 pt-1">
                <button onClick={onClose} className="rounded-lg px-3 py-2 text-sm text-slate-600">
                  Cancelar
                </button>
                <button
                  onClick={submit}
                  disabled={!canSubmit}
                  className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
                >
                  {pending ? "Enviando…" : "Enviar a Swayp"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * `YYYY-MM-DD` del día siguiente. Se hace en UTC a propósito: `limaTodayKey()`
 * ya resolvió cuál es «hoy» en Lima, y construir la fecha con el constructor
 * local volvería a meter la zona del navegador en una cuenta que ya estaba
 * hecha —el operador que abra el panel desde otro huso vería otro mínimo—.
 */
function nextDayKey(dayKey: string): string {
  const parts = dayKey.split("-").map(Number);
  const [y, m, d] = parts;
  if (parts.length !== 3 || y == null || m == null || d == null) return dayKey;
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}
