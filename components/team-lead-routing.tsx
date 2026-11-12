"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { LEAD_WORK_BLOCKS, PRINCIPAL_BLOCKS, routingCoverage, routingLabel, type LeadBlockAssignment, type LeadRoutingSettings, type LeadWorkBlock } from "@/lib/lead-routing";
import { saveTeamLeadRouting } from "@/app/dashboard/team/actions";
import { Badge, CHECKBOX, FIELD_BOX, OpsButton } from "@/components/ops-ui";
import { IconChevronDown, IconSearch } from "@/components/icons";

interface Advisor { userId: string; name: string; account: string; stores: string[] }
type Preset = "principal" | "recuperacion" | "todos" | "ninguno" | "personalizado";
const COLUMN_LABELS = [["Carritos", "recientes"], ["Interés", "reciente"], ["Nuevos", "sin intención"], ["Pendientes", "con interés"], ["Recuperación", "baja intención"]];
const sameBlocks = (a: LeadWorkBlock[], b: LeadWorkBlock[]) => a.length === b.length && a.every(key => b.includes(key));
const normalizeSearch = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
function presetFor(blocks: LeadWorkBlock[]): Preset {
  if (!blocks.length) return "ninguno";
  if (sameBlocks(blocks, [...PRINCIPAL_BLOCKS])) return "principal";
  if (sameBlocks(blocks, ["recuperacion"])) return "recuperacion";
  return blocks.length === LEAD_WORK_BLOCKS.length ? "todos" : "personalizado";
}
function PresetSelect({ member, assignment, onChange }: { member: Advisor; assignment: LeadBlockAssignment; onChange: (blocks: LeadWorkBlock[]) => void }) {
  return <select aria-label={`Configuración de ${member.name}`} className={`${FIELD_BOX} h-9 w-full px-2 text-[13px]`} value={presetFor(assignment.blocks)} onChange={e => {
    const value = e.target.value as Preset;
    onChange(value === "principal" ? [...PRINCIPAL_BLOCKS] : value === "recuperacion" ? ["recuperacion"] : value === "todos" ? LEAD_WORK_BLOCKS.map(b => b.key) : []);
  }}>
    <option value="ninguno">Sin asignar</option><option value="principal">Principal</option><option value="recuperacion">Recuperación</option><option value="todos">Todos los bloques</option><option value="personalizado" disabled>Personalizado</option>
  </select>;
}

