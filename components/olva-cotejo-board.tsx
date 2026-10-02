"use client";

// «Cotejar Olva» (MOM §12): lo que trajo el último cotejo, lo que vinculó solo
// y lo que espera a una persona, con los candidatos a la vista.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { pasteCotejo, runCotejoNow } from "@/app/dashboard/olva/actions";
import { setOlvaTracking } from "@/app/dashboard/pedidos/actions";
import type { CotejoResumen, CotejoResumenRow } from "@/lib/olva/portal-sync";

export interface CotejoRun {
  id: string;
  source: "cron" | "manual" | "pegado";
  desde: string | null;
  hasta: string | null;
  ok: boolean;
  error: string | null;
  fetched: number;
  linked: number;
  created_at: string;
  resumen?: CotejoResumen;
}

export interface CotejoOrg {
  orgId: string;
  label: string;
  configured: boolean;
  canEdit: boolean;
  stores: { id: string; name: string }[];
  latest: CotejoRun | null;
  history: CotejoRun[];
}

const button =
  "rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";
const primary = "rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50";
const timeLabel = (value: string) =>
  new Intl.DateTimeFormat("es-PE", { dateStyle: "short", timeStyle: "short", timeZone: "America/Lima" }).format(new Date(value));
const SOURCE: Record<CotejoRun["source"], string> = { cron: "automático", manual: "botón", pegado: "pegado a mano" };

export function OlvaCotejoBoard({ orgs, liveLinked }: { orgs: CotejoOrg[]; liveLinked: Record<string, string | null> }) {
  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-slate-900">Cotejar Olva</h1>
        <p className="max-w-3xl text-sm text-slate-500">
          Trae del portal de Olva los envíos que registró la empresa y les pone el tracking a las salidas de Kapta
          que no lo tienen. <strong>Solo vincula lo que no admite duda</strong>: el «Doc. externo» igual al número
          del pedido, o la misma dirección con todos los nombres de la clienta. Lo demás queda abajo para que lo
          decida una persona. Con el tracking puesto, Kapta rastrea el envío y le avisa a la clienta.
        </p>
      </header>
      {orgs.map((org) => (
        <OrgCotejo key={org.orgId} org={org} liveLinked={liveLinked} />
      ))}
    </div>
  );
}

