// El recruce de Yape (MOM §16.2, 13-11-2026): cada media hora, en los minutos
// 17 y 47 (`vercel.json`), los comprobantes «Pendiente de revisión» de los
// últimos días se cruzan con los movimientos de Yape YA GUARDADOS. Arregla el
// comprobante cargado después de que llegó el reporte de su hora, que antes no
// volvía a cruzarse (lib/yape-statement/rematch.ts).
//
//   ?dry=1   calcula y contesta, sin validar ni escribir nada.
//
// La línea de log lleva conteos y pedidos, nunca nombres de quien pagó.

import { NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase } from "@/lib/db";
import { internalAuthorized } from "@/lib/voice-recovery-server";
import { rematchStoredMovements } from "@/lib/yape-statement/rematch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  if (!internalAuthorized(req)) return new NextResponse("unauthorized", { status: 401 });
  const dryRun = req.nextUrl.searchParams.get("dry") === "1";
  const result = await rematchStoredMovements(createAdminSupabase(), { budgetMs: 100_000, dryRun });
  console.log(
    "[yape-rematch]",
    JSON.stringify({
      dryRun,
      pendientes: result.pendientes,
      cuentas: result.cuentas,
      movimientos: result.movimientos,
      validados: result.validados.map((v) => v.pedido),
      omitidos: result.omitidos,
      errores: result.errores.length,
    }),
  );
  return NextResponse.json(
    {
      ok: result.errores.length === 0,
      dryRun,
      pendientes: result.pendientes,
      cuentas: result.cuentas,
      validados: result.validados.map((v) => ({ pedido: v.pedido, tipo: v.tipo, monto: v.monto, hora: v.hora, regla: v.regla, clave: v.clave })),
      omitidos: result.omitidos,
      errores: result.errores,
    },
    { status: result.errores.length ? 502 : 200 },
  );
}
