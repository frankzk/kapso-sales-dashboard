import Link from "next/link";
import { cn } from "@/components/ui";

export function CourierRouteNav({ current }: { current: "cajas" | "reparto" }) {
  return <header className="space-y-3">
    <Link href="/dashboard/courier" className="inline-flex min-h-12 items-center text-sm font-semibold text-brand-700">Grupo GF Courier</Link>
    <nav aria-label="Secciones de Grupo GF Courier" className="grid grid-cols-4 gap-1 border-b border-slate-200 text-center text-sm">
      {[["Disponibles", "available"], ["Tomados", "preparation"], ["Rutas", "routes"], ["Tarifario", "tariffs"]].map(([label, tab]) =>
        <Link key={tab} href={`/dashboard/courier?tab=${tab}`} aria-current={tab === "routes" ? "location" : undefined}
          className={cn("flex min-h-12 items-center justify-center rounded-t-lg px-1 font-medium focus-visible:ring-2 focus-visible:ring-brand-500", tab === "routes" ? "border-b-2 border-brand-600 text-brand-700" : "text-slate-600 hover:bg-slate-100")}>{label}</Link>)}
    </nav>
    <nav aria-label="Trabajo de rutas" className="flex flex-wrap gap-2 text-sm">
      <Link href="/dashboard/courier?tab=routes" aria-current={current === "cajas" ? "page" : undefined}
        className={cn("inline-flex min-h-12 items-center rounded-lg px-3 font-medium", current === "cajas" ? "bg-brand-50 text-brand-700" : "text-slate-600 hover:bg-slate-100")}>Cajas y cotejos</Link>
      <Link href="/dashboard/courier/reparto" aria-current={current === "reparto" ? "page" : undefined}
        className={cn("inline-flex min-h-12 items-center rounded-lg px-3 font-medium", current === "reparto" ? "bg-brand-50 text-brand-700" : "text-slate-600 hover:bg-slate-100")}>Reparto y cierre diario</Link>
    </nav>
  </header>;
}
