"use client";

// La propuesta de «Leer con IA» (MOM §45.10). Lo que leyó la IA NO está
// guardado: aquí se revisa, se desmarca lo que no va, se corrige nombre, SKU,
// tienda, cantidad y precio y, si el documento no está en USD, se escribe el
// tipo de cambio «1 USD = X <moneda>». Solo «Agregar seleccionados» escribe, y
// lo hace con las mismas reglas que agregar a mano (`addAiProposalRows`). Sin
// «Montos de compras» el servidor ya mandó la propuesta sin precios ni cargos.

import { useState } from "react";
import { cn } from "@/components/ui";
import { ALLOCATIONS, COST_KINDS } from "@/lib/compras";
import { chargeToUsd, cleanAiFx, unitToUsd } from "@/lib/compras-ia";
import { addAiProposalRows, type AiReadState, type ComprasActionState } from "@/app/dashboard/compras/actions";
import { BTN_GHOST, BTN_PRIMARY, FIELD, LABEL } from "@/components/compras/header-form";
import { fmtUsd, fmtUsdUnit } from "@/components/compras/format";

type Proposal = Exclude<AiReadState, { error: string }>;
type Store = { id: string; name: string };
type Run = (fn: () => Promise<ComprasActionState>, after?: () => void) => void;

type LineDraft = {
  on: boolean;
  docName: string;
  name: string;
  sku: string;
  storeId: string;
  qty: string;
  unitPrice: string;
  unitWeightKg: string;
  matched: boolean;
};

type ChargeDraft = { on: boolean; kind: string; label: string; amount: string; allocation: string };

const short = (n: number) => String(Math.round(n * 1_000_000) / 1_000_000);

