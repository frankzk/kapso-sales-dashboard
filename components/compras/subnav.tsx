// La sub-navegación de Compras (MOM §45.7): Importaciones · Proveedores ·
// Reportes. Solo muestra lo que la persona puede abrir: Importaciones y
// Proveedores con «Compras» o «Montos de compras»; Reportes solo con «Montos de
// compras». En el teléfono se desliza de lado si no entra.

import Link from "next/link";
import { cn } from "@/components/ui";

export type ComprasSection = "importaciones" | "proveedores" | "reportes";

export const COMPRAS_SECTIONS: { id: ComprasSection; label: string; href: string; money: boolean }[] = [
  { id: "importaciones", label: "Importaciones", href: "/dashboard/compras", money: false },
  { id: "proveedores", label: "Proveedores", href: "/dashboard/compras/proveedores", money: false },
  { id: "reportes", label: "Reportes", href: "/dashboard/compras/reportes", money: true },
];

/** Las secciones que ve: Reportes solo con «Montos de compras». */
export function visibleComprasSections(perms: { canManage: boolean; canMoney: boolean }) {
  if (!perms.canManage && !perms.canMoney) return [];
  return COMPRAS_SECTIONS.filter((s) => !s.money || perms.canMoney);
}

export function ComprasSubnav({
  current,
  perms,
  orgId,
  multiOrg,
}: {
  current: ComprasSection;
  perms: { canManage: boolean; canMoney: boolean };
  orgId: string;
  /** Con más de una organización, el enlace lleva `?org=`. */
  multiOrg: boolean;
}) {
  const sections = visibleComprasSections(perms);
  if (sections.length < 2) return null;
  return (
    <nav aria-label="Secciones de Compras" className="-mb-px flex gap-5 overflow-x-auto border-b border-slate-200">
      {sections.map((s) => (
        <Link
          key={s.id}
          href={multiOrg ? `${s.href}?org=${orgId}` : s.href}
          aria-current={s.id === current ? "page" : undefined}
          className={cn(
            "inline-flex min-h-11 shrink-0 items-center border-b-2 px-0.5 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-inset",
            s.id === current ? "border-brand-600 text-brand-700" : "border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-900",
          )}
        >
          {s.label}
        </Link>
      ))}
    </nav>
  );
}
