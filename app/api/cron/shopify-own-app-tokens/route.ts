// Renovación del acceso de las tiendas con «app propia» de Shopify (0271,
// owner 23-10-2026, MOM §36.3).
//
// El token del client credentials grant dura ~24 h. Cada hora (en el minuto
// 23, que no comparte con ningún otro barrido) este cron renueva el de cada
// tienda ACTIVA con `shopify_app = 'propia'` cuyo token vence en las próximas
// 12 horas o no lo tiene. Así cada token se renueva cuando le quedan unas 12
// horas (en la práctica, uno nuevo cada ~12 h), y si Shopify falla quedan unas
// 12 pasadas más antes de que venza: una caída de unas horas no deja a nadie
// sin acceso. Al usarlo, `getStoreCreds` lo renueva igual si le quedan menos
// de 15 minutos.
//
// A QUIÉN NO TOCA. La consulta filtra `shopify_app = 'propia'` y la renovación
// vuelve a comprobarlo antes de escribir: Kenku y Aurela ('interna') y las
// tiendas de la app de clientes no se leen, ni se renuevan, ni se escriben. Una
// tienda deshabilitada (por ejemplo, porque desinstaló la app y llegó el
// `app/uninstalled`) tampoco: el cron no la resucita.
//
// Sin la 0271 (el código puede llegar antes que ella, que se aplica a mano)
// responde 200 con `skipped: "sin_migracion"`, como el de comprobantes.
//
// La línea de log lleva ids de tienda, conteos y códigos de motivo: nunca el
// token, el Client secret ni el dominio.

import { NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase } from "@/lib/db";
import {
  isOwnAppMigrationMissing,
  OWN_APP,
  OWN_APP_RENEW_BEFORE_MS,
  renewOwnAppToken,
} from "@/lib/shopify-own-app";
import { internalAuthorized } from "@/lib/voice-recovery-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export interface OwnAppTokensReport {
  at: string;
  /** Tiendas activas con app propia cuyo token vence en menos de 12 horas o no lo tienen. */
  due: number;
  renewed: number;
  /** Otro proceso ya la había renovado: el token guardado aún servía. */
  vigentes: number;
  /** Renovadas con permisos de menos (el token se guardó igual). */
  sinPermisos: string[];
  failed: { storeId: string; reason: string }[];
}

async function run(req: NextRequest) {
  // Vercel Cron manda `Authorization: Bearer <CRON_SECRET>`.
  if (!internalAuthorized(req)) return new NextResponse("unauthorized", { status: 401 });

  const admin = createAdminSupabase();
  const now = new Date();
  // Lo que vence antes de `cutoff`, o no tiene token o fecha. El token cifrado
  // no se lee aquí: solo se filtra por si está.
  const cutoff = new Date(now.getTime() + OWN_APP_RENEW_BEFORE_MS).toISOString();
  const { data, error } = await admin
    .from("stores")
    .select("id,shopify_token_expires_at")
    .eq("shopify_app", OWN_APP)
    .eq("status", "active")
    .or(`shopify_token_enc.is.null,shopify_token_expires_at.is.null,shopify_token_expires_at.lte.${cutoff}`);
  if (error) {
    if (isOwnAppMigrationMissing(error)) {
      const skipped = { ok: true, skipped: "sin_migracion" as const };
      console.log(`[shopify-own-app] ${JSON.stringify(skipped)}`);
      return NextResponse.json(skipped);
    }
    console.log(`[shopify-own-app] ${JSON.stringify({ error: "No se pudieron leer las tiendas." })}`);
    return NextResponse.json({ ok: false, error: "No se pudieron leer las tiendas." }, { status: 500 });
  }

  const due = (data ?? []) as { id: string; shopify_token_expires_at: string | null }[];
  const report: OwnAppTokensReport = {
    at: now.toISOString(),
    due: due.length,
    renewed: 0,
    vigentes: 0,
    sinPermisos: [],
    failed: [],
  };

  // Una por una: son pocas, y así una tienda lenta no le quita el turno a otra.
  for (const row of due) {
    try {
      const r = await renewOwnAppToken(admin, row.id, { now, skipIfValidForMs: OWN_APP_RENEW_BEFORE_MS });
      if (!r.ok) {
        report.failed.push({ storeId: row.id, reason: r.reason });
        continue;
      }
      if (r.renewed) report.renewed += 1;
      else report.vigentes += 1;
      if (r.missingScopes.length) report.sinPermisos.push(row.id);
    } catch {
      report.failed.push({ storeId: row.id, reason: "excepcion" });
    }
  }

  console.log(`[shopify-own-app] ${JSON.stringify(report)}`);
  // Como el de comprobantes: si una tienda no se pudo renovar, el cron se ve rojo.
  const failed = report.failed.length > 0;
  return NextResponse.json({ ok: !failed, ...report }, { status: failed ? 502 : 200 });
}

export const GET = run;
export const POST = run;
