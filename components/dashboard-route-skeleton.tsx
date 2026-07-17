import { Skeleton } from "@/components/ui";

/** Stable, lightweight placeholder shared by Next's route boundary and the
 * optimistic sidebar transition. It reserves the destination layout instantly
 * instead of leaving the previous panel frozen while the RSC payload arrives. */
export function DashboardRouteSkeleton() {
  return (
    <div className="space-y-6" aria-label="Cargando panel">
      <div className="flex items-center justify-between gap-3">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-9 w-40" />
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <Skeleton className="h-64 lg:col-span-5" />
        <Skeleton className="h-64 lg:col-span-4" />
        <Skeleton className="h-64 lg:col-span-3" />
      </div>
    </div>
  );
}
