"use client";

// La pantalla del motorizado. Pensada para un teléfono, con una mano, en la
// calle y con mala señal:
//
//   - una parada a la vez, no una tabla;
//   - botones grandes y pocos;
//   - la dirección y el mapa antes que nada, que es lo que necesita primero;
//   - el formulario valida ANTES de subir nada, para no gastarle datos;
//   - la foto se sube aparte del reporte, así una caída de red no le borra lo
//     que ya escribió.

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  NON_DELIVERY_REASONS,
  PAYMENT_METHODS,
  routeTotals,
  validateStopReport,
  type PaymentMethod,
  type StopStatus,
} from "@/lib/routes";
import type { RouteRow, StopWithOrder } from "@/lib/routes-access";
import { reportStop } from "@/app/reparto/actions";

const money = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : `S/ ${n.toFixed(2)}`;

function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** Enlace al mapa: por coordenadas si las hay, si no por la dirección escrita. */
function mapHref(stop: StopWithOrder): string {
  const o = stop.order;
  if (o?.latitude != null && o?.longitude != null) {
    return `https://www.google.com/maps/search/?api=1&query=${o.latitude},${o.longitude}`;
  }
  const parts = [o?.address, o?.district, o?.province, "Perú"].filter(Boolean).join(", ");
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(parts)}`;
}

export function RiderRouteScreen({
  riderName,
  routes,
  route,
  stops,
}: {
  riderName: string;
  routes: RouteRow[];
  route: RouteRow | null;
  stops: StopWithOrder[];
}) {
  const router = useRouter();
  const [openId, setOpenId] = useState<string | null>(null);
  const totals = useMemo(() => routeTotals(stops), [stops]);
  const closed = route?.status === "cerrada";

  if (!route) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center p-6">
        <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center">
          <h1 className="text-lg font-semibold text-slate-900">Hola, {riderName}</h1>
          <p className="mt-2 text-sm text-slate-500">
            Todavía no tienes ninguna ruta asignada. Cuando el coordinador te la entregue, aparecerá
            aquí.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto min-h-screen max-w-md bg-slate-50 pb-24">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white px-4 py-3">
        <div className="flex items-baseline justify-between">
          <h1 className="text-base font-semibold text-slate-900">{riderName}</h1>
          {routes.length > 1 ? (
            <select
              value={route.id}
              onChange={(e) => router.push(`/reparto?ruta=${e.target.value}`)}
              className="rounded-lg border border-slate-300 px-2 py-1 text-xs text-slate-600"
            >
              {routes.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.route_date}
                  {r.status === "cerrada" ? " (cerrada)" : ""}
                </option>
              ))}
            </select>
          ) : (
            <span className="text-xs text-slate-500">{route.route_date}</span>
          )}
        </div>
        <div className="mt-2 flex gap-3 text-xs">
          <Pill label="Por entregar" value={totals.pendientes} tone="pend" />
          <Pill label="Entregados" value={totals.entregados} tone="ok" />
          <Pill label="No entregados" value={totals.noEntregados} tone="bad" />
        </div>
        {totals.efectivo > 0 && (
          <p className="mt-2 text-xs text-slate-500">
            Efectivo en tu mano:{" "}
            <strong className="text-slate-800">{money(totals.efectivo)}</strong>
            {totals.yape > 0 && <> · Yape {money(totals.yape)}</>}
            {totals.pos > 0 && <> · POS {money(totals.pos)}</>}
          </p>
        )}
        {closed && (
          <p className="mt-2 rounded-lg bg-slate-100 px-2 py-1 text-xs text-slate-600">
            Esta ruta ya está cerrada. Si algo quedó mal, avisa al coordinador.
          </p>
        )}
      </header>

      <ul className="space-y-2 p-3">
        {stops.map((stop) => (
          <li key={stop.id}>
            <StopCard
              stop={stop}
              open={openId === stop.id}
              readOnly={closed}
              onToggle={() => setOpenId(openId === stop.id ? null : stop.id)}
              onDone={() => {
                setOpenId(null);
                router.refresh();
              }}
            />
          </li>
        ))}
        {stops.length === 0 && (
          <li className="rounded-xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
            Esta ruta no tiene paradas.
          </li>
        )}
      </ul>

      {totals.completa && !closed && (
        <div className="fixed inset-x-0 bottom-0 mx-auto max-w-md border-t border-emerald-200 bg-emerald-50 px-4 py-3 text-center text-sm text-emerald-800">
          Terminaste tus {totals.total} paradas. Ya puedes entregar{" "}
          <strong>{money(totals.efectivo)}</strong> en efectivo.
        </div>
      )}
    </main>
  );
}

function Pill({ label, value, tone }: { label: string; value: number; tone: "pend" | "ok" | "bad" }) {
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-xs font-medium",
        tone === "ok" && "bg-emerald-50 text-emerald-700",
        tone === "bad" && "bg-red-50 text-red-700",
        tone === "pend" && "bg-slate-100 text-slate-600",
      )}
    >
      {value} {label}
    </span>
  );
}

function StopCard({
  stop,
  open,
  readOnly,
  onToggle,
  onDone,
}: {
  stop: StopWithOrder;
  open: boolean;
  readOnly: boolean;
  onToggle: () => void;
  onDone: () => void;
}) {
  const o = stop.order;
  const done = stop.status !== "pendiente";

  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border bg-white",
        stop.status === "entregado" && "border-emerald-200",
        stop.status === "no_entregado" && "border-red-200",
        stop.status === "pendiente" && "border-slate-200",
      )}
    >
      <button onClick={onToggle} className="w-full px-4 py-3 text-left">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-slate-900">
              {o?.customer_name ?? "Sin nombre"}
            </p>
            <p className="truncate text-xs text-slate-500">
              {o?.district ?? "—"} · {o?.name ?? "—"}
            </p>
          </div>
          <div className="shrink-0 text-right">
            <p className="text-sm font-semibold text-slate-800">{money(o?.total)}</p>
            <p
              className={cn(
                "text-[11px]",
                stop.status === "entregado" && "text-emerald-700",
                stop.status === "no_entregado" && "text-red-700",
                stop.status === "pendiente" && "text-slate-400",
              )}
            >
              {stop.status === "entregado"
                ? "Entregado"
                : stop.status === "no_entregado"
                  ? "No entregado"
                  : "Por entregar"}
            </p>
          </div>
        </div>
      </button>

      {open && (
        <div className="space-y-3 border-t border-slate-100 px-4 py-3">
          <div className="text-sm text-slate-700">
            <p>{o?.address ?? "Sin dirección"}</p>
            {o?.reference && <p className="text-xs text-slate-500">Ref: {o.reference}</p>}
          </div>
          <div className="flex gap-2">
            <a
              href={mapHref(stop)}
              target="_blank"
              rel="noreferrer"
              className="flex-1 rounded-lg bg-slate-800 px-3 py-2.5 text-center text-sm font-medium text-white"
            >
              Abrir mapa
            </a>
            {o?.customer_phone && (
              <a
                href={`tel:${o.customer_phone}`}
                className="flex-1 rounded-lg border border-slate-300 px-3 py-2.5 text-center text-sm font-medium text-slate-700"
              >
                Llamar
              </a>
            )}
          </div>

          {readOnly ? (
            <p className="text-xs text-slate-500">
              {done ? "Ya reportada." : "Sin reportar."} La ruta está cerrada.
            </p>
          ) : (
            <ReportForm stop={stop} onDone={onDone} />
          )}
        </div>
      )}
    </div>
  );
}

function ReportForm({ stop, onDone }: { stop: StopWithOrder; onDone: () => void }) {
  const [pending, start] = useTransition();
  const [status, setStatus] = useState<StopStatus>(
    stop.status === "pendiente" ? "entregado" : stop.status,
  );
  const [method, setMethod] = useState<PaymentMethod | null>(
    (stop.payment_method as PaymentMethod | null) ?? "efectivo",
  );
  const [amount, setAmount] = useState(
    stop.collected_amount != null ? String(stop.collected_amount) : String(stop.order?.total ?? ""),
  );
  const [reason, setReason] = useState(stop.outcome_reason ?? "");
  const [note, setNote] = useState(stop.note ?? "");
  const [photoPath, setPhotoPath] = useState<string | null>(stop.photo_path);
  const [voucherPath, setVoucherPath] = useState<string | null>(stop.voucher_path);
  const [err, setErr] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);

  const photoRef = useRef<HTMLInputElement>(null);
  const voucherRef = useRef<HTMLInputElement>(null);

  const numericAmount = amount.trim() ? Number(amount.replace(",", ".")) : null;

  async function upload(kind: "entrega" | "yape", file: File) {
    setUploading(kind);
    setErr(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("stopId", stop.id);
      fd.append("kind", kind);
      const res = await fetch("/api/reparto/foto", { method: "POST", body: fd });
      const json = await res.json();
      if (!res.ok) setErr(json.error ?? "No se pudo subir la foto.");
      else if (kind === "entrega") setPhotoPath(json.path);
      else setVoucherPath(json.path);
    } catch {
      setErr("No se pudo subir la foto. Revisa tu señal.");
    } finally {
      setUploading(null);
    }
  }

  function submit() {
    // Se valida con la MISMA función que el servidor, para avisarle antes de
    // gastarle datos en una petición que va a rebotar igual.
    const check = validateStopReport({
      status,
      paymentMethod: status === "entregado" ? method : null,
      collectedAmount: status === "entregado" ? (numericAmount ?? null) : null,
      outcomeReason: status === "no_entregado" ? reason || null : null,
      note,
      hasPhoto: Boolean(photoPath),
      hasVoucher: Boolean(voucherPath),
    });
    if (!check.ok) {
      setErr(check.errors.join(" "));
      return;
    }
    start(async () => {
      setErr(null);
      const res = await reportStop({
        stopId: stop.id,
        status,
        paymentMethod: status === "entregado" ? method : null,
        collectedAmount: status === "entregado" ? (numericAmount ?? null) : null,
        outcomeReason: status === "no_entregado" ? reason || null : null,
        note: note.trim() || null,
        photoPath,
        voucherPath,
      });
      if (!res.ok) setErr(res.error ?? "No se pudo guardar.");
      else onDone();
    });
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <button
          onClick={() => setStatus("entregado")}
          className={cn(
            "rounded-lg px-3 py-2.5 text-sm font-medium",
            status === "entregado"
              ? "bg-emerald-600 text-white"
              : "border border-slate-300 text-slate-700",
          )}
        >
          Entregado
        </button>
        <button
          onClick={() => setStatus("no_entregado")}
          className={cn(
            "rounded-lg px-3 py-2.5 text-sm font-medium",
            status === "no_entregado"
              ? "bg-red-600 text-white"
              : "border border-slate-300 text-slate-700",
          )}
        >
          No entregado
        </button>
      </div>

      {status === "entregado" && (
        <>
          <div className="flex flex-wrap gap-1.5">
            {PAYMENT_METHODS.map((m) => (
              <button
                key={m.code}
                onClick={() => setMethod(m.code)}
                className={cn(
                  "rounded-lg px-2.5 py-2 text-xs font-medium",
                  method === m.code
                    ? "bg-slate-800 text-white"
                    : "border border-slate-300 text-slate-700",
                )}
              >
                {m.label}
              </button>
            ))}
          </div>
          {method !== "sin_cobro" && (
            <input
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="¿Cuánto cobraste?"
              className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base"
            />
          )}
          <PhotoField
            label="Foto de la entrega"
            path={photoPath}
            busy={uploading === "entrega"}
            inputRef={photoRef}
            onPick={(f) => upload("entrega", f)}
          />
          {method === "yape" && (
            <PhotoField
              label="Captura del Yape"
              path={voucherPath}
              busy={uploading === "yape"}
              inputRef={voucherRef}
              onPick={(f) => upload("yape", f)}
            />
          )}
        </>
      )}

      {status === "no_entregado" && (
        <select
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base"
        >
          <option value="">¿Por qué no se entregó?</option>
          {NON_DELIVERY_REASONS.map((r) => (
            <option key={r.code} value={r.code}>
              {r.label}
            </option>
          ))}
        </select>
      )}

      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Nota (opcional)"
        rows={2}
        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
      />

      {err && <p className="text-sm text-red-600">{err}</p>}

      <button
        onClick={submit}
        disabled={pending || uploading !== null}
        className="w-full rounded-lg bg-brand-600 px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"
      >
        {pending ? "Guardando…" : stop.status === "pendiente" ? "Guardar" : "Corregir"}
      </button>
    </div>
  );
}

function PhotoField({
  label,
  path,
  busy,
  inputRef,
  onPick,
}: {
  label: string;
  path: string | null;
  busy: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onPick: (file: File) => void;
}) {
  return (
    <div className="rounded-lg border border-dashed border-slate-300 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-slate-600">
          {label}
          {path && <strong className="ml-1 text-emerald-700">✓ lista</strong>}
        </span>
        <button
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-medium text-slate-700 disabled:opacity-50"
        >
          {busy ? "Subiendo…" : path ? "Cambiar" : "Tomar foto"}
        </button>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        // `capture` abre la cámara directamente en el móvil, que es lo que hace
        // el 99 % de las veces; en escritorio el navegador lo ignora y abre el
        // selector de archivos.
        capture="environment"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onPick(f);
          e.target.value = "";
        }}
      />
    </div>
  );
}
