import { Skeleton } from "@/components/ui";

export default function Loading() {
  return (
    <div className="flex flex-col gap-3 xl:h-[calc(100vh-3rem)] xl:overflow-hidden">
      <div className="flex items-center justify-between gap-3">
        <Skeleton className="h-7 w-64" />
        <Skeleton className="h-7 w-96" />
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-[74px]" />
        ))}
      </div>
      <div className="min-h-0 flex-1 space-y-3 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-full" />
        ))}
      </div>
    </div>
  );
}
