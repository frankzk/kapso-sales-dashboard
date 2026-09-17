import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/access";
import { getMyRider } from "@/lib/routes-access";
import { limaDate } from "@/lib/sheets/resolver";
import { getRiderSheet, loadRiderDay, loadRiderManifestPackages, loadRiderVocabulary } from "@/lib/sheets/rider-access";
import { RiderCuaderno } from "@/components/rider-cuaderno";

export const dynamic = "force-dynamic";

/**
 * Mi cuaderno (MOM §30.9): la hoja de Reparto propio del motorizado, un día a
 * la vez. Vive bajo /reparto a propósito: sin barra lateral, para el teléfono.
 * Lo que se ve lo acota la RLS de 0171 a su propia hoja.
 */
export default async function CuadernoPage({ searchParams }: { searchParams: Promise<{ fecha?: string }> }) {
  const [sp, user] = await Promise.all([searchParams, getCurrentUser()]);
  if (!user) redirect("/login?redirectedFrom=/reparto/cuaderno");
  const rider = await getMyRider();
  const today = limaDate(new Date().toISOString()) ?? new Date().toISOString().slice(0, 10);
  const fecha = sp.fecha && /^\d{4}-\d{2}-\d{2}$/.test(sp.fecha) ? sp.fecha : today;

  if (!rider) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center p-6">
        <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center">
          <h1 className="text-lg font-semibold text-slate-900">Mi cuaderno</h1>
          <p className="mt-2 text-sm text-slate-500">
            Tu usuario <strong className="text-slate-700">{user.email}</strong> no tiene ficha de motorizado. Pide que la vinculen desde Liquidaciones.
          </p>
        </div>
      </main>
    );
  }
  const sheet = await getRiderSheet(rider.id);
  if (!sheet) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center p-6">
        <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center">
          <h1 className="text-lg font-semibold text-slate-900">Mi cuaderno</h1>
          <p className="mt-2 text-sm text-slate-500">
            Hola {rider.full_name}. Todavía no tienes hoja de reparto en Liquidaciones 2: pide que la creen con «Crear hojas que falten».
          </p>
        </div>
      </main>
    );
  }

  const [day, vocabulary, manifest] = await Promise.all([
    loadRiderDay(sheet, fecha),
    loadRiderVocabulary(sheet),
    loadRiderManifestPackages(sheet.org_id, rider.id, fecha),
  ]);

  return (
    <RiderCuaderno
      riderName={rider.full_name}
      today={today}
      day={day}
      vocabulary={vocabulary}
      manifestCount={manifest.length}
    />
  );
}
