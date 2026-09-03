"use client";

// Declarar qué producto vende cada anuncio de Meta.
//
// La pantalla existe porque el dato no está en ninguna parte: quien llega por
// un anuncio nunca pasa por la ficha del producto, así que su lead trae `ad_id`
// y nada más. Alguien tiene que decirlo una vez por anuncio.
//
// LO QUE LA PANTALLA NO HACE: aplicar la sugerencia sola. El histórico propone
// —«de este anuncio suelen comprar Beewax, 98 % sobre 44 pedidos»— y la persona
// firma o no. Un anuncio sin firmar deja a sus leads en «Sin producto», que es
// la verdad, en vez de en un producto probable, que es una mentira que nadie
// puede ver.

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, EmptyState, cn } from "@/components/ui";
import { FUERZA_LABEL, fuerzaEvidencia, type AdProductRow } from "@/lib/ad-products";
import { productLabel } from "@/lib/leads";
import {
  clearAdProduct,
  confirmAdProduct,
  refreshAdSuggestions,
} from "@/app/dashboard/leads/anuncios/actions";

export interface AdRow extends AdProductRow {
  leads: number;
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
    () => ads.filter((a) => !a.confirmed_at).reduce((n, a) => n + a.leads, 0),
    [ads],
  );
  const declarados = useMemo(() => ads.filter((a) => a.confirmed_at).length, [ads]);

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
            sí llegaron por la ficha.{" "}
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
              <th className="px-3 py-2 font-medium">Producto declarado</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {ads.map((ad) => {
              const key = `${ad.store_id}::${ad.ad_id}`;
              const fuerza = fuerzaEvidencia(ad);
              const valor = draft[key] ?? ad.product_handle ?? "";
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
                    {canEdit ? (
                      <>
                        <input
                          list="handles-conocidos"
                          value={valor}
                          onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
                          placeholder="handle del producto"
                          className="w-64 rounded-lg border border-slate-300 px-2 py-1 text-xs"
                        />
                        {ad.confirmed_at && (
                          <p className="mt-0.5 text-[11px] text-emerald-700">
                            Declarado · {productLabel(ad.product_handle ?? "")}
                          </p>
                        )}
                      </>
                    ) : (
                      <span className="text-slate-600">
                        {ad.product_handle ? productLabel(ad.product_handle) : "—"}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    {canEdit && (
                      <>
                        <button
                          disabled={busy || !valor.trim() || valor.trim() === ad.product_handle}
                          onClick={() =>
                            run(() =>
                              confirmAdProduct({
                                storeId: ad.store_id,
                                adId: ad.ad_id,
                                handle: valor,
                                adHeadline: ad.ad_headline ?? null,
                              }),
                            )
                          }
                          className="rounded-lg bg-brand-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-40"
                        >
                          {ad.confirmed_at ? "Actualizar" : "Confirmar"}
                        </button>
                        {ad.confirmed_at && (
                          <button
                            disabled={busy}
                            onClick={() =>
                              run(() => clearAdProduct({ storeId: ad.store_id, adId: ad.ad_id }))
                            }
                            className="ml-2 text-xs text-slate-500 underline hover:text-red-600 disabled:opacity-50"
                          >
                            Retirar
                          </button>
                        )}
                      </>
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
