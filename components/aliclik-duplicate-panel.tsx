"use client";

import { useEffect, useId, useState, useTransition } from "react";
import { getAliclikDuplicateHold, resolveAliclikDuplicate } from "@/app/dashboard/pedidos/aliclik-duplicate-actions";
import {
  DUPLICATE_DECISIONS,
  PRIOR_SHIPMENT_OUTCOMES,
  allowedPriorOutcomes,
  type DuplicateDecision,
  type DuplicateHold,
  type PriorShipmentOutcome,
} from "@/lib/aliclik-duplicate";
import { ADELANTO_MINIMO_LABEL } from "@/lib/adelanto-minimo";
import { cn } from "@/components/ui";
import { Banner, FIELD_BOX, OpsButton, OptionTile } from "@/components/ops-ui";
import { IconArrowUpRight } from "@/components/icons";

/** Lo que pasa con cada resolución (MOM §8.3), escrito bajo su opción. */
const DECISION_HINT: Record<DuplicateDecision, string> = {
  keep_existing: "El nuevo sigue retenido; su cancelación va por el procedimiento habitual.",
  both: `Libera la guía con al menos ${ADELANTO_MINIMO_LABEL} validados en este pedido.`,
  replacement: "Libera la guía al declarar qué pasó con el envío anterior: volvió, lo recibió o se perdió.",
  exception: "Vale solo para los productos y salidas revisados.",
};