export function AiProposalBox({
  importId,
  stores,
  proposal,
  run,
  pending,
  onClose,
}: {
  importId: string;
  stores: Store[];
  proposal: Proposal;
  run: Run;
  pending: boolean;
  onClose: () => void;
}) {
  const money = proposal.money;
  const storeIds = new Set(stores.map((s) => s.id));
  const [currency, setCurrency] = useState(proposal.currency ?? "USD");
  const [fx, setFx] = useState("");
  const [lines, setLines] = useState<LineDraft[]>(() =>
    proposal.lines.map((l) => ({
      on: true,
      docName: l.name,
      name: l.match?.name ?? l.name,
      sku: l.match?.sku ?? l.sku ?? "",
      storeId: l.match?.storeId && storeIds.has(l.match.storeId) ? l.match.storeId : "",
      qty: String(l.qty),
      unitPrice: l.unitPrice == null ? "" : short(l.unitPrice),
      unitWeightKg: l.unitWeightKg == null ? "" : String(l.unitWeightKg),
      matched: Boolean(l.match),
    })),
  );
  const [charges, setCharges] = useState<ChargeDraft[]>(() =>
    proposal.charges.map((c) => ({ on: true, kind: c.kind, label: c.label, amount: short(c.amount), allocation: "value" })),
  );
  const setLine = (i: number, patch: Partial<LineDraft>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const setCharge = (i: number, patch: Partial<ChargeDraft>) => setCharges((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  const cur = currency.trim().toUpperCase() || "USD";
  const isUsd = cur === "USD";
  const fxValue = isUsd ? 1 : cleanAiFx(fx);
  const chosenLines = lines.filter((l) => l.on);
  const chosenCharges = money ? charges.filter((c) => c.on) : [];
  const needsFx = money && !isUsd && (chosenLines.some((l) => l.unitPrice.trim() !== "") || chosenCharges.length > 0);
  const missingFx = needsFx && fxValue === null;
  const priceNum = (raw: string) => {
    const n = Number(raw.replace(",", "."));
    return raw.trim() !== "" && Number.isFinite(n) && n >= 0 ? n : null;
  };

  const submit = () =>
    run(
      () =>
        addAiProposalRows(importId, {
          documentId: proposal.documentId,
          currency: cur,
          fx,
          lines: chosenLines.map((l) => ({
            name: l.name,
            sku: l.sku,
            storeId: l.storeId,
            qty: l.qty,
            unitWeightKg: l.unitWeightKg,
            ...(money ? { unitPrice: l.unitPrice } : {}),
          })),
          charges: chosenCharges.map((c) => ({ kind: c.kind, label: c.label, amount: c.amount, allocation: c.allocation })),
        }),
      onClose,
    );

  return (
    <div className="space-y-3 rounded-lg border border-brand-200 bg-brand-50/40 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-slate-900">Leído con IA{proposal.filename ? `: ${proposal.filename}` : ""}</p>
          <p className="text-xs text-slate-600">
            Es una propuesta: no se guardó nada. Revisa, desmarca lo que no va y pulsa «Agregar seleccionados».
            {proposal.existingItems > 0 ? ` La importación ya tiene ${proposal.existingItems} productos: lo leído se agrega aparte.` : ""}
            {proposal.dropped > 0 ? ` ${proposal.dropped} fila${proposal.dropped === 1 ? "" : "s"} sin nombre, cantidad o monto se dejaron fuera.` : ""}
          </p>
        </div>
        <button type="button" className={BTN_GHOST} onClick={onClose}>
          Descartar
        </button>
      </div>

      {money && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <label className={LABEL}>Moneda del documento</label>
            <input className={cn(FIELD, "w-24 uppercase")} maxLength={3} value={currency} onChange={(e) => setCurrency(e.target.value)} aria-label="Moneda del documento" />
          </div>
          {!isUsd && (
            <div className="space-y-1">
              <label className={LABEL}>Tipo de cambio: 1 USD = X {cur}</label>
              <input
                className={cn(FIELD, "w-36", missingFx && "border-amber-400")}
                inputMode="decimal"
                placeholder={`X ${cur}`}
                value={fx}
                onChange={(e) => setFx(e.target.value)}
                aria-label={`1 USD en ${cur}`}
              />
            </div>
          )}
          <p className="text-xs text-slate-500">
            {isUsd
              ? "En USD: el precio por unidad se guarda a 4 decimales y los cargos a 2."
              : `Precio por unidad en USD = precio ÷ X, a 4 decimales; cargos ÷ X, a 2.`}
          </p>
        </div>
      )}

      {lines.length > 0 ? (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-slate-600">
            Productos ({chosenLines.length} de {lines.length})
          </p>
          {lines.map((l, i) => {
            const price = priceNum(l.unitPrice);
            return (
              <div key={i} className={cn("grid gap-2 rounded-md border border-slate-200 bg-white p-2 sm:grid-cols-[auto_minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_5rem]", !l.on && "opacity-50")}>
                <input type="checkbox" className="mt-2.5 h-4 w-4" checked={l.on} onChange={(e) => setLine(i, { on: e.target.checked })} aria-label={`Incluir ${l.name}`} />
                <div className="space-y-1">
                  <input className={FIELD} value={l.name} onChange={(e) => setLine(i, { name: e.target.value })} aria-label="Producto" />
                  <p className="text-[11px] text-slate-500">
                    {l.matched ? <span className="font-medium text-emerald-700">Coincide con un SKU conocido · </span> : <span>Producto nuevo · </span>}
                    {l.docName !== l.name ? `En el documento: ${l.docName}` : "Tal como está en el documento"}
                  </p>
                </div>
                <input className={FIELD} placeholder="SKU" value={l.sku} onChange={(e) => setLine(i, { sku: e.target.value })} aria-label="SKU" />
                <select className={FIELD} value={l.storeId} onChange={(e) => setLine(i, { storeId: e.target.value })} aria-label="Tienda">
                  <option value="">Todas las tiendas</option>
                  {stores.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                <input className={FIELD} inputMode="numeric" value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} aria-label="Cantidad" />
                {money && (
                  <div className="flex flex-wrap items-center gap-2 sm:col-span-4 sm:col-start-2">
                    <input
                      className={cn(FIELD, "w-36")}
                      inputMode="decimal"
                      placeholder={`Precio/u (${cur})`}
                      value={l.unitPrice}
                      onChange={(e) => setLine(i, { unitPrice: e.target.value })}
                      aria-label={`Precio por unidad en ${cur}`}
                    />
                    <span className="text-xs text-slate-500">
                      {price === null ? "Sin precio: se guarda en 0" : fxValue ? `= ${fmtUsdUnit(unitToUsd(price, fxValue))}/u` : "Falta el tipo de cambio"}
                    </span>
                    {l.unitWeightKg && <span className="text-xs text-slate-500">· {l.unitWeightKg} kg/u</span>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-sm text-slate-500">La IA no encontró productos en el documento.</p>
      )}

      {money && charges.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-slate-600">
            Cargos a repartir ({chosenCharges.length} de {charges.length})
          </p>
          {charges.map((c, i) => {
            const amount = priceNum(c.amount);
            return (
              <div key={i} className={cn("grid gap-2 rounded-md border border-slate-200 bg-white p-2 sm:grid-cols-[auto_8rem_minmax(0,2fr)_8rem_9rem]", !c.on && "opacity-50")}>
                <input type="checkbox" className="mt-2.5 h-4 w-4" checked={c.on} onChange={(e) => setCharge(i, { on: e.target.checked })} aria-label={`Incluir ${c.label}`} />
                <select className={FIELD} value={c.kind} onChange={(e) => setCharge(i, { kind: e.target.value })} aria-label="Tipo de costo">
                  {COST_KINDS.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.label}
                    </option>
                  ))}
                </select>
                <input className={FIELD} value={c.label} onChange={(e) => setCharge(i, { label: e.target.value })} aria-label="Nombre del cargo" />
                <div className="space-y-0.5">
                  <input className={FIELD} inputMode="decimal" value={c.amount} onChange={(e) => setCharge(i, { amount: e.target.value })} aria-label={`Monto en ${cur}`} />
                  <p className="text-[11px] text-slate-500">{amount !== null && fxValue ? `= ${fmtUsd(chargeToUsd(amount, fxValue))}` : cur}</p>
                </div>
                <select className={FIELD} value={c.allocation} onChange={(e) => setCharge(i, { allocation: e.target.value })} aria-label="Reparto">
                  {ALLOCATIONS.filter((a) => a.id !== "item").map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label}
                    </option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>
      )}

      {missingFx && <p className="text-sm text-amber-800">Escribe el tipo de cambio: 1 USD = X {cur}.</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={BTN_PRIMARY} disabled={pending || missingFx || (!chosenLines.length && !chosenCharges.length)} onClick={submit}>
          Agregar seleccionados
        </button>
        <button type="button" className={BTN_GHOST} onClick={onClose}>
          Cancelar
        </button>
      </div>
    </div>
  );
}
