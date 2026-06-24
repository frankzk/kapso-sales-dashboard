import { Skeleton } from "@/components/ui";

// Generic dashboard skeleton — shown instantly on navigation while the server
// component fetches. Also the fallback for child routes without their own.
export default function Loading() {
  return (
    <div className="space-y-6">
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
