import { Badge, Banner, type BadgeTone } from "@/components/ops-ui";
import type { HealthStatus, StageHealth } from "@/lib/metrics";

/** El semáforo de `funnelHealth` dicho con palabras: el color nunca va solo. */
export const HEALTH: Record<HealthStatus, { tone: BadgeTone; label: string }> = {
  green: { tone: "ok", label: "Sana" },
  amber: { tone: "warn", label: "Atención" },
  red: { tone: "crit", label: "Crítica" },
};

/**
 * La salud de cada paso del embudo: cuántos pasan de la etapa anterior y su
 * chapa (60 % o más, sana; desde 30 %, atención; menos, crítica). Antes eran
 * arcos concéntricos de colores que había que descifrar con la leyenda.
 */
export function FunnelHealth({
  stages,
  critical,
}: {
  stages: StageHealth[];
  critical: StageHealth | null;
}) {
  return (
    <div className="flex flex-col gap-4">
      {critical && (
        <Banner tone="crit" title={`Punto crítico: ${critical.label}`}>
          Solo {critical.stepPct != null ? `${Math.round(critical.stepPct * 100)}\u00a0%` : "—"} llega desde la etapa anterior. Revisa
          seguimiento, tiempos de contacto o logística.
        </Banner>
      )}
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs font-semibold text-ink-600">
            <th scope="col" className="py-2 pr-3 font-semibold">Etapa</th>
            <th scope="col" className="px-3 py-2 text-right font-semibold">Pasa de la anterior</th>
            <th scope="col" className="py-2 pl-3 text-right font-semibold">Estado</th>
          </tr>
        </thead>
        <tbody>
          {stages.map((s) => (
            <tr key={s.key} className="border-b border-line last:border-0">
              <td className="py-2.5 pr-3 text-ink-900">{s.label}</td>
              <td className="px-3 py-2.5 text-right tabular-nums text-ink-600">
                {s.stepPct != null ? `${Math.round(s.stepPct * 100)}\u00a0%` : "—"}
              </td>
              <td className="py-2.5 pl-3 text-right">
                {s.stepPct != null ? <Badge tone={HEALTH[s.status].tone}>{HEALTH[s.status].label}</Badge> : <span className="text-xs text-ink-500">Inicio</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs leading-4 text-ink-500">Sana desde 60 % que pasa; atención desde 30 %; por debajo, crítica.</p>
    </div>
  );
}
