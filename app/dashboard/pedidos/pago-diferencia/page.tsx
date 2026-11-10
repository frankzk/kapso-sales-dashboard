import { Suspense } from "react";
import { EmptyState } from "@/components/ui";
import { PagoDiferenciaTray } from "@/components/pago-diferencia-tray";
import { createAdminSupabase } from "@/lib/db";
import { getAccessibleStores } from "@/lib/access";
import { loadPagoDiferencia } from "@/lib/pago-diferencia-access";
import type { PagoDiferenciaRow } from "@/lib/pago-diferencia";
import Loading from "./loading";

// «Pago de diferencia» (MOM §44): los pedidos de Agencia que esperan en la
// sucursal el pago de lo que falta, con la última gestión del equipo. La ve
// quien ve el Master, en las tiendas que tiene (`getAccessibleStores`); se lee
// con el cliente de servicio DESPUÉS de saber esas tiendas. Solo lectura: la
// gestión se registra en la ficha del pedido.

export const dynamic = "force-dynamic";

export default function PagoDiferenciaPage() {
  return (
    <Suspense fallback={<Loading />}>
      <PagoDiferenciaContent />
    </Suspense>
  );
}

async function PagoDiferenciaContent() {
  const stores = await getAccessibleStores();
  if (!stores.length) return <EmptyState title="No tienes tiendas asignadas" />;
  let rows: PagoDiferenciaRow[];
  try {
    rows = await loadPagoDiferencia(createAdminSupabase(), stores.map((s) => s.id));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return <EmptyState title="No pudimos cargar «Pago de diferencia»">{`${message} Recarga la página.`}</EmptyState>;
  }
  const storeNames = Object.fromEntries(stores.map((s) => [s.id, s.name]));
  return <PagoDiferenciaTray rows={rows} storeNames={storeNames} />;
}
