"use client";

// Los tres bloques de Repro Lima (owner, 15-11-2026; MOM §9.5): «Por gestionar
// hoy», «Agenda» y «En manos del courier». Cada cifra es una tarjeta de estado
// que filtra la única lista de abajo (The Cifras Navegan Rule); los filtros de
// adentro (Reintentos Aliclik, Esperan anulación, Más de 30 días,
// Reprogramados) y los trabados del equipo (§9.6) son chips debajo de su
// bloque. Solo dibuja: las cuentas salen de lib/repro-lima-blocks.ts.
import { ChoiceChip, StatusCard } from "@/components/ops-ui";
import {
  LIMA_COURIER_CARDS,
  LIMA_SUB_FILTERS,
  LIMA_TASK_CARDS,
  agendaCards,
  type LimaBoardCounts,
  type LimaBoardKey,
  type LimaSubFilter,
} from "@/lib/repro-lima-blocks";
import { LIMA_STUCK_OWNER_LABEL, limaStuckRule, type LimaStuckReason } from "@/lib/lima-stuck";

export interface LimaStuckChip {
  reason: LimaStuckReason;
  count: number;
}

const CARD_GRID = "grid grid-cols-2 gap-2 [&>button>span:first-child]:whitespace-normal [&>button>span:last-child]:mt-auto";

function BlockHead({ id, title, total, help }: { id: string; title: string; total: number; help: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <h2 id={id} className="text-sm font-semibold text-ink-900">{title}</h2>
      <span className="text-[13px] font-semibold tabular-nums text-ink-600">{total.toLocaleString("es-PE")}</span>
      <p className="w-full text-[13px] text-ink-500 lg:w-auto">{help}</p>
    </div>
  );
}

function SubChips({ keys, counts, active, onPick }: { keys: readonly LimaSubFilter[]; counts: LimaBoardCounts; active: LimaBoardKey; onPick: (key: LimaBoardKey) => void }) {
  const shown = keys.filter((key) => counts.sub[key] > 0 || active === key);
  if (!shown.length) return null;
  return (
    <>
      {shown.map((key) => (
        <ChoiceChip key={key} label={LIMA_SUB_FILTERS[key].label} count={counts.sub[key]} title={LIMA_SUB_FILTERS[key].hint} active={active === key} onClick={() => onPick(key)} />
      ))}
    </>
  );
}

function StuckChips({ chips, active, onStuck }: { chips: readonly LimaStuckChip[]; active: LimaStuckReason | "todos" | null; onStuck: (reason: LimaStuckReason) => void }) {
  const shown = chips.filter((chip) => chip.count > 0 || active === chip.reason);
  if (!shown.length) return null;
  return (
    <span role="group" aria-label="Trabados" className="flex flex-wrap items-center gap-1.5">
      <span className="text-[13px] font-medium text-warn-fg">Trabados</span>
      {shown.map((chip) => {
        const rule = limaStuckRule(chip.reason);
        return (
          <ChoiceChip
            key={chip.reason}
            label={rule.label}
            count={chip.count}
            active={active === chip.reason}
            title={`${rule.hint} Siguiente paso (${LIMA_STUCK_OWNER_LABEL[rule.owner]}): ${rule.action}`}
            onClick={() => onStuck(chip.reason)}
          />
        );
      })}
    </span>
  );
}

export function ReproLimaBlocks({ counts, today, active, onPick, stuck, activeStuck, onStuck }: {
  counts: LimaBoardCounts;
  today: string;
  /** El filtro elegido; «todos» sin ninguno. */
  active: LimaBoardKey;
  onPick: (key: LimaBoardKey) => void;
  /** Los trabados de cada bloque (§9.6), por motivo. */
  stuck: { gestion: readonly LimaStuckChip[]; courier: readonly LimaStuckChip[] };
  activeStuck: LimaStuckReason | "todos" | null;
  onStuck: (reason: LimaStuckReason) => void;
}) {
  const agenda = agendaCards(today, counts.agenda);
  const gestionTotal = LIMA_TASK_CARDS.reduce((sum, card) => sum + counts.task[card.key], 0);
  const agendaTotal = agenda.reduce((sum, card) => sum + (counts.agenda[card.key] ?? 0), 0);
  const courierTotal = LIMA_COURIER_CARDS.reduce((sum, card) => sum + counts.courier[card.key], 0);
  return (
    <div className="space-y-4">
      <section aria-labelledby="repro-bloque-gestion" className="space-y-2">
        <BlockHead id="repro-bloque-gestion" title="Por gestionar hoy" total={gestionTotal} help="Lo que pide al equipo: confirmar, llamar, acordar o cerrar. Cada pedido, una sola tarea." />
        <div role="group" aria-label="Por gestionar hoy" className={`${CARD_GRID} sm:grid-cols-3 xl:grid-cols-5`}>
          {LIMA_TASK_CARDS.map((card) => (
            <StatusCard key={card.key} label={card.label} value={counts.task[card.key]} hint={card.hint} active={active === card.key} onClick={() => onPick(card.key)} />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 empty:hidden">
          <SubChips keys={["mas_de_30", "reintentos_aliclik", "esperan_anulacion"]} counts={counts} active={active} onPick={onPick} />
          <StuckChips chips={stuck.gestion} active={activeStuck} onStuck={onStuck} />
        </div>
      </section>

      <section aria-labelledby="repro-bloque-agenda" className="space-y-2">
        <BlockHead id="repro-bloque-agenda" title="Agenda" total={agendaTotal} help="El día en que sale: lo acordado con la clienta, «Programar envío», el programa de Grupo GF o el recojo del courier." />
        <div role="group" aria-label="Agenda" className={`${CARD_GRID} sm:grid-cols-4 xl:grid-cols-8`}>
          {agenda.map((card) => (
            <StatusCard key={card.key} label={card.label} value={counts.agenda[card.key] ?? 0} hint={card.hint} active={active === card.key} onClick={() => onPick(card.key)} />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 empty:hidden">
          <SubChips keys={["reprogramados"]} counts={counts} active={active} onPick={onPick} />
        </div>
      </section>

      <section aria-labelledby="repro-bloque-courier" className="space-y-2">
        <BlockHead id="repro-bloque-courier" title="En manos del courier" total={courierTotal} help="Solo seguimiento: con la guía viva de un courier, por su estado. Las cajas y los motorizados de Grupo GF están en Grupo GF Courier." />
        <div role="group" aria-label="En manos del courier" className={`${CARD_GRID} sm:grid-cols-3 xl:grid-cols-5`}>
          {LIMA_COURIER_CARDS.map((card) => (
            <StatusCard key={card.key} label={card.label} value={counts.courier[card.key]} hint={card.hint} active={active === card.key} onClick={() => onPick(card.key)} />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 empty:hidden">
          <StuckChips chips={stuck.courier} active={activeStuck} onStuck={onStuck} />
        </div>
      </section>
    </div>
  );
}
