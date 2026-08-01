"use client";

import { useState } from "react";
import { Card } from "@/components/ui";
import { ShalomGuideModal } from "@/components/shalom-guide-modal";

/** Entry point kept inside the Master drawer; the actual form talks only to
 * the direct Shalom API and opens in a focused modal because the first session
 * connection can take up to two minutes. */
export function ShalomGuidePanel({
  orderId,
  onCreated,
}: {
  orderId: string;
  onCreated: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Card>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-slate-900">Guía de Agencia Shalom</h3>
              <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-700">
                API directa
              </span>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-slate-500">
              Crea la preguía en Shalom Pro, busca la agencia y descarga el rótulo sin pasar por Aliclik.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="shrink-0 rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800"
          >
            Generar guía
          </button>
        </div>
      </Card>

      {open ? (
        <ShalomGuideModal
          orderId={orderId}
          onClose={() => setOpen(false)}
          onCreated={onCreated}
        />
      ) : null}
    </>
  );
}
