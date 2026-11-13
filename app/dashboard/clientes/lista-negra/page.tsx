import { EmptyState } from "@/components/ui";
import { ListaNegraPage } from "@/components/prepay-list-page";
import { loadPrepayListPage } from "@/lib/prepay-list-access";

// La «Lista negra» (MOM §41 y §41.11, owner 09-11-2026): las dos listas que
// frenan el contra entrega, en una página. Arriba la automática (cuántos,
// cuándo, el envío a cada tienda, la búsqueda por UN celular y las
// excepciones de Kapta, enmascaradas); abajo las altas a mano. La ve
// cualquiera que vea pedidos; cambiarla es de quien tiene
// `prepay_list.manage` (dueño y admin). Cada acción lo vuelve a pedir.

export const dynamic = "force-dynamic";

export default async function ListaNegraRoute() {
  let data: Awaited<ReturnType<typeof loadPrepayListPage>>;
  try {
    data = await loadPrepayListPage();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return <EmptyState title="No pudimos cargar la Lista negra">{`${message} Recarga la página.`}</EmptyState>;
  }
  if (data.denied) {
    return <EmptyState title="Acceso restringido">La Lista negra la ve el equipo de la organización.</EmptyState>;
  }
  if (!data.installed) {
    return <EmptyState title="Aún no está instalada">Falta aplicar la migración 0309 en la base de datos.</EmptyState>;
  }
  return <ListaNegraPage orgs={data.orgs} writable={process.env.VERCEL_ENV === "production"} />;
}
