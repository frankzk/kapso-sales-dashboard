import { redirect } from "next/navigation";
import { PaymentReviewBoard } from "@/components/payment-review-board";
import { EmptyState } from "@/components/ui";
import { getPaymentReviewBoard } from "@/lib/payment-review-access";

export const dynamic = "force-dynamic";

export default async function PaymentReviewPage() {
  let data;
  try {
    data = await getPaymentReviewBoard();
  } catch (error) {
    console.error("payment-review-board-load-failed", error);
    throw error;
  }
  if (!data) redirect("/dashboard/pedidos");
  if (!data.counts.pending && !data.counts.observed && !data.counts.validated) {
    return (
      <div className="space-y-5">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.15em] text-brand-700">Finanzas</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-950">Validación de pagos</h1>
        </div>
        <EmptyState title="No hay comprobantes por revisar">
          Los pagos nuevos aparecerán aquí apenas el equipo registre una constancia.
        </EmptyState>
      </div>
    );
  }
  return <PaymentReviewBoard data={data} />;
}
