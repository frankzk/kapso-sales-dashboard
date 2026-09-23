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
    return <p className="mt-3 text-xs text-slate-500">Agente de voz: {loadError}</p>;
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
      className="mt-3 space-y-2 rounded-lg border border-slate-200 bg-white p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id={`voz-${orderId}`} className="text-xs font-semibold text-slate-800">
          Agente de voz
        </h4>
        <span
          className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
            data.eligible ? "bg-emerald-50 text-emerald-800" : "bg-slate-100 text-slate-600"
          }`}
        >
          {data.eligible ? "En la cola del agente" : "Fuera de la cola"}
        </span>
      </div>

      {!puedeLlamar && porQueNo && <p className="text-xs text-slate-600">{porQueNo}</p>}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={pending || !puedeLlamar}
          onClick={() => run(() => llamarConAgente(orderId))}
          className="min-h-[44px] rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-700 disabled:opacity-40"
        >
          Llamar con el agente
        </button>
        {data.configured && !probando && (
          <button
            type="button"
            onClick={() => setProbando(true)}
            className="text-xs text-slate-600 underline-offset-2 hover:underline"
          >
            Probar en mi teléfono
          </button>
        )}
      </div>

      {probando && (
        <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50/60 p-2">
          <p className="text-xs text-amber-900">
            El agente te llama con la ficha de este pedido. Es una prueba: nada se escribe sobre el pedido.
          </p>
          <label className="block text-xs text-amber-900">
            Tu celular
            <input
              value={telefono}
              onChange={(e) => setTelefono(e.target.value)}
              inputMode="tel"
              placeholder="9XXXXXXXX"
              className="mt-1 w-full rounded-lg border border-amber-200 px-2 py-1.5 text-sm"
            />
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={pending || telefono.replace(/\D/g, "").length < 9}
              onClick={() => run(() => probarAgenteEnMiTelefono(orderId, telefono))}
              className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-40"
            >
              Llamarme
            </button>
            <button
              type="button"
              onClick={() => setProbando(false)}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100"
            >
              Cancelar
            </button>
          </div>
        </div>
      )}

      {data.calls.length > 0 && (
        <ul className="divide-y divide-slate-100 text-xs">
          {data.calls.map((c) => (
            <li key={c.id} className="py-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="tabular-nums text-slate-500">{hora.format(new Date(c.queued_at))}</span>
                <span className="font-medium text-slate-800">{estadoLlamada(c.status, c.outcome, c.error)}</span>
                {c.mode === "test" && (
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-900">
                    prueba
                  </span>
                )}
                {c.propone_descartar && c.mode === "real" && (
                  <span className="text-rose-700">Propone descartar: revisar y descartar a mano.</span>
                )}
                {c.no_llamar && <span className="text-rose-700">Pidió que no la llamen.</span>}
              </div>
              {c.resumen && <p className="mt-0.5 text-slate-600">{c.resumen}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
