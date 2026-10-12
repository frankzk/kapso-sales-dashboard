import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createAdminSupabase } from "@/lib/db";
import { env } from "@/lib/env";
import { cotejarShalom } from "@/lib/shalom/account-cotejo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Cotejar Shalom (MOM §12), con reloj propio.
//
// POR QUÉ ES UN CRON APARTE. Nació como un paso de `shalom-reconcile`, detrás
// del rastreo y del relleno del OSE ID, con la hora límite contada desde que
// entraba la petición. El listado de la cuenta es lento —Shalom arma la cuenta
// entera para contestar cada página— y le llegaba lo que sobraba: el 10-10-2026
// a las 16:00 la petición entró a las 16:00:11 y el cotejo se rindió a las
// 16:03:31 sin haber recibido ni la primera página («No hubo respuesta de
// Shalom»), con 47 pedidos esperando. Es el mismo defecto que ya documentan
// master-reconcile y aliclik-close: un trabajo colgado del final de otro más
// largo no tiene garantía de ejecutarse. Aquí tiene la invocación entera.
//
// CUÁNDO. 8, 12, 16 y 20 h de Lima (`COTEJO_HORAS_LIMA`), en el minuto 10: lejos
// de las pasadas de `shalom-reconcile` (:00 y :30), que comparten con este el
// cupo de la API de Shalom.

/** Corte por reloj, por debajo de `maxDuration`: el corte tiene que ser nuestro. */
const BUDGET_MS = 270_000;

function secretEquals(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function authorized(req: NextRequest): boolean {
  const secret = env.cronSecret();
  const bearer = req.headers.get("authorization");
  if (bearer?.startsWith("Bearer ") && secretEquals(bearer.slice(7), secret)) return true;
  return secretEquals(req.nextUrl.searchParams.get("secret"), secret);
}

export async function GET(req: NextRequest) {
  const startedAt = Date.now();
  if (!authorized(req)) return new NextResponse("unauthorized", { status: 401 });
  if (!env.shalomConfigured()) {
    return NextResponse.json({ ok: true, skipped: "SHALOM_API_KEY no configurada" });
  }

  const admin = createAdminSupabase();
  const cotejo = await cotejarShalom(admin, { deadlineMs: startedAt + BUDGET_MS });
  // La respuesta del cron no se guarda en ningún sitio; la bitácora sí.
  console.info("[shalom-cotejo]", JSON.stringify(cotejo));

  return NextResponse.json({
    ok: cotejo.errores.length === 0,
    candidatos: cotejo.candidatos,
    vinculados: cotejo.vinculados,
    ambiguos: cotejo.ambiguos,
    sinPareja: cotejo.sinPareja,
    porTope: cotejo.porTope,
    sinCotejar: cotejo.sinCotejar,
    cuentas: cotejo.cuentas,
    detalle: cotejo.detalle,
    errores: cotejo.errores,
    ms: Date.now() - startedAt,
  });
}
