import { Skeleton } from "@/components/ui";

export default function Loading() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-7 w-48" />
      <div className="flex flex-wrap gap-1.5">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-28" />
        ))}
      </div>
      <div className="space-y-3 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        {Array.from({ length: 10 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-full" />
        ))}
      </div>
    </div>
  );
}
