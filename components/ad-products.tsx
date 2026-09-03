"use client";

// Declarar qué producto vende cada anuncio de Meta.
//
// La pantalla existe porque el dato no está en ninguna parte: quien llega por
// un anuncio nunca pasa por la ficha del producto, así que su lead trae `ad_id`
// y nada más. Alguien tiene que decirlo una vez por anuncio.
//
// LO QUE LA PANTALLA NO HACE: aplicar la sugerencia sola. El histórico propone
// —«de este anuncio suelen comprar Beewax, 98 % sobre 44 pedidos»— y la persona
// declara o no. Un anuncio sin declarar deja a sus leads en «Sin producto», que
// es la verdad, en vez de en un producto probable, que es una mentira que nadie
// puede ver.
//
// Y LA DECLARACIÓN TIENE FECHA. Un creativo que funciona se reutiliza para otro
// producto —el del café que hoy vende el gel de limpieza de lengua—, así que un
// anuncio puede tener varios periodos. Cada lead toma el que valía el día que
// entró; declarar hoy no reescribe lo que ya se trabajó.

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, EmptyState, cn } from "@/components/ui";
import {
  FUERZA_LABEL,
  fuerzaEvidencia,
  type AdDeclaration,
  type AdProductRow,
} from "@/lib/ad-products";
import { productLabel } from "@/lib/leads";
import {
  declareAdProduct,
  refreshAdSuggestions,
  removeAdDeclaration,
} from "@/app/dashboard/leads/anuncios/actions";

export interface AdRow extends AdProductRow {
  leads: number;
  declaraciones: AdDeclaration[];
}

/** «desde siempre» o la fecha, en corto. */
function desdeLabel(validFrom: string): string {
  const v = validFrom.trim().toLowerCase();
  if (v === "-infinity") return "desde siempre";
  const t = Date.parse(validFrom);
  return Number.isNaN(t)
    ? validFrom
    : `desde ${new Date(t).toLocaleDateString("es-PE", { day: "2-digit", month: "short", year: "numeric" })}`;
}

const FUERZA_STYLE: Record<string, string> = {
  fuerte: "bg-emerald-50 text-emerald-700",
  dudosa: "bg-amber-50 text-amber-700",
  ninguna: "bg-slate-100 text-slate-500",
};

