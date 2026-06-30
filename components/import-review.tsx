"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { Card } from "@/components/ui";
import type { ShipmentRow, StoreSummary } from "@/lib/types";
import { resolveShipmentMatch } from "@/app/dashboard/envios/actions";

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
        setMsg(
          `Importadas ${json.rowCount} filas — ${json.matchedCount} con pedido, ${json.unmatchedCount} a revisión, ${json.errorCount} con error.`,
        );
        if (fileRef.current) fileRef.current.value = "";
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
          enlazan automáticamente al pedido por número (#KP…) o teléfono; lo que no
          calce queda abajo para revisión manual.
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
        <div className="border-b border-slate-200 px-5 py-3">
          <p className="text-sm font-medium text-slate-800">
            Por revisar ({reviewRows.length})
          </p>
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

function ReviewRow({ shipment }: { shipment: ShipmentRow }) {
  const router = useRouter();
  const [orderId, setOrderId] = useState("");
  const [pending, start] = useTransition();

  function run(input: { orderId?: string | null }) {
    start(async () => {
      await resolveShipmentMatch(shipment.id, input);
      router.refresh();
    });
  }

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
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
      <div className="flex items-center gap-2">
        <input
          value={orderId}
          onChange={(e) => setOrderId(e.target.value)}
          placeholder="UUID del pedido"
          className="w-40 rounded-lg border border-slate-200 px-2 py-1 text-xs"
        />
        <button
          onClick={() => orderId.trim() && run({ orderId: orderId.trim() })}
          disabled={pending || !orderId.trim()}
          className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs hover:bg-slate-50 disabled:opacity-50"
        >
          Vincular
        </button>
        <button
          onClick={() => run({ orderId: null })}
          disabled={pending}
          className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs hover:bg-slate-50"
        >
          Sin pedido
        </button>
      </div>
    </li>
  );
}
