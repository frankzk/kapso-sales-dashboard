import { Skeleton } from "@/components/ops-ui";

// La silueta de «Pago de diferencia» (MOM §44): título, las cuatro tarjetas de
// filtro y la lista.
export default function Loading() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Cargando Pago de diferencia">
      <div className="space-y-2">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-5 w-[36rem] max-w-full" />
        <Skeleton className="h-5 w-48" />
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-[62px]" />
        ))}
      </div>
      <Skeleton className="h-96 w-full" />
    </div>
  );
}
