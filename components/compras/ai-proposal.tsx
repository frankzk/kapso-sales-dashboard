"use client";

// La propuesta de «Leer con IA» (MOM §45.10). Lo que leyó la IA NO está
// guardado: aquí se revisa, se desmarca lo que no va, se corrige nombre, SKU,
// tienda, cantidad y precio y, si el documento no está en USD, se escribe el
// tipo de cambio «1 USD = X <moneda>». Solo «Agregar seleccionados» escribe, y
// lo hace con las mismas reglas que agregar a mano (`addAiProposalRows`). Sin
// «Montos de compras» el servidor ya mandó la propuesta sin precios ni cargos.
//
// Cada cargo trae SU moneda (0342): en US$ o S/ se guarda así, sin convertir
// (la factura de DHL Express Perú en soles da costos en soles); en la moneda
// del documento (CNY, EUR…) pasa a USD con el tipo de cambio. El IGV del
// documento se muestra como dato y nunca se agrega como costo.

import { useState } from "react";
import { cn } from "@/components/ui";
import { ALLOCATIONS, COST_KINDS, MISSING_FX } from "@/lib/compras";
import { aiChargeNeedsFx, chargeToUsd, cleanAiFx, unitToUsd } from "@/lib/compras-ia";
import { addAiProposalRows, type AiReadState, type ComprasActionState } from "@/app/dashboard/compras/actions";
import { BTN_GHOST, BTN_PRIMARY, FIELD, Field, fieldBox } from "@/components/compras/header-form";
import { Badge, Banner, CHECKBOX } from "@/components/ops-ui";
import { IconInfo } from "@/components/icons";
import { fmtPen, fmtUsd, fmtUsdUnit } from "@/components/compras/format";

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

type ChargeDraft = { on: boolean; kind: string; label: string; amount: string; currency: string; allocation: string };

