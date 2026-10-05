import { Skeleton } from "@/components/ops-ui";

// La silueta de Repro Provincia (DESIGN.md, mundo de operación): título y
// acciones, el resumen plegado, seis tarjetas de vista, la fila de filtros y la
// tarjeta de la cola.
export default function Loading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Cargando Repro Provincia">
      <div className="space-y-2">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-5 w-96 max-w-full" />
      </div>
      <Skeleton className="h-12 w-full" />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-[62px]" />
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-28 rounded-full" />
        ))}
      </div>
      <div className="space-y-3 rounded-lg bg-white p-4 shadow-control ring-1 ring-line sm:p-5">
        {Array.from({ length: 10 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full rounded-md" />
        ))}
      </div>
    </div>
  );
}
