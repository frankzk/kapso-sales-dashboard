import Link from "next/link";
import { cn } from "@/components/ui";

export type PaymentReviewView = "comprobantes" | "estado-yape";

const TABS: { id: PaymentReviewView; label: string; href: string }[] = [
  { id: "comprobantes", label: "Comprobantes", href: "/dashboard/pagos" },
  // Cada reporte de Yape recibido por correo y lo que validó (MOM §16.2).
  { id: "estado-yape", label: "Estado de cuenta Yape", href: "/dashboard/pagos?vista=estado-yape" },
];

export function PaymentReviewTabs({ active }: { active: PaymentReviewView }) {
  return (
    <nav aria-label="Vistas de validación de pagos" className="flex gap-1 overflow-x-auto border-b border-slate-200">
      {TABS.map((tab) => (
        <Link
          key={tab.id}
          href={tab.href}
          aria-current={tab.id === active ? "page" : undefined}
          className={cn(
            "-mb-px shrink-0 border-b-2 px-3 py-2 text-sm font-semibold transition-colors",
            tab.id === active
              ? "border-brand-700 text-brand-700"
              : "border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800",
          )}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
