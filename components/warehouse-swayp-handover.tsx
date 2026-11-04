"use client";

// «Entregar a Swayp» · Lima (fase 3; owner 04-11-2026, MOM §9.1). El panel de
// la entrega del día dentro de «Swayp por salir»: se escanea cada caja al
// dársela al chofer de Swayp (pasa hacia las 07:00), la que no sale lleva su
// motivo y su explicación, y se cierra con el nombre del chofer y cuántas cajas
// contó. Las reglas y los textos están en lib/swayp-handover.ts; las escrituras
// son acciones de servidor; lo que se ve sale de la relectura de «Swayp por
// salir» (la estación la pide después de cada acción).

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { cn } from "@/components/ui";
import { Badge, Banner, FIELD, FIELD_BOX, OpsButton, SidePanel } from "@/components/ops-ui";
import {
  closeSwaypHandover,
  markSwaypNoSale,
  markSwaypNoVino,
  scanSwaypHandover,
  undoSwaypNoSale,
} from "@/app/dashboard/pedidos/despacho/actions";
import {
  SWAYP_CLOSE_BUTTON,
  SWAYP_CLOSE_COUNT,
  SWAYP_CLOSE_COUNT_LABEL,
  SWAYP_CLOSE_DRIVER,
  SWAYP_CLOSE_DRIVER_LABEL,
  SWAYP_HANDOVER_COUNTER,
  SWAYP_HANDOVER_HELP,
  SWAYP_HANDOVER_REMAINING,
  SWAYP_HANDOVER_SCAN_LABEL,
  SWAYP_HANDOVER_TITLE,
  SWAYP_NO_SALE_BUTTON,
  SWAYP_NO_SALE_DETAIL_LABEL,
  SWAYP_NO_SALE_DETAIL_MAX,
  SWAYP_NO_SALE_QUESTION,
  SWAYP_NO_SALE_REASONS,
  SWAYP_NO_SALE_UNDO,
  SWAYP_NO_VINO_BUTTON,
  SWAYP_NO_VINO_CONFIRM,
  SWAYP_ROW_ENTREGADA,
  swaypNoSaleError,
  swaypNoSaleReason,
  swaypSuggestedNoSale,
  type SwaypHandoverItem,
  type SwaypNoSaleCode,
} from "@/lib/swayp-handover";
import type { SwaypArmadaRow, SwaypFaltaRow, SwaypZone } from "@/lib/warehouse-swayp";

type Result = { error?: string; notice?: string };
const NETWORK_ERROR = "No pudimos guardar. Revisa la conexión y vuelve a intentarlo.";
type Row = (SwaypFaltaRow | SwaypArmadaRow) & { where?: SwaypFaltaRow["where"] };

/** Las filas de la entrega con lo que «Swayp por salir» sabe de cada caja. */
function handoverRows(zone: SwaypZone): Map<string, Row> {
  const rows = new Map<string, Row>();
  for (const row of zone.faltan) rows.set(row.shipmentId, row);
  for (const row of zone.armadas) rows.set(row.shipmentId, row);
  return rows;
}

