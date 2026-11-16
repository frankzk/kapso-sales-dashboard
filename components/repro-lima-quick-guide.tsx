"use client";

// Crear la guía desde la fila de Repro Lima, sin abrir la ficha (owner,
// 16-11-2026: «debajo del botón de atender, botones para crear directamente la
// guía con los couriers, como un fast forward»). No es un camino nuevo: llama
// a las MISMAS acciones de la Mesa de ruta —`previewAliclikGuide` +
// `createAliclikGuide`, `createGfCourierGuide`—, con su permiso, sus compuertas
// (Lista negra, duplicados, riesgo, cobertura, salida adicional) y su
// confirmación. Aliclik cotiza primero y muestra lo que va a cobrar en la
// puerta antes de crear; lo que pide una decisión que aquí no cabe (la
// ubicación, una excepción por escrito) se hace en la ficha.
import { useRef, useState, useTransition } from "react";
import { cn } from "@/components/ui";
import { Banner, FIELD_BOX, OpsButton, choiceChipClass } from "@/components/ops-ui";
import { Sheet } from "@/components/filter-sheet";
import { createAliclikGuide, previewAliclikGuide, type AliclikPreview } from "@/app/dashboard/pedidos/aliclik-actions";
import { createGfCourierGuide } from "@/app/dashboard/pedidos/gf-courier-actions";
import { programDayLabel } from "@/lib/dispatch-day";
import type { LimaPendingOrder } from "@/lib/repro-lima-pending";
import { defaultAliclikTransport } from "@/lib/repro-lima-blocks";

type Feedback = { kind: "notice" | "error"; text: string };
type QuickRow = Pick<LimaPendingOrder, "orderId" | "orderName">;

/** Mínimo de caracteres del motivo de una salida adicional en Lima (el mismo criterio que la ficha: una frase). */
export const QUICK_MOTIVE_MIN = 8;


export function QuickGuideButtons({ row, aliclik, gf, size = "sm", onDone, onOpenFicha }: {
  row: QuickRow;
  aliclik: boolean;
  gf: boolean;
  size?: "sm" | "md";
  onDone: (feedback: Feedback) => void;
  onOpenFicha: () => void;
}) {
  if (!aliclik && !gf) return null;
  return (
    <div className="flex flex-wrap gap-1.5 [&>*]:grow">
      {aliclik && <AliclikQuick row={row} size={size} onDone={onDone} onOpenFicha={onOpenFicha} />}
      {gf && <GfQuick row={row} size={size} onDone={onDone} />}
    </div>
  );
}

