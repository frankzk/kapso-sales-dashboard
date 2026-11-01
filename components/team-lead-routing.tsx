"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { LEAD_WORK_BLOCKS, PRINCIPAL_BLOCKS, routingCoverage, routingLabel, type LeadBlockAssignment, type LeadRoutingSettings, type LeadWorkBlock } from "@/lib/lead-routing";
import { saveTeamLeadRouting } from "@/app/dashboard/team/actions";
import { OpsButton } from "@/components/ops-ui";

export function TeamLeadRouting({ orgId, initial, installed, advisors, stores }: {
  orgId: string; initial: LeadRoutingSettings; installed: boolean;
  advisors: { userId: string; name: string; account: string; stores: string[] }[];
  stores: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(initial.enabled);
  const [hours, setHours] = useState(initial.freshHours);
  const [assignments, setAssignments] = useState<LeadBlockAssignment[]>(() => advisors.map(m => initial.assignments.find(a => a.userId === m.userId) ?? { userId: m.userId, blocks: [], backup: false }));
  const [message, setMessage] = useState<{ error?: string; notice?: string }>({});
  const [pending, start] = useTransition();
  const missing = routingCoverage(assignments, advisors, stores.map(s => s.id));
  const patch = (userId: string, change: Partial<LeadBlockAssignment>) => setAssignments(rows => rows.map(a => a.userId === userId ? { ...a, ...change } : a));
  const toggle = (userId: string, block: LeadWorkBlock) => {
    const current = assignments.find(a => a.userId === userId)!;
    patch(userId, { blocks: current.blocks.includes(block) ? current.blocks.filter(b => b !== block) : [...current.blocks, block] });
  };
  return <section className="space-y-5" aria-labelledby="lead-routing-title">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="max-w-[70ch]">
        <h2 id="lead-routing-title" className="text-lg font-semibold text-ink-900">Qué leads atiende cada asesora</h2>
        <p className="mt-1 text-sm text-ink-600">Marca uno o varios bloques. Las asesoras comparten la cola de sus bloques; una reserva evita que atiendan al mismo cliente.</p>
      </div>
      <label className="flex min-h-11 items-center gap-2 text-sm font-medium text-ink-900">
        <input type="checkbox" checked={enabled} disabled={pending || !installed} onChange={e => setEnabled(e.target.checked)} />
        Activar reparto por bloques
      </label>
    </div>
    {!installed && <p role="status" className="rounded-lg bg-warn-wash p-3 text-sm text-warn-fg">Falta instalar la migración de bloques. La cola actual sigue funcionando.</p>}
    {!enabled && <p className="text-sm text-ink-600">Reparto desactivado: la cola conserva el acceso actual. Puedes preparar los checks y activarlos al guardar.</p>}
    <fieldset disabled={pending || !installed} className="space-y-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-y border-line py-3 text-sm">
        <label htmlFor="lead-fresh-hours" className="font-medium text-ink-900">Oportunidad inicial</label>
        <input id="lead-fresh-hours" type="number" min={1} max={168} value={hours} onChange={e => setHours(Number(e.target.value))} className="w-20 rounded-md border border-line px-2 py-1.5 text-ink-900" />
        <span className="text-ink-600">horas corridas desde el ingreso, respuesta o carrito más reciente. Notas y llamadas fallidas no reinician el plazo.</span>
      </div>
      <div className="divide-y divide-line border-y border-line">
        {advisors.map(member => {
          const a = assignments.find(row => row.userId === member.userId)!;
          return <fieldset key={member.userId} className="py-4">
            <legend className="sr-only">Bloques de {member.name}</legend>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div><h3 className="text-sm font-semibold text-ink-900">{member.name} <span className="ml-2 font-normal text-ink-600">{routingLabel(a.blocks)}</span></h3><p className="text-xs text-ink-500">{member.account} · {stores.filter(s => member.stores.includes(s.id)).map(s => s.name).join(", ") || "Sin tiendas asignadas"}</p></div>
              <div className="flex flex-wrap gap-2" aria-label={`Configuraciones rápidas de ${member.name}`}>
                <OpsButton size="sm" onClick={() => patch(member.userId, { blocks: [...PRINCIPAL_BLOCKS] })}>Principal</OpsButton>
                <OpsButton size="sm" onClick={() => patch(member.userId, { blocks: ["recuperacion"] })}>Recuperación</OpsButton>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
              {LEAD_WORK_BLOCKS.map(block => <label key={block.key} className="flex min-h-11 max-w-[30ch] items-start gap-2 text-sm text-ink-800">
                <input type="checkbox" className="mt-1" checked={a.blocks.includes(block.key)} onChange={() => toggle(member.userId, block.key)} />
                <span>{block.label}<span className="mt-0.5 block text-xs text-ink-600">{block.detail}</span></span>
              </label>)}
            </div>
            <label className="mt-2 flex min-h-11 items-center gap-2 text-xs text-ink-600"><input type="checkbox" checked={a.backup} onChange={e => patch(member.userId, { backup: e.target.checked })} />Recibir otros prioritarios solo si no hay asesora asignada disponible en esa tienda.</label>
          </fieldset>;
        })}
      </div>
    </fieldset>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="max-w-[75ch] text-sm" aria-live="polite">
        {missing.length ? <p className={enabled ? "text-crit-fg" : "text-ink-600"}>{missing.length} combinaciones de bloque y tienda sin cobertura. {enabled && "Asigna una asesora antes de activar."}</p> : <p className="text-ok-fg">Los cinco bloques tienen cobertura en todas las tiendas.</p>}
        {missing.length > 0 && <details className="mt-1 text-xs text-ink-600"><summary className="cursor-pointer">Ver qué falta asignar</summary><ul className="mt-2 space-y-1">{missing.map(m => <li key={`${m.storeId}:${m.block}`}>{stores.find(s => s.id === m.storeId)?.name}: {LEAD_WORK_BLOCKS.find(b => b.key === m.block)?.label}</li>)}</ul></details>}
        <p className="mt-2 text-xs text-ink-600">Al cambiar de bloque, conserva sus reservas vigentes y citas acordadas. Supervisión mantiene la vista completa. Los cambios quedan en el historial.</p>
      </div>
      <OpsButton variant="primary" disabled={pending || !installed || (enabled && missing.length > 0) || !Number.isInteger(hours) || hours < 1 || hours > 168} onClick={() => start(async () => {
        setMessage({});
        try {
          const result = await saveTeamLeadRouting(orgId, initial.revision, { enabled, freshHours: hours, assignments });
          setMessage(result);
          if (!result.error) router.refresh();
        } catch { setMessage({ error: "No se pudo guardar. Conservamos tu selección para reintentar." }); }
      })}>{pending ? "Guardando…" : "Guardar reparto"}</OpsButton>
    </div>
    {message.error && <p role="alert" className="text-sm text-crit-fg">{message.error}</p>}
    {message.notice && <p role="status" className="text-sm text-ok-fg">{message.notice}</p>}
  </section>;
}
