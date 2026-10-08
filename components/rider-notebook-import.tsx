"use client";

// «Cargar la hoja del motorizado» en Reparto y liquidación (MOM §29.7,
// 08-10-2026). Para el motorizado que todavía no usa la app: quien liquida
// sube las capturas de su hoja del día, Kapta las lee, las cruza con la ruta y
// propone fila por fila qué cargar. Nada se escribe hasta «Aplicar».
//
//   1. Fotos: una o varias capturas de la MISMA hoja (se suben de una en una,
//      bajo el corte de 4,5 MB de Vercel).
//   2. Revisar: cada fila con lo que dice la hoja, con qué parada cruzó y cómo
//      se cargaría. Lo que no está en la caja se enseña con su motivo y no se
//      carga; lo dudoso (por nombre, cobro parcial) se marca.
//   3. Aplicar: pasa los reprogramados que conserva y reporta cada parada sin
//      foto, como «cuaderno» (reported_by null).

import { useMemo, useRef, useState } from "react";
import { Badge, Banner, CHECKBOX, FIELD_BOX, OpsButton, SECTION_CARD, SectionHead, type BadgeTone } from "@/components/ops-ui";
import { IconCheckCircle, IconImage, IconX } from "@/components/icons";
import { cn } from "@/components/ui";
import { NON_DELIVERY_REASONS } from "@/lib/routes";
import { fitWithin } from "@/lib/photo-resize";
import {
  ddmm,
  nextNamedDay,
  outcomeLabel,
  planTotals,
  type MatchKind,
  type NotebookAction,
  type NotebookOutcome,
  type NotebookPlan,
  type PlanRow,
} from "@/lib/notebook-import";

const MAX_PHOTOS = 4;
// Una captura de Excel pesa cientos de KB; solo una foto grande se achica, y
// con más resolución que la de una entrega: la hoja tiene letra chica.
const SHRINK_ABOVE = 3 * 1024 * 1024;
const SHEET_MAX_SIDE = 2400;

const MATCH: Record<MatchKind, { label: string; tone: BadgeTone }> = {
  pendiente: { label: "Pendiente", tone: "info" },
  reportada: { label: "Ya reportada", tone: "neutral" },
  arrastre: { label: "Pasa a esta ruta", tone: "brand" },
  anulado: { label: "Anulado", tone: "crit" },
  otra_caja: { label: "No está en la caja", tone: "warn" },
  no_existe: { label: "No existe", tone: "warn" },
  sin_codigo: { label: "Sin código", tone: "warn" },
};

type ReadResponse = {
  importId: string;
  target: { riderName: string; routeDate: string; routeId: string | null; routeStatus: string | null };
  sheetDate: string | null;
  photos: string[];
  plan: NotebookPlan;
  notices: string[];
};

type ApplyResponse = {
  reported: number;
  carried: number;
  failed: number;
  skipped: number;
  rows: { index: number; item: number | null; orderName: string | null; ok: boolean; carried?: boolean; error?: string }[];
};

type Choice = { action: NotebookAction; outcome: NotebookOutcome | null; stopId: string | null };

/** El valor del selector «Se carga como»: «entregado:efectivo», «no_entregado:reprogramado». */
function outcomeKey(o: NotebookOutcome | null): string {
  if (!o) return "";
  return o.status === "entregado" ? `entregado:${o.method}` : `no_entregado:${o.reason}`;
}

function outcomeFromKey(key: string, amount: number | null): NotebookOutcome | null {
  const [status, value] = key.split(":");
  if (status === "entregado" && (value === "efectivo" || value === "pos" || value === "yape" || value === "sin_cobro")) {
    return { status: "entregado", method: value, amount: value === "sin_cobro" ? 0 : amount ?? 0 };
  }
  if (status === "no_entregado" && value) return { status: "no_entregado", reason: value };
  return null;
}

/** ¿El resultado se puede cargar? Una entrega con cobro necesita monto. */
function validOutcome(o: NotebookOutcome | null): boolean {
  if (!o) return false;
  return o.status === "no_entregado" || o.method === "sin_cobro" || o.amount > 0;
}

function naturalAction(row: PlanRow, stopId: string | null): NotebookAction | null {
  if (row.match.kind === "arrastre") return "pasar_y_reportar";
  if (row.match.kind === "pendiente" || stopId) return "reportar";
  return null;
}

const money = (n: number) => `S/ ${n.toFixed(2)}`;

