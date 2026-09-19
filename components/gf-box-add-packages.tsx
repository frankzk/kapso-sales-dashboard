"use client";

// Paso 1 «Agregar pedidos» de la caja de Grupo GF, dentro del panel (MOM
// §29.14): el mismo gesto de Despacho del día acotado a ESTA caja. Cada
// escaneo toma el pedido si hace falta, lo mete en la caja de este motorizado
// y este día, y lo deja cotejado (`scanAssignToRider`); con 0179 también
// readmite un paquete que el motorizado rechazó. No hay motorizado que
// elegir: la caja ya es de uno. Antes aquí solo había un enlace a otra
// página.

import { useState, useTransition } from "react";
import { cn } from "@/components/ui";
import { ScanAction } from "@/components/scan-action";
import { moveManifestItem, type ScanAssignLine } from "@/app/dashboard/courier/actions";
import type { DispatchManifest } from "@/lib/dispatch-access";

function money(value: number): string {
  return `S/ ${value.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function presentation(l: ScanAssignLine, riderName: string): { text: string; textClass: string; rowClass: string } {
  switch (l.status) {
    case "asignado_cotejado":
      return { text: `En la caja de ${l.riderName ?? riderName}`, textClass: "text-emerald-700", rowClass: "bg-emerald-50/50" };
    case "ya_en_caja":
      return { text: "Ya estaba", textClass: "text-amber-700", rowClass: "bg-amber-50/40" };
    case "en_otra_caja":
      return { text: `En la caja de ${l.riderName ?? "otro"} → Mover`, textClass: "text-amber-700", rowClass: "bg-amber-50/40" };
    case "bloqueado_efectivo":
      return { text: "Límite de efectivo → Autorizar", textClass: "text-amber-700", rowClass: "bg-amber-50/40" };
    case "no_elegible":
      return { text: l.message ? `No elegible: ${l.message.replace(/\.$/, "")}` : "No elegible", textClass: "text-red-700", rowClass: "bg-red-50/50" };
    default:
      return { text: "QR desconocido", textClass: "text-red-700", rowClass: "bg-red-50/50" };
  }
}

export function GfBoxAddPackages({ manifest, canManage, refresh }: {
  manifest: DispatchManifest;
  canManage: boolean;
  refresh: (preferId?: string | null) => Promise<void>;
}) {
  const [lines, setLines] = useState<ScanAssignLine[]>([]);
  const [overrideCash, setOverrideCash] = useState(false);
  const [pending, start] = useTransition();
  const riderName = manifest.driver_name ?? "el motorizado";
  const riderId = manifest.rider_id ?? null;

  if (!canManage) return <p className="p-6 text-sm text-slate-600">Tu rol no organiza rutas: puedes mirar, no agregar.</p>;
  if (!riderId) return <p className="p-6 text-sm text-slate-600">Esta caja no tiene motorizado asignado; se agrega desde Despacho del día.</p>;
  if (manifest.state === "cancelled") return <p className="p-6 text-sm text-slate-600">Esta caja está cancelada.</p>;

  const push = (line: ScanAssignLine) => {
    setLines((cur) => [line, ...cur.filter((l) => l.code !== line.code)].slice(0, 30));
    if (line.status === "asignado_cotejado" || line.status === "ya_en_caja") void refresh(manifest.id);
  };

  return (
    <div className="space-y-3 p-4 sm:p-7">
      <ScanAction
        context="supervisor_asignacion"
        compact
        disabled={pending}
        assign={{ orgId: manifest.org_id, riderId, scheduledFor: manifest.route_date, overrideCash }}
        onResult={(r) => { if (r.line) push(r.line); }}
      />
      <p className="text-xs text-slate-500">Cada escaneo toma el pedido, lo pone en esta caja y lo deja cotejado.</p>
      {lines.length > 0 && (
        <ul className="max-h-72 divide-y divide-slate-100 overflow-auto rounded-xl border border-slate-200" aria-live="polite">
          {lines.map((l, i) => {
            const r = presentation(l, riderName);
            return (
              <li key={`${l.code}:${i}`} className={cn("flex items-center gap-2 px-3 py-1.5 text-sm", r.rowClass)} title={[l.message, l.cashWarning].filter(Boolean).join(" · ")}>
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-semibold text-slate-900">{l.orderName ?? l.code}</span>
                  <span className={cn("ml-2 text-xs font-medium", r.textClass)}>{r.text}</span>
                </span>
                {l.amount != null && <span className="shrink-0 text-xs tabular-nums text-slate-600">{money(l.amount)}</span>}
                {l.status === "en_otra_caja" && l.manifestId && l.shipmentId && (
                  <button type="button" disabled={pending} onClick={() => start(async () => {
                    const res = await moveManifestItem(manifest.org_id, l.manifestId!, l.shipmentId!, riderId, `Escaneado en la caja de ${riderName}`);
                    push({ ...l, status: res.error ? "no_elegible" : "asignado_cotejado", riderName, message: res.error ?? "" });
                  })} className="min-h-8 shrink-0 rounded-lg border border-amber-300 px-2 text-xs font-medium text-amber-800 disabled:opacity-50">Mover</button>
                )}
                {l.status === "bloqueado_efectivo" && !overrideCash && (
                  <button type="button" onClick={() => setOverrideCash(true)} title="Autoriza superar el límite de efectivo de la ruta y vuelve a escanear" className="min-h-8 shrink-0 rounded-lg border border-amber-300 px-2 text-xs font-medium text-amber-800">Autorizar</button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {overrideCash && <p className="text-xs text-amber-700">Límite de efectivo autorizado para esta caja.</p>}
    </div>
  );
}
