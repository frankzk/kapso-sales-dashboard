"use client";

import { useState, useTransition } from "react";
import { Card } from "@/components/ui";
import {
  dryRunTandersPayments,
  dryRunTandersStatus,
} from "@/app/dashboard/pedidos/tanders-actions";
import type { SweepReport } from "@/lib/tanders/payment-sweep";
import type { TandersStatusReport } from "@/lib/tanders/status-sweep";
import type { SweepFailure } from "@/lib/tanders/sweep-failures";

/**
 * Revisión en seco de los cobros Tanders.
 *
 * Muestra la constancia al lado de lo que el modelo leyó de ella. Esa
 * comparación es el punto: sin la imagen, "destinatario: Grupo GF SAC" es una
 * afirmación que hay que creerse; con la imagen al lado, se verifica de un
 * vistazo. Y lo que se está verificando es si un modelo puede decidir que un
 * pedido está cobrado.
 */
const TONE: Record<string, string> = {
  validado: "bg-emerald-100 text-emerald-800",
  rechazado: "bg-red-100 text-red-800",
  pendiente: "bg-amber-100 text-amber-800",
};

export function TandersCobros() {
  const [report, setReport] = useState<SweepReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [status, setStatus] = useState<TandersStatusReport | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusPending, startStatus] = useTransition();

  function run() {
    start(async () => {
      const res = await dryRunTandersPayments();
      if ("error" in res) {
        setError(res.error);
        setReport(null);
        return;
      }
      setError(null);
      setReport(res.report);
    });
  }

  function runStatus() {
    startStatus(async () => {
      const res = await dryRunTandersStatus();
      if ("error" in res) {
        setStatusError(res.error);
        setStatus(null);
        return;
      }
      setStatusError(null);
      setStatus(res.report);
    });
  }

  return (
    <div className="space-y-4">
      <section className="space-y-3 rounded-xl border border-slate-200 bg-slate-50/60 p-4">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Estados Tanders · lectura en seco</h2>
          <p className="mt-1 max-w-3xl text-sm text-slate-500">
            Pregunta a Tanders por cada guía viva y dice qué haría, sin escribir nada. Si su API
            falla, aquí sale <strong className="text-slate-700">por qué</strong>: el cron que corre
            cada hora no se lo cuenta a nadie.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={runStatus}
            disabled={statusPending}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 disabled:opacity-50"
          >
            {statusPending ? "Preguntando a Tanders…" : "Leer estados sin tocar nada"}
          </button>
        </div>
        {statusError && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{statusError}</p>
        )}
        {status && (
          <>
            <Card>
              <dl className="grid grid-cols-2 gap-4 sm:grid-cols-5">
                <Stat label="Leídas" value={status.scanned} />
                <Stat label="Cambiarían" value={status.aplicados} tone="text-emerald-700" />
                <Stat label="Sin novedad" value={status.sinCambio} />
                <Stat label="Omitidas" value={status.omitidas} tone="text-amber-700" />
                <Stat label="Errores" value={status.errores} tone="text-red-700" />
              </dl>
            </Card>
            <Failures fallos={status.fallos} detenido={status.detenido} />
            {Object.keys(status.desconocidos).length > 0 && (
              <p className="text-sm text-slate-600">
                Estados que Tanders devolvió y todavía no traducimos:{" "}
                {Object.entries(status.desconocidos)
                  .map(([code, n]) => `${code} (${n})`)
                  .join(", ")}
                .
              </p>
            )}
            {status.cambios.length > 0 && (
              <ul className="space-y-1 text-sm text-slate-700">
                {status.cambios.slice(0, 20).map((c) => (
                  <li key={c.guia}>
                    <span className="font-medium">{c.pedido ?? "—"}</span>{" "}
                    <span className="font-mono text-xs text-slate-500">{c.guia}</span>: {c.de} →{" "}
                    {c.a} <span className="text-xs text-slate-500">(Tanders: {c.estadoTanders})</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      <div>
        <h1 className="text-lg font-semibold text-slate-900">Cobros Tanders · revisión en seco</h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-500">
          Lee la constancia de pago de cada guía que Tanders da por entregada y dice qué haría.{" "}
          <strong className="text-slate-700">No escribe nada</strong>: ni el estado de la guía, ni el
          registro de la comprobación. Sirve para comprobar que el lector acierta antes de dejar que
          mueva pedidos a entregado.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={run}
          disabled={pending}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {pending ? "Leyendo constancias…" : "Analizar sin tocar nada"}
        </button>
        {pending && (
          <span className="text-xs text-slate-500">
            Cada guía es una llamada al modelo; puede tardar un minuto.
          </span>
        )}
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {report && (
        <>
          <Card>
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-6">
              <Stat label="Revisadas" value={report.scanned} />
              <Stat label="Sin constancia aún" value={report.enCurso} />
              <Stat label="Validado" value={report.validado} tone="text-emerald-700" />
              <Stat label="Rechazado" value={report.rechazado} tone="text-red-700" />
              <Stat label="Pendiente" value={report.pendiente} tone="text-amber-700" />
              <Stat label="Errores" value={report.errores} />
            </dl>
          </Card>
          <Failures fallos={report.fallos} detenido={report.detenido} />

          {report.duplicados.length > 0 && (
            <div className="rounded-xl border-2 border-red-300 bg-red-50 p-4">
              <p className="text-sm font-semibold text-red-900">
                🚨 {report.duplicados.length} comprobante
                {report.duplicados.length === 1 ? "" : "s"} de pago repetido
                {report.duplicados.length === 1 ? "" : "s"}
              </p>
              <p className="mt-1 text-xs text-red-800">
                El mismo nº de operación ya estaba registrado en otra guía: es el mismo dinero
                acreditando dos pedidos. Ninguna se dio por cobrada.
              </p>
              <ul className="mt-3 space-y-2 text-sm text-red-900">
                {report.duplicados.map((d) => (
                  <li key={`${d.guia}-${d.operacion}`}>
                    <span className="font-medium">{d.pedido ?? d.guia}</span>
                    {d.monto != null && <span> · S/ {d.monto.toFixed(2)}</span>} · operación{" "}
                    <span className="font-mono text-xs">{d.operacion}</span>
                    <br />
                    <span className="text-xs">ya estaba en: {d.otras.join(", ")}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {report.muestras.length > 0 && (
            <details className="rounded-xl border border-amber-200 bg-amber-50 p-4">
              <summary className="cursor-pointer text-sm font-medium text-amber-900">
                Guías entregadas sin constancia reconocida ({report.muestras.length} de muestra) —
                respuesta cruda de Tanders
              </summary>
              <p className="mt-2 text-xs text-amber-800">
                La API respondió 200, así que estas guías SÍ están entregadas: si no lo estuvieran,
                habría contestado «not yet delivered». Que no encontremos la constancia apunta a que
                el extractor busca donde no es.
              </p>
              {report.muestras.map((m) => (
                <div key={m.guia} className="mt-3">
                  <p className="font-mono text-xs text-amber-900">{m.guia}</p>
                  <pre className="mt-1 max-h-64 overflow-auto rounded-lg bg-white p-2 text-[11px] leading-snug text-slate-700">
                    {m.respuesta}
                  </pre>
                </div>
              ))}
            </details>
          )}

          {report.detalle.length === 0 ? (
            <p className="text-sm text-slate-500">
              Ninguna guía llegó a la validación: o Tanders todavía no las da por entregadas, o ya
              tienen veredicto.
            </p>
          ) : (
            <ul className="space-y-3">
              {report.detalle.map((d) => (
                <li key={d.guia} className="rounded-xl border border-slate-200 bg-white p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        TONE[d.veredicto] ?? "bg-slate-100 text-slate-700"
                      }`}
                    >
                      {d.veredicto}
                    </span>
                    <span className="text-sm font-medium text-slate-900">{d.pedido ?? "—"}</span>
                    <span className="font-mono text-xs text-slate-500">{d.guia}</span>
                    <span className="ml-auto text-xs text-slate-500">→ {d.haria}</span>
                  </div>

                  <p className="mt-2 text-sm text-slate-700">{d.resumen}</p>

                  <div className="mt-3 flex flex-wrap gap-4">
                    {d.imagen && (
                      <a href={d.imagen} target="_blank" rel="noreferrer" className="shrink-0">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={d.imagen}
                          alt="Constancia de pago"
                          className="h-40 w-32 rounded-lg border border-slate-200 object-cover"
                        />
                      </a>
                    )}
                    <dl className="grid flex-1 grid-cols-2 gap-x-4 gap-y-1.5 text-sm sm:grid-cols-3">
                      <Field label="Cobro de la guía" value={money(d.cobroEsperado)} />
                      <Field label="Monto leído" value={money(d.leido?.monto ?? null)} />
                      <Field label="Medio" value={d.leido?.medio ?? "—"} />
                      <Field
                        label="Destinatario leído"
                        value={d.leido?.destinatario ?? "—"}
                        wide
                      />
                      <Field label="N° operación" value={d.leido?.operacion ?? "—"} />
                    </dl>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function money(v: number | null): string {
  return v == null ? "—" : `S/ ${v.toFixed(2)}`;
}

/**
 * Por qué falló lo que falló. Es la diferencia entre «errores: 200» y saber si
 * es la contraseña (401), el endpoint (404) o Tanders caído (5xx).
 */
function Failures({ fallos, detenido }: { fallos: SweepFailure[]; detenido?: boolean }) {
  if (!fallos.length && !detenido) return null;
  return (
    <div className="space-y-2">
      {detenido && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Tanders cortó por límite de llamadas (429). El barrido paró ahí; lo que quedó sigue en la
          próxima pasada.
        </p>
      )}
      {fallos.length > 0 && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          <p className="font-medium">Motivos de los fallos</p>
          <ul className="mt-1 space-y-0.5">
            {fallos.map((f) => (
              <li key={f.mensaje} className="flex gap-2">
                <span className="shrink-0 tabular-nums">×{f.n}</span>
                <span className="break-all font-mono text-xs">{f.mensaje}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className={`text-lg font-semibold ${tone ?? "text-slate-900"}`}>{value}</dd>
    </div>
  );
}

function Field({ label, value, wide }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={wide ? "col-span-2" : ""}>
      <dt className="text-[11px] uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className="text-slate-800">{value}</dd>
    </div>
  );
}
