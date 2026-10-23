"use client";

// Traer el historial por la API de Shopify (MOM §37.5). Primero se prueba si el
// token ve los pedidos antiguos; después, «Traer pedidos y clientes» le pide a
// Shopify un archivo con todo y lo va guardando por tandas en las tablas del
// historial. Nunca en el Master. Si la pestaña se cierra, «Continuar» sigue
// donde quedó.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Badge, Banner, OpsButton } from "@/components/ops-ui";
import {
  advanceHistoryImport,
  probeShopifyHistoryAccess,
  startHistoryImport,
  type HistoryAccessProbe,
  type HistoryImportView,
} from "@/app/dashboard/stores/historial/actions";

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString("es-PE", { timeZone: "America/Lima", day: "2-digit", month: "2-digit", year: "numeric" });
const fmtInt = (n: number | null | undefined) => Number(n ?? 0).toLocaleString("es-PE");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const KINDS = ["pedidos", "clientes"] as const;
type Kind = (typeof KINDS)[number];

function describe(imp: HistoryImportView): string {
  const what = imp.kind === "pedidos" ? "pedidos" : "clientes";
  if (imp.status === "preparando") {
    return imp.object_count
      ? `Shopify está armando el archivo de ${what}: ${fmtInt(imp.object_count)} registros hasta ahora…`
      : `Shopify está armando el archivo de ${what}…`;
  }
  if (imp.status === "importando") {
    const pct = imp.file_size ? Math.min(100, Math.round((100 * imp.bytes_done) / imp.file_size)) : 0;
    return `Guardando ${what}: ${fmtInt(imp.records)} guardados (${pct}%)${imp.busy ? " · otra pestaña está leyendo esta tanda" : ""}`;
  }
  if (imp.status === "listo") {
    const range = imp.first_at && imp.last_at ? `, del ${fmtDate(imp.first_at)} al ${fmtDate(imp.last_at)}` : "";
    return `Listo: ${fmtInt(imp.records)} ${what} guardados${range}.`;
  }
  return `Error: ${imp.error ?? "sin detalle"}`;
}

