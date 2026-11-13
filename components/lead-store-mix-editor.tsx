"use client";
import { FIELD_BOX } from "@/components/ops-ui";
import { validStoreWeights, type StoreWeights } from "@/lib/lead-store-distribution";

export function LeadStoreMixEditor({ name, stores, value, onChange }: {
  name: string; stores: { id: string; name: string }[]; value?: StoreWeights | null;
  onChange: (value: StoreWeights | null) => void;
}) {
  const total = Object.values(value ?? {}).reduce((sum, n) => sum + n, 0);
  return <div className="space-y-2">
    <select aria-label={`Distribución por tienda de ${name}`} className={`${FIELD_BOX} h-9 w-full px-2 text-[13px]`} value={value ? "custom" : "priority"} onChange={e => {
      if (e.target.value === "priority") return onChange(null);
      const each = Math.floor(100 / stores.length);
      onChange(Object.fromEntries(stores.map((s, i) => [s.id, i === stores.length - 1 ? 100 - each * i : each])));
    }}>
      <option value="priority">Por prioridad</option>
      <option value="custom" disabled={stores.length < 2}>Por porcentajes</option>
    </select>
    {value && <>
      <div className="flex flex-wrap gap-x-3 gap-y-2">{stores.map(store => <label key={store.id} className="flex min-w-0 items-center gap-1.5 text-xs text-ink-600">
        <span className="max-w-24 truncate" title={store.name}>{store.name}</span>
        <input aria-label={`Porcentaje ${store.name} de ${name}`} type="number" inputMode="numeric" min={0} max={100} step={1} value={value[store.id] ?? 0} className={`${FIELD_BOX} h-8 w-14 px-1.5 tabular-nums`} onChange={e => {
          const next = Number(e.target.value);
          const other = stores.find(s => s.id !== store.id);
          onChange({ ...value, [store.id]: next, ...(stores.length === 2 && other && Number.isInteger(next) && next >= 0 && next <= 100 ? { [other.id]: 100 - next } : {}) });
        }} /><span>%</span>
      </label>)}</div>
      {!validStoreWeights(value) && <p role="alert" className="text-xs text-crit-fg">Deben sumar 100 %. Total: {total} %.</p>}
    </>}
  </div>;
}
