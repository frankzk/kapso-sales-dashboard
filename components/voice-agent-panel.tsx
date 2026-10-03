"use client";

// Agente de voz en el drawer del Master, en Reproprovincia (MOM §11.8).
//
// Tres cosas y nada más: si el pedido entra a la cola del agente (y si no,
// por qué, con la misma frase que decide el barrido), llamar a la clienta, y
// probar el agente con la ficha de ESTE pedido en otro teléfono sin escribir
// nada sobre él. Debajo, las llamadas del agente a este pedido.

import { useCallback, useEffect, useState } from "react";
import {
  llamarConAgente,
  loadVoiceAgentPanel,
  probarAgenteEnMiTelefono,
  type MasterActionState,
} from "@/app/dashboard/pedidos/actions";
import { VOICE_OUTCOME_LABEL, type VoiceAgentPanelData } from "@/lib/voice-recovery-labels";
import { cn } from "@/components/ui";
import { Badge, CARD_ZONE, FIELD, OpsButton } from "@/components/ops-ui";
import { IconPhone } from "@/components/icons";

const hora = new Intl.DateTimeFormat("es-PE", {
  timeZone: "America/Lima",
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

function estadoLlamada(status: string, outcome: string | null, error: string | null): string {
  if (outcome) return VOICE_OUTCOME_LABEL[outcome] ?? outcome;
  if (status === "dialing") return "Marcando…";
  if (status === "in_progress") return "En curso…";
  if (status === "failed") return error === "no conectó" ? "No conectó" : "Falló";
  return status;
}

export function VoiceAgentPanel({
  orderId,
  pending,
  run,
}: {
  orderId: string;
  pending: boolean;
  run: (action: () => Promise<MasterActionState>) => void;
}) {
  const [data, setData] = useState<VoiceAgentPanelData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [probando, setProbando] = useState(false);
  const [telefono, setTelefono] = useState("");

  const cargar = useCallback(async () => {
    const res = await loadVoiceAgentPanel(orderId);
    if ("error" in res) {
      setLoadError(res.error);
      setData(null);
    } else {
      setLoadError(null);
      setData(res.data);
    }
  }, [orderId]);

  useEffect(() => {
    void cargar();
  }, [cargar, pending]);

  if (loadError) {
    return <p className="mt-4 text-[13px] text-ink-500">Agente de voz: {loadError}</p>;
  }
  if (!data) return null;

  const puedeLlamar = data.enabled && data.configured && data.eligible;
  const porQueNo = !data.configured
    ? "Falta configurar el número del agente y la extensión con caller ID peruano (Ajustes de la tienda)."
    : !data.enabled
      ? "El agente de voz está apagado en esta tienda (Ajustes)."
      : data.reason;

  return (
    <section
      aria-labelledby={`voz-${orderId}`}
      // Una zona más de la tarjeta de confirmación, sobre su hairline.
      className={cn(CARD_ZONE, "mt-4 space-y-3 sm:mt-5")}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id={`voz-${orderId}`} className="text-sm font-semibold text-ink-900">
          Agente de voz
        </h4>
        <Badge tone={data.eligible ? "ok" : "neutral"}>
          {data.eligible ? "En la cola del agente" : "Fuera de la cola"}
        </Badge>
      </div>

      {!puedeLlamar && porQueNo && <p className="text-[13px] leading-5 text-ink-600">{porQueNo}</p>}

      <div className="flex flex-wrap items-center gap-2">
        <OpsButton
          disabled={pending || !puedeLlamar}
          onClick={() => run(() => llamarConAgente(orderId))}
          className="pointer-coarse:h-11"
        >
          <IconPhone aria-hidden className="text-ink-500" />
          Llamar con el agente
        </OpsButton>
        {data.configured && !probando && (
          <OpsButton variant="ghost" size="sm" onClick={() => setProbando(true)} className="pointer-coarse:h-11">
            Probar en mi teléfono
          </OpsButton>
        )}
      </div>

      {probando && (
        <div className="space-y-3 rounded-lg bg-wash p-3">
          <p className="text-[13px] leading-5 text-ink-700">
            El agente te llama con la ficha de este pedido. Es una prueba: nada se escribe sobre el pedido.
          </p>
          <label className="grid gap-1.5 text-[13px] font-medium text-ink-700 sm:w-56">
            Tu celular
            <input
              value={telefono}
              onChange={(e) => setTelefono(e.target.value)}
              inputMode="tel"
              placeholder="9XXXXXXXX"
              className={cn(FIELD, "font-normal tabular-nums pointer-coarse:h-11")}
            />
          </label>
          <div className="flex gap-2">
            <OpsButton
              size="sm"
              variant="primary"
              disabled={pending || telefono.replace(/\D/g, "").length < 9}
              onClick={() => run(() => probarAgenteEnMiTelefono(orderId, telefono))}
              className="pointer-coarse:h-11"
            >
              Llamarme
            </OpsButton>
            {/* La otra línea del mismo agente (Agente Telnyx, MOM §11.8). */}
            <OpsButton
              size="sm"
              disabled={pending || telefono.replace(/\D/g, "").length < 9}
              onClick={() => run(() => probarAgenteEnMiTelefono(orderId, telefono, "telnyx"))}
              className="pointer-coarse:h-11"
            >
              Por Telnyx
            </OpsButton>
            <OpsButton size="sm" variant="ghost" onClick={() => setProbando(false)} className="pointer-coarse:h-11">
              Cancelar
            </OpsButton>
          </div>
        </div>
      )}

      {data.calls.length > 0 && (
        <ul className="divide-y divide-line border-t border-line text-[13px] leading-5">
          {data.calls.map((c) => (
            <li key={c.id} className="py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="tabular-nums text-ink-500">{hora.format(new Date(c.queued_at))}</span>
                <span className="font-medium text-ink-900">{estadoLlamada(c.status, c.outcome, c.error)}</span>
                {c.mode === "test" && <Badge tone="warn">prueba</Badge>}
                {c.propone_descartar && c.mode === "real" && (
                  <span className="text-crit-fg">Propone descartar: revisar y descartar a mano.</span>
                )}
                {c.no_llamar && <span className="text-crit-fg">Pidió que no la llamen.</span>}
              </div>
              {c.resumen && <p className="mt-0.5 text-ink-700">{c.resumen}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
