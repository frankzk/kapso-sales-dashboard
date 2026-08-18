import { Skeleton } from "@/components/ui";

export default function PaymentReviewLoading() {
  return (
    <div className="space-y-5" aria-label="Cargando validación de pagos">
      <div className="space-y-2">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-[34rem] max-w-full" />
      </div>
      <div className="grid gap-4 xl:grid-cols-3">
        {[0, 1, 2].map((column) => (
          <div key={column} className="space-y-3 rounded-2xl bg-slate-100 p-3">
            <Skeleton className="h-8 w-36" />
            <Skeleton className="h-[28rem] w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
