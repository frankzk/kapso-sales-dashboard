import { Suspense } from "react";
import { EmptyState } from "@/components/ui";
import { AutomationsPanel } from "@/components/automations-panel";
import { loadAutomationsPanel } from "@/lib/automations-access";
import AutomationsLoading from "./loading";

// «Automatizaciones» (MOM §40, 04-11-2026): un solo lugar para encender y
// apagar lo que crea guías, llama o escribe a clientas sin persona, y los
// reintentos Aliclik automáticos de Lima (Apagado / Simulación / Activo).
// Entra quien tiene `automations.manage` (el owner, o a quien él se lo dé en
// Equipo); el menú lo oculta a los demás y cada acción lo vuelve a pedir.

export const dynamic = "force-dynamic";
// «Simular ahora» corre dentro de esta página (su acción de servidor) y cotiza
// en Aliclik pedido por pedido. Sin esto la función se cortaba al tope por
// omisión de Vercel; la vista previa se para sola a los 200 s
// (`PREVIEW_TIME_BUDGET_MS`) y dice que se cortó.
export const maxDuration = 300;

export default function AutomatizacionesPage() {
  return (
    <Suspense fallback={<AutomationsLoading />}>
      <AutomatizacionesContent />
    </Suspense>
  );
}

async function AutomatizacionesContent() {
  let data: Awaited<ReturnType<typeof loadAutomationsPanel>>;
  try {
    data = await loadAutomationsPanel();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return <EmptyState title="No pudimos cargar Automatizaciones">{`${message} Recarga la página.`}</EmptyState>;
  }
  if (data.denied) {
    return (
      <EmptyState title="Acceso restringido">
        Encender y apagar automatizaciones es del dueño, o de quien él lo autorice en Equipo.
      </EmptyState>
    );
  }
  // Solo en producción se guardan cambios (las acciones lo vuelven a mirar):
  // en un preview faltan las credenciales de Aliclik y de Swayp.
  return <AutomationsPanel orgs={data.orgs} writable={process.env.VERCEL_ENV === "production"} />;
}
