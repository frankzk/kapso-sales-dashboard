import { Suspense } from "react";
import { EmptyState } from "@/components/ui";
import { PagoDiferenciaTray } from "@/components/pago-diferencia-tray";
import { PagoDiferenciaPage, pagoDiferenciaView, type PagoDiferenciaView } from "@/components/pago-diferencia-page";
import { OLVA_CORREOS_DESCRIPTION, OLVA_COTEJO_DESCRIPTION, OlvaCotejoSection, OlvaEmailsSection } from "@/components/olva-sections";
import { createAdminSupabase } from "@/lib/db";
import { getAccessibleStores } from "@/lib/access";
import { loadPagoDiferencia } from "@/lib/pago-diferencia-access";
import { countOlvaCotejoPending } from "@/lib/olva/cotejo-pending";
import type { PagoDiferenciaRow } from "@/lib/pago-diferencia";
import Loading from "./loading";

// «Pago de diferencia» (MOM §44): los pedidos de Agencia a los que les falta
// pagar la diferencia, con la última gestión del equipo, y desde el 10-11-2026
// «Cotejar Olva» (MOM §12) en dos vistas más: sin tracking, un pedido de Olva
// no llega a la bandeja. La ve quien ve el Master, en las tiendas que tiene
// (`getAccessibleStores`); se lee con el cliente de servicio DESPUÉS de saber
// esas tiendas. Vincular un envío de Olva pide «Gestionar pedidos».

export const dynamic = "force-dynamic";
// «Cotejar ahora» entra al portal de Olva y coteja en la misma petición.
export const maxDuration = 120;

const BANDEJA_DESCRIPTION =
  "Pedidos de Agencia a los que les falta pagar la diferencia. Abre el pedido y registra cada gestión en «Comentario», con la captura como constancia: aquí se ve quién la hizo y cuándo.";

export default function PagoDiferenciaRoute({ searchParams }: { searchParams: Promise<{ vista?: string }> }) {
  return (
    <Suspense fallback={<Loading />}>
      <PagoDiferenciaContent searchParams={searchParams} />
    </Suspense>
  );
}

async function PagoDiferenciaContent({ searchParams }: { searchParams: Promise<{ vista?: string }> }) {
  const [{ vista }, stores] = await Promise.all([searchParams, getAccessibleStores()]);
  if (!stores.length) return <EmptyState title="No tienes tiendas asignadas" />;
  const view = pagoDiferenciaView(vista);
  const admin = createAdminSupabase();
  const orgIds = [...new Set(stores.map((s) => s.org_id))];
  // El número de «Cotejar Olva» sale en las tres vistas. Un fallo aquí no
  // tumba la página: sin número, la pestaña sigue.
  const olvaPending = await countOlvaCotejoPending(admin, orgIds).catch(() => 0);

  if (view !== "bandeja") {
    return (
      <PagoDiferenciaPage
        active={view}
        description={view === "olva" ? OLVA_COTEJO_DESCRIPTION : OLVA_CORREOS_DESCRIPTION}
        counts={{ olva: olvaPending }}
      >
        {view === "olva" ? <OlvaCotejoSection stores={stores} /> : <OlvaEmailsSection stores={stores} />}
      </PagoDiferenciaPage>
    );
  }

  let rows: PagoDiferenciaRow[];
  try {
    rows = await loadPagoDiferencia(admin, stores.map((s) => s.id));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return (
      <PagoDiferenciaPage active={view} description={BANDEJA_DESCRIPTION} counts={{ olva: olvaPending }}>
        <EmptyState title="No pudimos cargar la bandeja">{`${message} Recarga la página.`}</EmptyState>
      </PagoDiferenciaPage>
    );
  }
  const storeNames = Object.fromEntries(stores.map((s) => [s.id, s.name]));
  const counts: Partial<Record<PagoDiferenciaView, number>> = { bandeja: rows.length, olva: olvaPending };
  return (
    <PagoDiferenciaPage active={view} description={BANDEJA_DESCRIPTION} counts={counts}>
      <PagoDiferenciaTray rows={rows} storeNames={storeNames} />
    </PagoDiferenciaPage>
  );
}
