"use client";

// Traer el historial por la API de Shopify (MOM §37.5 y §37.6). Primero se
// prueba si el token ve los pedidos antiguos; después, «Traer todo» va paso por
// paso: productos, sus fotos, carritos abandonados, borradores, clientes y
// pedidos. Cada paso le pide a Shopify un archivo con todo y lo guarda por
// tandas en las tablas del historial; nunca en el Master. Si un paso falla, se
// sigue con el siguiente. Si la pestaña se cierra, «Continuar» sigue donde quedó.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Badge, Banner, OpsButton } from "@/components/ops-ui";
import {
  advanceHistoryImport,
  copyHistoryImages,
  probeShopifyHistoryAccess,
  startHistoryImport,
  type HistoryAccessProbe,
  type HistoryImportView,
} from "@/app/dashboard/stores/historial/actions";

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString("es-PE", { timeZone: "America/Lima", day: "2-digit", month: "2-digit", year: "numeric" });
const fmtInt = (n: number | null | undefined) => Number(n ?? 0).toLocaleString("es-PE");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** El orden de «Traer todo»: lo que más falta primero, los pedidos (lo más largo) al final. */
const KINDS = ["productos", "carritos", "borradores", "clientes", "pedidos"] as const;
type Kind = (typeof KINDS)[number];
const LABEL: Record<Kind, string> = {
  productos: "Productos",
  carritos: "Carritos abandonados",
  borradores: "Borradores",
  clientes: "Clientes",
  pedidos: "Pedidos",
};
const WHAT: Record<Kind, string> = {
  productos: "productos",
  carritos: "carritos",
  borradores: "borradores",
  clientes: "clientes",
  pedidos: "pedidos",
};

export type ImageStats = { total: number; copied: number; failed: number };

function describe(imp: HistoryImportView): string {
  const what = WHAT[imp.kind as Kind] ?? imp.kind;
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
  images: initialImages,
}: {
  storeId: string;
  storeName?: string;
  imports?: HistoryImportView[];
  images?: ImageStats;
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
  const [failures, setFailures] = useState<string[]>([]);
  const [images, setImages] = useState<(ImageStats & { running?: boolean }) | null>(
    initialImages && initialImages.total > 0 ? initialImages : null,
  );
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

  /** Un paso de archivo (productos, carritos, …): empieza o retoma, y avanza hasta terminar. */
  async function runKind(kind: Kind) {
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

  /** Las fotos de los productos: se copian por tandas hasta que no falte ninguna. */
  async function runImages() {
    let idle = 0;
    for (;;) {
      setImages((s) => (s ? { ...s, running: true } : { total: 0, copied: 0, failed: 0, running: true }));
      const res = await copyHistoryImages(storeId);
      if ("error" in res) throw new Error(res.error);
      setImages({ total: res.total, copied: res.total - res.remaining - res.failed, failed: res.failed, running: res.remaining > 0 });
      if (res.remaining === 0) return;
      idle = res.copied === 0 ? idle + 1 : 0;
      if (idle >= 3) throw new Error(`Quedan ${fmtInt(res.remaining)} fotos que Shopify no entrega ahora; vuelve a intentarlo más tarde.`);
    }
  }

  async function bring() {
    if (running) return;
    setRunning(true);
    setFailures([]);
    const steps: { name: string; run: () => Promise<void> }[] = [
      { name: LABEL.productos, run: () => runKind("productos") },
      { name: "Fotos de productos", run: runImages },
      ...KINDS.filter((k) => k !== "productos").map((k) => ({ name: LABEL[k], run: () => runKind(k) })),
    ];
    for (const step of steps) {
      try {
        await step.run();
      } catch (cause) {
        // Un paso que falla no detiene los demás: se anota y se sigue.
        setFailures((f) => [...f, `${step.name}: ${(cause as Error).message}`]);
      }
    }
    setImages((s) => (s ? { ...s, running: false } : s));
    router.refresh();
    setRunning(false);
  }

  const canBring = probe && !("error" in probe) && probe.fullAccess;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <OpsButton variant="secondary" disabled={probing || running} onClick={runProbe}>
          {probing ? "Consultando a Shopify…" : "Probar acceso a pedidos antiguos"}
        </OpsButton>
        <span className="text-[13px] text-ink-500">Solo lee: revisa si Kapta ve todos los pedidos de la tienda.</span>
      </div>
      {probe && "error" in probe && <Banner tone="crit">{probe.error}</Banner>}
      {probe && !("error" in probe) && (
        <Banner tone={probe.fullAccess ? "ok" : "warn"}>
          {probe.fullAccess ? (
            <>
              Kapta ve todos los pedidos de la tienda
              {probe.oldest ? `, desde el primero: ${probe.oldest.name}, del ${fmtDate(probe.oldest.createdAt)}` : ""}
              {probe.before2022 > 0
                ? ` (${probe.before2022AtLeast ? "al menos " : ""}${probe.before2022.toLocaleString("es-PE")} anteriores a 2022)`
                : ""}
              . Se puede traer el historial por API.
            </>
          ) : (
            <>
              Kapta solo ve los últimos 60 días
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
                : `Traer todo${storeName ? ` de ${storeName}` : ""}`}
          </OpsButton>
          <span className="text-[13px] text-ink-500">
            {canBring || active
              ? "Productos con todas sus fotos, carritos abandonados, borradores del formulario, clientes y pedidos con su detalle. Va solo al historial: no toca el Master."
              : "Primero prueba el acceso."}
          </span>
        </div>
        {(running || active) && (
          <p className="text-[13px] text-ink-500">
            No cierres esta pestaña. Si se cierra, vuelve y pulsa «Continuar la traída»: sigue donde quedó, sin duplicar nada.
          </p>
        )}
        {images && (
          <div className="rounded-lg border border-line px-3 py-2 text-[13px]">
            <div className="flex flex-wrap items-center gap-2">
              <Badge>Fotos de productos</Badge>
              <Badge tone={images.running ? "info" : images.copied + images.failed >= images.total ? (images.failed ? "warn" : "ok") : "info"}>
                {images.running ? "copiando" : images.copied + images.failed >= images.total ? "listo" : "pendiente"}
              </Badge>
              <span className="text-ink-700">
                {fmtInt(images.copied)} de {fmtInt(images.total)} fotos copiadas a Kapta
                {images.failed ? ` · ${fmtInt(images.failed)} no se pudieron bajar` : ""}
              </span>
            </div>
            {images.total > 0 && (
              <div className="mt-2 h-1.5 overflow-hidden rounded bg-slate-100">
                <div className="h-full bg-brand-600" style={{ width: `${Math.round((100 * images.copied) / images.total)}%` }} />
              </div>
            )}
          </div>
        )}
        {KINDS.map((kind) => {
          const imp = current[kind];
          if (!imp) return null;
          const pct =
            imp.status === "importando" && imp.file_size ? Math.min(100, Math.round((100 * imp.bytes_done) / imp.file_size)) : null;
          return (
            <div key={kind} className="rounded-lg border border-line px-3 py-2 text-[13px]">
              <div className="flex flex-wrap items-center gap-2">
                <Badge>{LABEL[kind]}</Badge>
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
        {failures.length > 0 && (
          <Banner tone="crit">
            {failures.map((f) => (
              <span key={f} className="block">
                {f}
              </span>
            ))}
          </Banner>
        )}
      </div>
    </div>
  );
}
