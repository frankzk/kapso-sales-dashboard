import { redirect } from "next/navigation";
import { PaymentReviewBoard } from "@/components/payment-review-board";
import { PaymentReviewTabs } from "@/components/payment-review-tabs";
import { EmptyState } from "@/components/ui";
import { YapeStatementLog } from "@/components/yape-statement-log";
import { getPaymentReviewBoard } from "@/lib/payment-review-access";
import { getYapeStatementLog } from "@/lib/yape-statement/log-access";

export const dynamic = "force-dynamic";

export default async function PaymentReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ vista?: string }>;
}) {
  const { vista } = await searchParams;
  if (vista === "estado-yape") {
    let log;
    try {
      log = await getYapeStatementLog();
    } catch (error) {
      console.error("yape-statement-log-load-failed", error);
      throw error;
    }
    if (!log) redirect("/dashboard/pedidos");
    return <YapeStatementLog log={log} />;
  }

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
        <PaymentReviewTabs active="comprobantes" />
        <EmptyState title="No hay comprobantes por revisar">
          Los pagos nuevos aparecerán aquí apenas el equipo registre una constancia.
        </EmptyState>
      </div>
    );
  }
  return <PaymentReviewBoard data={data} />;
}
