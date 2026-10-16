"use client";

// Agente de voz de leads en el drawer de Leads (MOM §33).
//
// Lo que el agente ya hizo con este lead (sus llamadas y si pidió no ser
// contactado) y «Probar en mi teléfono»: el agente con la ficha de ESTE lead,
// llamando a quien prueba, sin escribir nada sobre él.
//
// A CIEGAS, a propósito (MOM §33.3): el panel no dice si el lead entra a la
// cola del agente ni a qué brazo del sorteo cayó, y no hay botón para que lo
// llame a mano. Una asesora que lee «grupo de control» o «el agente lo llama»
// trabaja ese lead distinto —el repo ya lo midió con el experimento del frío
// (lib/lead-experiment.ts, v1)— y la comparación deja de medir al agente.
// Quién llama y cuándo lo decide solo el barrido.
//
// No importa lib/voice-leads: arrastra lib/voice-recovery y con él
// node:crypto, que no entra al cliente. Por eso las constantes del historial
// viven aquí, copiadas a mano y atadas a las originales por una prueba
// (test/voice-leads-drawer.test.ts).

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { probarAgenteLeadEnMiTelefono, type LeadActionState } from "@/app/dashboard/leads/actions";
import { loadLeadVoicePanel } from "@/lib/leads-read-client";
import { labelOf } from "@/lib/leads";
import {
  LEAD_VOICE_MOTIVO_LABEL,
  leadVoiceCallState,
  type LeadVoicePanelData,
} from "@/lib/voice-lead-labels";
import { cn } from "@/components/ui";
import { Badge, FIELD_BOX, OpsButton } from "@/components/ops-ui";

/** `lead_calls.kind` del agente (= LEAD_VOICE_KIND). */
export const LEAD_VOICE_AGENT_KIND = "voice_agent";
/** `leads.handoff_reason` de su «quiere comprar» (= LEAD_VOICE_HANDOFF_REASON). */
export const LEAD_VOICE_AGENT_HANDOFF = "agente_voz";
/** Quién firma sus filas del historial (= LEAD_VOICE_NOTE_SIGNER). */
export const LEAD_VOICE_AGENT_NAME = "Agente de voz";

/** Título de su fila en el historial (= leadVoiceTimelineTitle de lib/voice-leads). */
export function leadVoiceAgentTitle(newStatus: string | null | undefined): string {
  return newStatus ? `🤖 ${LEAD_VOICE_AGENT_NAME} · ${labelOf(newStatus)}` : `🤖 ${LEAD_VOICE_AGENT_NAME}`;
}

/**
 * Se puede probar el agente, y si no, por qué. La prueba no exige el agente
 * encendido (sirve para escucharlo antes), solo la línea configurada.
 */
export function leadVoicePanelView(data: LeadVoicePanelData): { puedeProbar: boolean; aviso: string | null } {
  return {
    puedeProbar: data.configured,
    aviso: !data.configured ? "Falta configurar la línea del agente de leads en Vercel (puerta SIP y secreto)." : null,
  };
}

const OPEN = new Set(["queued", "dialing", "in_progress"]);
/** Mientras una llamada sigue abierta, el panel se vuelve a leer cada tanto. */
const POLL_OPEN_MS = 15_000;

