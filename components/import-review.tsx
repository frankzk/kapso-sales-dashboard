"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { Card } from "@/components/ui";
import type { ShipmentRow, StoreSummary } from "@/lib/types";
import { OrderLinkPicker } from "@/components/order-link-picker";
import {
  clearShipmentSuggestion,
  linkShipmentToShopifyOrder,
  processSuggestionBatch,
  recomputeFenixEligibility,
} from "@/app/dashboard/envios/actions";

export function ImportReview({
  stores,
  storeId,
  reviewRows,
}: {
  stores: StoreSummary[];
  storeId: string;
  reviewRows: ShipmentRow[];
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [store, setStore] = useState(storeId);
  const [uploading, setUploading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function upload() {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setMsg("Selecciona un archivo CSV o XLSX.");
      return;
    }
    setUploading(true);
    setMsg(null);
    const fd = new FormData();
    fd.append("file", file);
    fd.append("storeId", store);
    try {
      const res = await fetch("/api/import/aliclik", { method: "POST", body: fd });
      const json = await res.json();
      if (!res.ok) {
        setMsg(json.error ?? "Error al importar.");
      } else {
        const base = `Importadas ${json.rowCount} filas — ${json.matchedCount} con pedido, ${json.unmatchedCount} a revisión, ${json.errorCount} con error.`;
        if (fileRef.current) fileRef.current.value = "";
        // Auto-link the fresh review rows against live Shopify (NOTA + phone) so
        // the operator doesn't have to click through them one by one.
        if (json.unmatchedCount > 0) {
          setMsg(`${base} Buscando coincidencias…`);
          const r = await runAutoLinkLoop(({ linked }) =>
            setMsg(`${base} Vinculando… (${linked} vinculados)`),
          );
          // Now that guides carry their Shopify order, re-evaluate Fenix
          // eligibility off the order's products (best-effort; admins only).
          await recomputeFenixEligibility().catch(() => {});
          setMsg(
            r.error
              ? `${base} (auto-vínculo: ${r.error})`
              : `${base} Auto-vinculadas ${r.linked} guías; el resto queda para revisión.`,
          );
        } else {
          setMsg(base);
        }
        router.refresh();
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Error de red.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-slate-900">Importar reporte Aliclik</h1>
        <a
          href={`/dashboard/envios?store=${storeId}`}
          className="text-sm text-brand-700 hover:underline"
        >
          ← Volver a Envíos
        </a>
      </div>

      <Card className="space-y-3">
        <p className="text-sm text-slate-600">
          Sube el reporte de entregas de Aliclik (CSV o Excel). Las guías AUR5X se
          enlazan automáticamente al pedido por número (#KP…) o teléfono; al terminar
          se buscan las restantes en Shopify y se vinculan solas cuando el número de
          nota y el teléfono coinciden. Solo lo ambiguo queda abajo para revisión manual.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-sm text-slate-600">Tienda por defecto</label>
          <select
            value={store}
            onChange={(e) => setStore(e.target.value)}
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm"
          >
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.xlsx,text/csv"
          className="block text-sm text-slate-600"
        />
        <button
          onClick={upload}
          disabled={uploading}
          className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {uploading ? "Importando…" : "Importar"}
        </button>
        {msg && <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">{msg}</p>}
      </Card>

      <Card className="p-0">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-5 py-3">
          <p className="text-sm font-medium text-slate-800">
            Por revisar ({reviewRows.length})
          </p>
          <SuggestionBatchRunner onDone={() => router.refresh()} />
        </div>
        {reviewRows.length === 0 ? (
          <p className="p-5 text-sm text-slate-400">Nada pendiente de revisión.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {reviewRows.map((row) => (
              <ReviewRow key={row.id} shipment={row} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

/**
 * Drive the whole Revisión queue through the auto-link batch: process
 * SUGGESTION_BATCH_SIZE shipments per round-trip and loop until `done`, so no
 * single request risks a serverless timeout. Each confident match (NOTA
 * reference + same phone) is linked directly, shrinking "Por revisar". Shared
 * by the manual button and the post-import auto-run. `onProgress` fires after
 * every chunk with running totals.
 */
async function runAutoLinkLoop(
  onProgress?: (totals: { processed: number; linked: number }) => void,
): Promise<{ processed: number; linked: number; error?: string }> {
  let processed = 0;
  let linked = 0;
  for (;;) {
    const r = await processSuggestionBatch();
    if ("error" in r) return { processed, linked, error: r.error };
    processed += r.processed;
    linked += r.linked;
    onProgress?.({ processed, linked });
    if (r.done) break;
  }
  return { processed, linked };
}

/**
 * Manual trigger for the auto-link batch (the post-import path runs it too).
 * Links every confident match across the queue; anything ambiguous stays in
 * Revisión for a human.
 */
function SuggestionBatchRunner({ onDone }: { onDone: () => void }) {
  const [running, setRunning] = useState(false);
  const [stats, setStats] = useState({ processed: 0, linked: 0 });
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    setRunning(true);
    setErr(null);
    setStats({ processed: 0, linked: 0 });
    const r = await runAutoLinkLoop(setStats);
    if (r.error) setErr(r.error);
    setRunning(false);
    onDone();
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={run}
        disabled={running}
        className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50"
      >
        {running
          ? `Procesando… (${stats.processed} revisados, ${stats.linked} vinculados)`
          : "Vincular coincidencias automáticas"}
      </button>
      {err && <span className="text-xs text-rose-600">{err}</span>}
    </div>
  );
}

function SuggestionBanner({ shipment, onResolved }: { shipment: ShipmentRow; onResolved: () => void }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  function confirm() {
    start(async () => {
      const r = await linkShipmentToShopifyOrder(
        shipment.id,
        shipment.suggested_order_gid!,
        shipment.suggested_store_id!,
      );
      setMsg(r.error ?? null);
      if (!r.error) onResolved();
    });
  }

  function discard() {
    start(async () => {
      const r = await clearShipmentSuggestion(shipment.id);
      setMsg(r.error ?? null);
      if (!r.error) onResolved();
    });
  }

  return (
    <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-sm">
      <p className="text-slate-700">
        Sugerencia: <span className="font-mono text-xs">{shipment.suggested_order_name}</span>
        <span className="ml-2 text-xs font-medium text-emerald-600">✓ mismo teléfono</span>
      </p>
      <div className="mt-1 flex gap-2">
        <button
          type="button"
          onClick={confirm}
          disabled={pending}
          className="rounded-lg bg-brand-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50"
        >
          Confirmar
        </button>
        <button
          type="button"
          onClick={discard}
          disabled={pending}
          className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50"
        >
          Descartar
        </button>
      </div>
      {msg && <p className="mt-1 text-xs text-rose-600">{msg}</p>}
    </div>
  );
}

function ReviewRow({ shipment }: { shipment: ShipmentRow }) {
  const router = useRouter();

  return (
    <li className="space-y-2 px-5 py-3 text-sm">
      <div className="min-w-0">
        <p className="font-mono text-xs text-slate-700">{shipment.guide_code}</p>
        <p className="text-slate-700">
          {shipment.order_name ?? "sin pedido"} · {shipment.customer_name ?? "—"} ·{" "}
          {shipment.customer_phone ?? "—"}
        </p>
        <p className="text-xs text-slate-400">
          {shipment.product ?? ""} {shipment.city ? `· ${shipment.city}` : ""}
        </p>
      </div>
      {shipment.suggested_order_gid && (
        <SuggestionBanner shipment={shipment} onResolved={() => router.refresh()} />
      )}
      <OrderLinkPicker
        shipmentId={shipment.id}
        prefill={shipment.order_name}
        customerPhone={shipment.customer_phone}
        onLinked={() => router.refresh()}
      />
    </li>
  );
}
