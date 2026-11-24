import { NextResponse } from "next/server";
import { publishedBuild } from "@/lib/app-version";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// La versión publicada de Kapta, para el aviso «Kapta tiene mejoras nuevas» (lib/app-version.ts). Solo el commit de
// la compilación: nada del usuario ni de la tienda.
export function GET() {
  return NextResponse.json({ build: publishedBuild() }, { headers: { "Cache-Control": "no-store, max-age=0" } });
}
