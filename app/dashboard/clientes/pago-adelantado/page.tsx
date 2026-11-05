import { EmptyState } from "@/components/ui";
import { PrepayListPage } from "@/components/prepay-list-page";
import { loadPrepayListPage } from "@/lib/prepay-list-access";

// «Lista de pago adelantado» (la lista negra, MOM §41, owner 05-11-2026): los
// celulares que pagan el total por adelantado, por organización. La ve
// cualquiera que vea pedidos; agregar y quitar (con motivo) es de quien tiene
// `prepay_list.manage` (dueño y admin). Cada acción lo vuelve a pedir.

export const dynamic = "force-dynamic";

export default async function PagoAdelantadoPage() {
  let data: Awaited<ReturnType<typeof loadPrepayListPage>>;
  try {
    data = await loadPrepayListPage();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return <EmptyState title="No pudimos cargar la lista">{`${message} Recarga la página.`}</EmptyState>;
  }
  if (data.denied) {
    return <EmptyState title="Acceso restringido">La lista de pago adelantado la ve el equipo de la organización.</EmptyState>;
  }
  if (!data.installed) {
    return <EmptyState title="Aún no está instalada">Falta aplicar la migración 0309 en la base de datos.</EmptyState>;
  }
  return <PrepayListPage orgs={data.orgs} writable={process.env.VERCEL_ENV === "production"} />;
}