export function ShopifyHistoryApiProbe({
  storeId,
  storeName,
  imports = [],
}: {
  storeId: string;
  storeName?: string;
  imports?: HistoryImportView[];
}) {
  const router = useRouter();
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<HistoryAccessProbe | { error: string } | null>(null);
  const [running, setRunning] = useState(false);
  const [current, setCurrent] = useState<Partial<Record<Kind, HistoryImportView>>>(() => {
    const latest: Partial<Record<Kind, HistoryImportView>> = {};
    for (const imp of imports) if (!latest[imp.kind]) latest[imp.kind] = imp;
    return latest;
  });
  const [failure, setFailure] = useState<string | null>(null);
  const active = Object.values(current).some((imp) => imp && (imp.status === "preparando" || imp.status === "importando"));

  async function runProbe() {
    setProbing(true);
    setProbe(null);
    try {
      setProbe(await probeShopifyHistoryAccess(storeId));
    } catch (cause) {
      setProbe({ error: (cause as Error).message });
    }
    setProbing(false);
  }

  async function bring() {
    if (running) return;
    setRunning(true);
    setFailure(null);
    try {
      for (const kind of KINDS) {
        // Una traída también tiene `error` (su último aviso): lo que distingue
        // una respuesta fallida es que no trae `id`.
        const started = await startHistoryImport(storeId, kind);
        if (!("id" in started)) throw new Error(started.error);
        let imp: HistoryImportView = started;
        setCurrent((c) => ({ ...c, [kind]: started }));
        while (imp.status === "preparando" || imp.status === "importando") {
          if (imp.status === "preparando") await sleep(5000);
          else if (imp.busy) await sleep(15000);
          const next = await advanceHistoryImport(imp.id);
          if (!("id" in next)) throw new Error(next.error);
          imp = next;
          setCurrent((c) => ({ ...c, [kind]: next }));
          // Un error de lectura sin vencer el archivo se reintenta: la tanda sigue donde quedó.
          if (imp.status === "importando" && imp.error) await sleep(5000);
        }
        if (imp.status === "error") throw new Error(imp.error ?? "La traída falló.");
      }
      router.refresh();
    } catch (cause) {
      setFailure((cause as Error).message);
    }
    setRunning(false);
  }

  const canBring = probe && !("error" in probe) && probe.before2022 > 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <OpsButton variant="secondary" disabled={probing || running} onClick={runProbe}>
          {probing ? "Consultando a Shopify…" : "Probar acceso a pedidos antiguos"}
        </OpsButton>
        <span className="text-[13px] text-ink-500">Solo lee: cuenta los pedidos anteriores a 2022 que Kapta alcanza a ver.</span>
      </div>
      {probe && "error" in probe && <Banner tone="crit">{probe.error}</Banner>}
      {probe && !("error" in probe) && (
        <Banner tone={probe.before2022 > 0 ? "ok" : "warn"}>
          {probe.before2022 > 0 ? (
            <>
              Kapta ve {probe.before2022AtLeast ? "al menos " : ""}
              {probe.before2022.toLocaleString("es-PE")} pedidos anteriores a 2022
              {probe.oldest ? ` (el más antiguo, ${probe.oldest.name}, del ${fmtDate(probe.oldest.createdAt)})` : ""}. Se
              puede traer el historial por API.
            </>
          ) : (
            <>
              Kapta no ve pedidos anteriores a 2022
              {probe.oldest ? `: el más antiguo que alcanza es ${probe.oldest.name}, del ${fmtDate(probe.oldest.createdAt)}` : ""}. Por
              API no se puede; sigue con los CSV.
            </>
          )}
          <span className="mt-1 block text-[12px] opacity-80">Permisos del token: {probe.scopes.join(", ") || "—"}</span>
        </Banner>
      )}

      <div className="space-y-2 border-t border-line pt-4">
        <div className="flex flex-wrap items-center gap-3">
          <OpsButton variant="primary" disabled={running || (!canBring && !active)} onClick={bring}>
            {running
              ? "Trayendo desde Shopify…"
              : active
                ? "Continuar la traída"
                : `Traer pedidos y clientes${storeName ? ` de ${storeName}` : ""}`}
          </OpsButton>
          <span className="text-[13px] text-ink-500">
            {canBring || active
              ? "Trae todos los pedidos (con sus productos) y todos los clientes. Va solo al historial: no toca el Master."
              : "Primero prueba el acceso."}
          </span>
        </div>
        {(running || active) && (
          <p className="text-[13px] text-ink-500">
            No cierres esta pestaña. Si se cierra, vuelve y pulsa «Continuar la traída»: sigue donde quedó, sin duplicar nada.
          </p>
        )}
        {KINDS.map((kind) => {
          const imp = current[kind];
          if (!imp) return null;
          const pct =
            imp.status === "importando" && imp.file_size ? Math.min(100, Math.round((100 * imp.bytes_done) / imp.file_size)) : null;
          return (
            <div key={kind} className="rounded-lg border border-line px-3 py-2 text-[13px]">
              <div className="flex flex-wrap items-center gap-2">
                <Badge>{kind === "pedidos" ? "Pedidos" : "Clientes"}</Badge>
                <Badge tone={imp.status === "listo" ? "ok" : imp.status === "error" ? "crit" : "info"}>{imp.status}</Badge>
                <span className="text-ink-700">{describe(imp)}</span>
              </div>
              {pct != null && (
                <div className="mt-2 h-1.5 overflow-hidden rounded bg-slate-100">
                  <div className="h-full bg-brand-600" style={{ width: `${pct}%` }} />
                </div>
              )}
              {imp.status === "importando" && imp.error && (
                <p className="mt-1 text-ink-500">Último aviso: {imp.error}. Se reintenta solo.</p>
              )}
            </div>
          );
        })}
        {failure && <Banner tone="crit">{failure}</Banner>}
      </div>
    </div>
  );
}
