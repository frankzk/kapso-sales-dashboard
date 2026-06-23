import { BarList, type BarItem } from "@/components/ui";
import type { DateHourPattern } from "@/lib/metrics";

const WEEKDAYS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];

function topHours(byHour: number[]): BarItem[] {
  return byHour
    .map((v, h) => ({ label: `${String(h).padStart(2, "0")}:00`, value: v, valueLabel: String(v) }))
    .filter((i) => i.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 6);
}

/** Per-store order timing: peak weekday/hour + top hours and by-weekday bars. */
export function HourPattern({ pattern }: { pattern: DateHourPattern }) {
  return (
    <div>
      {pattern.peak ? (
        <p className="text-sm text-slate-700">
          Pico: <strong>{WEEKDAYS[pattern.peak.weekday]}</strong> a las{" "}
          <strong>{String(pattern.peak.hour).padStart(2, "0")}:00</strong> ({pattern.peak.count} órdenes)
        </p>
      ) : (
        <p className="text-sm text-slate-400">Sin datos en el rango.</p>
      )}
      <div className="mt-4 grid gap-6 sm:grid-cols-2">
        <BarList items={topHours(pattern.byHour)} empty="—" />
        <BarList
          items={pattern.byWeekday.map((v, i) => ({ label: WEEKDAYS[i]!, value: v, valueLabel: String(v) }))}
        />
      </div>
    </div>
  );
}