async function shrinkSheet(file: File): Promise<Blob> {
  if (file.size <= SHRINK_ABOVE) return file;
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file;
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height, SHEET_MAX_SIDE);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d", { alpha: false })?.drawImage(bitmap, 0, 0, width, height);
    const out = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    return out ?? file;
  } finally {
    bitmap.close();
  }
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  let json: { error?: string } & Partial<T> = {};
  try {
    json = (await res.json()) as typeof json;
  } catch {
    // Un corte de la plataforma no responde JSON.
  }
  if (!res.ok) throw new Error(json.error ?? (res.status === 504 ? "La lectura tardó demasiado: prueba con menos capturas." : "No se pudo completar."));
  return json as T;
}

export function RiderNotebookImport({ routeId, riderName, routeDate, onApplied }: {
  routeId: string;
  riderName: string;
  routeDate: string;
  onApplied: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [sheetDate, setSheetDate] = useState(routeDate);
  const [files, setFiles] = useState<File[]>([]);
  const [phase, setPhase] = useState<"idle" | "subiendo" | "leyendo" | "revisar" | "aplicando" | "listo">("idle");
  const [error, setError] = useState<string | null>(null);
  const [read, setRead] = useState<ReadResponse | null>(null);
  const [choices, setChoices] = useState<Record<number, Choice>>({});
  const [applied, setApplied] = useState<ApplyResponse | null>(null);
  const input = useRef<HTMLInputElement>(null);

  function reset() {
    setFiles([]);
    setRead(null);
    setChoices({});
    setApplied(null);
    setError(null);
    setPhase("idle");
  }

  async function readSheet() {
    setError(null);
    try {
      setPhase("subiendo");
      const paths: string[] = [];
      for (const file of files) {
        const blob = await shrinkSheet(file);
        const fd = new FormData();
        fd.append("file", blob, file.name || "hoja.jpg");
        fd.append("routeId", routeId);
        fd.append("sheetDate", sheetDate);
        const res = await fetch("/api/courier/notebook/photo", { method: "POST", body: fd });
        const json = (await res.json().catch(() => ({}))) as { path?: string; error?: string };
        if (!res.ok || !json.path) throw new Error(json.error ?? (res.status === 413 ? "Una foto pesa demasiado." : "No se pudo subir una foto."));
        paths.push(json.path);
      }
      setPhase("leyendo");
      const data = await postJson<ReadResponse>("/api/courier/notebook", { routeId, sheetDate, paths });
      setRead(data);
      setChoices(Object.fromEntries(data.plan.rows.map((r) => [r.index, { action: r.action, outcome: r.outcome, stopId: null }])));
      setPhase("revisar");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("idle");
    }
  }

  const rows = useMemo(() => read?.plan.rows ?? [], [read]);
  const missing = read?.plan.missing ?? [];
  // Las paradas pendientes que la hoja no nombró: a ellas se puede asignar una fila sin código.
  const assignedStops = new Set(Object.values(choices).map((c) => c.stopId).filter(Boolean));
  const unnamed = missing.filter((m) => !assignedStops.has(m.stopId));
  const current = rows.map((r) => ({ ...r, action: choices[r.index]?.action ?? r.action, outcome: choices[r.index]?.outcome ?? r.outcome }));
  const totals = planTotals(current, { amount: read?.plan.totals.declaredAmount ?? null, fee: read?.plan.totals.declaredFee ?? null });
  const toApply = current.filter((r) => r.action !== "omitir");
  const invalid = toApply.filter((r) => !validOutcome(r.outcome));

  function choose(index: number, patch: Partial<Choice>) {
    setChoices((prev) => {
      const row = rows.find((r) => r.index === index)!;
      const next = { ...(prev[index] ?? { action: row.action, outcome: row.outcome, stopId: null }), ...patch };
      // Asignar o quitar la parada de una fila sin código enciende o apaga su carga.
      if ("stopId" in patch) next.action = patch.stopId ? "reportar" : "omitir";
      return { ...prev, [index]: next };
    });
  }

  async function apply() {
    if (!read) return;
    setError(null);
    setPhase("aplicando");
    try {
      const decisions = rows.map((r) => ({ index: r.index, action: choices[r.index]?.action ?? r.action, outcome: choices[r.index]?.outcome ?? r.outcome, stopId: choices[r.index]?.stopId ?? null }));
      const data = await postJson<{ result: ApplyResponse }>("/api/courier/notebook/apply", { importId: read.importId, decisions });
      setApplied(data.result);
      setPhase("listo");
      onApplied();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("revisar");
    }
  }

  if (!open) {
    return (
      <section className={cn(SECTION_CARD, "mb-4")} aria-label="Hoja del motorizado sin app">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-ink-900">¿{riderName} no usa la app?</p>
            <p className="text-[13px] leading-5 text-ink-500">Sube las fotos de su hoja del día: Kapta la lee, la cruza con esta ruta y te propone qué cargar.</p>
          </div>
          <OpsButton variant="secondary" onClick={() => setOpen(true)}>
            <IconImage /> Cargar hoja
          </OpsButton>
        </div>
      </section>
    );
  }

  const busy = phase === "subiendo" || phase === "leyendo" || phase === "aplicando";
  return (
    <section className={cn(SECTION_CARD, "mb-4")} aria-labelledby="hoja-motorizado">
      <SectionHead
        id="hoja-motorizado"
        title={`Hoja de ${riderName}`}
        badge={<Badge tone="brand">Sin app</Badge>}
        help="Cada fila se carga como reporte del cuaderno: sin foto y con tu nombre en la actividad del pedido. Solo entra lo que está en su caja y los reprogramados que él conserva (§29.7)."
        aside={!busy && (
          <OpsButton variant="ghost" size="sm" onClick={() => { reset(); setOpen(false); }}>
            <IconX /> Cerrar
          </OpsButton>
        )}
      />
      <div className="space-y-4 pt-4">
        {error && <Banner tone="crit" role="alert">{error}</Banner>}

        {(phase === "idle" || phase === "subiendo" || phase === "leyendo") && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-[13px] text-ink-600">
                Día de la hoja
                <input
                  type="date"
                  value={sheetDate}
                  onChange={(e) => setSheetDate(e.target.value || routeDate)}
                  disabled={busy}
                  className={cn(FIELD_BOX, "mt-1 h-9 w-40 px-3")}
                />
              </label>
              <input
                ref={input}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                multiple
                className="hidden"
                onChange={(e) => {
                  const picked = [...(e.target.files ?? [])];
                  setFiles((prev) => [...prev, ...picked].slice(0, MAX_PHOTOS));
                  e.target.value = "";
                }}
              />
              <OpsButton onClick={() => input.current?.click()} disabled={busy || files.length >= MAX_PHOTOS}>
                <IconImage /> {files.length ? "Agregar otra captura" : "Elegir fotos"}
              </OpsButton>
              <OpsButton variant="primary" onClick={readSheet} disabled={busy || !files.length}>
                {phase === "subiendo" ? "Subiendo…" : phase === "leyendo" ? "Leyendo la hoja…" : "Leer hoja"}
              </OpsButton>
            </div>
            {sheetDate !== routeDate && (
              <p className="text-[13px] text-ink-500">
                Se cruza con la ruta de {riderName} del {ddmm(sheetDate)}, no con la de esta caja. Sirve para el día en que solo salió con reprogramados.
              </p>
            )}
            {files.length > 0 && (
              <ul className="flex flex-wrap gap-2">
                {files.map((f, i) => (
                  <li key={`${f.name}-${i}`} className="flex items-center gap-2 rounded-md bg-wash px-2 py-1 text-[13px] text-ink-700">
                    {f.name || `Captura ${i + 1}`} · {Math.max(1, Math.round(f.size / 1024))} KB
                    {!busy && (
                      <button type="button" aria-label="Quitar" className="text-ink-500 hover:text-ink-900" onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}>
                        <IconX className="size-3.5" />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {phase === "leyendo" && <p className="text-[13px] text-ink-500">Una hoja de 50 filas tarda hasta un minuto. No cierres el panel.</p>}
          </div>
        )}

        {read && (phase === "revisar" || phase === "aplicando") && (
          <div className="space-y-4">
            {read.notices.map((n) => <Banner key={n} tone="warn">{n}</Banner>)}
            <div className="flex flex-wrap gap-x-6 gap-y-2 text-[13px] text-ink-600">
              <span>
                Hoja: <b className="text-ink-900">{money(totals.sheetAmount)}</b> recaudado · ganancia {money(totals.sheetFee)}
                {totals.declaredAmount !== null && (
                  <> · total escrito {money(totals.declaredAmount)}{" "}
                    {totals.matchesDeclared ? <Badge tone="ok">cuadra</Badge> : <Badge tone="warn">no cuadra</Badge>}
                  </>
                )}
              </span>
              <span>
                Se carga: efectivo <b className="text-ink-900">{money(totals.loadCash)}</b> · POS {money(totals.loadPos)} · Yape {money(totals.loadYape)}
              </span>
              {totals.notLoadedAmount > 0 && <span>Fuera de la ruta: {money(totals.notLoadedAmount)}</span>}
              <span className="flex gap-2">
                {read.photos.map((p, i) => (
                  <a key={p} href={`/api/courier/notebook/photo?path=${encodeURIComponent(p)}`} target="_blank" rel="noreferrer" className="text-brand-700 underline">
                    Foto {i + 1}
                  </a>
                ))}
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] text-left text-[13px]">
                <thead className="text-xs text-ink-500">
                  <tr className="border-b border-line">
                    <th className="w-10 py-2 pr-2 font-medium">Cargar</th>
                    <th className="py-2 pr-2 font-medium">Ítem</th>
                    <th className="py-2 pr-2 font-medium">Pedido</th>
                    <th className="py-2 pr-2 font-medium">La hoja dice</th>
                    <th className="py-2 pr-2 font-medium">Se carga como</th>
                    <th className="py-2 font-medium">Avisos</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const c = choices[r.index] ?? { action: r.action, outcome: r.outcome, stopId: null };
                    const natural = naturalAction(r, c.stopId);
                    const on = c.action !== "omitir";
                    const needsAmount = c.outcome?.status === "entregado" && c.outcome.method !== "sin_cobro";
                    const unmatched = r.match.kind === "sin_codigo" || r.match.kind === "no_existe";
                    return (
                      <tr key={r.index} className={cn("border-b border-line align-top", !on && "text-ink-500")}>
                        <td className="py-2 pr-2">
                          <input
                            type="checkbox"
                            className={CHECKBOX}
                            aria-label={`Cargar la fila ${r.line.item ?? r.index + 1}`}
                            checked={on}
                            disabled={!natural || phase === "aplicando"}
                            onChange={(e) => choose(r.index, { action: e.target.checked && natural ? natural : "omitir" })}
                          />
                        </td>
                        <td className="py-2 pr-2 tabular-nums">{r.line.item ?? "—"}</td>
                        <td className="py-2 pr-2">
                          <div className="font-medium text-ink-900">{r.match.orderName ?? r.line.order ?? "Sin código"}</div>
                          <div className="text-ink-500">{r.line.customer ?? ""}{r.line.district ? ` · ${r.line.district}` : ""}</div>
                          <Badge tone={MATCH[r.match.kind].tone} className="mt-1">
                            {MATCH[r.match.kind].label}{r.match.via === "nombre" ? " · por nombre" : ""}
                          </Badge>
                          {unmatched && missing.length > 0 && (
                            <select
                              aria-label="Asignar a una parada pendiente"
                              value={c.stopId ?? ""}
                              disabled={phase === "aplicando"}
                              onChange={(e) => choose(r.index, { stopId: e.target.value || null })}
                              className={cn(FIELD_BOX, "mt-1 h-8 w-full px-2 text-[13px]")}
                            >
                              <option value="">Asignar a una parada…</option>
                              {missing.map((m) => (
                                <option key={m.stopId} value={m.stopId} disabled={assignedStops.has(m.stopId) && c.stopId !== m.stopId}>
                                  {m.orderName ?? "Sin nombre"} · {m.customerName ?? ""}
                                </option>
                              ))}
                            </select>
                          )}
                        </td>
                        <td className="py-2 pr-2">
                          <div>{r.interpretation.written || "—"}</div>
                          {r.line.amount !== null && <div className="tabular-nums text-ink-500">{money(r.line.amount)}</div>}
                        </td>
                        <td className="py-2 pr-2">
                          {natural ? (
                            <div className="flex flex-col gap-1">
                              <select
                                aria-label="Se carga como"
                                value={outcomeKey(c.outcome)}
                                disabled={phase === "aplicando"}
                                onChange={(e) => {
                                  const outcome = outcomeFromKey(e.target.value, c.outcome?.status === "entregado" ? c.outcome.amount : r.line.amount);
                                  // Elegir qué pasó en una fila que se puede cargar la marca para cargar.
                                  choose(r.index, outcome ? { outcome, action: natural } : { outcome });
                                }}
                                className={cn(FIELD_BOX, "h-8 w-64 px-2 text-[13px]")}
                              >
                                <option value="">Elige qué pasó…</option>
                                <optgroup label="Entregado">
                                  <option value="entregado:efectivo">Entregado · Efectivo</option>
                                  <option value="entregado:pos">Entregado · POS</option>
                                  <option value="entregado:yape">Entregado · Yape</option>
                                  <option value="entregado:sin_cobro">Entregado · Sin cobro</option>
                                </optgroup>
                                <optgroup label="No entregado">
                                  {NON_DELIVERY_REASONS.map((x) => <option key={x.code} value={`no_entregado:${x.code}`}>No entregado · {x.label}</option>)}
                                </optgroup>
                              </select>
                              {needsAmount && (
                                <input
                                  type="number"
                                  inputMode="decimal"
                                  min={0}
                                  step="0.01"
                                  aria-label="Monto cobrado"
                                  value={c.outcome?.status === "entregado" ? String(c.outcome.amount || "") : ""}
                                  disabled={phase === "aplicando"}
                                  onChange={(e) => c.outcome?.status === "entregado" && choose(r.index, { outcome: { ...c.outcome, amount: Number(e.target.value) || 0 } })}
                                  className={cn(FIELD_BOX, "h-8 w-32 px-2 text-[13px] tabular-nums")}
                                />
                              )}
                            </div>
                          ) : (
                            <span className="text-ink-500">No se carga</span>
                          )}
                        </td>
                        <td className="py-2 text-ink-600">
                          {c.stopId ? (
                            <p className="text-ink-900">Asignada a mano a {missing.find((m) => m.stopId === c.stopId)?.orderName ?? "la parada elegida"}: confírmalo.</p>
                          ) : r.warnings.length ? (
                            <ul className="space-y-1">{r.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
                          ) : on && c.outcome ? (
                            <span className="text-ok-fg">{outcomeLabel(c.outcome)}</span>
                          ) : null}
                          {on && r.interpretation.day && c.outcome?.status === "no_entregado" && c.outcome.reason === "reprogramado" && (
                            <p className="mt-1 text-ink-500">Para el {nextNamedDay(read.target.routeDate, r.interpretation.day) ?? r.interpretation.day.toLowerCase()}: queda en la nota.</p>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {unnamed.length > 0 && (
              <Banner tone="warn" title={`${unnamed.length} ${unnamed.length === 1 ? "parada pendiente no aparece" : "paradas pendientes no aparecen"} en la hoja`}>
                {unnamed.map((m) => `${m.orderName ?? "Sin nombre"}${m.customerName ? ` (${m.customerName})` : ""}`).join(" · ")}. Pregúntale a {riderName} qué pasó o asígnale una fila sin código. Una parada sin reporte frena el cierre de la ruta.
              </Banner>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <OpsButton variant="primary" onClick={apply} disabled={phase === "aplicando" || !toApply.length || invalid.length > 0}>
                {phase === "aplicando" ? "Aplicando…" : `Aplicar ${toApply.length} ${toApply.length === 1 ? "fila" : "filas"}`}
              </OpsButton>
              <OpsButton variant="ghost" onClick={reset} disabled={phase === "aplicando"}>Leer otra hoja</OpsButton>
              {invalid.length > 0 && <span className="text-[13px] text-crit-fg">{invalid.length} {invalid.length === 1 ? "fila marcada no dice" : "filas marcadas no dicen"} qué pasó o cuánto cobró.</span>}
              {toApply.some((r) => r.action === "pasar_y_reportar") && (
                <span className="text-[13px] text-ink-500">
                  {toApply.filter((r) => r.action === "pasar_y_reportar").length} reprogramado(s) pasan a la ruta del {ddmm(read.target.routeDate)}, ya cotejados.
                </span>
              )}
            </div>
          </div>
        )}

        {phase === "listo" && applied && (
          <div className="space-y-3">
            <Banner tone={applied.failed ? "warn" : "ok"} title={applied.failed ? "Hoja aplicada con pendientes" : "Hoja aplicada"}>
              {applied.reported} {applied.reported === 1 ? "parada reportada" : "paradas reportadas"}
              {applied.carried ? `, ${applied.carried} ${applied.carried === 1 ? "reprogramado pasó" : "reprogramados pasaron"} a esta ruta` : ""}
              {applied.skipped ? ` · ${applied.skipped} sin cargar` : ""}. Revisa abajo el efectivo y la ganancia antes de terminar la ruta.
            </Banner>
            {applied.rows.filter((r) => !r.ok).length > 0 && (
              <ul className="space-y-1 text-[13px] text-crit-fg">
                {applied.rows.filter((r) => !r.ok).map((r) => (
                  <li key={r.index}>Ítem {r.item ?? "—"} {r.orderName ?? ""}: {r.error}</li>
                ))}
              </ul>
            )}
            <OpsButton onClick={() => { reset(); setOpen(false); }}>
              <IconCheckCircle /> Listo
            </OpsButton>
          </div>
        )}
      </div>
    </section>
  );
}
