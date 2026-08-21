import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createAdminSupabase } from "@/lib/db";
import { reprocessObservedVouchers } from "@/lib/voucher-reprocess";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Relee los comprobantes observados sin necesitar una máquina con el repo.
//
// POR QUÉ ES UNA RUTA Y NO SOLO UN SCRIPT. El script existe y funciona, pero
// exige clone + Node + dependencias + `.env.production.local` con la clave de
// servicio. Quien tiene que disparar esto trabaja por el navegador, y montar
// todo eso para un pase de 44 comprobantes es más trabajo que el pase.
//
// NO ESTÁ EN vercel.json A PROPÓSITO: no es un trabajo periódico, es un pase
// que se dispara cuando se arregla el lector. Vive bajo `/api/cron` porque
// comparte la autorización por `CRON_SECRET` con el resto, no porque tenga
// horario.
//
// EL SIMULACRO ES EL MODO POR DEFECTO. Sin `?escribir=1` calcula todo y no
// toca la base. Escribir es lo que hay que pedir expresamente, no al revés:
// esto reescribe la auditoría de visión de cada comprobante y rellena campos
// de pagos, y el informe del simulacro es lo que deja verlo antes.
//
// LA REGLA DE QUÉ SE RELLENA NO VIVE AQUÍ. Está entera en
// `lib/voucher-reprocess.ts`, compartida con el script. Este fichero solo
// decide CUÁNDO, CON CUÁNTO TIEMPO y SI ESCRIBE.

/** Corte por reloj, por debajo de `maxDuration`: el corte tiene que ser nuestro. */
const BUDGET_MS = 240_000;

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

async function run(req: NextRequest) {
  if (!authorized(req)) return new NextResponse("unauthorized", { status: 401 });

  const params = req.nextUrl.searchParams;
  // Escribir se pide; no se hereda de un descuido. Cualquier otro valor de
  // `escribir` es simulacro, que es el lado seguro en el que equivocarse.
  const write = params.get("escribir") === "1";
  const rawLimit = Number(params.get("limit"));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : undefined;

  try {
    const report = await reprocessObservedVouchers(createAdminSupabase(), {
      write,
      limit,
      deadline: Date.now() + BUDGET_MS,
    });
    return NextResponse.json({ ok: true, ...report });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

export async function GET(req: NextRequest) {
  return run(req);
}
export async function POST(req: NextRequest) {
  return run(req);
}
