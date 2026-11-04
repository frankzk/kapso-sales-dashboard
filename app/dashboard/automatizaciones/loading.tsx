import { Skeleton } from "@/components/ops-ui";

// La silueta de Automatizaciones (DESIGN.md › «Página de ajustes»): título y
// su línea, el índice desde `xl` y, a su lado, el primer grupo con la matriz
// de los reintentos y una tarjeta de interruptores.
export default function Loading() {
  return (
    <div className="mx-auto max-w-[76rem] space-y-8" aria-busy="true" aria-label="Cargando Automatizaciones">
      <div className="space-y-2">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-5 w-[36rem] max-w-full" />
      </div>
      <div className="xl:grid xl:grid-cols-[13rem_minmax(0,1fr)] xl:gap-10">
        <div className="hidden space-y-2 xl:block" aria-hidden="true">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-7 w-full rounded-md" />
          ))}
        </div>
        <div className="space-y-6">
          <Skeleton className="h-7 w-72" />
          <div className="space-y-3 rounded-lg bg-white p-4 shadow-control ring-1 ring-line sm:p-5">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-14 w-full rounded-md" />
            ))}
          </div>
          <div className="space-y-3 rounded-lg bg-white p-4 shadow-control ring-1 ring-line sm:p-5">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full rounded-md" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
