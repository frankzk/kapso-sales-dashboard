"use client";

// Los filtros de la lista de importaciones (MOM §45): las píldoras de
// excepción (avisar a la bodega, atrasadas, sin novedades) y la píldora del
// proveedor. Todo vive en la URL (`?alerta=`, `?proveedor=`), así que filtrar
// es navegar: el servidor vuelve a leer con los mismos permisos.

import { useRouter } from "next/navigation";
import { AttentionPill } from "@/components/ops-ui";
import { ChoicePill } from "@/components/facet-pill";
import { IconAlert, IconClock, IconTruck } from "@/components/icons";
import { IMPORT_ALERT_FILTERS, IMPORT_KIND_FILTERS, comprasListHref, type ImportAlertFilter } from "@/components/compras/chrome";

const ICON = { avisar: IconTruck, atrasadas: IconClock, sin_novedades: IconAlert } as const;

export function AlertPills({
  tab,
  org,
  proveedor,
  alerta,
  tipo = null,
  counts,
}: {
  tab: string;
  org: string | null;
  proveedor: string | null;
  alerta: ImportAlertFilter | null;
  tipo?: string | null;
  counts: Record<ImportAlertFilter, number>;
}) {
  const router = useRouter();
  return (
    <div role="group" aria-label="Lo que pide atención" className="flex flex-wrap items-center gap-2">
      {IMPORT_ALERT_FILTERS.map((f) => {
        const active = alerta === f.id;
        return (
          <AttentionPill
            key={f.id}
            icon={ICON[f.id]}
            label={f.label}
            count={counts[f.id]}
            active={active}
            hint={f.hint}
            // Las alertas son de las activas: encender una lleva a «Activas».
            onClick={() =>
              router.push(comprasListHref({ tab: active ? tab : "activas", org, proveedor, tipo, alerta: active ? null : f.id }), { scroll: false })
            }
          />
        );
      })}
    </div>
  );
}

export function SupplierPill({
  tab,
  org,
  proveedor,
  alerta,
  tipo = null,
  options,
}: {
  tab: string;
  org: string | null;
  proveedor: string | null;
  alerta: string | null;
  tipo?: string | null;
  options: { value: string; label: string; count: number }[];
}) {
  const router = useRouter();
  if (!options.length) return null;
  return (
    <ChoicePill
      label="Proveedor"
      allLabel="Todos los proveedores"
      allValue=""
      options={options}
      value={proveedor ?? ""}
      onChange={(next) => router.push(comprasListHref({ tab, org, proveedor: next || null, alerta, tipo }), { scroll: false })}
    />
  );
}

/** El tipo de compra (MOM §45.12): importaciones o compras locales; vive en `?tipo=`. */
export function KindPill({
  tab,
  org,
  proveedor,
  alerta,
  tipo,
  counts,
}: {
  tab: string;
  org: string | null;
  proveedor: string | null;
  alerta: string | null;
  tipo: string | null;
  counts: Record<string, number>;
}) {
  const router = useRouter();
  return (
    <ChoicePill
      label="Tipo"
      allLabel="Todas las compras"
      allValue=""
      options={IMPORT_KIND_FILTERS.map((k) => ({ value: k.id, label: k.label, count: counts[k.id] ?? 0 }))}
      value={tipo ?? ""}
      onChange={(next) => router.push(comprasListHref({ tab, org, proveedor, alerta, tipo: next || null }), { scroll: false })}
    />
  );
}
