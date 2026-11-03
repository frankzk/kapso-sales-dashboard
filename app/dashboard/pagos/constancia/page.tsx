// «Cargar constancia de courier» (03-11-2026): la constancia de cobro de una
// guía Tanders que llegó por WhatsApp. Ver lib/tanders/manual-collection.ts.

import { redirect } from "next/navigation";
import { ManualCollectionUpload } from "@/components/manual-collection-upload";
import { PaymentReviewTabs } from "@/components/payment-review-tabs";
import { getMasterPermissions } from "@/lib/permissions-access";
import { canValidatePaymentsAnywhere } from "@/lib/payment-review-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Leer la imagen es una llamada al modelo.
export const maxDuration = 60;

export default async function CourierCollectionPage() {
  const perms = await getMasterPermissions();
  // El mismo permiso que «Registrar un pago»: subir un comprobante no es
  // validarlo, eso lo sigue haciendo quien tiene «Validar pagos».
  if (!perms.can("shalom.register_payment")) redirect("/dashboard/pedidos");
  const canValidate = await canValidatePaymentsAnywhere();
  return (
    <div className="space-y-5">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.15em] text-brand-700">Finanzas</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-950">
          {canValidate ? "Validación de pagos" : "Cargar constancia de courier"}
        </h1>
      </div>
      {canValidate && <PaymentReviewTabs active="constancia" />}
      <ManualCollectionUpload />
    </div>
  );
}