export function SwaypHandoverPanel({
  zone,
  manifestId,
  onClose,
  onChanged,
}: {
  /** La zona «Hoy» ya leída, con su `entrega`. */
  zone: SwaypZone;
  manifestId: string;
  onClose: () => void;
  /** Relee «Swayp por salir» después de cada acción. */
  onChanged: () => Promise<unknown>;
}) {
  const entrega = zone.entrega;
  const rows = handoverRows(zone);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [noSaleFor, setNoSaleFor] = useState<string | null>(null);
  const [confirmNoVino, setConfirmNoVino] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const noVinoCancelRef = useRef<HTMLButtonElement>(null);
  // Los escaneos van en cola: el lector manda el siguiente código con su Enter
  // mientras el anterior se guarda, y ninguno se pierde ni se pega al otro.
  const queue = useRef<string[]>([]);
  const draining = useRef(false);
  const counterId = useId();
  const focusScanner = () => requestAnimationFrame(() => inputRef.current?.focus());

  // El panel enfoca su hoja al abrir; el escáner va después, en el siguiente cuadro.
  useEffect(() => {
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);
  // La confirmación de «Swayp no vino» recibe el foco en «Cancelar».
  useEffect(() => {
    if (confirmNoVino) noVinoCancelRef.current?.focus();
  }, [confirmNoVino]);

  async function drain() {
    if (draining.current) return;
    draining.current = true;
    setScanning(true);
    try {
      while (queue.current.length) {
        const next = queue.current.shift()!;
        try {
          setResult(await scanSwaypHandover(manifestId, next));
        } catch {
          setResult({ error: NETWORK_ERROR });
        }
        // Se relee al vaciar la cola; lo que llegue mientras tanto sigue en el bucle.
        if (!queue.current.length) await onChanged();
      }
    } finally {
      draining.current = false;
      setScanning(false);
    }
  }

  function onScan(event: FormEvent) {
    event.preventDefault();
    const value = code.trim();
    setCode("");
    inputRef.current?.focus();
    if (!value) return;
    queue.current.push(value);
    void drain();
  }

  /**
   * Las demás acciones. Con `inline`, el error lo pinta el formulario junto a
   * su campo (cierre y «No sale») y el foco se queda ahí; lo que sale bien se
   * dice arriba y se relee.
   */
  async function run(action: () => Promise<Result>, opts: { inline?: boolean; refocus?: boolean } = {}): Promise<Result> {
    setBusy(true);
    let outcome: Result;
    try {
      outcome = await action();
    } catch {
      outcome = { error: NETWORK_ERROR };
    }
    try {
      if (outcome.error && opts.inline) return outcome;
      setResult(outcome);
      await onChanged();
      if (opts.refocus) focusScanner();
      return outcome;
    } finally {
      setBusy(false);
    }
  }

  const items = entrega?.items ?? [];
  const pending = items.filter((item) => item.status === "por_entregar");
  const delivered = items.filter((item) => item.status === "entregada");
  const noSale = items.filter((item) => item.status === "no_sale");
  const open = entrega?.state === "abierta";
  const total = entrega?.total ?? 0;

  return (
    <SidePanel
      label={SWAYP_HANDOVER_TITLE(zone.dayLabel)}
      title={SWAYP_HANDOVER_TITLE(zone.dayLabel)}
      meta={SWAYP_HANDOVER_HELP}
      width="max-w-[640px]"
      onClose={onClose}
    >
      <div className="space-y-5">
        {/* El contador manda: se lee desde lejos y el lector lo anuncia. */}
        <div id={counterId} role="status" aria-live="polite" className="rounded-lg bg-wash px-4 py-3">
          <p className="text-2xl font-semibold tabular-nums text-ink-900">{SWAYP_HANDOVER_COUNTER(entrega?.delivered ?? 0, total)}</p>
          <p className={cn("text-sm font-medium tabular-nums", entrega && entrega.missing > 0 ? "text-crit-fg" : "text-ok-fg")}>
            {SWAYP_HANDOVER_REMAINING(entrega?.missing ?? 0)}
            {noSale.length > 0 ? ` · ${noSale.length === 1 ? "1 no sale" : `${noSale.length} no salen`}` : ""}
          </p>
        </div>

        {!open && entrega && <Banner tone={entrega.state === "cerrada" ? "ok" : "crit"} title={entrega.statusLine} />}

        {open && (
          <form onSubmit={onScan} className="space-y-2">
            <label className="block text-[13px] font-medium text-ink-700" htmlFor={`${counterId}-scan`}>{SWAYP_HANDOVER_SCAN_LABEL}</label>
            <div className="flex gap-2">
              <input
                id={`${counterId}-scan`}
                ref={inputRef}
                value={code}
                onChange={(event) => setCode(event.target.value)}
                autoComplete="off"
                inputMode="text"
                aria-describedby={counterId}
                className={cn(FIELD, "h-11 text-base font-medium")}
              />
              {/* Nunca se apaga por lo que se está guardando: el lector manda el Enter del siguiente. */}
              <OpsButton type="submit" variant="primary" disabled={!code.trim()} className="h-11 shrink-0 px-5">
                Entregar
              </OpsButton>
            </div>
            {scanning && <p className="text-xs text-ink-500">Guardando el escaneo…</p>}
          </form>
        )}

        {result && (
          <Banner tone={result.error ? "crit" : "ok"} role={result.error ? "alert" : "status"}>
            {result.error ?? result.notice}
          </Banner>
        )}

        {pending.length > 0 && (
          <HandoverList title="Por entregar" count={pending.length} tone="warn">
            {pending.map((item) => {
              const row = rows.get(item.shipmentId);
              return (
                <li key={item.shipmentId} className="min-w-0 break-words px-3 py-2.5">
                  <RowHead row={row} fallback={item.shipmentId} />
                  {row?.where && <p className="mt-1 text-[13px] text-ink-700">{row.where.text}</p>}
                  {open && noSaleFor !== item.shipmentId && (
                    <OpsButton size="sm" variant="danger" className="mt-2 pointer-coarse:h-11" onClick={() => setNoSaleFor(item.shipmentId)} disabled={busy}>
                      {SWAYP_NO_SALE_BUTTON}
                    </OpsButton>
                  )}
                  {open && noSaleFor === item.shipmentId && (
                    <NoSaleForm
                      code={row?.code ?? "esta caja"}
                      suggested={swaypSuggestedNoSale(row?.where ?? null)}
                      busy={busy}
                      onCancel={() => {
                        setNoSaleFor(null);
                        focusScanner();
                      }}
                      onSave={async (reason, detail) => {
                        const outcome = await run(() => markSwaypNoSale(manifestId, item.shipmentId, reason, detail), { inline: true, refocus: true });
                        if (!outcome.error) setNoSaleFor(null);
                        return outcome;
                      }}
                    />
                  )}
                </li>
              );
            })}
          </HandoverList>
        )}

        {noSale.length > 0 && (
          <HandoverList title="No sale" count={noSale.length} tone="crit">
            {noSale.map((item) => (
              <li key={item.shipmentId} className="min-w-0 break-words px-3 py-2.5">
                <RowHead row={rows.get(item.shipmentId)} fallback={item.shipmentId} />
                <p className="mt-1 text-[13px] font-medium text-crit-fg">{item.reason ?? "Sin motivo."}</p>
                <NoSaleMeta item={item} />
                {open && (
                  <OpsButton size="sm" className="mt-2 pointer-coarse:h-11" disabled={busy} onClick={() => run(() => undoSwaypNoSale(manifestId, item.shipmentId), { refocus: true })}>
                    {SWAYP_NO_SALE_UNDO}
                  </OpsButton>
                )}
              </li>
            ))}
          </HandoverList>
        )}

        {delivered.length > 0 && (
          <HandoverList title="Entregadas" count={delivered.length} tone="ok">
            {delivered.map((item) => (
              <li key={item.shipmentId} className="min-w-0 break-words px-3 py-2">
                <p className="text-xs tabular-nums text-ink-700">
                  <span className="font-mono font-semibold text-ink-900">{rows.get(item.shipmentId)?.code ?? "Salida"}</span>
                  {" · "}
                  {SWAYP_ROW_ENTREGADA(item.time, item.by)}
                </p>
              </li>
            ))}
          </HandoverList>
        )}

        {open && entrega && entrega.missing === 0 && entrega.delivered > 0 && (
          <CloseForm busy={busy} onClose={(name, count) => run(() => closeSwaypHandover(manifestId, name, count), { inline: true })} />
        )}

        {open && (
          <div className="shadow-[inset_0_1px_0_var(--color-line)] pt-4">
            {!confirmNoVino ? (
              <OpsButton variant="danger" className="pointer-coarse:h-11" disabled={busy} onClick={() => setConfirmNoVino(true)}>
                {SWAYP_NO_VINO_BUTTON}
              </OpsButton>
            ) : (
              <div role="alertdialog" aria-label={SWAYP_NO_VINO_BUTTON} className="space-y-2">
                <p className="text-[13px] font-medium text-ink-900">{SWAYP_NO_VINO_CONFIRM(total + noSale.length)}</p>
                <div className="flex flex-wrap gap-2">
                  <OpsButton
                    variant="danger"
                    className="pointer-coarse:h-11"
                    disabled={busy}
                    onClick={async () => {
                      const outcome = await run(() => markSwaypNoVino(manifestId));
                      if (!outcome.error) setConfirmNoVino(false);
                    }}
                  >
                    Sí, no vino
                  </OpsButton>
                  <OpsButton
                    ref={noVinoCancelRef}
                    className="pointer-coarse:h-11"
                    onClick={() => {
                      setConfirmNoVino(false);
                      focusScanner();
                    }}
                  >
                    Cancelar
                  </OpsButton>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </SidePanel>
  );
}

function HandoverList({ title, count, tone, children }: { title: string; count: number; tone: "warn" | "crit" | "ok"; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="flex items-center gap-2 text-sm font-semibold text-ink-900">
        {title}
        <Badge tone={tone} className="tabular-nums">{count}</Badge>
      </h3>
      <ul className="mt-2 divide-y divide-line rounded-lg ring-1 ring-line">{children}</ul>
    </section>
  );
}

function RowHead({ row, fallback }: { row: Row | undefined; fallback: string }) {
  if (!row) return <p className="font-mono text-xs font-semibold text-ink-900">{fallback}</p>;
  return (
    <>
      <p className="font-mono text-xs font-semibold text-ink-900">{row.title}</p>
      <p className="text-[13px] text-ink-700">{row.customerLine}</p>
    </>
  );
}

function NoSaleMeta({ item }: { item: SwaypHandoverItem }) {
  if (!item.time && !item.by) return null;
  return <p className="mt-0.5 text-xs tabular-nums text-ink-500">{[item.time ? `Marcada ${item.time}` : null, item.by].filter(Boolean).join(" · ")}</p>;
}

/** El motivo de «No sale»: de la lista cerrada, con su explicación (E4). */
function NoSaleForm({
  code,
  suggested,
  busy,
  onCancel,
  onSave,
}: {
  code: string;
  suggested: { code: SwaypNoSaleCode; detail: string } | null;
  busy: boolean;
  onCancel: () => void;
  onSave: (reason: SwaypNoSaleCode, detail: string) => Promise<Result>;
}) {
  const [reason, setReason] = useState<string>(suggested?.code ?? "");
  const [detail, setDetail] = useState(suggested?.detail ?? "");
  const [error, setError] = useState<string | null>(null);
  const selectRef = useRef<HTMLSelectElement>(null);
  const detailRef = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  const chosen = swaypNoSaleReason(reason);
  const required = chosen?.detailRequired ?? false;
  // El error es del motivo (sin elegir) o de la explicación (corta o larga).
  const reasonInvalid = !!error && !chosen;
  const detailInvalid = !!error && !!chosen;

  // Al abrir, el foco va al motivo: el botón «No sale» ya no está.
  useEffect(() => {
    selectRef.current?.focus();
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const invalid = swaypNoSaleError(reason, detail);
    if (invalid) {
      setError(invalid);
      (chosen ? detailRef : selectRef).current?.focus();
      return;
    }
    setError(null);
    const outcome = await onSave(reason as SwaypNoSaleCode, detail);
    if (outcome.error) setError(outcome.error);
  }

  return (
    <form onSubmit={submit} className="mt-2 space-y-2 rounded-md bg-wash p-3" aria-label={SWAYP_NO_SALE_QUESTION(code)}>
      <p className="text-[13px] font-semibold text-ink-900">{SWAYP_NO_SALE_QUESTION(code)}</p>
      <select
        ref={selectRef}
        aria-label="Motivo"
        aria-required
        aria-invalid={reasonInvalid || undefined}
        aria-describedby={reasonInvalid ? `${id}-error` : undefined}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        className={cn(FIELD, "pointer-coarse:h-11")}
      >
        <option value="">Elige el motivo</option>
        {SWAYP_NO_SALE_REASONS.map((option) => (
          <option key={option.code} value={option.code}>{option.label}</option>
        ))}
      </select>
      <label className="block text-[13px] font-medium text-ink-700" htmlFor={`${id}-detail`}>
        {SWAYP_NO_SALE_DETAIL_LABEL}
        {chosen && !required ? " (opcional)" : ""}
      </label>
      <textarea
        id={`${id}-detail`}
        ref={detailRef}
        aria-required={required || undefined}
        aria-invalid={detailInvalid || undefined}
        aria-describedby={detailInvalid ? `${id}-error` : undefined}
        value={detail}
        maxLength={SWAYP_NO_SALE_DETAIL_MAX}
        onChange={(event) => setDetail(event.target.value)}
        rows={2}
        className={cn(FIELD_BOX, "w-full px-3 py-2")}
      />
      {error && <p id={`${id}-error`} role="alert" className="text-[13px] font-medium text-crit-fg">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <OpsButton type="submit" variant="danger" disabled={busy} className="pointer-coarse:h-11">Guardar «No sale»</OpsButton>
        <OpsButton onClick={onCancel} className="pointer-coarse:h-11">Cancelar</OpsButton>
      </div>
    </form>
  );
}

/** El cierre: nombre del chofer y su conteo (E2). El error va junto a su campo. */
function CloseForm({ busy, onClose }: { busy: boolean; onClose: (name: string, count: number) => Promise<Result> }) {
  const [name, setName] = useState("");
  const [count, setCount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const countRef = useRef<HTMLInputElement>(null);
  const id = useId();
  // Del nombre, o del conteo; lo demás (faltas, guías nuevas) es de la entrega.
  const nameInvalid = error === SWAYP_CLOSE_DRIVER;
  const countInvalid = !!error && (error === SWAYP_CLOSE_COUNT || error.startsWith("El chofer contó"));
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        setError(null);
        const outcome = await onClose(name, count.trim() === "" ? Number.NaN : Number(count));
        if (!outcome.error) return;
        setError(outcome.error);
        if (outcome.error === SWAYP_CLOSE_DRIVER) nameRef.current?.focus();
        else if (outcome.error === SWAYP_CLOSE_COUNT || outcome.error.startsWith("El chofer contó")) countRef.current?.select();
      }}
      className="space-y-3 rounded-lg p-4 ring-1 ring-line"
    >
      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
        <label className="block text-[13px] font-medium text-ink-700" htmlFor={`${id}-name`}>
          {SWAYP_CLOSE_DRIVER_LABEL}
          <input
            id={`${id}-name`}
            ref={nameRef}
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoComplete="off"
            aria-invalid={nameInvalid || undefined}
            aria-describedby={nameInvalid ? `${id}-error` : undefined}
            className={cn(FIELD, "mt-1 pointer-coarse:h-11")}
          />
        </label>
        <label className="block text-[13px] font-medium text-ink-700" htmlFor={`${id}-count`}>
          {SWAYP_CLOSE_COUNT_LABEL}
          <input
            id={`${id}-count`}
            ref={countRef}
            value={count}
            onChange={(event) => setCount(event.target.value.replace(/\D/g, ""))}
            inputMode="numeric"
            autoComplete="off"
            aria-invalid={countInvalid || undefined}
            aria-describedby={countInvalid ? `${id}-error` : undefined}
            className={cn(FIELD, "mt-1 w-28 tabular-nums pointer-coarse:h-11")}
          />
        </label>
      </div>
      {error && <p id={`${id}-error`} role="alert" className="text-[13px] font-medium text-crit-fg">{error}</p>}
      <OpsButton type="submit" variant="primary" disabled={busy} className="w-full pointer-coarse:h-11 sm:w-auto">
        {SWAYP_CLOSE_BUTTON}
      </OpsButton>
    </form>
  );
}