const hora = new Intl.DateTimeFormat("es-PE", {
  timeZone: "America/Lima",
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

export function LeadVoiceAgentPanel({ leadId, onChanged }: { leadId: string; onChanged: () => void }) {
  const [data, setData] = useState<LeadVoicePanelData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [probando, setProbando] = useState(false);
  const [telefono, setTelefono] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  const cargar = useCallback(async () => {
    try {
      const res = await loadLeadVoicePanel(leadId);
      if ("error" in res) {
        // Lo último que se leyó se queda: si falla una relectura con una
        // llamada abierta, el panel sigue mirándola en vez de borrarse.
        setLoadError(res.error);
      } else {
        setLoadError(null);
        setData(res.data);
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "No se pudo cargar el agente de voz.");
    }
  }, [leadId]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  // Una llamada abierta termina sola (el agente registra, o el barrido la da
  // por no contestada): mientras siga abierta se relee el panel, y cuando se
  // cierra se refresca el drawer para que el historial traiga lo que escribió.
  const abierta = data?.calls.some((c) => OPEN.has(c.status)) ?? false;
  const estabaAbierta = useRef(false);
  useEffect(() => {
    if (estabaAbierta.current && !abierta) onChangedRef.current();
    estabaAbierta.current = abierta;
    if (!abierta) return;
    const id = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void cargar();
    }, POLL_OPEN_MS);
    return () => clearInterval(id);
  }, [abierta, cargar]);

  function run(action: () => Promise<LeadActionState>, after?: () => void) {
    setMsg(null);
    startTransition(async () => {
      let res: LeadActionState;
      try {
        res = await action();
      } catch {
        res = { error: "No se pudo completar. Intenta nuevamente." };
      }
      if (res.error) {
        setMsg({ tone: "error", text: res.error });
      } else {
        setMsg(res.notice ? { tone: "ok", text: res.notice } : null);
        after?.();
        onChangedRef.current();
      }
      await cargar();
    });
  }

  if (!data) {
    return <p className="text-[13px] text-ink-500">Agente de voz: {loadError ?? "cargando…"}</p>;
  }

  const { puedeProbar, aviso } = leadVoicePanelView(data);
  const telOk = telefono.replace(/\D/g, "").length >= 9;

  // Lo mínimo (Frankz, 14-10-2026): una línea con su estado y «Probar en mi
  // teléfono». Crece solo con sus llamadas, un aviso o al probar.
  return (
    <section aria-labelledby={`voz-lead-${leadId}`} className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <p className="min-w-0 text-[13px] leading-5 text-ink-500">
          <span id={`voz-lead-${leadId}`} className="font-semibold text-ink-900">
            Agente de voz
          </span>
          {data.calls.length === 0 && <> · El agente no ha llamado a este lead.</>}
        </p>
        {(data.optOut || (puedeProbar && !probando)) && (
          <span className="flex shrink-0 items-center gap-2">
            {data.optOut && <Badge tone="crit">Pidió no ser contactado</Badge>}
            {puedeProbar && !probando && (
              <OpsButton size="sm" onClick={() => setProbando(true)}>
                Probar en mi teléfono
              </OpsButton>
            )}
          </span>
        )}
      </div>

      {loadError && <p className="text-[13px] text-ink-500">{loadError}</p>}
      {aviso && <p className="text-[13px] text-ink-600">{aviso}</p>}

      {probando && (
        <div className="space-y-2.5 rounded-md bg-wash p-3">
          <p className="text-[13px] leading-5 text-ink-700">
            El agente te llama con la ficha y el chat de este lead. Es una prueba: nada se escribe sobre el lead, y
            no puede ser el número del lead.
          </p>
          <label className="block text-[13px] font-medium text-ink-700">
            Tu celular
            <input
              value={telefono}
              onChange={(e) => setTelefono(e.target.value)}
              inputMode="tel"
              placeholder="9XXXXXXXX"
              className={cn(FIELD_BOX, "mt-1 h-9 w-full px-3 font-normal tabular-nums sm:w-56")}
            />
          </label>
          <div className="flex gap-2">
            <OpsButton
              variant="primary"
              size="sm"
              disabled={pending || !telOk}
              onClick={() => run(() => probarAgenteLeadEnMiTelefono(leadId, telefono), () => setProbando(false))}
            >
              {pending ? "Llamando…" : "Llamarme"}
            </OpsButton>
            <OpsButton size="sm" variant="ghost" onClick={() => setProbando(false)}>
              Cancelar
            </OpsButton>
          </div>
        </div>
      )}

      {msg && <p className={cn("text-[13px]", msg.tone === "error" ? "text-crit-fg" : "text-ok-fg")}>{msg.text}</p>}

      {data.calls.length > 0 && (
        <ul className="divide-y divide-line border-t border-line text-[13px]">
          {data.calls.map((c) => (
            <li key={c.id} className="py-2">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-xs tabular-nums text-ink-500">{hora.format(new Date(c.queued_at))}</span>
                <span className="font-medium text-ink-900">{leadVoiceCallState(c.status, c.outcome, c.error)}</span>
                {c.motivo && <span className="text-ink-500">· {LEAD_VOICE_MOTIVO_LABEL[c.motivo] ?? c.motivo}</span>}
                {c.mode === "test" && <Badge tone="warn">Prueba</Badge>}
              </div>
              {c.resumen && <p className="mt-0.5 text-ink-700">{c.resumen}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
