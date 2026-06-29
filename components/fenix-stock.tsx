"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Card } from "@/components/ui";
import { FENIX_CITIES } from "@/lib/shipments";
import type { FenixStockRowDb } from "@/lib/types";
import { deleteFenixStock, upsertFenixStock } from "@/app/dashboard/envios/actions";

export function FenixStockEditor({
  rows,
  canEdit,
}: {
  rows: FenixStockRowDb[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [city, setCity] = useState<string>(FENIX_CITIES[0] ?? "cusco");
  const [product, setProduct] = useState("");
  const [quantity, setQuantity] = useState("0");
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function add() {
    start(async () => {
      const r = await upsertFenixStock({
        city,
        product,
        quantity: Number(quantity) || 0,
      });
      setMsg(r.error ?? r.notice ?? null);
      if (!r.error) {
        setProduct("");
        setQuantity("0");
        router.refresh();
      }
    });
  }

  function remove(id: string) {
    start(async () => {
      await deleteFenixStock(id);
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-slate-900">Stock Fenix por ciudad</h1>
        <a href="/dashboard/envios" className="text-sm text-brand-700 hover:underline">
          ← Volver a Envíos
        </a>
      </div>

      {!canEdit && (
        <Card>
          <p className="text-sm text-amber-700">
            Solo un administrador puede editar el stock. Lo ves en modo lectura.
          </p>
        </Card>
      )}

      {canEdit && (
        <Card className="space-y-3">
          <p className="text-sm font-medium text-slate-800">Agregar / actualizar</p>
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <label className="block text-xs text-slate-400">Ciudad</label>
              <select
                value={city}
                onChange={(e) => setCity(e.target.value)}
                className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm capitalize"
              >
                {FENIX_CITIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex-1">
              <label className="block text-xs text-slate-400">Producto</label>
              <input
                value={product}
                onChange={(e) => setProduct(e.target.value)}
                placeholder="Nombre del producto"
                className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400">Cantidad</label>
              <input
                type="number"
                min={0}
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                className="w-24 rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm"
              />
            </div>
            <button
              onClick={add}
              disabled={pending || !product.trim()}
              className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
            >
              Guardar
            </button>
          </div>
          {msg && <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">{msg}</p>}
        </Card>
      )}

      <Card className="p-0">
        {rows.length === 0 ? (
          <p className="p-5 text-sm text-slate-400">Sin stock registrado.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs text-slate-500">
                  <th className="px-4 py-2.5 text-left font-medium">Ciudad</th>
                  <th className="px-4 py-2.5 text-left font-medium">Producto</th>
                  <th className="px-4 py-2.5 text-right font-medium">Cantidad</th>
                  {canEdit && <th className="px-4 py-2.5"></th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-4 py-2.5 capitalize text-slate-700">{r.city}</td>
                    <td className="px-4 py-2.5 text-slate-700">{r.product}</td>
                    <td className="px-4 py-2.5 text-right text-slate-700">{r.quantity}</td>
                    {canEdit && (
                      <td className="px-4 py-2.5 text-right">
                        <button
                          onClick={() => remove(r.id)}
                          disabled={pending}
                          className="text-xs text-rose-600 hover:underline"
                        >
                          Eliminar
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
