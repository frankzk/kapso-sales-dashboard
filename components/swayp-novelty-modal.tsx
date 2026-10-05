"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { solveSwaypNovelty } from "@/app/dashboard/envios/actions";
import { NOVELTY_ACTIONS, type NoveltyAction } from "@/lib/swayp-novelty";
import { limaTodayKey } from "@/lib/shipments";
import { cn } from "@/components/ui";
import { Banner, FIELD, FIELD_BOX, OpsButton, OptionTile } from "@/components/ops-ui";
import { IconX } from "@/components/icons";

const LABEL = "grid gap-1.5 text-[13px] font-medium text-ink-700";
const HELP = "text-[13px] font-normal leading-5 text-ink-500";

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
  const panel = useRef<HTMLDivElement>(null);

  // El foco entra al abrir: el modal se monta dentro del cajón, y con teclado
  // se quedaba detrás.
  useEffect(() => {
    panel.current?.focus({ preventScroll: true });
  }, []);

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
      className="fixed inset-0 z-40 grid place-items-center bg-ink-900/30 p-4"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="novedad-swayp-titulo"
        tabIndex={-1}
        style={{ outline: "none" }}
        onClick={(e) => e.stopPropagation()}
        // Escape cierra ESTE modal y no el cajón de atrás: el cajón escucha la
        // tecla en la ventana y respeta `defaultPrevented`.
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }}
        className="max-h-full w-full max-w-lg overflow-y-auto overscroll-contain rounded-lg bg-white shadow-pop"
      >
        <header className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-line bg-white px-5 pb-3 pt-4">
          <div className="min-w-0">
            <h2 id="novedad-swayp-titulo" className="text-lg font-semibold leading-7 text-ink-900">
              Resolver novedad de Swayp
            </h2>
            <p className="text-[13px] leading-5 text-ink-500">
              <span className="font-mono text-ink-700">{guideCode ?? "Envío"}</span>
              {swaypGuide ? <> · guía <span className="font-mono">{swaypGuide}</span></> : ""}
              {swaypState === 8 ? " · el mensajero marcó devolución" : ""}
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

        <div className="space-y-5 px-5 py-4">
          {done ? (
            <Banner tone="ok" role="status" title={done}>
              <p>
                El estado del envío lo va a confirmar Swayp por su cuenta; puede tardar unos minutos en
                reflejarse.
              </p>
              <OpsButton size="sm" onClick={onClose} className="mt-3 pointer-coarse:h-11">
                Cerrar
              </OpsButton>
            </Banner>
          ) : (
            <>
              <div role="group" aria-labelledby="novedad-que-hacer" className="space-y-2">
                <p id="novedad-que-hacer" className="text-sm font-semibold text-ink-900">
                  Qué hacer
                </p>
                <div className="grid gap-2">
                  {(Object.keys(NOVELTY_ACTIONS) as NoveltyAction[]).map((key) => {
                    const option = NOVELTY_ACTIONS[key];
                    const blocked = option.isReturn && !canReturn;
                    return (
                      <OptionTile
                        key={key}
                        label={option.label}
                        description={blocked ? "Necesitas el permiso de retornos y devoluciones." : option.hint}
                        active={accion === key}
                        disabled={blocked}
                        onClick={() => setAccion(key)}
                      />
                    );
                  })}
                </div>
              </div>

              {needsDate && (
                <label className={LABEL}>
                  Nueva fecha de entrega
                  <input
                    type="date"
                    value={fecha}
                    min={minDate}
                    onChange={(e) => setFecha(e.target.value)}
                    className={cn(FIELD, "font-normal sm:w-56 pointer-coarse:h-11")}
                  />
                  <span className={HELP}>
                    Desde mañana: Swayp arma la ruta del día siguiente entre las 16:00 y las 17:00.
                  </span>
                </label>
              )}

              <label className={LABEL}>
                Comentario para el mensajero
                <textarea
                  value={comentario}
                  onChange={(e) => setComentario(e.target.value)}
                  rows={3}
                  className={cn(FIELD_BOX, "w-full px-3 py-2 font-normal leading-5")}
                  placeholder="La clienta pidió que vuelvan por la tarde, hay portero."
                />
                <span className={HELP}>
                  Swayp se lo muestra al mensajero: es lo único que va a leer antes de decidir.
                </span>
              </label>

              {error && (
                <Banner tone="crit" role="alert">
                  {error}
                </Banner>
              )}

              <div className="flex justify-end gap-2">
                <OpsButton onClick={onClose} className="pointer-coarse:h-11">
                  Cancelar
                </OpsButton>
                <OpsButton variant="primary" onClick={submit} disabled={!canSubmit} className="pointer-coarse:h-11">
                  {pending ? "Enviando…" : "Enviar a Swayp"}
                </OpsButton>
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