function AliclikQuick({ row, size, onDone, onOpenFicha }: { row: QuickRow; size: "sm" | "md"; onDone: (f: Feedback) => void; onOpenFicha: () => void }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<AliclikPreview | null>(null);
  const [transportId, setTransportId] = useState<number | null>(null);
  const [motive, setMotive] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function show() {
    setOpen(true);
    setPreview(null);
    setError(null);
    setMotive("");
    previewAliclikGuide(row.orderId)
      .then((p) => {
        setPreview(p);
        setTransportId(defaultAliclikTransport(p.couriers));
      })
      .catch(() => setPreview({ ok: false, error: "No pudimos cotizar con Aliclik. Vuelve a intentarlo." }));
  }

  const ok = preview?.ok ? preview : null;
  const extra = ok?.additionalOutput;
  const chosen = ok?.couriers?.find((c) => c.transportId === transportId) ?? null;
  const missing = !ok ? null
    : extra?.blocked ? extra.message
      : !chosen ? "Aliclik no ofrece un transporte que se pueda elegir para esta dirección."
        : extra?.requiresReason && motive.trim().length < QUICK_MOTIVE_MIN ? "Escribe el motivo de la salida adicional."
          : null;

  function create() {
    if (!ok || !chosen || missing || pending) return;
    setError(null);
    start(async () => {
      const result = await createAliclikGuide(row.orderId, {
        transportId: chosen.transportId,
        expectedCollectTotal: ok.collectTotal ?? null,
        motivoSalidaAdicional: extra?.requiresReason ? motive.trim() : null,
        note: null,
      }).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
      if ("error" in result && result.error) {
        setError(result.error);
        return;
      }
      setOpen(false);
      onDone({ kind: "notice", text: `${row.orderName}: ${("notice" in result && result.notice) || "guía creada en Aliclik."}` });
    });
  }

  return (
    <>
      <OpsButton ref={anchor} size={size} aria-expanded={open} onClick={() => (open ? setOpen(false) : show())} className="pointer-coarse:h-11">
        Guía Aliclik
      </OpsButton>
      {open && (
        <Sheet look="ops" title={`Guía Aliclik · ${row.orderName}`} onClose={() => setOpen(false)} anchored anchorRef={anchor}>
          <div className="w-full max-w-md space-y-3">
            {!preview && <p className="text-[13px] text-ink-500">Cotizando con Aliclik…</p>}
            {preview && !preview.ok && (
              <>
                <Banner tone="warn" role="status">
                  {preview.needsCoordinate ? "Falta la ubicación del pedido: ponla en la ficha (Aliclik) y crea la guía ahí." : preview.notReady ? "El pedido todavía no tiene su dirección: espera unos segundos y vuelve a intentarlo." : preview.pinSinCorroborar ?? preview.error ?? "No se pudo cotizar con Aliclik."}
                </Banner>
                <div className="flex justify-end">
                  <OpsButton size="sm" onClick={() => { setOpen(false); onOpenFicha(); }} className="pointer-coarse:h-11">Abrir la ficha</OpsButton>
                </div>
              </>
            )}
            {ok && (
              <>
                <fieldset>
                  <legend className="text-xs font-medium text-ink-600">Transporte</legend>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {(ok.couriers ?? []).map((c) => (
                      <button
                        key={c.transportId}
                        type="button"
                        disabled={!c.selectable}
                        aria-pressed={transportId === c.transportId}
                        title={c.selectable ? undefined : c.reason}
                        onClick={() => setTransportId(c.transportId)}
                        className={cn(choiceChipClass(transportId === c.transportId), "pointer-coarse:h-11", !c.selectable && "cursor-not-allowed opacity-40")}
                      >
                        {c.transportName ?? "Aliclik"} · S/ {Number(c.deliveryCost ?? 0).toFixed(2)}
                      </button>
                    ))}
                  </div>
                </fieldset>
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[13px]">
                  <dt className="text-ink-500">Cobra en la puerta</dt>
                  <dd className="font-semibold tabular-nums text-ink-900">S/ {(ok.collectTotal ?? 0).toFixed(2)}</dd>
                  {ok.dispatch?.date && (
                    <>
                      <dt className="text-ink-500">Lo recoge</dt>
                      <dd className="text-ink-900">el {programDayLabel(ok.dispatch.date)}{ok.dispatch.fallsOnSunday ? " (cae en domingo: revisa la fecha en su portal)" : ""}</dd>
                    </>
                  )}
                </dl>
                {(ok.warnings ?? []).map((w) => <p key={w} className="text-xs leading-5 text-warn-fg">{w}</p>)}
                {extra && !extra.blocked && (
                  <label className="grid gap-1 text-xs font-medium text-ink-600">
                    <span>{extra.message}</span>
                    {extra.requiresReason && (
                      <input value={motive} maxLength={300} onChange={(e) => setMotive(e.target.value)} placeholder="2do intento: no estaba en casa" className={cn(FIELD_BOX, "h-9 w-full px-3 pointer-coarse:h-11")} />
                    )}
                  </label>
                )}
              </>
            )}
            {error && (
              <Banner tone="crit" role="alert">
                {error} Si pide una excepción o la ubicación, créala desde la ficha.
              </Banner>
            )}
            {ok && (
              <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-3">
                {missing && <span className="mr-auto text-xs text-ink-500">{missing}</span>}
                <OpsButton variant="ghost" size="sm" onClick={() => setOpen(false)} className="pointer-coarse:h-11">Cancelar</OpsButton>
                <OpsButton variant="primary" size="sm" disabled={Boolean(missing) || pending} onClick={create} className="pointer-coarse:h-11">
                  {pending ? "Creando…" : "Crear guía en Aliclik"}
                </OpsButton>
              </div>
            )}
          </div>
        </Sheet>
      )}
    </>
  );
}

function GfQuick({ row, size, onDone }: { row: QuickRow; size: "sm" | "md"; onDone: (f: Feedback) => void }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function create() {
    if (pending) return;
    setError(null);
    start(async () => {
      const result = await createGfCourierGuide(row.orderId).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
      if (result.error) {
        setError(result.error);
        return;
      }
      setOpen(false);
      onDone({ kind: "notice", text: `${row.orderName}: ${"notice" in result && result.notice ? result.notice : "guía creada en GF Courier."}` });
    });
  }

  return (
    <>
      <OpsButton ref={anchor} size={size} aria-expanded={open} onClick={() => { setOpen(!open); setError(null); }} className="pointer-coarse:h-11">
        Guía GF
      </OpsButton>
      {open && (
        <Sheet look="ops" title={`Guía GF Courier · ${row.orderName}`} onClose={() => setOpen(false)} anchored anchorRef={anchor}>
          <div className="w-full max-w-md space-y-3">
            <p className="text-[13px] leading-5 text-ink-600">
              Crea la guía en GF Courier con los datos del pedido. GF cotiza el envío y lo dice al crearla; se anula sin costo antes de la preparación.
            </p>
            {error && <Banner tone="crit" role="alert">{error}</Banner>}
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-3">
              <OpsButton variant="ghost" size="sm" onClick={() => setOpen(false)} className="pointer-coarse:h-11">Cancelar</OpsButton>
              <OpsButton variant="primary" size="sm" disabled={pending} onClick={create} className="pointer-coarse:h-11">
                {pending ? "Creando…" : "Crear guía en GF Courier"}
              </OpsButton>
            </div>
          </div>
        </Sheet>
      )}
    </>
  );
}
