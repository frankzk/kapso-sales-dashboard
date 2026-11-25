import { EmptyState } from "@/components/ui";
import { ResendPanel } from "@/components/resend-panel";
import { loadResendPanel } from "@/lib/resend-marketing-server";

// Automatizaciones › Correo · Resend (MOM §46, 25-11-2026): la clave de Resend
// y la subida de los clientes que aceptaron publicidad en Shopify, por tienda y
// por su último pedido. Las campañas se arman y se envían en Resend. Entra
// quien tiene `automations.manage`.

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export default async function CorreoPage() {
  let data: Awaited<ReturnType<typeof loadResendPanel>>;
  try {
    data = await loadResendPanel();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return <EmptyState title="No pudimos cargar Correo · Resend">{`${message} Recarga la página.`}</EmptyState>;
  }
  if (data.denied) {
    return (
      <EmptyState title="Acceso restringido">
        Conectar Resend es del dueño, o de quien él autorice en Equipo («Automatizaciones»).
      </EmptyState>
    );
  }
  if (data.migrationMissing) {
    return (
      <EmptyState title="Falta la migración 0355">
        Hay que aplicar la migración 0355 (correo con Resend) en la base antes de conectar Resend.
      </EmptyState>
    );
  }
  return <ResendPanel orgs={data.orgs} writable={process.env.VERCEL_ENV === "production"} />;
}