function OrgCotejo({ org, liveLinked }: { org: CotejoOrg; liveLinked: Record<string, string | null> }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<{ ok: boolean; message: string } | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [pasteStore, setPasteStore] = useState(org.stores[0]?.id ?? "");

  const run = (fn: () => Promise<{ ok: boolean; message: string }>) =>
    startTransition(async () => {
      const res = await fn();
      setNotice(res);
      if (res.ok) {
        setPasteText("");
        router.refresh();
      }
    });

  const rows = org.latest?.resumen?.rows ?? [];
  const pendingRows = rows.filter((r) => (r.outcome === "revisar" || r.outcome === "sin_pareja") && !(r.tracking in liveLinked));
  const review = pendingRows.filter((r) => r.outcome === "revisar");
  const unmatched = pendingRows.filter((r) => r.outcome === "sin_pareja");
  const linked = rows.filter((r) => r.outcome === "vinculado");
  const lastFailure = org.history[0] && !org.history[0].ok ? org.history[0] : null;

  return (
    <section className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-800">{org.label}</h2>
          <p className="text-xs text-slate-500">
            {org.latest
              ? `Último cotejo: ${timeLabel(org.latest.created_at)} (${SOURCE[org.latest.source]}) · ${org.latest.fetched} envíos de Olva, ${org.latest.linked} vinculados.`
              : "Todavía no hay cotejos."}{" "}
            {org.configured ? "Corre solo cada dos horas, de 7 a 19 h." : null}
          </p>
        </div>
        {org.canEdit ? (
          <div className="flex flex-wrap gap-2">
            <button className={button} disabled={pending} onClick={() => setPasteOpen((v) => !v)}>
              Pegar respuesta
            </button>
            <button className={primary} disabled={pending || !org.configured} onClick={() => run(() => runCotejoNow(org.orgId))}>
              {pending ? "Cotejando…" : "Traer de Olva ahora"}
            </button>
          </div>
        ) : null}
      </div>

      {!org.configured ? (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Falta la cuenta del portal de Olva. Ponla en{" "}
          {org.stores[0] ? (
            <Link className="underline" href={`/dashboard/${org.stores[0].id}/settings`}>
              Ajustes de la tienda
            </Link>
          ) : (
            "Ajustes de la tienda"
          )}{" "}
          → «Olva (portal de clientes)»: usuario, contraseña y RUC. Mientras tanto se puede pegar la respuesta a mano.
        </p>
      ) : null}
      {lastFailure ? (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
          El cotejo de las {timeLabel(lastFailure.created_at)} ({SOURCE[lastFailure.source]}) falló: {lastFailure.error}
        </p>
      ) : null}
      {notice ? (
        <p className={`rounded-lg px-3 py-2 text-sm ${notice.ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-800"}`}>
          {notice.message}
        </p>
      ) : null}

      {pasteOpen && org.canEdit ? (
        <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm">
          <p className="text-slate-600">
            En el portal de Olva: Reportes → Seguimiento de envíos → «Listar». En las herramientas del navegador
            (F12) → Red, abre <code>getTrackingsClient</code> → «Respuesta», copia todo y pégalo aquí. Pasa por el
            mismo cotejo que el automático.
          </p>
          {org.stores.length > 1 ? (
            <select
              value={pasteStore}
              onChange={(e) => setPasteStore(e.target.value)}
              className="h-9 rounded-lg border border-slate-300 bg-white px-2 text-sm"
            >
              {org.stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          ) : null}
          <textarea
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            rows={6}
            placeholder='{"success":true,"msg":"resultados obtenidos","data":[…]}'
            className="w-full rounded-lg border border-slate-300 bg-white p-2 font-mono text-xs"
          />
          <button
            className={primary}
            disabled={pending || !pasteText.trim()}
            onClick={() => run(() => pasteCotejo(pasteStore, pasteText))}
          >
            Cotejar lo pegado
          </button>
        </div>
      ) : null}

      {org.latest ? (
        <div className="space-y-5">
          <ReviewTable rows={review} canEdit={org.canEdit} onDone={() => router.refresh()} />
          <SimpleList
            title={`Vinculados en este cotejo (${linked.length})`}
            empty="Ninguno en este cotejo."
            rows={linked}
            render={(r) => (
              <>
                <span className="font-mono">{r.tracking}</span> → <strong>{r.orderName}</strong>{" "}
                <span className="text-slate-500">
                  · {r.destinatario} · {r.via === "doc_externo" ? "Doc. externo" : "nombre y dirección"}
                </span>
              </>
            )}
          />
          <SimpleList
            title={`Sin pareja en Kapta (${unmatched.length})`}
            empty="Todos los envíos de Olva tienen su salida."
            rows={unmatched}
            render={(r) => (
              <>
                <span className="font-mono">{r.tracking}</span> · {r.destinatario}{" "}
                <span className="text-slate-500">
                  · {r.distrito} · {r.direccion}
                </span>
              </>
            )}
          />
        </div>
      ) : null}
    </section>
  );
}

function ReviewTable({ rows, canEdit, onDone }: { rows: CotejoResumenRow[]; canEdit: boolean; onDone: () => void }) {
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">Por revisar ({rows.length})</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-slate-400">Nada pendiente.</p>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
          {rows.map((r) => (
            <li key={r.tracking} className="space-y-2 p-3 text-sm">
              <div>
                <span className="font-mono">{r.tracking}</span> · <strong>{r.destinatario}</strong>{" "}
                <span className="text-slate-500">
                  · {r.distrito} · {r.direccion}
                </span>
                <p className="text-xs text-amber-700">{r.reason}</p>
              </div>
              {r.hints?.map((h) => (
                <HintRow key={h.shipmentId} tracking={r.tracking} hint={h} canEdit={canEdit} onDone={onDone} />
              ))}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function HintRow({
  tracking,
  hint,
  canEdit,
  onDone,
}: {
  tracking: string;
  hint: NonNullable<CotejoResumenRow["hints"]>[number];
  canEdit: boolean;
  onDone: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2">
      <div className="text-xs text-slate-600">
        <strong className="text-slate-800">{hint.orderName ?? "Sin pedido"}</strong> · {hint.customerName ?? "sin nombre"} ·{" "}
        {hint.address ?? "sin dirección"} <span className="text-slate-400">— {hint.why}</span>
        {error ? <p className="text-red-700">{error}</p> : null}
      </div>
      {canEdit ? (
        <button
          className={button}
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const res = await setOlvaTracking(hint.shipmentId, { tracking });
              if (res.error) setError(res.error);
              else onDone();
            })
          }
        >
          {pending ? "Vinculando…" : `Es este: vincular a ${hint.orderName ?? "la salida"}`}
        </button>
      ) : null}
    </div>
  );
}

function SimpleList({
  title,
  empty,
  rows,
  render,
}: {
  title: string;
  empty: string;
  rows: CotejoResumenRow[];
  render: (r: CotejoResumenRow) => React.ReactNode;
}) {
  return (
    <details className="space-y-2" open={rows.length > 0 && rows.length <= 10}>
      <summary className="cursor-pointer text-xs font-semibold tracking-wide text-slate-500 uppercase">{title}</summary>
      {rows.length === 0 ? (
        <p className="text-sm text-slate-400">{empty}</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {rows.map((r) => (
            <li key={r.tracking}>{render(r)}</li>
          ))}
        </ul>
      )}
    </details>
  );
}
