import { Suspense } from "react";
import { EmptyState } from "@/components/ui";
import { ReproLimaBoard } from "@/components/repro-lima-board";
import { createAdminSupabase } from "@/lib/db";
import { loadReproLima, requireReproLima } from "@/lib/repro-lima-access";
import { loadLimaOpenCounts } from "@/lib/repro-lima-todos-access";
import type { LimaOpenCounts } from "@/lib/repro-lima-todos";
import ReproLimaLoading from "./loading";

// «Repro Lima» (fase 1, entrega 1a; MOM §9.5): los clientes de Lima con
// entrega fallida. Entra quien llama a los clientes o despacha
// (`repro_lima.manage`) en las tiendas que tiene en Equipo (E36). La lista se lee con
// el cliente de servicio DESPUÉS de comprobar el permiso y las tiendas
// (`requireReproLima`); cada acción lo vuelve a comprobar. En paralelo se
// cuenta «Todos» (14-10-2026): los pedidos de Lima sin estado final, por etapa
// y subetapa del Master (lib/repro-lima-todos-access.ts). Esa lectura nunca
// lanza: si no se puede leer, la tarjeta no aparece y el resto sigue igual.

export const dynamic = "force-dynamic";

export default function ReproLimaPage() {
  return (
    <Suspense fallback={<ReproLimaLoading />}>
      <ReproLimaContent />
    </Suspense>
  );
}

async function ReproLimaContent() {
  const scope = await requireReproLima();
  if ("error" in scope) {
    return scope.reason === "permiso"
      ? <EmptyState title="Acceso restringido">{scope.error}</EmptyState>
      : <EmptyState title="No tienes tiendas asignadas">{scope.error}</EmptyState>;
  }
  let data: Awaited<ReturnType<typeof loadReproLima>>;
  let openCounts: LimaOpenCounts | null = null;
  try {
    [data, openCounts] = await Promise.all([
      loadReproLima(createAdminSupabase(), scope),
      loadLimaOpenCounts(createAdminSupabase(), scope),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return <EmptyState title="No pudimos cargar Repro Lima">{`${message} Recarga la página.`}</EmptyState>;
  }
  return <ReproLimaBoard data={data} openCounts={openCounts} />;
}
