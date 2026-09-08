// Entrega del tratamiento de v2: la lista de leads por llamar, por Telegram.
//
// POR QUÉ NO VA EN LA PANTALLA. Se probaron las dos formas de señalarlo en la
// cola y las dos salieron al revés: el empujón al principio de la lista (mediana
// 47 min hasta la llamada contra 17 del control) y el aviso 🧪 (23,5% de leads
// llamados alguna vez contra 34,3%, p ≈ 0,04). Marcar un lead como "de la
// prueba" hace que se salte. Ver lib/coverage-push.ts.
//
// EL RITMO ES PARTE DEL TRATAMIENTO. Cinco tandas cada dos horas, a las 8, 10,
// 12, 14 y 16 de Lima (13,15,17,19,21 UTC — Perú es UTC-5 fijo, sin horario de
// verano). Dentro de esa franja ocurre el 89,3% de los toques humanos, y la
// última deja dos horas de trabajo por delante. Con ~51 leads tratados al día
// salen ~10 por tanda: una lista que se trabaja de una sentada, que es lo que
// hay que conseguir. Una de cincuenta se ignora entera — el mismo fracaso que
// las señales visuales, solo que en otro canal.

import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createAdminSupabase } from "@/lib/db";
import { getStoreCreds } from "@/lib/ingest";
import {
  PUSH_BATCH,
  PUSH_MIN_BATCH,
  formatCoverageMessage,
  pendingCoverageLeads,
  recordCoveragePush,
} from "@/lib/coverage-push";
import { sendTelegramToAll } from "@/lib/telegram";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Constant-time equality (length-gated) to avoid leaking the secret via timing. */
function secretEquals(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function authorized(req: NextRequest): boolean {
  const secret = env.cronSecret();
  // Vercel Cron manda `Authorization: Bearer <CRON_SECRET>` solo.
  const bearer = req.headers.get("authorization");
  if (bearer?.startsWith("Bearer ") && secretEquals(bearer.slice(7), secret)) return true;
  return secretEquals(req.nextUrl.searchParams.get("secret"), secret);
}

async function run(req: NextRequest) {
  if (!authorized(req)) return new NextResponse("unauthorized", { status: 401 });
  const admin = createAdminSupabase();
  const siteUrl = env.siteUrl();
  const now = Date.now();

  // `?dry=1` arma el mensaje y no lo manda ni lo apunta. Sirve para ver qué
  // saldría sin gastar una tanda: como cada lead sale UNA sola vez, un envío de
  // prueba de verdad quemaría leads del experimento.
  const dry = req.nextUrl.searchParams.get("dry") === "1";
  const single = req.nextUrl.searchParams.get("storeId");

  let storeIds: string[];
  if (single) {
    storeIds = [single];
  } else {
    const { data, error } = await admin.from("stores").select("id").eq("status", "active");
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    storeIds = (data ?? []).map((s: { id: string }) => s.id);
  }

  const reports = [];
  for (const id of storeIds) {
    try {
      const pendientes = await pendingCoverageLeads(admin, id, PUSH_BATCH);
      if (pendientes.length === 0) {
        reports.push({ storeId: id, pendientes: 0, enviados: 0 });
        continue;
      }
      // Por debajo del mínimo no se manda: dos mensajes al día con un lead cada
      // uno enseñan a ignorar el canal. Se acumulan hasta que valga la pena
      // mirar — y como no se apuntan, salen enteros en la siguiente pasada.
      if (pendientes.length < PUSH_MIN_BATCH && !dry) {
        reports.push({ storeId: id, pendientes: pendientes.length, enviados: 0, esperando: true });
        continue;
      }
      const creds = await getStoreCreds(id, admin);
      if (!creds?.telegram_bot_token || !creds.telegram_chat_id) {
        reports.push({ storeId: id, pendientes: pendientes.length, skipped: "sin Telegram configurado" });
        continue;
      }
      const text = formatCoverageMessage(creds.name, pendientes, siteUrl, now);
      if (dry) {
        reports.push({ storeId: id, pendientes: pendientes.length, enviados: 0, dry: text });
        continue;
      }
      const res = await sendTelegramToAll(creds.telegram_bot_token, creds.telegram_chat_id, text);
      const failed = res.results.filter((r) => !r.ok);
      // SE APUNTA DESPUÉS DE ENVIAR Y SOLO SI SALIÓ. Apuntar primero perdería
      // estos leads para siempre si el envío fallara —no volverían a salir— y el
      // tratamiento se evaporaría en silencio, que es justo como v1 se fue al
      // traste sin que nadie lo notara. Al revés el peor caso es repetir una
      // lista: visible y recuperable.
      const apuntados = res.sent > 0 ? await recordCoveragePush(admin, id, pendientes.map((l) => l.id)) : 0;
      reports.push({
        storeId: id,
        pendientes: pendientes.length,
        enviados: apuntados,
        recipients: res.total,
        error: failed.length ? failed.map((r) => `${r.chatId}: ${r.error}`).join("; ") : undefined,
      });
    } catch (e) {
      reports.push({ storeId: id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return NextResponse.json({ ok: true, stores: storeIds.length, reports });
}

export async function GET(req: NextRequest) {
  return run(req);
}
export async function POST(req: NextRequest) {
  return run(req);
}
