import { Skeleton } from "@/components/ops-ui";

// La silueta de Repro Lima (DESIGN.md, mundo de operación): título y corte,
// las cuatro tarjetas de lista y «Todos» (en el teléfono, una fila entera
// debajo de las cuatro; desde 1024 px, la quinta columna) y la tarjeta de
// trabajo. Propia, porque pedidos/loading.tsx es la del Master.
export default function Loading() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Cargando Repro Lima">
      <div className="space-y-2">
        <Skeleton className="h-9 w-48" />
        <Skeleton className="h-5 w-96 max-w-full" />
        <Skeleton className="h-5 w-64 max-w-full" />
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className={i === 4 ? "h-[62px] col-span-2 sm:col-span-4 lg:col-span-1" : "h-[62px]"} />
        ))}
      </div>
      <div className="space-y-2 rounded-lg bg-white p-4 ring-1 ring-line" aria-hidden="true">
        {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-9 w-full" />)}
      </div>
      <div className="space-y-3 rounded-lg bg-white p-4 shadow-control ring-1 ring-line sm:p-5">
        <Skeleton className="h-8 w-full sm:w-72" />
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full rounded-md" />
        ))}
      </div>
    </div>
  );
}
