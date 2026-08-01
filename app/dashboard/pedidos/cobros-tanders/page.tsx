// Revisión en seco de los cobros Tanders.
//
// `maxDuration` alto porque cada guía es una llamada al modelo: veinte guías no
// caben en el timeout por defecto.

import { redirect } from "next/navigation";
import { getMasterPermissions } from "@/lib/permissions-access";
import { TandersCobros } from "@/components/tanders-cobros";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export default async function CobrosTandersPage() {
  const perms = await getMasterPermissions();
  // Mismo permiso que levanta un bloqueo: quien puede decidir sobre un cobro es
  // quien puede revisarlo.
  if (!perms.can("tanders.review_payment")) redirect("/dashboard/pedidos");
  return <TandersCobros />;
}
