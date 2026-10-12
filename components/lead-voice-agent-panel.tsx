"use client";

// Agente de voz de leads en el drawer de Leads (MOM §33).
//
// El mismo patrón que el panel de Reproprovincia (components/voice-agent-panel)
// con el estilo del drawer de leads: si el lead entra a la cola del agente (y
// si no, por qué, con la misma frase que decide el barrido), su brazo del
// sorteo, llamar con el agente, y probar el agente con la ficha de ESTE lead en
// otro teléfono sin escribir nada sobre él. Debajo, sus llamadas.
//
// No importa lib/voice-leads: arrastra lib/voice-recovery y con él
// node:crypto, que no entra al cliente. Por eso las constantes del historial
// viven aquí, copiadas a mano y atadas a las originales por una prueba
// (test/voice-leads-drawer.test.ts).

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import {
  llamarLeadConAgente,
  probarAgenteLeadEnMiTelefono,
  type LeadActionState,
} from "@/app/dashboard/leads/actions";
import { loadLeadVoicePanel } from "@/lib/leads-read-client";
import { labelOf } from "@/lib/leads";
import {
  LEAD_VOICE_MOTIVO_LABEL,
  leadVoiceCallState,
  type LeadVoicePanelData,
} from "@/lib/voice-lead-labels";
import { cn } from "@/components/ui";

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
 * Se puede llamar con el agente, y si no, por qué. El orden importa: sin la
 * línea configurada o con el agente apagado, la razón de la cola no es la que
 * hay que arreglar primero.
 */
export function leadVoicePanelView(data: LeadVoicePanelData): { puedeLlamar: boolean; porQueNo: string | null } {
  const puedeLlamar = data.enabled && data.configured && data.eligible;
  const porQueNo = puedeLlamar
    ? null
    : !data.configured
      ? "Falta configurar la línea del agente de leads en Vercel (puerta SIP y secreto)."
      : !data.enabled
        ? "El agente de leads está apagado en esta tienda (Ajustes)."
        : data.reason;
  return { puedeLlamar, porQueNo };
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

const chip = "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold";

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
        setLoadError(res.error);
        setData(null);
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

  if (loadError) return <p className="text-sm text-slate-500">Agente de voz: {loadError}</p>;
  if (!data) return <p className="text-sm text-slate-400">Agente de voz: cargando…</p>;

  const { puedeLlamar, porQueNo } = leadVoicePanelView(data);
  const telOk = telefono.replace(/\D/g, "").length >= 9;

  return (
    <section aria-labelledby={`voz-lead-${leadId}`} className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p
          id={`voz-lead-${leadId}`}
          className="text-xs font-semibold tracking-wide text-slate-400 uppercase"
        >
          🤖 Agente de voz
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={cn(chip, data.eligible ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600")}>
            {data.eligible ? "En la cola del agente" : "Fuera de la cola"}
          </span>
          {data.arm === "control" && (
            <span
              className={cn(chip, "bg-violet-50 text-violet-700")}
              title="El sorteo lo dejó en el grupo de control: el agente nunca lo llama, para comparar."
            >
              Grupo de control
            </span>
          )}
          {data.optOut && <span className={cn(chip, "bg-red-50 text-red-700")}>Pidió no ser contactado</span>}
        </div>
      </div>

      {porQueNo && <p className="text-sm text-slate-600">{porQueNo}</p>}

      {(puedeLlamar || (data.configured && !probando)) && (
        <div className="flex flex-wrap items-center gap-2">
          {puedeLlamar && (
            <button
              type="button"
              disabled={pending}
              onClick={() => run(() => llamarLeadConAgente(leadId))}
              className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
            >
              {pending ? "Llamando…" : "Llamar con el agente"}
            </button>
          )}
          {data.configured && !probando && (
            <button
              type="button"
              onClick={() => setProbando(true)}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Probar en mi teléfono
            </button>
          )}
        </div>
      )}

      {probando && (
        <div className="space-y-2.5 rounded-lg bg-slate-50 p-3">
          <p className="text-sm text-slate-700">
            El agente te llama con la ficha y el chat de este lead. Es una prueba: nada se escribe sobre el lead.
          </p>
          <label className="block text-sm font-medium text-slate-700">
            Tu celular
            <input
              value={telefono}
              onChange={(e) => setTelefono(e.target.value)}
              inputMode="tel"
              placeholder="9XXXXXXXX"
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-normal tabular-nums outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 sm:w-56"
            />
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={pending || !telOk}
              onClick={() => run(() => probarAgenteLeadEnMiTelefono(leadId, telefono), () => setProbando(false))}
              className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
            >
              {pending ? "Llamando…" : "Llamarme"}
            </button>
            <button
              type="button"
              onClick={() => setProbando(false)}
              className="rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100"
            >
              Cancelar
            </button>
          </div>
        </div>
      )}

      {msg && (
        <p className={cn("text-sm", msg.tone === "error" ? "text-red-600" : "text-emerald-600")}>{msg.text}</p>
      )}

      {data.calls.length > 0 && (
        <ul className="divide-y divide-slate-100 border-t border-slate-100 text-sm">
          {data.calls.map((c) => (
            <li key={c.id} className="py-2">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-xs tabular-nums text-slate-400">{hora.format(new Date(c.queued_at))}</span>
                <span className="font-medium text-slate-800">{leadVoiceCallState(c.status, c.outcome, c.error)}</span>
                {c.motivo && (
                  <span className="text-slate-500">· {LEAD_VOICE_MOTIVO_LABEL[c.motivo] ?? c.motivo}</span>
                )}
                {c.mode === "test" && <span className={cn(chip, "bg-amber-50 text-amber-700")}>Prueba</span>}
              </div>
              {c.resumen && <p className="mt-0.5 text-slate-600">{c.resumen}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