export function AliclikDuplicatePanel({ orderId, initialHold, onGateChange, onChanged }: {
  orderId: string;
  initialHold?: DuplicateHold | null;
  onGateChange?: (allowed: boolean) => void;
  onChanged?: () => void;
}) {
  const id = useId();
  const [hold, setHold] = useState<DuplicateHold | null>(initialHold ?? null);
  const [error, setError] = useState<string | null>(null);
  const [decision, setDecision] = useState<DuplicateDecision | "">("");
  const [reason, setReason] = useState("");
  const [outcomes, setOutcomes] = useState<Record<string, PriorShipmentOutcome>>({});
  const [pending, startTransition] = useTransition();
  useEffect(() => {
    let alive = true;
    setHold(initialHold ?? null);
    setError(null);
    if (initialHold) return;
    void getAliclikDuplicateHold(orderId).then((result) => {
      if (!alive) return;
      if ("error" in result) setError(result.error);
      else setHold(result.hold);
    }).catch(() => { if (alive) setError("No se pudo verificar el posible duplicado. Reintenta."); });
    return () => { alive = false; };
  }, [orderId, initialHold]);
  useEffect(() => {
    onGateChange?.(Boolean(hold?.allowed && !error && !pending));
  }, [hold, error, pending, onGateChange]);

  const refresh = () => startTransition(async () => {
    setError(null);
    try {
      const result = await getAliclikDuplicateHold(orderId);
      if ("error" in result) { setHold(null); setError(result.error); }
      else { setHold(result.hold); onChanged?.(); }
    } catch { setHold(null); setError("No se pudo verificar el posible duplicado. Reintenta."); }
  });
  const save = () => {
    if (!decision || !hold?.fingerprint) return;
    startTransition(async () => {
      setError(null);
      try {
        const result = await resolveAliclikDuplicate(orderId, {
          decision, reason, fingerprint: hold.fingerprint!,
          ...(decision === "replacement" ? { outcomes } : {}),
        });
        if ("error" in result) setError(result.error);
        else { setHold(result.hold); setDecision(""); setReason(""); setOutcomes({}); onChanged?.(); }
      } catch { setError("No se pudo guardar la resolución. Reintenta."); }
    });
  };
  if (hold && !hold.conflicts.length && !error) return null;
  const verifying = !hold && !error;
  const cleared = Boolean(hold?.allowed && !error);
  return (
    <section aria-label="Revisión de posible duplicado" className="@container">
      <Banner
        tone={verifying ? "info" : cleared ? "ok" : "crit"}
        title={
          verifying
            ? "Verificando historial para Aliclik"
            : cleared
              ? "Duplicado revisado para Aliclik"
              : "Guía Aliclik retenida · posible duplicado"
        }
      >
        {error ? <p role="alert">{error}</p> : <p>{hold?.message ?? "Verificando otros envíos del mismo teléfono y producto…"}</p>}
        {hold?.conflicts.length ? (
          <ul className="mt-2 divide-y divide-line rounded-md bg-white ring-1 ring-line">
            {hold.conflicts.map((conflict) => (
              <li key={conflict.shipmentId} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3 py-2 text-[13px] leading-5">
                <a
                  className="inline-flex items-center gap-0.5 font-semibold text-brand-700 underline-offset-2 hover:underline"
                  href={`/dashboard/pedidos?abrir=${encodeURIComponent(conflict.orderId)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {conflict.orderName}
                  <IconArrowUpRight aria-hidden className="size-3.5" />
                </a>
                <span className="text-ink-600">
                  {conflict.courier} · <span className="font-mono">{conflict.guideCode}</span>
                </span>
                <span className="basis-full text-ink-500">despachado, sin entrega ni recuperación registrada</span>
              </li>
            ))}
          </ul>
        ) : null}
        {hold?.resolution && (
          <p className="mt-2">
            Última resolución: <b className="font-semibold text-ink-900">{DUPLICATE_DECISIONS[hold.resolution.decision]}</b>.{" "}
            {hold.resolution.reason}
          </p>
        )}
        {hold?.conflicts.length ? (
          <>
            {/* Quien puede resolver lee lo mismo bajo cada opción; quien no,
                necesita la regla escrita. */}
            {!hold.canResolve && (
              <p className="mt-2">
                Si quiere ambos: registra su confirmación y valida al menos {ADELANTO_MINIMO_LABEL} en este pedido. Si
                es reemplazo: quien resuelve declara qué pasó con el envío anterior.
              </p>
            )}
            {hold.canResolve && (
              <div className="mt-3 space-y-3">
                <div role="group" aria-labelledby={`${id}-decision`}>
                  <p id={`${id}-decision`} className="text-[13px] font-medium leading-5 text-ink-700">
                    Resolución del caso
                  </p>
                  <div className="mt-1.5 grid gap-2 @lg:grid-cols-2">
                    {(Object.entries(DUPLICATE_DECISIONS) as [DuplicateDecision, string][])
                      .filter(([key]) => key !== "exception" || hold.canOverride)
                      .map(([key, label]) => (
                        <OptionTile
                          key={key}
                          label={label}
                          description={DECISION_HINT[key]}
                          active={decision === key}
                          disabled={pending}
                          onClick={() => setDecision(key)}
                        />
                      ))}
                  </div>
                </div>
                {/* Reemplazo: el destino de CADA envío anterior, por la puerta
                    que le corresponde (MOM §8.3). Solo Aliclik admite «lo
                    recibió» y «se perdió»; el resto, solo la devolución. */}
                {decision === "replacement" && (
                  <div role="group" aria-labelledby={`${id}-outcomes`} className="space-y-2">
                    <p id={`${id}-outcomes`} className="text-[13px] font-medium leading-5 text-ink-700">
                      ¿Qué pasó con el envío anterior?
                    </p>
                    {hold.conflicts.map((conflict) => {
                      const chosen = outcomes[conflict.shipmentId] ?? "";
                      return (
                        <label key={conflict.shipmentId} className="grid gap-1 text-[13px] text-ink-700">
                          <span>
                            {conflict.orderName} · <span className="font-mono">{conflict.guideCode}</span>
                          </span>
                          <select
                            value={chosen}
                            disabled={pending}
                            onChange={(e) =>
                              setOutcomes((prev) => ({
                                ...prev,
                                [conflict.shipmentId]: e.target.value as PriorShipmentOutcome,
                              }))
                            }
                            className={cn(FIELD_BOX, "w-full px-3 py-2")}
                          >
                            <option value="" disabled>
                              Elige qué pasó…
                            </option>
                            {allowedPriorOutcomes(conflict.courier).map((outcome) => (
                              <option key={outcome} value={outcome}>
                                {PRIOR_SHIPMENT_OUTCOMES[outcome].label}
                              </option>
                            ))}
                          </select>
                          {chosen && (
                            <span className="text-ink-500">{PRIOR_SHIPMENT_OUTCOMES[chosen].hint}</span>
                          )}
                        </label>
                      );
                    })}
                  </div>
                )}
                {decision && (
                  <>
                    <label className="grid gap-1.5 text-[13px] font-medium text-ink-700" htmlFor={`${id}-reason`}>
                      {decision === "both" ? "Detalle de la confirmación expresa (canal y qué indicó)" : "Motivo y gestión realizada"}
                      <textarea
                        id={`${id}-reason`}
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        maxLength={1000}
                        rows={2}
                        disabled={pending}
                        className={cn(FIELD_BOX, "w-full px-3 py-2 font-normal leading-5")}
                      />
                    </label>
                    {/* Secundario, como todo botón dentro de un aviso: el azul de
                        la tarjeta es «Cotizar» o «Crear guía». */}
                    <OpsButton
                      onClick={save}
                      disabled={
                        pending ||
                        reason.trim().length < 12 ||
                        (decision === "replacement" &&
                          hold.conflicts.some((conflict) => !outcomes[conflict.shipmentId]))
                      }
                      className="pointer-coarse:h-11"
                    >
                      {pending ? "Guardando…" : "Registrar resolución"}
                    </OpsButton>
                  </>
                )}
              </div>
            )}
          </>
        ) : null}
        <OpsButton
          size="sm"
          variant="ghost"
          onClick={refresh}
          disabled={pending}
          className="-ml-2 mt-2 pointer-coarse:h-11"
        >
          {pending ? "Actualizando…" : "Volver a verificar pagos y envíos"}
        </OpsButton>
      </Banner>
    </section>
  );
}