export function TeamLeadRouting({ orgId, initial, installed, advisors, stores }: {
  orgId: string; initial: LeadRoutingSettings; installed: boolean; advisors: Advisor[]; stores: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(initial.enabled);
  const [hours, setHours] = useState(initial.freshHours);
  const [assignments, setAssignments] = useState<LeadBlockAssignment[]>(() => advisors.map(m => initial.assignments.find(a => a.userId === m.userId) ?? { userId: m.userId, blocks: [], backup: false, manualTake: false }));
  const [search, setSearch] = useState("");
  const [message, setMessage] = useState<{ error?: string; notice?: string }>({});
  const [pending, start] = useTransition();
  const missing = routingCoverage(assignments, advisors, stores.map(s => s.id));
  const missingBlocks = new Set(missing.map(m => m.block)).size;
  const assignedCount = assignments.filter(a => a.blocks.length).length;
  const visible = advisors.filter(m => normalizeSearch(`${m.name} ${m.account}`).includes(normalizeSearch(search.trim())));
  const dirty = enabled !== initial.enabled || hours !== initial.freshHours || assignments.some(a => {
    const before = initial.assignments.find(row => row.userId === a.userId);
    return !sameBlocks(a.blocks, before?.blocks ?? []) || a.backup !== (before?.backup ?? false) || !!a.manualTake !== !!before?.manualTake;
  });
  const patch = (userId: string, change: Partial<LeadBlockAssignment>) => setAssignments(rows => rows.map(a => a.userId === userId ? { ...a, ...change } : a));
  const toggle = (userId: string, block: LeadWorkBlock) => {
    const current = assignments.find(a => a.userId === userId)!;
    patch(userId, { blocks: current.blocks.includes(block) ? current.blocks.filter(b => b !== block) : [...current.blocks, block] });
  };
  const storeNames = (member: Advisor) => stores.filter(s => member.stores.includes(s.id)).map(s => s.name).join(", ") || "Sin tiendas asignadas";
  const save = () => start(async () => {
    setMessage({});
    try {
      const result = await saveTeamLeadRouting(orgId, initial.revision, { enabled, freshHours: hours, assignments });
      setMessage(result);
      if (!result.error) router.refresh();
    } catch { setMessage({ error: "No se pudo guardar. Conservamos tu selección para reintentar." }); }
  });
  return <section className="space-y-5" aria-labelledby="lead-routing-title">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <div className="flex items-center gap-3"><h2 id="lead-routing-title" className="text-lg font-semibold text-ink-900">Reparto de leads</h2><Badge tone={!dirty && initial.enabled ? "ok" : "neutral"}>{dirty ? "Cambios pendientes" : initial.enabled ? "Activo" : "Desactivado"}</Badge></div>
        <p className="mt-1 text-sm text-ink-600">Define qué bloques atiende cada asesora. Comparten la cola, sin atender al mismo cliente a la vez.</p>
      </div>
      <label className="relative flex min-h-11 cursor-pointer items-center gap-3 text-sm font-medium text-ink-900">
        <span className="relative inline-flex"><input type="checkbox" role="switch" aria-label="Activar reparto por bloques" checked={enabled} disabled={pending || !installed} onChange={e => setEnabled(e.target.checked)} className="peer absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed" /><span className="h-5 w-9 rounded-full bg-line-strong transition-colors peer-checked:bg-brand-600 peer-focus-visible:ring-2 peer-focus-visible:ring-brand-600 peer-focus-visible:ring-offset-2 peer-disabled:opacity-50 motion-reduce:transition-none" /><span className="pointer-events-none absolute left-0.5 top-0.5 size-4 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-4 motion-reduce:transition-none" /></span>
        Reparto por bloques
      </label>
    </div>
    {!installed && <p role="status" className="rounded-lg bg-warn-wash p-3 text-sm text-warn-fg">Esta configuración aún no está disponible. La cola actual sigue operativa.</p>}
    <div className="rounded-lg border border-line bg-white">
      <fieldset disabled={pending || !installed} className="min-w-0">
        <legend className="sr-only">Configuración del reparto de leads</legend>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
          <div className="flex flex-wrap items-center gap-2 text-[13px]"><label htmlFor="lead-fresh-hours" className="font-medium text-ink-900">Oportunidad inicial</label><input id="lead-fresh-hours" type="number" min={1} max={168} value={hours} onChange={e => setHours(Number(e.target.value))} className={`${FIELD_BOX} h-8 w-16 px-2`} /><span className="text-ink-600">horas desde la última señal del cliente</span></div>
          <details className="group w-full text-[13px] lg:w-auto">
            <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 font-medium text-brand-700">Qué incluye cada bloque<IconChevronDown className="size-4 group-open:rotate-180" /></summary>
            <div className="mt-3 max-w-[72ch] rounded-md border border-line bg-wash p-4 text-ink-600">
              <dl className="space-y-3">{LEAD_WORK_BLOCKS.map(block => <div key={block.key}><dt className="font-medium text-ink-900">{block.label}</dt><dd className="mt-0.5">{block.detail}</dd></div>)}<div><dt className="font-medium text-ink-900">Respaldo</dt><dd className="mt-0.5">Recibe otros prioritarios solo si no hay asesora asignada disponible en esa tienda.</dd></div></dl>
              <p className="mt-3">Toma puntual: permite atender un cliente fuera de sus bloques desde la búsqueda o Venta por teléfono. No amplía su cola automática ni toma reservas o citas ajenas.</p><p className="mt-4 border-t border-line pt-3">El plazo cuenta desde el ingreso, respuesta o carrito más reciente. Notas y llamadas fallidas no lo reinician.</p>
            </div>
          </details>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
          <div className="relative w-full sm:w-72"><IconSearch className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-ink-500" /><input type="search" aria-label="Buscar persona" placeholder="Buscar por nombre o cuenta" value={search} onChange={e => setSearch(e.target.value)} className={`${FIELD_BOX} h-9 w-full pl-9 pr-3`} /></div>
          <p className="text-xs text-ink-500"><span className="font-medium tabular-nums text-ink-900">{assignedCount}</span> de {advisors.length} personas con bloques asignados</p>
        </div>
        <div className="relative hidden max-h-[min(52vh,600px)] overflow-auto rounded-b-lg lg:block">
          <table className="w-full min-w-[1152px] table-fixed text-[13px]">
            <caption className="sr-only">Bloques de leads, respaldo y toma puntual por persona</caption>
            <colgroup><col className="w-60" /><col className="w-[152px]" />{LEAD_WORK_BLOCKS.map(b => <col key={b.key} className="w-24" />)}<col className="w-[84px]" /><col className="w-[100px]" /></colgroup>
            <thead className="sticky top-0 z-10 bg-wash text-xs text-ink-600"><tr>
              <th scope="col" className="sticky left-0 z-20 bg-wash px-4 py-3 text-left font-medium">Persona</th><th scope="col" className="px-3 py-3 text-left font-medium">Configuración</th>
              {LEAD_WORK_BLOCKS.map((b, i) => <th scope="col" key={b.key} title={b.label} className="px-2 py-3 text-center font-medium"><span className="block text-ink-900">{COLUMN_LABELS[i]![0]}</span><span className="block font-normal">{COLUMN_LABELS[i]![1]}</span></th>)}
              <th scope="col" className="border-l border-line px-2 py-3 text-center font-medium">Respaldo</th><th scope="col" title="Puede tomar leads fuera de sus bloques desde búsqueda o venta por teléfono. Respeta reservas y citas." className="px-2 py-3 text-center font-medium">Toma puntual</th>
            </tr></thead>
            <tbody className="divide-y divide-line">{visible.map(member => {
              const a = assignments.find(row => row.userId === member.userId)!;
              return <tr key={member.userId} className="group hover:bg-wash">
                <th scope="row" className="sticky left-0 bg-white px-4 py-3 text-left font-normal group-hover:bg-wash"><span title={member.name} className="block truncate font-medium text-ink-900">{member.name}</span><span title={`${member.account} · ${storeNames(member)}`} className="mt-0.5 block truncate text-xs text-ink-500">{member.account} · {member.stores.length ? `${member.stores.length} ${member.stores.length === 1 ? "tienda" : "tiendas"}` : "Sin tiendas"}</span></th>
                <td className="px-3 py-2"><PresetSelect member={member} assignment={a} onChange={blocks => patch(member.userId, { blocks })} /></td>
                {LEAD_WORK_BLOCKS.map(block => <td key={block.key} className="p-0 text-center"><label className="relative flex min-h-14 cursor-pointer items-center justify-center"><input className={CHECKBOX} type="checkbox" checked={a.blocks.includes(block.key)} onChange={() => toggle(member.userId, block.key)} /><span className="sr-only">{block.label} para {member.name}</span></label></td>)}
                <td className="border-l border-line p-0 text-center"><label className="relative flex min-h-14 cursor-pointer items-center justify-center"><input type="checkbox" className={CHECKBOX} checked={a.backup} onChange={e => patch(member.userId, { backup: e.target.checked })} /><span className="sr-only">Respaldo para {member.name}</span></label></td>
                <td className="p-0 text-center"><label className="flex min-h-14 cursor-pointer items-center justify-center"><input type="checkbox" className={CHECKBOX} checked={!!a.manualTake} onChange={e => patch(member.userId, { manualTake: e.target.checked })} /><span className="sr-only">Puede tomar leads fuera de sus bloques para {member.name}</span></label></td>
              </tr>;
            })}</tbody>
          </table>
        </div>
        <div className="divide-y divide-line lg:hidden">{visible.map(member => {
          const a = assignments.find(row => row.userId === member.userId)!;
          return <details key={member.userId} className="group">
            <summary className="flex min-h-16 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3"><span className="min-w-0"><span className="block truncate text-sm font-medium text-ink-900">{member.name}</span><span className="mt-0.5 block text-xs text-ink-500">{routingLabel(a.blocks)}</span></span><IconChevronDown className="size-4 shrink-0 text-ink-500 group-open:rotate-180" /></summary>
            <div className="space-y-3 px-4 pb-4"><p className="break-words text-xs text-ink-500">{member.account} · {storeNames(member)}</p><PresetSelect member={member} assignment={a} onChange={blocks => patch(member.userId, { blocks })} /><div>{LEAD_WORK_BLOCKS.map(block => <label key={block.key} className="relative flex min-h-11 cursor-pointer items-center gap-3 text-[13px] text-ink-900"><input type="checkbox" className={CHECKBOX} checked={a.blocks.includes(block.key)} onChange={() => toggle(member.userId, block.key)} /><span>{block.label}<span className="sr-only"> para {member.name}</span></span></label>)}</div><label className="relative flex min-h-11 cursor-pointer items-center gap-3 border-t border-line pt-3 text-[13px] text-ink-900"><input type="checkbox" className={CHECKBOX} checked={a.backup} onChange={e => patch(member.userId, { backup: e.target.checked })} /><span>Respaldo<span className="sr-only"> para {member.name}</span></span></label><label className="relative flex min-h-11 cursor-pointer items-start gap-3 border-t border-line pt-3 text-[13px] text-ink-900"><input type="checkbox" className={CHECKBOX} checked={!!a.manualTake} onChange={e => patch(member.userId, { manualTake: e.target.checked })} /><span>Puede tomar leads fuera de sus bloques<span className="sr-only"> para {member.name}</span><span className="mt-1 block text-xs text-ink-500">Solo desde búsqueda o venta por teléfono. Respeta reservas y citas.</span></span></label></div>
          </details>;
        })}</div>
        {!visible.length && <div className="px-4 py-10 text-center"><p className="text-sm text-ink-600">No se encontraron personas.</p><OpsButton className="mt-3" size="sm" onClick={() => setSearch("")}>Mostrar equipo</OpsButton></div>}
      </fieldset>
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-b-lg border-t border-line bg-white px-4 py-4">
        <div className="text-xs text-ink-600"><p className="font-medium text-ink-900">{dirty ? "Cambios sin guardar" : "Configuración actual"}</p>
          {missing.length ? <details className="mt-1"><summary className={`cursor-pointer ${enabled ? "text-crit-fg" : "text-ink-600"}`}>{missingBlocks} {missingBlocks === 1 ? "bloque sin" : "bloques sin"} cobertura · Ver pendientes</summary><ul className="mt-2 max-w-[70ch] space-y-1">{stores.filter(s => missing.some(m => m.storeId === s.id)).map(store => <li key={store.id}><span className="font-medium text-ink-900">{store.name}:</span> {missing.filter(m => m.storeId === store.id).map(m => LEAD_WORK_BLOCKS.find(b => b.key === m.block)!.label).join(", ")}</li>)}</ul></details> : <p className="mt-1 text-ok-fg">Todos los bloques cubiertos.</p>}
          <p className="mt-1">{enabled && missing.length ? "Completa la cobertura antes de activar." : "Se aplica al guardar. Conserva reservas y citas vigentes."}</p>
          {message.error && <p role="alert" className="mt-2 text-crit-fg">{message.error}</p>}{message.notice && <p role="status" className="mt-2 text-ok-fg">{message.notice}</p>}
        </div>
        <OpsButton variant="primary" className="w-full sm:w-auto" disabled={!dirty || pending || !installed || (enabled && missing.length > 0) || !Number.isInteger(hours) || hours < 1 || hours > 168} onClick={save}>{pending ? "Guardando…" : "Guardar cambios"}</OpsButton>
      </div>
    </div>
    {!enabled && <p className="text-xs text-ink-500">El reparto está desactivado. Puedes preparar los bloques; la cola conserva el acceso actual hasta que lo actives y guardes.</p>}
  </section>;
}
