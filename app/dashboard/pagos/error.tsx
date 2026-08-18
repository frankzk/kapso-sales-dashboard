"use client";

import { useEffect } from "react";
import Link from "next/link";

export default function PaymentReviewError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("payment-review-page-failed", error);
  }, [error]);

  return (
    <div className="mx-auto max-w-xl rounded-2xl border border-rose-200 bg-white p-6 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-[0.15em] text-rose-700">Finanzas</p>
      <h1 className="mt-2 text-xl font-semibold text-slate-950">No pudimos cargar los pagos</h1>
      <p className="mt-2 text-sm leading-relaxed text-slate-600">
        Ningún comprobante fue modificado. Puedes reintentar la consulta o volver al Master de Pedidos.
      </p>
      <div className="mt-5 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={reset}
          className="rounded-lg bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
        >
          Reintentar
        </button>
        <Link
          href="/dashboard/pedidos"
          className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
        >
          Volver a pedidos
        </Link>
      </div>
      {error.digest && (
        <p className="mt-4 text-xs text-slate-400">Referencia técnica: {error.digest}</p>
      )}
    </div>
  );
}
