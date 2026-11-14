// La sub-navegación de Compras (MOM §45.7): Importaciones · Proveedores ·
// Reportes. Solo muestra lo que la persona puede abrir: Importaciones con
// cualquiera de los tres permisos; Proveedores con «Compras» o «Montos de
// compras» (no con solo «Recepción de compras», MOM §45.11); Reportes solo con
// «Montos de compras». En el teléfono se desliza de lado si no entra.

import Link from "next/link";
import { cn } from "@/components/ui";

export type ComprasSection = "importaciones" | "proveedores" | "reportes";

export const COMPRAS_SECTIONS: { id: ComprasSection; label: string; href: string; money: boolean; receive: boolean }[] = [
  { id: "importaciones", label: "Importaciones", href: "/dashboard/compras", money: false, receive: true },
  { id: "proveedores", label: "Proveedores", href: "/dashboard/compras/proveedores", money: false, receive: false },
  { id: "reportes", label: "Reportes", href: "/dashboard/compras/reportes", money: true, receive: false },
];

type SubnavPerms = { canManage: boolean; canMoney: boolean; canReceive?: boolean };

/** Las secciones que ve: Reportes solo con «Montos de compras»; con solo «Recepción», Importaciones. */
export function visibleComprasSections(perms: SubnavPerms) {
  if (!perms.canManage && !perms.canMoney) return perms.canReceive ? COMPRAS_SECTIONS.filter((s) => s.receive) : [];
  return COMPRAS_SECTIONS.filter((s) => !s.money || perms.canMoney);
}

export function ComprasSubnav({
  current,
  perms,
  orgId,
  multiOrg,
}: {
  current: ComprasSection;
  perms: SubnavPerms;
  orgId: string;
  /** Con más de una organización, el enlace lleva `?org=`. */
  multiOrg: boolean;
}) {
  const sections = visibleComprasSections(perms);
  if (sections.length < 2) return null;
  return (
    <nav aria-label="Secciones de Compras" className="flex gap-6 overflow-x-auto border-b border-line">
      {sections.map((s) => (
        <Link
          key={s.id}
          href={multiOrg ? `${s.href}?org=${orgId}` : s.href}
          aria-current={s.id === current ? "page" : undefined}
          className={cn(
            // Pestaña subrayada (DESIGN.md › Navigation): 48 px de objetivo, la
            // activa en `brand-700` con su barra de 2 px sobre la hairline.
            "-mb-px inline-flex min-h-12 shrink-0 items-center border-b-2 text-[13px] font-semibold transition-colors duration-150 lg:text-sm",
            s.id === current ? "border-brand-600 text-brand-700" : "border-transparent text-ink-500 hover:text-ink-900",
          )}
        >
          {s.label}
        </Link>
      ))}
    </nav>
  );
}
