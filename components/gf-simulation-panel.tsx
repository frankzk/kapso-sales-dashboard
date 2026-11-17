"use client";

// Pedidos › Simular GF Courier (MOM §29.17, owner 16-11-2026). Pide la lista de pedidos y los manda a simular de a 120
// (`runGfSimulationStep`), mostrando el avance y el resumen. Los resultados viven solo en esta pantalla: al cerrarla o
// recargarla se pierden. «Detener» termina después de la pasada en curso.
import { useMemo, useRef, useState } from "react";
import { Badge, Banner, OpsButton } from "@/components/ops-ui";
import { SECTION_CARD } from "@/components/ops-styles";
import { runGfSimulationStep, startGfSimulation } from "@/app/dashboard/pedidos/gf-simulacion/actions";
import {
  GF_SIM_CHUNK,
  GF_SIM_DAYS,
  GF_SIM_KAPTA_CODE,
  GF_SIM_SUFFIX,
  gfSimulationText,
  summarizeGfSimulation,
  type GfSimOutcome,
} from "@/lib/gf-courier-simulation";

type Phase = "idle" | "listing" | "running" | "stopping" | "done" | "stopped" | "error";

export function GfSimulationPanel({ stores }: { stores: string[] }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [plan, setPlan] = useState<{ name: string; count: number }[]>([]);
  const [outcomes, setOutcomes] = useState<GfSimOutcome[]>([]);
  const [copied, setCopied] = useState(false);
  const stop = useRef(false);
  const summary = useMemo(() => summarizeGfSimulation(outcomes), [outcomes]);
  const busy = phase === "listing" || phase === "running" || phase === "stopping";

  async function run() {
    stop.current = false;
    setError(null); setOutcomes([]); setCopied(false); setPhase("listing");
    const start = await startGfSimulation().catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));
    if (!start.ok) { setError(start.error); setPhase("error"); return; }
    setPlan(start.stores.map((s) => ({ name: s.name, count: s.count })));
    setTotal(start.orderIds.length);
    setPhase("running");
    for (let i = 0; i < start.orderIds.length; i += GF_SIM_CHUNK) {
      if (stop.current) { setPhase("stopped"); return; }
      const step = await runGfSimulationStep(start.orderIds.slice(i, i + GF_SIM_CHUNK))
        .catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));
      if (!step.ok) { setError(`${step.error} Se detuvo en ${i} de ${start.orderIds.length}.`); setPhase("error"); return; }
      setOutcomes((prev) => [...prev, ...step.outcomes]);
    }
    setPhase("done");
  }

  async function copy() {
    try { await navigator.clipboard.writeText(gfSimulationText(summary)); setCopied(true); } catch { setCopied(false); }
  }

  const done = summary.total;
  const minutes = Math.ceil(((total - done) * 0.25) / 60);
  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4 sm:p-6">
      <header className="space-y-1">
        <h1 className="text-lg font-semibold text-ink-900">Simular GF Courier</h1>
        <p className="text-sm text-ink-700">
          Los pedidos de Lima y Callao de los últimos {GF_SIM_DAYS} días (contraentrega y manuales, sin anular) de {stores.join(" y ")},
          con el mismo cuerpo con el que Kapta crea la guía, a <code>/v1/orders/validate</code> de GF: no crea guías, no reserva
          stock y no cambia pedidos. Si el pedido ya tuvo guía en GF se envía con <code>{GF_SIM_SUFFIX}</code>; una fecha programada
          pasada no se envía. 4 pedidos por segundo. El resultado queda solo en esta pantalla.
        </p>
      </header>

      <div className={`${SECTION_CARD} flex flex-wrap items-center gap-3`}>
        <OpsButton variant="primary" onClick={() => void run()} disabled={busy}>
          {phase === "listing" ? "Buscando pedidos…" : busy ? "Simulando…" : done ? "Simular otra vez" : "Simular"}
        </OpsButton>
        {phase === "running" ? (
          <OpsButton variant="secondary" onClick={() => { stop.current = true; setPhase("stopping"); }}>Detener</OpsButton>
        ) : null}
        {total ? (
          <span className="text-sm text-ink-700">
            {done} de {total} revisados{busy && total > done ? ` · faltan ~${minutes} min` : ""}
            {plan.length ? ` · ${plan.map((p) => `${p.name}: ${p.count}`).join(" · ")}` : ""}
          </span>
        ) : null}
        {phase === "stopping" ? <Badge tone="warn">Termina la pasada en curso y se detiene</Badge> : null}
        {phase === "stopped" ? <Badge tone="warn">Detenida</Badge> : null}
        {phase === "done" ? <Badge tone="ok">Terminada</Badge> : null}
      </div>

      {error ? <Banner tone="crit" role="alert" title="No se pudo seguir">{error}</Banner> : null}

      {done ? (
        <section className={`${SECTION_CARD} space-y-4`}>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold text-ink-900">Resumen</h2>
            <OpsButton size="sm" onClick={() => void copy()}>{copied ? "Copiado" : "Copiar resumen"}</OpsButton>
          </div>
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <Stat label="Revisados" value={summary.total} />
            <Stat label="Válidos" value={summary.valid} />
            <Stat label="Con error" value={summary.errors} />
            <Stat label="Válidos con distrito tomado de la dirección" value={summary.takenFromAddress} />
          </dl>
          <p className="text-sm text-ink-700">
            {summary.byStore.map((b) => `${b.store}: ${b.total} revisados, ${b.valid} válidos, ${b.errors} con error`).join(" · ")}
            {summary.withGuide ? ` · ${summary.withGuide} ya tenían guía en GF (enviados con ${GF_SIM_SUFFIX})` : ""}
          </p>
          {summary.groups.length ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead className="text-xs uppercase text-ink-500">
                  <tr><th className="py-2 pr-3">Código</th><th className="py-2 pr-3">Campo</th><th className="py-2 pr-3 text-right">Pedidos</th><th className="py-2">Ejemplos (pedido · mensaje · valor enviado)</th></tr>
                </thead>
                <tbody>
                  {summary.groups.map((g) => (
                    <tr key={`${g.code}|${g.field ?? ""}`} className="border-t border-line align-top">
                      <td className="py-2 pr-3 font-mono text-xs">{g.code === GF_SIM_KAPTA_CODE ? "Kapta no arma el cuerpo" : g.code}</td>
                      <td className="py-2 pr-3 font-mono text-xs">{g.field ?? "—"}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{g.count}</td>
                      <td className="py-2">
                        <ul className="space-y-1">
                          {g.examples.map((e, i) => (
                            <li key={i} className="text-ink-700">
                              <span className="font-medium text-ink-900">{e.order}</span>
                              {stores.length > 1 ? <span className="text-ink-500"> ({e.store})</span> : null}
                              {` · ${e.message}`}
                              {e.sent != null ? <span className="text-ink-500">{` · enviado: ${e.sent}`}</span> : null}
                            </li>
                          ))}
                        </ul>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-ink-700">Sin errores hasta ahora.</p>
          )}
        </section>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md bg-wash p-3">
      <dt className="text-xs text-ink-500">{label}</dt>
      <dd className="text-xl font-semibold tabular-nums text-ink-900">{value}</dd>
    </div>
  );
}