export function AdProductsBoard({
  ads,
  handles,
  stores,
  canEdit,
}: {
  ads: AdRow[];
  handles: string[];
  stores: { id: string; name: string }[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [desde, setDesde] = useState<Record<string, string>>({});
  const hoy = new Date().toISOString().slice(0, 10);
  const storeName = useMemo(() => {
    const byId = new Map(stores.map((s) => [s.id, s.name]));
    return (id: string) => byId.get(id) ?? "—";
  }, [stores]);

  const run = (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>) =>
    start(async () => {
      const res = await fn();
      setMsg({ ok: res.ok, text: res.error ?? res.message ?? "" });
      if (res.ok) router.refresh();
    });

  // Cuántos leads dependen de una firma que todavía no existe. Es el número que
  // dice si vale la pena sentarse a esto.
  const pendientes = useMemo(
    () => ads.filter((a) => !a.declaraciones.length).reduce((n, a) => n + a.leads, 0),
    [ads],
  );
  const declarados = useMemo(() => ads.filter((a) => a.declaraciones.length).length, [ads]);

  if (!ads.length) {
    return <EmptyState title="No hay anuncios con leads en la cola" />;
  }

  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div>
          <h2 className="text-sm font-semibold text-slate-800">Qué vende cada anuncio</h2>
          <p className="mt-1 text-xs text-slate-500">
            Quien llega por un anuncio nunca pasa por la ficha del producto, así que su lead
            no trae ninguno. Declararlo acá hace que caiga en el mismo producto que los que
            sí llegaron por la ficha. Si un creativo se reutilizó para vender otra cosa, pon
            la fecha desde la que vale: cada lead toma lo que el anuncio vendía el día que
            entró, y el pasado no se reescribe.{" "}
            <strong className="font-medium text-slate-700">
              {pendientes.toLocaleString("es-PE")} leads
            </strong>{" "}
            esperan una firma; {declarados} de {ads.length} anuncios ya están declarados.
          </p>
        </div>
        {canEdit && (
          <button
            disabled={busy}
            onClick={() => run(() => refreshAdSuggestions())}
            className="shrink-0 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
          >
            Recalcular sugerencias
          </button>
        )}
      </Card>

      {msg && (
        <p
          className={cn(
            "rounded-lg px-3 py-2 text-sm",
            msg.ok ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700",
          )}
        >
          {msg.text}
        </p>
      )}

      <Card className="overflow-x-auto p-0">
        <table className="w-full min-w-[900px] text-sm">
          <thead className="border-b border-slate-200 text-left text-xs text-slate-500">
            <tr>
              <th className="px-3 py-2 font-medium">Anuncio</th>
              <th className="px-3 py-2 font-medium">Tienda</th>
              <th className="px-3 py-2 text-right font-medium">Leads</th>
              <th className="px-3 py-2 font-medium">Suele vender (histórico)</th>
              <th className="px-3 py-2 font-medium">Qué vendió, y desde cuándo</th>
              <th className="px-3 py-2 font-medium">Declarar</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {ads.map((ad) => {
              const key = `${ad.store_id}::${ad.ad_id}`;
              const fuerza = fuerzaEvidencia(ad);
              const valor = draft[key] ?? "";
              return (
                <tr key={key} className="border-b border-slate-100 align-top">
                  <td className="px-3 py-2">
                    <p className="text-slate-700">{ad.ad_headline || "Sin titular"}</p>
                    {/* El id se muestra porque el titular NO identifica: hay
                        cuatro anuncios de Beewax con tres titulares distintos, y
                        dos de ellos son nombres de archivo de video. */}
                    <p className="font-mono text-[11px] text-slate-400">{ad.ad_id}</p>
                  </td>
                  <td className="px-3 py-2 text-slate-500">{storeName(ad.store_id)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                    {ad.leads.toLocaleString("es-PE")}
                  </td>
                  <td className="px-3 py-2">
                    {ad.suggested_label ? (
                      <>
                        <p className="text-slate-600">{ad.suggested_label}</p>
                        <span
                          className={cn(
                            "mt-0.5 inline-block rounded-full px-1.5 py-0.5 text-[11px] font-medium",
                            FUERZA_STYLE[fuerza],
                          )}
                        >
                          {FUERZA_LABEL[fuerza]} · {ad.evidence_pct ?? 0}% de {ad.evidence_sample ?? 0}
                        </span>
                      </>
                    ) : (
                      <span className="text-xs text-slate-400">Sin evidencia todavía</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {/* Los periodos declarados, del más nuevo al más viejo. Un
                        anuncio reutilizado tiene varios y cada lead toma el que
                        valía el día que entró. */}
                    {ad.declaraciones.length > 0 ? (
                      <ul className="space-y-0.5">
                        {ad.declaraciones.map((d) => (
                          <li key={d.id ?? d.valid_from} className="text-[11px]">
                            <span className="font-medium text-emerald-700">
                              {productLabel(d.product_handle)}
                            </span>{" "}
                            <span className="text-slate-400">{desdeLabel(d.valid_from)}</span>
                            {d.note && <span className="text-slate-400"> · {d.note}</span>}
                            {canEdit && (
                              <button
                                disabled={busy}
                                onClick={() =>
                                  run(() =>
                                    removeAdDeclaration({
                                      storeId: ad.store_id,
                                      declarationId: d.id!,
                                    }),
                                  )
                                }
                                className="ml-1.5 text-slate-400 underline hover:text-red-600 disabled:opacity-50"
                              >
                                quitar
                              </button>
                            )}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <span className="text-xs text-slate-400">Sin declarar</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {canEdit && (
                      <div className="space-y-1">
                        <input
                          list="handles-conocidos"
                          value={valor}
                          onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
                          placeholder="handle del producto"
                          className="w-56 rounded-lg border border-slate-300 px-2 py-1 text-xs"
                        />
                        {/* La fecha solo hace falta cuando el anuncio CAMBIÓ de
                            producto. En blanco vale desde siempre, que es el
                            caso normal y no debe costar un clic de más. */}
                        <input
                          type="date"
                          value={desde[key] ?? ""}
                          onChange={(e) => setDesde((d) => ({ ...d, [key]: e.target.value }))}
                          max={hoy}
                          title="Desde cuándo vende este producto. En blanco = desde siempre."
                          className="w-56 rounded-lg border border-slate-300 px-2 py-1 text-xs text-slate-600"
                        />
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    {canEdit && (
                      <button
                        disabled={busy || !valor.trim()}
                        onClick={() =>
                          run(() =>
                            declareAdProduct({
                              storeId: ad.store_id,
                              adId: ad.ad_id,
                              handle: valor,
                              validFrom: desde[key] || null,
                              adHeadline: ad.ad_headline ?? null,
                            }),
                          )
                        }
                        className="rounded-lg bg-brand-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-40"
                      >
                        {ad.declaraciones.length ? "Añadir periodo" : "Declarar"}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      {/* Los handles que ya existen en links. Elegir de esta lista es lo que
          garantiza que el anuncio caiga en el MISMO balde que la ficha. */}
      <datalist id="handles-conocidos">
        {handles.map((h) => (
          <option key={h} value={h}>
            {productLabel(h)}
          </option>
        ))}
      </datalist>
    </div>
  );
}
