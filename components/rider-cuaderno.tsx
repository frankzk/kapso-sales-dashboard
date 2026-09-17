"use client";

// Mi cuaderno — la pantalla del motorizado para Liquidaciones 2 (MOM §30.9).
// Teléfono, una mano, mala señal: un punto por tarjeta, botones grandes, y
// el formulario valida antes de subir nada. La foto del comprobante se sube
// aparte, así una caída de red no borra lo escrito.

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { RiderDay, RiderOrderInfo, RiderVocabulary } from "@/lib/sheets/rider-access";
import { isDigitalMethod, montoDiffers, PAYMENT_OPTIONS } from "@/lib/sheets/rider-cuaderno";
import type { CellValue, StoredRow } from "@/lib/sheets/types";
import {
  addRiderPoint,
  pullManifestPackages,
  saveRiderPoint,
  searchOrdersForRider,
  type RiderActionResult,
} from "@/app/reparto/cuaderno/actions";

const money = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `S/ ${n.toFixed(2)}`);
const cn = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");
const str = (v: CellValue | undefined) => (v === null || v === undefined ? "" : String(v));
const numOrNull = (v: CellValue | undefined) => (typeof v === "number" ? v : null);

function shiftDay(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function dayLabel(iso: string, today: string): string {
  if (iso === today) return "Hoy";
  if (iso === shiftDay(today, -1)) return "Ayer";
  const d = new Date(`${iso}T12:00:00Z`);
  return d.toLocaleDateString("es-PE", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

export function RiderCuaderno(props: {
  riderName: string;
  today: string;
  day: RiderDay;
  vocabulary: RiderVocabulary;
  manifestCount: number;
}) {
  const { day, vocabulary } = props;
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [adding, setAdding] = useState(false);

  const run = (action: () => Promise<RiderActionResult>, after?: () => void) => {
    startTransition(async () => {
      const r = await action();
      setNotice(r.ok ? (r.message ? { ok: true, text: r.message } : null) : { ok: false, text: r.error ?? "Error" });
      if (r.ok) {
        after?.();
        router.refresh();
      }
    });
  };

  const statusByCode = useMemo(() => new Map(vocabulary.statuses.map((s) => [s.code, s])), [vocabulary.statuses]);
  const obsByRow = useMemo(() => {
    const m = new Map<string, RiderDay["openObservations"]>();
    for (const o of day.openObservations) if (o.row_id) m.set(o.row_id, [...(m.get(o.row_id) ?? []), o]);
    return m;
  }, [day.openObservations]);

  const delivered = day.rows.filter((r) => statusByCode.get(str(r.values.estado))?.effect === "entrega").length;
  const efectivo = day.rows.reduce((s, r) => s + (numOrNull(r.values.efectivo) ?? 0), 0);

  return (
    <main className="mx-auto min-h-screen max-w-md bg-slate-50 pb-24">
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white px-4 py-3">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-base font-semibold text-slate-900">Mi cuaderno</h1>
            <p className="text-xs text-slate-500">{props.riderName}</p>
          </div>
          <div className="flex items-center gap-1">
            <a href={`/reparto/cuaderno?fecha=${shiftDay(day.fecha, -1)}`} className="rounded-lg border border-slate-200 px-3 py-2 text-sm" aria-label="Día anterior">‹</a>
            <span className="min-w-20 text-center text-sm font-medium text-slate-800">{dayLabel(day.fecha, props.today)}</span>
            <a
              href={`/reparto/cuaderno?fecha=${shiftDay(day.fecha, 1)}`}
              className={cn("rounded-lg border border-slate-200 px-3 py-2 text-sm", day.fecha >= props.today && "pointer-events-none opacity-30")}
              aria-label="Día siguiente"
            >
              ›
            </a>
          </div>
        </div>
        <div className="mt-2 flex gap-3 text-xs text-slate-600">
          <span><b>{day.rows.length}</b> puntos</span>
          <span><b>{delivered}</b> entregados</span>
          <span>efectivo <b>{money(efectivo)}</b></span>
        </div>
      </header>

      {notice && (
        <div className={cn("mx-4 mt-3 rounded-lg px-3 py-2 text-sm", notice.ok ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-800")}>{notice.text}</div>
      )}

      <div className="space-y-3 px-4 pt-3">
        {props.manifestCount > 0 && (
          <button
            type="button"
            disabled={pending}
            className="w-full rounded-xl border border-brand-700 bg-white px-4 py-3 text-sm font-medium text-brand-700"
            onClick={() => run(() => pullManifestPackages(day.fecha))}
          >
            Traer los {props.manifestCount} paquetes de mi ruta
          </button>
        )}

        {day.rows.length === 0 && (
          <p className="rounded-xl border border-dashed border-slate-300 bg-white p-4 text-center text-sm text-slate-500">
            Sin puntos este día. Añade uno abajo{props.manifestCount ? " o trae los de tu ruta" : ""}.
          </p>
        )}

        {day.rows.map((row) => (
          <PointCard
            key={row.id}
            row={row}
            order={row.order_id ? day.orders[row.order_id] ?? null : null}
            vocabulary={vocabulary}
            observations={obsByRow.get(row.id) ?? []}
            pending={pending}
            run={run}
          />
        ))}
      </div>

      <div className="fixed inset-x-0 bottom-0 z-20 mx-auto max-w-md border-t border-slate-200 bg-white p-3">
        {adding ? (
          <AddPoint fecha={day.fecha} pending={pending} run={run} onClose={() => setAdding(false)} />
        ) : (
          <button type="button" className="w-full rounded-xl bg-brand-700 px-4 py-3 text-base font-semibold text-white" onClick={() => setAdding(true)}>
            + Añadir punto
          </button>
        )}
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Un punto
// ---------------------------------------------------------------------------
function PointCard(props: {
  row: StoredRow;
  order: RiderOrderInfo | null;
  vocabulary: RiderVocabulary;
  observations: RiderDay["openObservations"];
  pending: boolean;
  run: (a: () => Promise<RiderActionResult>, after?: () => void) => void;
}) {
  const { row, order, vocabulary } = props;
  const v = row.values;
  const [open, setOpen] = useState(false);
  const [estado, setEstado] = useState(str(v.estado_reportado));
  const [efectivo, setEfectivo] = useState(str(v.efectivo));
  const [aCobrar, setACobrar] = useState(str(v.a_cobrar) || (order?.order_total != null ? order.order_total.toFixed(2) : ""));
  const [metodo, setMetodo] = useState(str(v.metodo_pago));
  const [obs, setObs] = useState(str(v.observacion_1));
  const [reason, setReason] = useState("");
  const [reasonNote, setReasonNote] = useState("");
  const [comprobante, setComprobante] = useState<string | null>(str(v.comprobante_path) || null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const status = statusFor(estado, vocabulary);
  const kaptaTotal = order?.order_total ?? null;
  const aCobrarNum = aCobrar.trim() ? Number(aCobrar.replace(",", ".")) : null;
  const explain = status?.effect === "entrega" && montoDiffers(Number.isFinite(aCobrarNum as number) ? aCobrarNum : null, kaptaTotal);
  const digital = isDigitalMethod(metodo || null);
  const savedStatus = vocabulary.statuses.find((s) => s.code === str(v.estado));

  useEffect(() => {
    if (!open) return;
    setEstado(str(v.estado_reportado));
    setEfectivo(str(v.efectivo));
    setACobrar(str(v.a_cobrar) || (order?.order_total != null ? order.order_total.toFixed(2) : ""));
    setMetodo(str(v.metodo_pago));
    setObs(str(v.observacion_1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const upload = async (file: File) => {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.set("file", file);
      fd.set("rowKey", row.row_key);
      const res = await fetch("/api/reparto/cuaderno-foto", { method: "POST", body: fd });
      const json = (await res.json()) as { path?: string; error?: string };
      if (!res.ok || !json.path) throw new Error(json.error ?? "No se pudo subir la foto.");
      setComprobante(json.path);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const effectStyle: Record<string, string> = {
    entrega: "bg-emerald-50 text-emerald-700",
    devolucion: "bg-amber-50 text-amber-700",
    anulacion: "bg-rose-50 text-rose-700",
    sin_salida: "bg-slate-100 text-slate-600",
    informa: "bg-sky-50 text-sky-700",
  };

  return (
    <section className={cn("rounded-2xl border bg-white p-4", props.observations.length ? "border-amber-300" : "border-slate-200")}>
      <button type="button" className="w-full text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{str(v.punto) || "Punto"} · {str(v.tienda) || "—"}</p>
            <p className="text-base font-semibold text-slate-900">{str(v.cliente) || order?.customer_name || "Sin nombre"}</p>
            <p className="text-sm text-slate-600">{str(v.pedido) || order?.order_name || "Sin pedido"}{order?.district ? ` · ${order.district}` : ""}</p>
          </div>
          <div className="text-right">
            <p className="text-sm font-semibold tabular-nums text-slate-900">{money(kaptaTotal ?? numOrNull(v.a_cobrar))}</p>
            {savedStatus ? (
              <span className={cn("mt-1 inline-block rounded-full px-2 py-0.5 text-xs font-medium", effectStyle[savedStatus.effect] ?? "bg-slate-100 text-slate-600")}>{savedStatus.label}</span>
            ) : str(v.estado_reportado) ? (
              <span className="mt-1 inline-block rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">{str(v.estado_reportado)}</span>
            ) : (
              <span className="mt-1 inline-block rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">Sin reportar</span>
            )}
          </div>
        </div>
        {order?.address && <p className="mt-1 text-xs text-slate-500">{order.address}</p>}
        {props.observations.length > 0 && (
          <p className="mt-2 text-xs text-amber-700">Tu explicación está pendiente de revisión: {props.observations.map((o) => o.note ?? o.field).join(" · ")}</p>
        )}
      </button>

      {order?.customer_phone && (
        <div className="mt-2 flex gap-2">
          <a href={`tel:${order.customer_phone}`} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700">Llamar</a>
          <a href={`https://wa.me/${order.customer_phone.replace(/\D/g, "")}`} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700" target="_blank" rel="noreferrer">WhatsApp</a>
        </div>
      )}

      {open && (
        <form
          className="mt-3 space-y-3 border-t border-slate-100 pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            props.run(
              () =>
                saveRiderPoint({
                  rowKey: row.row_key,
                  estado: estado || null,
                  efectivo: efectivo || null,
                  a_cobrar: aCobrar || null,
                  metodo_pago: metodo || null,
                  observacion_1: obs || null,
                  comprobante_path: comprobante,
                  reason_code: explain ? reason || null : null,
                  reason_note: explain ? reasonNote || null : null,
                }),
              () => setOpen(false),
            );
          }}
        >
          <label className="block">
            <span className="text-xs font-medium text-slate-600">Estado</span>
            <input
              list={`estados-${row.id}`}
              value={estado}
              onChange={(e) => setEstado(e.target.value)}
              placeholder="ENTREGADO, NO RESPONDE, MAÑANA…"
              className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-3 text-base"
              autoCapitalize="characters"
            />
            <datalist id={`estados-${row.id}`}>
              {vocabulary.suggestions.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
            {status && <p className="mt-1 text-xs text-slate-500">Se entiende como «{status.label}».</p>}
            {estado.trim() && !status && <p className="mt-1 text-xs text-amber-700">Estado nuevo: se guardará tal cual y alguien lo clasificará.</p>}
          </label>

          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-xs font-medium text-slate-600">A cobrar</span>
              <input type="number" inputMode="decimal" step="0.01" value={aCobrar} onChange={(e) => setACobrar(e.target.value)} className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-3 text-base tabular-nums" />
              {kaptaTotal !== null && <p className="mt-1 text-xs text-slate-500">Kapta: {money(kaptaTotal)}</p>}
            </label>
            <label className="block">
              <span className="text-xs font-medium text-slate-600">Efectivo</span>
              <input type="number" inputMode="decimal" step="0.01" value={efectivo} onChange={(e) => setEfectivo(e.target.value)} className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-3 text-base tabular-nums" />
            </label>
          </div>

          <label className="block">
            <span className="text-xs font-medium text-slate-600">Método de pago</span>
            <select value={metodo} onChange={(e) => setMetodo(e.target.value)} className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-3 text-base">
              <option value="">—</option>
              {PAYMENT_OPTIONS.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </label>

          {digital && (
            <div className="rounded-xl border border-dashed border-slate-300 p-3">
              <p className="text-xs font-medium text-slate-600">Comprobante del pago</p>
              {comprobante ? (
                <p className="mt-1 text-xs text-emerald-700">Foto subida.</p>
              ) : (
                <p className="mt-1 text-xs text-slate-500">Sube la captura del Yape, Plin o transferencia.</p>
              )}
              <label className={cn("mt-2 inline-block rounded-lg border px-3 py-2 text-sm font-medium", uploading ? "border-slate-200 text-slate-400" : "border-brand-700 text-brand-700")}>
                {uploading ? "Subiendo…" : comprobante ? "Cambiar foto" : "Tomar o elegir foto"}
                <input ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden" disabled={uploading} aria-label="Foto del comprobante" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
              </label>
            </div>
          )}

          {explain && (
            <div className="rounded-xl border border-amber-300 bg-amber-50 p-3">
              <p className="text-sm font-medium text-amber-800">Cobraste distinto a lo que dice Kapta ({money(kaptaTotal)}). ¿Por qué?</p>
              <select value={reason} onChange={(e) => setReason(e.target.value)} className="mt-2 w-full rounded-xl border border-amber-300 bg-white px-3 py-3 text-base" aria-label="Motivo de la diferencia" required>
                <option value="">Elige un motivo</option>
                {vocabulary.reasons.map((r) => (
                  <option key={r.code} value={r.code}>{r.label}</option>
                ))}
              </select>
              <input value={reasonNote} onChange={(e) => setReasonNote(e.target.value)} placeholder="Nota (obligatoria si es «Otro»)" className="mt-2 w-full rounded-xl border border-amber-300 bg-white px-3 py-3 text-base" aria-label="Nota del motivo" />
            </div>
          )}

          <label className="block">
            <span className="text-xs font-medium text-slate-600">Observación</span>
            <input value={obs} onChange={(e) => setObs(e.target.value)} className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-3 text-base" />
          </label>

          <div className="flex gap-2">
            <button type="submit" disabled={props.pending || uploading || (explain && !reason)} className="flex-1 rounded-xl bg-brand-700 px-4 py-3 text-base font-semibold text-white disabled:opacity-50">
              Guardar
            </button>
            <button type="button" className="rounded-xl border border-slate-300 px-4 py-3 text-base text-slate-700" onClick={() => setOpen(false)}>
              Cerrar
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

function statusFor(text: string, vocabulary: RiderVocabulary) {
  const norm = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
  if (!norm) return null;
  const byLabel = vocabulary.statuses.find((s) => s.label.normalize("NFKD").replace(/[̀-ͯ]/g, "").toUpperCase() === norm || s.code === norm.toLowerCase().replace(/\s+/g, "_"));
  if (byLabel) return byLabel;
  const word = norm.replace(/\s+\d.*$/, "");
  if (["LUNES", "MARTES", "MIERCOLES", "JUEVES", "VIERNES", "SABADO", "DOMINGO", "HOY", "MANANA", "MAÑANA"].includes(word)) {
    return vocabulary.statuses.find((s) => s.code === "reprogramado") ?? null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Añadir punto
// ---------------------------------------------------------------------------
function AddPoint(props: { fecha: string; pending: boolean; run: (a: () => Promise<RiderActionResult>, after?: () => void) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Awaited<ReturnType<typeof searchOrdersForRider>>["results"]>([]);
  const [searching, setSearching] = useState(false);
  const [manual, setManual] = useState(false);
  const [cliente, setCliente] = useState("");
  const [tienda, setTienda] = useState("Kast");

  useEffect(() => {
    const q = query.trim();
    if (q.length < 3 || manual) {
      setResults([]);
      return;
    }
    const t = setTimeout(async () => {
      setSearching(true);
      const r = await searchOrdersForRider(q);
      setResults(r.results);
      setSearching(false);
    }, 300);
    return () => clearTimeout(t);
  }, [query, manual]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-slate-800">Añadir punto</p>
        <button type="button" className="text-sm text-slate-500" onClick={props.onClose}>Cerrar</button>
      </div>
      {!manual ? (
        <>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Nº de pedido o nombre del cliente"
            className="w-full rounded-xl border border-slate-300 px-3 py-3 text-base"
            aria-label="Buscar pedido"
            autoFocus
          />
          {searching && <p className="text-xs text-slate-500">Buscando…</p>}
          <div className="max-h-56 space-y-1 overflow-auto">
            {results.map((r) => (
              <button
                key={r.order_id}
                type="button"
                disabled={props.pending}
                className="flex w-full items-center justify-between rounded-xl border border-slate-200 px-3 py-2 text-left"
                onClick={() => props.run(() => addRiderPoint({ fecha: props.fecha, orderId: r.order_id }), props.onClose)}
              >
                <span>
                  <span className="block text-sm font-medium text-slate-900">{r.order_name} · {r.customer_name ?? "—"}</span>
                  <span className="block text-xs text-slate-500">{r.store_name ?? ""}{r.district ? ` · ${r.district}` : ""}</span>
                </span>
                <span className="text-sm tabular-nums">{money(r.order_total)}</span>
              </button>
            ))}
          </div>
          <button type="button" className="text-xs text-brand-700 underline" onClick={() => setManual(true)}>
            No está en Kapta: escribirlo a mano
          </button>
        </>
      ) : (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            props.run(() => addRiderPoint({ fecha: props.fecha, pedido: query || null, cliente: cliente || null, tienda }), props.onClose);
          }}
        >
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Nº de pedido (opcional)" className="w-full rounded-xl border border-slate-300 px-3 py-3 text-base" aria-label="Número de pedido" />
          <input value={cliente} onChange={(e) => setCliente(e.target.value)} placeholder="Nombre del cliente" className="w-full rounded-xl border border-slate-300 px-3 py-3 text-base" aria-label="Nombre del cliente" required />
          <select value={tienda} onChange={(e) => setTienda(e.target.value)} className="w-full rounded-xl border border-slate-300 px-3 py-3 text-base" aria-label="Tienda">
            {["Aurela", "Kenku", "Kast", "Otra"].map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          <div className="flex gap-2">
            <button type="submit" disabled={props.pending} className="flex-1 rounded-xl bg-brand-700 px-4 py-3 text-base font-semibold text-white">Añadir</button>
            <button type="button" className="rounded-xl border border-slate-300 px-4 py-3 text-base text-slate-700" onClick={() => setManual(false)}>Buscar</button>
          </div>
        </form>
      )}
    </div>
  );
}
