import { NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase } from "@/lib/db";
import { isInventoryAuthError, listInventoryWarehouses, type SwaypInventoryCreds } from "@/lib/swayp-inventory-api";
import { describirErrorSwayp } from "@/lib/swayp-inventory-sync";
import { guardarSesionSwayp, orgDeLlave, sincronizarSiToca } from "@/lib/swayp-inventory-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Recibe la sesión del panel de Swayp desde la extensión de Chrome «Kapta ·
// Swayp» (MOM, «El mismo conteo, leído por API»). La extensión la lee del
// navegador de una persona que YA inició sesión en Swayp —con su reCAPTCHA—, y
// Kapta la reutiliza para leer inventario hasta que vence. Aquí:
//   1. la llave de la extensión identifica a la organización;
//   2. se comprueba con Swayp que la sesión sirve (una lectura de bodegas);
//   3. se guarda cifrada y, si toca (≥ 20 h desde el último sync bueno),
//      se sincroniza en el acto.

function texto(v: unknown, max = 200): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

export async function POST(req: NextRequest) {
  const admin = createAdminSupabase();
  const orgId = await orgDeLlave(admin, req.headers.get("x-kapta-key") ?? "");
  if (!orgId) {
    return NextResponse.json(
      { ok: false, mensaje: "La llave de la extensión no es válida. Descárgala de nuevo desde Stock Swayp." },
      { status: 401 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, mensaje: "Cuerpo inválido." }, { status: 400 });
  }
  const creds: SwaypInventoryCreds = {
    token: texto(body.token, 8000).replace(/^bearer\s+/i, ""),
    email: texto(body.email),
    user: texto(body.nit),
    idCompany: texto(body.idCompany),
    country: "PE",
  };
  if (!creds.token || !creds.email || !creds.user || !creds.idCompany) {
    return NextResponse.json({ ok: false, mensaje: "Falta la sesión de Swayp (token, correo, RUC o empresa)." }, { status: 400 });
  }

  // Si la organización tiene una empresa de Swayp configurada, la sesión tiene
  // que ser de esa empresa: una persona con acceso a otra cuenta de Swayp no
  // debe pisar el stock de esta.
  const empresa = (process.env.SWAYP_INVENTORY_COMPANY_ID ?? "").trim();
  const orgEmpresa = (process.env.SWAYP_INVENTORY_ORG_ID ?? "").trim();
  if (empresa && orgEmpresa === orgId && creds.idCompany !== empresa) {
    return NextResponse.json(
      { ok: false, mensaje: "Esta sesión de Swayp es de otra empresa; no se guardó." },
      { status: 409 },
    );
  }

  try {
    await listInventoryWarehouses(creds);
  } catch (e) {
    return NextResponse.json(
      { ok: false, mensaje: `Swayp no aceptó la sesión (${describirErrorSwayp(e)}).` },
      { status: isInventoryAuthError(e) ? 401 : 502 },
    );
  }

  const vence = await guardarSesionSwayp(admin, { orgId, creds, source: "extension", userId: null });
  const r = await sincronizarSiToca(admin, orgId);
  const sync =
    r.estado === "corrio"
      ? "error" in r.resultado
        ? `El sync falló: ${r.resultado.error}`
        : `Stock sincronizado (${r.resultado.ciudades.length} ciudades con cambios).`
      : r.estado === "al_dia"
        ? "El stock ya se sincronizó hoy."
        : "No se pudo sincronizar.";
  return NextResponse.json({ ok: true, vence: vence.toISOString(), mensaje: `Sesión recibida. ${sync}` });
}
