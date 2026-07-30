"use client";

import { useState, useTransition } from "react";
import { Card } from "@/components/ui";
import { dryRunTandersPayments } from "@/app/dashboard/pedidos/tanders-actions";
import type { SweepReport } from "@/lib/tanders/payment-sweep";

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

  return (
    <div className="space-y-4">
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
              <Stat label="Aún en ruta" value={report.enCurso} />
              <Stat label="Validado" value={report.validado} tone="text-emerald-700" />
              <Stat label="Rechazado" value={report.rechazado} tone="text-red-700" />
              <Stat label="Pendiente" value={report.pendiente} tone="text-amber-700" />
              <Stat label="Errores" value={report.errores} />
            </dl>
          </Card>

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