/** Un monto en una moneda cualquiera: «S/ 76.91», «US$ 20.00», «CNY 142.50». */
const fmtAny = (n: number, currency: string) => (currency === "PEN" ? fmtPen(n) : currency === "USD" ? fmtUsd(n) : `${currency} ${n.toFixed(2)}`);

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
    proposal.charges.map((c) => ({
      on: true,
      kind: c.kind,
      label: c.label,
      amount: short(c.amount),
      currency: c.currency ?? proposal.currency ?? "USD",
      allocation: "value",
    })),
  );
  const setLine = (i: number, patch: Partial<LineDraft>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const setCharge = (i: number, patch: Partial<ChargeDraft>) => setCharges((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  const cur = currency.trim().toUpperCase() || "USD";
  const isUsd = cur === "USD";
  const fxValue = isUsd ? 1 : cleanAiFx(fx);
  const chosenLines = lines.filter((l) => l.on);
  const chosenCharges = money ? charges.filter((c) => c.on) : [];
  // La moneda de cada cargo: US$, S/ o la del documento; otra cualquiera se toma como la del documento.
  const chargeCurrencies = ["USD", "PEN", ...(cur !== "USD" && cur !== "PEN" ? [cur] : [])];
  const chargeCur = (c: ChargeDraft) => {
    const v = c.currency.trim().toUpperCase();
    return chargeCurrencies.includes(v) ? v : cur;
  };
  // El tipo de cambio hace falta para los precios (pasan a USD) y para los cargos en la moneda del documento.
  const needsFx =
    money && !isUsd && (chosenLines.some((l) => l.unitPrice.trim() !== "") || chosenCharges.some((c) => aiChargeNeedsFx(chargeCur(c))));
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
          charges: chosenCharges.map((c) => ({ kind: c.kind, label: c.label, amount: c.amount, currency: chargeCur(c), allocation: c.allocation })),
        }),
      onClose,
    );

  const LINE_GRID = "sm:grid-cols-[1rem_minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_5.5rem]";
  const HEAD = "hidden gap-x-3 text-xs font-semibold text-ink-600 sm:grid";
  return (
    // Dentro de la tarjeta «Documentos»: una zona en el lavado `info` (una
    // ayuda que espera revisión), no otra tarjeta. Las filas van con hairlines.
    <div className="space-y-4 rounded-lg bg-info-wash p-3 sm:p-4" role="region" aria-label="Propuesta de la IA">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 gap-3">
          <IconInfo aria-hidden className="mt-0.5 size-4 shrink-0 text-info-fg" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="min-w-0 break-words text-sm font-semibold text-info-fg">Leído con IA{proposal.filename ? `: ${proposal.filename}` : ""}</p>
              <Badge tone="info">Sin guardar</Badge>
            </div>
            <p className="mt-0.5 max-w-[68ch] text-[13px] leading-5 text-ink-700">
              Es una propuesta: no se guardó nada. Revisa, desmarca lo que no va y pulsa «Agregar seleccionados».
              {proposal.existingItems > 0 ? ` La importación ya tiene ${proposal.existingItems} productos: lo leído se agrega aparte.` : ""}
              {proposal.dropped > 0 ? ` ${proposal.dropped} fila${proposal.dropped === 1 ? "" : "s"} sin nombre, cantidad o monto se dejaron fuera.` : ""}
            </p>
          </div>
        </div>
        <button type="button" className={BTN_GHOST} onClick={onClose}>
          Descartar
        </button>
      </div>

      {money && (
        <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
          <Field label="Moneda del documento">
            <input className={cn(fieldBox("w-24"), "font-mono uppercase")} maxLength={3} value={currency} onChange={(e) => setCurrency(e.target.value)} />
          </Field>
          {/* Solo si algo lo necesita: una factura en soles con cargos en soles no pide tipo de cambio. */}
          {!isUsd && (needsFx || fx.trim() !== "") && (
            <Field label={`Tipo de cambio: 1 USD = X ${cur}`}>
              <input
                className={cn(fieldBox("w-36"), "tabular-nums", missingFx && "ring-2 ring-warn-fg")}
                inputMode="decimal"
                placeholder={`X ${cur}`}
                value={fx}
                onChange={(e) => setFx(e.target.value)}
                aria-label={`1 USD en ${cur}`}
              />
            </Field>
          )}
          <p className="pb-2 text-xs leading-4 text-ink-600">
            {isUsd
              ? "En USD: el precio por unidad se guarda a 4 decimales y los cargos a 2. Un cargo en S/ se guarda en soles."
              : `Precio por unidad en USD = precio ÷ X, a 4 decimales. Los cargos en US$ o S/ se guardan así; en ${cur}, ÷ X a 2 decimales.`}
          </p>
        </div>
      )}

      {lines.length > 0 ? (
        <div className="space-y-2">
          <p className="text-[13px] font-semibold text-ink-900">
            Productos <span className="font-normal tabular-nums text-ink-600">· {chosenLines.length} de {lines.length}</span>
          </p>
          <div aria-hidden className={cn(HEAD, LINE_GRID)}>
            <span />
            <span>Producto</span>
            <span>SKU</span>
            <span>Tienda</span>
            <span>Cantidad</span>
          </div>
          <ul className="divide-y divide-line-strong/60 border-y border-line-strong/60">
            {lines.map((l, i) => {
              const price = priceNum(l.unitPrice);
              return (
                <li key={i} className={cn("grid grid-cols-[1rem_minmax(0,1fr)] gap-x-3 gap-y-2 py-3 sm:items-start", LINE_GRID)}>
                  <input type="checkbox" className={cn(CHECKBOX, "mt-2.5")} checked={l.on} onChange={(e) => setLine(i, { on: e.target.checked })} aria-label={`Incluir ${l.name}`} />
                  <div className={cn("min-w-0 space-y-1", !l.on && "opacity-50")}>
                    <input className={FIELD} value={l.name} onChange={(e) => setLine(i, { name: e.target.value })} aria-label="Producto" />
                    <p className="text-xs leading-4 text-ink-600">
                      {l.matched ? <span className="font-medium text-ok-fg">Coincide con un SKU conocido · </span> : <span>Producto nuevo · </span>}
                      {l.docName !== l.name ? `En el documento: ${l.docName}` : "Tal como está en el documento"}
                    </p>
                  </div>
                  <div className={cn("col-start-2 grid grid-cols-[minmax(0,1fr)_5.5rem] gap-x-3 gap-y-2 sm:contents", !l.on && "opacity-50")}>
                    <input className={cn(FIELD, "font-mono")} placeholder="SKU" value={l.sku} onChange={(e) => setLine(i, { sku: e.target.value })} aria-label="SKU" />
                    <select className={cn(FIELD, "order-last col-span-2 sm:order-none sm:col-span-1")} value={l.storeId} onChange={(e) => setLine(i, { storeId: e.target.value })} aria-label="Tienda">
                      <option value="">Todas las tiendas</option>
                      {stores.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                    <input className={cn(FIELD, "tabular-nums")} inputMode="numeric" value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} aria-label="Cantidad" />
                  </div>
                  {money && (
                    <div className={cn("col-start-2 flex flex-wrap items-center gap-x-3 gap-y-1 sm:col-[2/-1]", !l.on && "opacity-50")}>
                      <input
                        className={cn(fieldBox("w-36"), "tabular-nums")}
                        inputMode="decimal"
                        placeholder={`Precio/u (${cur})`}
                        value={l.unitPrice}
                        onChange={(e) => setLine(i, { unitPrice: e.target.value })}
                        aria-label={`Precio por unidad en ${cur}`}
                      />
                      <span className={cn("text-[13px] tabular-nums", price !== null && !fxValue ? "font-medium text-warn-fg" : "text-ink-600")}>
                        {price === null ? "Sin precio: se guarda en 0" : fxValue ? `= ${fmtUsdUnit(unitToUsd(price, fxValue))}/u` : "Falta el tipo de cambio"}
                      </span>
                      {l.unitWeightKg && <span className="text-[13px] tabular-nums text-ink-600">· {l.unitWeightKg} kg/u</span>}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        <p className="text-sm text-ink-700">La IA no encontró productos en el documento.</p>
      )}

      {money && charges.length > 0 && (
        <div className="space-y-2">
          <p className="text-[13px] font-semibold text-ink-900">
            Cargos a repartir <span className="font-normal tabular-nums text-ink-600">· {chosenCharges.length} de {charges.length}</span>
          </p>
          <p className="text-xs leading-4 text-ink-600">Montos sin IGV, en la moneda de cada cargo.</p>
          <ul className="divide-y divide-line-strong/60 border-y border-line-strong/60">
            {charges.map((c, i) => {
              const amount = priceNum(c.amount);
              const ccur = chargeCur(c);
              const convert = aiChargeNeedsFx(ccur);
              return (
                // Dos renglones también en pantalla ancha: tipo y nombre; monto con su moneda y reparto.
                <li key={i} className="grid grid-cols-[1rem_minmax(0,1fr)] gap-x-3 gap-y-2 py-3">
                  <input type="checkbox" className={cn(CHECKBOX, "mt-2.5")} checked={c.on} onChange={(e) => setCharge(i, { on: e.target.checked })} aria-label={`Incluir ${c.label}`} />
                  <div className={cn("grid min-w-0 gap-2 sm:grid-cols-[8.5rem_minmax(0,1fr)]", !c.on && "opacity-50")}>
                    <select className={FIELD} value={c.kind} onChange={(e) => setCharge(i, { kind: e.target.value })} aria-label="Tipo de costo">
                      {COST_KINDS.map((k) => (
                        <option key={k.id} value={k.id}>
                          {k.label}
                        </option>
                      ))}
                    </select>
                    <input className={FIELD} value={c.label} onChange={(e) => setCharge(i, { label: e.target.value })} aria-label="Nombre del cargo" />
                  </div>
                  <div className={cn("col-start-2 grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_9.5rem] sm:items-start", !c.on && "opacity-50")}>
                    <div className="min-w-0 space-y-0.5">
                      <div className="flex min-w-0 gap-2">
                        <select className={fieldBox("w-[5.5rem] shrink-0")} value={ccur} onChange={(e) => setCharge(i, { currency: e.target.value })} aria-label="Moneda del cargo">
                          {chargeCurrencies.map((x) => (
                            <option key={x} value={x}>
                              {x === "USD" ? "US$" : x === "PEN" ? "S/" : x}
                            </option>
                          ))}
                        </select>
                        <input
                          className={cn(fieldBox("min-w-0 flex-1"), "tabular-nums")}
                          inputMode="decimal"
                          value={c.amount}
                          onChange={(e) => setCharge(i, { amount: e.target.value })}
                          aria-label={`Monto sin IGV en ${ccur}`}
                        />
                      </div>
                      <p className={cn("text-xs tabular-nums", convert && amount !== null && !fxValue ? "font-medium text-warn-fg" : "text-ink-600")}>
                        {!convert
                          ? `Se guarda en ${ccur === "PEN" ? "soles" : "dólares"}, sin convertir`
                          : amount === null
                            ? ccur
                            : fxValue
                              ? `= ${fmtUsd(chargeToUsd(amount, fxValue))}`
                              : MISSING_FX}
                      </p>
                    </div>
                    <select className={FIELD} value={c.allocation} onChange={(e) => setCharge(i, { allocation: e.target.value })} aria-label="Reparto">
                      {ALLOCATIONS.filter((a) => a.id !== "item").map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {money && proposal.igv && (
        // El IGV es un dato del documento: los cargos ya vienen sin IGV y el IGV nunca se agrega como costo.
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] leading-5 text-ink-700">
          <Badge>Informativo</Badge>
          <span>
            IGV del documento: <span className="font-semibold tabular-nums text-ink-900">{fmtAny(proposal.igv.amount, proposal.igv.currency ?? cur)}</span>. No se agrega como
            costo: los montos de arriba ya van sin IGV.
          </span>
        </p>
      )}

      {missingFx && (
        <Banner tone="warn" role="alert">
          <p>Escribe el tipo de cambio: 1 USD = X {cur}.</p>
        </Banner>
      )}
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
