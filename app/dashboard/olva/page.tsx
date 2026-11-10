import { redirect } from "next/navigation";

// «Cotejar Olva» vive dentro de «Pago de diferencia» desde el 10-11-2026 (MOM
// §12 y §44, owner: «mudarla entera»). Los enlaces viejos llevan allí.
export const dynamic = "force-dynamic";

export default async function OlvaCotejoPage({ searchParams }: { searchParams: Promise<{ vista?: string }> }) {
  const { vista } = await searchParams;
  redirect(`/dashboard/pedidos/pago-diferencia?vista=${vista === "correos" ? "correos" : "olva"}`);
}
