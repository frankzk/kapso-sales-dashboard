"use client";

// Subida del historial de Shopify (MOM §37). El archivo se lee AQUÍ: un CSV de
// un año de Aurela pesa decenas de MB y no cabe por una acción del servidor. Se
// guarda el original comprimido en Storage (respaldo tal cual) y se cargan los
// pedidos o clientes por tandas, con el avance a la vista.
//
// La tienda es la de la pestaña de arriba y no se elige aquí: con un segundo
// selector, cambiar de pestaña dejaba el título en una tienda y la subida en
// otra (23-10-2026).

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Badge, Banner, OpsButton } from "@/components/ops-ui";
import { cn } from "@/components/ui";
import { createBrowserSupabase } from "@/lib/supabase-browser";
import {
  CUSTOMERS_PER_BATCH,
  ORDERS_PER_BATCH,
  batches,
  dateRange,
  decodeExport,
  parseShopifyExport,
} from "@/lib/shopify-history";
import {
  finishHistoryFile,
  importHistoryCustomers,
  importHistoryOrders,
  prepareHistoryUpload,
} from "@/app/dashboard/stores/historial/actions";

type Progress = {
  name: string;
  state: "leyendo" | "subiendo" | "cargando" | "listo" | "error";
  kind?: string;
  done: number;
  total: number;
  message?: string;
};

const KIND_LABEL: Record<string, string> = {
  pedidos: "Pedidos",
  clientes: "Clientes",
  productos: "Productos (solo respaldo)",
  otro: "No reconocido (solo respaldo)",
};

async function gzip(file: File): Promise<Blob> {
  if (typeof CompressionStream === "undefined") return file;
  const stream = file.stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).blob();
}

export function ShopifyHistoryUpload({ storeId, storeName }: { storeId: string; storeName: string }) {
  const router = useRouter();
  const [files, setFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState<Progress[]>([]);
  const [running, setRunning] = useState(false);

  function update(i: number, patch: Partial<Progress>) {
    setProgress((prev) => prev.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  }

  async function processFile(i: number, file: File) {
    update(i, { state: "leyendo" });
    const parsed = parseShopifyExport(decodeExport(new Uint8Array(await file.arrayBuffer())));
    const total = parsed.kind === "pedidos" ? parsed.orders.length : parsed.kind === "clientes" ? parsed.customers.length : 0;
    update(i, { kind: parsed.kind, total });

    const prep = await prepareHistoryUpload({ storeId, filename: file.name, sizeBytes: file.size, kind: parsed.kind });
    if ("error" in prep) throw new Error(prep.error);

    update(i, { state: "subiendo" });
    const { error: upError } = await createBrowserSupabase()
      .storage.from("shopify-history")
      .uploadToSignedUrl(prep.path, prep.token, await gzip(file), { contentType: "application/gzip" });
    if (upError) throw new Error(`No se pudo guardar el original: ${upError.message}`);

    update(i, { state: "cargando" });
    let done = 0;
    if (parsed.kind === "pedidos") {
      for (const batch of batches(parsed.orders, ORDERS_PER_BATCH)) {
        const res = await importHistoryOrders(prep.fileId, batch);
        if ("error" in res) throw Object.assign(new Error(res.error), { fileId: prep.fileId, done });
        done += res.saved;
        update(i, { done });
      }
    } else if (parsed.kind === "clientes") {
      for (const batch of batches(parsed.customers, CUSTOMERS_PER_BATCH)) {
        const res = await importHistoryCustomers(prep.fileId, batch);
        if ("error" in res) throw Object.assign(new Error(res.error), { fileId: prep.fileId, done });
        done += res.saved;
        update(i, { done });
      }
    }
    const range = dateRange(parsed.orders);
    const fin = await finishHistoryFile(prep.fileId, { rowsRead: parsed.rowsRead, records: done, firstAt: range.first, lastAt: range.last });
    if ("error" in fin) throw new Error(fin.error);
    update(i, {
      state: "listo",
      message:
        parsed.kind === "pedidos"
          ? `${done.toLocaleString("es-PE")} pedidos guardados`
          : parsed.kind === "clientes"
            ? `${done.toLocaleString("es-PE")} clientes guardados`
            : "Original guardado como respaldo",
    });
  }

  async function run() {
    if (!files.length || running) return;
    setRunning(true);
    setProgress(files.map((f) => ({ name: f.name, state: "leyendo", done: 0, total: 0 })));
    for (let i = 0; i < files.length; i++) {
      try {
        await processFile(i, files[i]!);
      } catch (cause) {
        const err = cause as Error & { fileId?: string; done?: number };
        if (err.fileId) {
          await finishHistoryFile(err.fileId, { rowsRead: 0, records: err.done ?? 0, firstAt: null, lastAt: null, error: err.message });
        }
        update(i, { state: "error", message: err.message });
      }
    }
    setRunning(false);
    setFiles([]);
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid min-w-64 flex-1 gap-1 text-[13px] font-medium text-ink-700">
          Archivos de Shopify de {storeName} (CSV de pedidos, clientes o productos)
          <input
            type="file"
            multiple
            accept=".csv,text/csv,.txt"
            disabled={running}
            onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
            className="text-[13px]"
          />
        </label>
        <OpsButton variant="primary" disabled={running || !files.length} onClick={run}>
          {running ? "Cargando…" : `Cargar ${files.length || ""} archivo${files.length === 1 ? "" : "s"} en ${storeName}`}
        </OpsButton>
      </div>
      <p className="text-[13px] text-ink-500">
        Para la otra marca, elige su pestaña arriba. Puedes subir varios a la vez (un CSV por año y el de clientes).
        Volver a subir uno no duplica nada. No cierres esta pestaña ni cambies de marca mientras carga.
      </p>

      {progress.length > 0 && (
        <ul className="space-y-2">
          {progress.map((p, i) => (
            <li key={`${p.name}-${i}`} className="rounded-lg border border-line px-3 py-2 text-[13px]">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-ink-900">{p.name}</span>
                {p.kind && <Badge>{KIND_LABEL[p.kind] ?? p.kind}</Badge>}
                <Badge tone={p.state === "listo" ? "ok" : p.state === "error" ? "crit" : "info"}>
                  {p.state === "leyendo"
                    ? "Leyendo…"
                    : p.state === "subiendo"
                      ? "Guardando el original…"
                      : p.state === "cargando"
                        ? `Cargando ${p.done.toLocaleString("es-PE")} de ${p.total.toLocaleString("es-PE")}`
                        : p.state === "listo"
                          ? "Listo"
                          : "Error"}
                </Badge>
              </div>
              {p.state === "cargando" && p.total > 0 && (
                <div className="mt-2 h-1.5 overflow-hidden rounded bg-slate-100">
                  <div className="h-full bg-brand-600" style={{ width: `${Math.round((100 * p.done) / p.total)}%` }} />
                </div>
              )}
              {p.message && (
                <p className={cn("mt-1", p.state === "error" ? "text-crit-fg" : "text-ink-600")}>{p.message}</p>
              )}
            </li>
          ))}
        </ul>
      )}
      {progress.some((p) => p.state === "error") && !running && (
        <Banner tone="warn">
          Algún archivo no terminó. Vuelve a subirlo: lo que ya entró no se duplica.
        </Banner>
      )}
    </div>
  );
}
