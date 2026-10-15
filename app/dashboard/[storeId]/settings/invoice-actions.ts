"use server";

// Ajustes → «Boletas y facturas» (MOM §35.2, §35.4, §35.7, §35.8).
//
// Tres acciones: guardar un RUC (alta o cambios), probar su conexión con
// SimpleFact y asignar el RUC a una cuenta de cobro de la tienda. Van aparte de
// actions.ts porque piden un permiso más: además de «Administrar tiendas», el de
// «Boletas y facturas», que solo da el owner. Pasar un RUC a Manual o a Real o
// darle una cuenta decide qué empresa paga el impuesto de qué venta, y una
// boleta que llegó a SUNAT no se borra.
//
// Lo que estas acciones cuidan, y por qué:
//
//  · EL TOKEN NO SALE. Se cifra aquí (`encrypt`) y se descifra aquí, solo para
//    probar la conexión. Ninguna respuesta lo lleva: ni el formulario, que lo
//    deja en blanco, ni el resultado de la prueba.
//  · «EMITIR DESDE» NO VA HACIA ATRÁS. Una fecha nueva en el pasado se guarda
//    como ahora, y al cambiar de modo, si quedó atrás, se mueve a ahora. La base
//    hace lo segundo por su cuenta (`invoice_issuers_touch`, 0257); aquí se hace
//    también para poder decirlo en pantalla.
//  · MANUAL Y REAL SE GANAN CON UNA PRUEBA. Los dos emiten boletas reales: en
//    Real el barrido, en Manual una persona con «Emitir esta boleta» (owner,
//    15-10-2026). La base lo exige (`invoice_issuers_real_ready`, 0257 y 0261)
//    y aquí se explica qué falta antes de llegar a chocar con ella.

import type { SupabaseClient } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { hasOrgPermission } from "@/lib/permissions-access";
import { decrypt, encrypt } from "@/lib/crypto";
import { limaDateTimeFromInput } from "@/lib/repro-lima";
import {
  INVOICE_DAILY_LIMIT_MAX,
  INVOICE_DAILY_LIMIT_MIN,
  INVOICE_MODES,
  INVOICE_MODE_LABEL,
  isValidRuc,
  normalizeSubdomain,
  type InvoiceMode,
} from "@/lib/invoicing/rules";

/**
 * Los modos que emiten boletas reales y por eso piden token, «Emitir desde» y
 * una prueba de conexión que leyó el RUC declarado: Real (el barrido) y Manual
 * (una persona, pedido por pedido). Lo que baja uno baja el otro (0261).
 */
const EMITTING_MODES: ReadonlySet<InvoiceMode> = new Set<InvoiceMode>(["manual", "real"]);
import { testSimplefactConnection } from "@/lib/invoicing/simplefact";
import type { SettingsState } from "./actions";

const SIN_PERMISO = "Sin permiso: «Boletas y facturas» lo configura quien tiene ese permiso (solo lo da el owner).";
const LECTURA_FALLIDA = "No se pudo leer el RUC: intenta de nuevo.";
const RUC_AJENO = "Ese RUC no es de la organización de esta tienda.";

/**
 * La puerta de las tres acciones: la tienda existe, hay sesión, y quien pide
 * tiene «Administrar tiendas» Y «Boletas y facturas» en la organización de la
 * tienda (MOM §35.7). Un permiso de otra empresa no vale aquí.
 */
async function requireInvoiceAdmin(
  storeId: string,
): Promise<{ admin: SupabaseClient; orgId: string; userId: string } | null> {
  if (!storeId) return null;
  const admin = createAdminSupabase();
  const { data: store } = await admin.from("stores").select("id, org_id").eq("id", storeId).maybeSingle();
  if (!store) return null;

  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) redirect("/login");
  const [storesManage, invoicesManage] = await Promise.all([
    hasOrgPermission(store.org_id, "stores.manage"),
    hasOrgPermission(store.org_id, "invoices.manage"),
  ]);
  if (!storesManage || !invoicesManage) return null;
  return { admin, orgId: store.org_id, userId: user.id };
}

function settingsPath(storeId: string): string {
  return `/dashboard/${storeId}/settings`;
}

/**
 * Un token de SimpleFact es una sola palabra de ASCII visible. Uno con espacios
 * o saltos de línea es un pegado roto: guardarlo solo daría «Token rechazado» al
 * probar, sin decir por qué.
 */
const TOKEN_RE = /^[\x21-\x7e]+$/;
const TOKEN_MAX = 2_000;

/** Lo que la base dijo que no, en palabras de quien configura. */
function issuerWriteError(error: { code?: string; message?: string }, mode: InvoiceMode): string {
  const message = error.message ?? "";
  if (error.code === "23505") return "Ese RUC ya está dado de alta.";
  if (error.code === "23514") {
    if (message.includes("invoice_issuers_real_ready")) {
      return `Para pasar a ${EMITTING_MODES.has(mode) ? INVOICE_MODE_LABEL[mode] : "Real"} hacen falta el token, «Emitir desde» y una prueba de conexión que leyó este mismo RUC.`;
    }
    // Sin la 0261 la base no conoce «Manual»: no es que el modo no exista.
    if (message.includes("invoice_issuers_mode_check") && mode === "manual") {
      return "La base todavía no admite el modo Manual: falta aplicar la migración 0261.";
    }
    if (message.includes("invoice_issuers_ruc_check")) return "El RUC no es válido.";
    if (message.includes("invoice_issuers_legal_name_check")) return "La razón social va de 1 a 200 caracteres.";
    if (message.includes("invoice_issuers_simplefact_subdomain_check")) return "El subdominio de SimpleFact no es válido.";
    if (message.includes("invoice_issuers_daily_limit_check")) {
      return `El tope diario va de ${INVOICE_DAILY_LIMIT_MIN} a ${INVOICE_DAILY_LIMIT_MAX}.`;
    }
    if (message.includes("invoice_issuers_mode_check")) return "Ese modo no existe.";
    return "La base rechazó los datos del RUC: revisa los campos.";
  }
  return `No se pudo guardar el RUC: ${message}`;
}

interface StoredIssuer {
  id: string;
  ruc: string;
  simplefact_subdomain: string;
  mode: InvoiceMode;
  emit_from: string | null;
  checked_ruc: string | null;
}

/**
 * Da de alta un RUC o cambia uno de la organización (MOM §35.2, §35.4, §35.8).
 *
 * Campos: `issuer_id` (vacío = alta), `ruc`, `legal_name`, `subdomain`, `token`
 * (vacío = conservar el guardado), `mode`, `emit_from` (`datetime-local` en hora
 * de Lima) y `daily_limit`.
 */
export async function saveInvoiceIssuer(
  storeId: string,
  _prev: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const ctx = await requireInvoiceAdmin(storeId);
  if (!ctx) return { error: SIN_PERMISO };

  const text = (k: string) => String(formData.get(k) ?? "").trim();
  const issuerId = text("issuer_id");
  const ruc = text("ruc");
  const legalName = text("legal_name").replace(/\s+/g, " ");
  const subdomain = normalizeSubdomain(text("subdomain"));
  const token = text("token");
  const mode = text("mode") as InvoiceMode;
  const emitFromRaw = text("emit_from");
  const limitRaw = text("daily_limit");

  if (!isValidRuc(ruc)) {
    return {
      error: "El RUC no es válido: son 11 dígitos que empiezan por 10, 15, 16, 17 o 20, con su dígito verificador.",
    };
  }
  if (!legalName || legalName.length > 200) return { error: "Falta la razón social (máx. 200 caracteres)." };
  if (!subdomain) {
    return { error: "El subdominio de SimpleFact no es válido: es lo que va antes de .simplefact.pe (p. ej. grupogf)." };
  }
  if (token && (!TOKEN_RE.test(token) || token.length > TOKEN_MAX)) {
    return { error: "El token va en una sola línea, sin espacios: vuelve a copiarlo de SimpleFact." };
  }
  if (!(INVOICE_MODES as readonly string[]).includes(mode)) {
    return { error: "Elige un modo: Apagado, Simulación, Manual o Real." };
  }
  const dailyLimit = Number(limitRaw);
  if (!/^\d+$/.test(limitRaw) || dailyLimit < INVOICE_DAILY_LIMIT_MIN || dailyLimit > INVOICE_DAILY_LIMIT_MAX) {
    return { error: `El tope diario es un número entero de ${INVOICE_DAILY_LIMIT_MIN} a ${INVOICE_DAILY_LIMIT_MAX}.` };
  }
  let submittedFrom: number | null = null;
  if (emitFromRaw) {
    const iso = limaDateTimeFromInput(emitFromRaw);
    const t = iso ? Date.parse(iso) : Number.NaN;
    if (!Number.isFinite(t)) return { error: "«Emitir desde» no es una fecha válida." };
    submittedFrom = t;
  }

  // Lo guardado: para saber qué cambia. El token no se trae; solo si hay uno.
  let current: StoredIssuer | null = null;
  let hasToken = false;
  if (issuerId) {
    const [row, withToken] = await Promise.all([
      ctx.admin
        .from("invoice_issuers")
        .select("id,ruc,simplefact_subdomain,mode,emit_from,checked_ruc")
        .eq("id", issuerId)
        .eq("org_id", ctx.orgId)
        .maybeSingle(),
      ctx.admin
        .from("invoice_issuers")
        .select("id")
        .eq("id", issuerId)
        .eq("org_id", ctx.orgId)
        .not("token_enc", "is", null)
        .maybeSingle(),
    ]);
    // Falla cerrada: sin saber qué hay guardado no se decide si puede ir a Real.
    if (row.error || withToken.error) return { error: LECTURA_FALLIDA };
    if (!row.data) return { error: RUC_AJENO };
    current = row.data as StoredIssuer;
    hasToken = Boolean(withToken.data);
  }

  // ── Manual y Real se ganan con una prueba (MOM §35.8) ─────────────────────
  // Un token, RUC o subdominio nuevo invalida la prueba al guardarse (0257,
  // 0261): no se puede pasar a Manual ni a Real en el mismo guardado que los
  // cambia. Manual pide exactamente lo mismo que Real, con las mismas frases:
  // también manda boletas a SUNAT.
  if (EMITTING_MODES.has(mode) && current?.mode !== mode) {
    const target = INVOICE_MODE_LABEL[mode];
    if (!current) {
      return {
        error: `Un RUC nuevo empieza en Apagado o Simulación: guarda su token y prueba la conexión antes de pasar a ${target}.`,
      };
    }
    if (token) return { error: `Guarda primero el token nuevo y prueba la conexión antes de pasar a ${target}.` };
    if (current.ruc !== ruc || current.simplefact_subdomain !== subdomain) {
      return { error: `Cambiaste el RUC o el subdominio: guarda y prueba la conexión antes de pasar a ${target}.` };
    }
    if (!hasToken) return { error: `Falta el token de SimpleFact: ponlo y prueba la conexión antes de pasar a ${target}.` };
    if (current.checked_ruc !== ruc) {
      return {
        error: current.checked_ruc
          ? `Prueba la conexión antes de pasar a ${target}: la última prueba leyó el RUC ${current.checked_ruc}, no el ${ruc}.`
          : `Prueba la conexión antes de pasar a ${target}: todavía no hay una prueba que haya leído este RUC.`,
      };
    }
  }

  // ── «Emitir desde» (MOM §35.4) ────────────────────────────────────────────
  const now = Date.now();
  const notes: string[] = [];
  const storedFrom = current?.emit_from ? Date.parse(current.emit_from) : null;
  // El formulario reenvía lo guardado, al minuto. Eso no es una fecha nueva:
  // «corregirla» a ahora la movería hacia adelante en cada guardado del tope, y
  // lo pagado entre medio se quedaría sin boleta sin que nadie lo decidiera.
  const untouched =
    submittedFrom !== null &&
    storedFrom !== null &&
    Number.isFinite(storedFrom) &&
    Math.floor(submittedFrom / 60_000) === Math.floor(storedFrom / 60_000);
  // undefined = no se toca la columna.
  let nextFrom: number | null | undefined;
  if (submittedFrom === null) nextFrom = null;
  else if (untouched) nextFrom = undefined;
  else if (submittedFrom < now) {
    nextFrom = now;
    notes.push("«Emitir desde» no puede quedar en el pasado: se guardó con la hora de ahora.");
  } else nextFrom = submittedFrom;

  // Al cambiar de modo (salvo a Apagado), si quedó atrás o vacía, se mueve a
  // ahora: la fecha de la simulación de ayer no habilita, al pasar a Real, las
  // boletas de todo lo pagado desde entonces.
  const modeChanged = !current || current.mode !== mode;
  const effectiveFrom = nextFrom === undefined ? storedFrom : nextFrom;
  if (mode !== "apagado" && modeChanged && (effectiveFrom === null || effectiveFrom < now)) {
    nextFrom = now;
    if (!notes.length) notes.push("Al cambiar de modo, «Emitir desde» quedó en ahora: ningún RUC emite hacia atrás.");
  }
  const finalFrom = nextFrom === undefined ? storedFrom : nextFrom;
  if (mode !== "apagado" && finalFrom === null) {
    return { error: "Pon «Emitir desde»: sin fecha de inicio el RUC no emite." };
  }

  const patch: Record<string, unknown> = {
    ruc,
    legal_name: legalName,
    simplefact_subdomain: subdomain,
    mode,
    daily_limit: dailyLimit,
  };
  if (nextFrom !== undefined) patch.emit_from = nextFrom === null ? null : new Date(nextFrom).toISOString();
  if (token) {
    try {
      patch.token_enc = encrypt(token);
    } catch {
      // Sin el mensaje de la excepción: no hace falta y no se arriesga nada.
      return { error: "No se pudo cifrar el token: falta la clave de cifrado del servidor." };
    }
  }

  const write = current
    ? ctx.admin
        .from("invoice_issuers")
        .update(patch)
        .eq("id", current.id)
        .eq("org_id", ctx.orgId)
        .select("id,mode")
        .maybeSingle()
    : ctx.admin
        .from("invoice_issuers")
        .insert({ org_id: ctx.orgId, ...patch })
        .select("id,mode")
        .maybeSingle();
  const { data: saved, error } = await write;
  if (error) return { error: issuerWriteError(error, mode) };
  if (!saved) return { error: RUC_AJENO };

  // Lo que quedó lo dice la base: un token, RUC o subdominio nuevo baja un RUC
  // en Manual o en Real a Simulación (0257, 0261), y eso se tiene que ver.
  const savedMode = (saved as { mode: InvoiceMode }).mode;
  const credentialsChanged = Boolean(token) || (current !== null && (current.ruc !== ruc || current.simplefact_subdomain !== subdomain));
  if (current && EMITTING_MODES.has(mode) && savedMode !== mode) {
    notes.unshift(
      `${token ? "El token cambió" : "Cambió el RUC o el subdominio"}: el RUC bajó a ${INVOICE_MODE_LABEL[savedMode]} hasta que vuelvas a probar la conexión.`,
    );
  } else if (current && credentialsChanged) {
    notes.unshift("Cambió la conexión: vuelve a pulsar «Probar conexión».");
  } else if (!current && token) {
    notes.unshift("Token guardado cifrado: pulsa «Probar conexión».");
  }
  // Recién pasado a Manual: qué cambia, para que nadie espere que el barrido
  // emita. Lo dice solo si la base lo dejó en Manual.
  if (savedMode === "manual" && current?.mode !== "manual") {
    notes.push("En Manual el barrido solo simula: cada boleta real se emite con «Emitir esta boleta» en el pedido.");
  }

  revalidatePath(settingsPath(storeId));
  const head = current
    ? `RUC ${ruc} guardado ✓ · ${INVOICE_MODE_LABEL[savedMode] ?? savedMode}`
    : `RUC ${ruc} dado de alta ✓ · ${INVOICE_MODE_LABEL[savedMode] ?? savedMode}`;
  return { notice: [head, ...notes].join("\n") };
}

/**
 * «Probar conexión» (MOM §35.4): lee las ventas de la cuenta de SimpleFact y
 * saca el RUC del nombre de sus archivos. Guarda qué RUC leyó, cuándo y el
 * error, que es lo que la base mira para dejar pasar a Real. Solo lee: no crea
 * ninguna venta.
 */
export async function testInvoiceIssuer(storeId: string, issuerId: string): Promise<SettingsState> {
  const ctx = await requireInvoiceAdmin(storeId);
  if (!ctx) return { error: SIN_PERMISO };
  const id = String(issuerId ?? "").trim();
  if (!id) return { error: "Falta el RUC a probar." };

  const { data, error } = await ctx.admin
    .from("invoice_issuers")
    .select("id,ruc,simplefact_subdomain,mode,token_enc,updated_at")
    .eq("id", id)
    .eq("org_id", ctx.orgId)
    .maybeSingle();
  if (error) return { error: LECTURA_FALLIDA };
  const row = data as {
    id: string;
    ruc: string;
    simplefact_subdomain: string;
    mode: InvoiceMode;
    token_enc: string | null;
    updated_at: string;
  } | null;
  if (!row) return { error: RUC_AJENO };
  if (!row.token_enc) return { error: "Primero guarda el token de SimpleFact de este RUC." };

  const result = await probe(row.simplefact_subdomain, row.token_enc, row.ruc);

  // Se guarda SOLO si el RUC no cambió mientras se probaba (`updated_at` es su
  // versión: la base la mueve en cada cambio). Si en esos segundos alguien pegó
  // otro token, esta prueba es del anterior y daría por bueno uno sin probar.
  const { data: saved, error: writeError } = await ctx.admin
    .from("invoice_issuers")
    .update({
      checked_at: new Date().toISOString(),
      checked_ruc: result.ok ? result.ruc : (result.ruc ?? null),
      check_error: result.ok ? null : result.error,
    })
    .eq("id", row.id)
    .eq("org_id", ctx.orgId)
    .eq("updated_at", row.updated_at)
    .select("mode")
    .maybeSingle();
  if (writeError) return { error: `Se probó, pero no se pudo guardar el resultado: ${writeError.message}` };
  if (!saved) return { error: "El RUC cambió mientras se probaba: vuelve a probar la conexión." };

  revalidatePath(settingsPath(storeId));
  if (!result.ok) {
    // Un RUC en Real o en Manual cuya prueba ya no confirma su RUC baja a
    // Simulación (0257, 0261).
    const demoted = EMITTING_MODES.has(row.mode) && (saved as { mode: InvoiceMode }).mode !== row.mode;
    const message = /[.!?]$/.test(result.error) ? result.error : `${result.error}.`;
    return {
      error: demoted ? `${message}\nEl RUC bajó a Simulación hasta que una prueba confirme el RUC.` : message,
    };
  }
  const ventas = result.sales === 1 ? "1 venta leída" : `${result.sales} ventas leídas`;
  return { notice: `Conexión correcta: RUC ${result.ruc}, ${ventas}.` };
}

/**
 * Descifra el token y prueba la conexión. El token en claro vive solo dentro de
 * esta función: no se devuelve ni entra en ningún mensaje.
 */
async function probe(
  subdomain: string,
  tokenEnc: string,
  ruc: string,
): Promise<Awaited<ReturnType<typeof testSimplefactConnection>>> {
  let token: string;
  try {
    token = decrypt(tokenEnc);
  } catch {
    return { ok: false, error: "No se pudo descifrar el token guardado: vuelve a pegarlo.", ruc: null };
  }
  try {
    return await testSimplefactConnection({ subdomain, token }, ruc);
  } catch {
    // El cliente no lanza; si algo lo hace, es que no se pudo confirmar el RUC.
    return { ok: false, error: "No se pudo probar la conexión.", ruc: null };
  }
}

/**
 * El RUC de una cuenta de cobro de esta tienda (MOM §35.2). `''` = «Sin
 * comprobante»: el dinero que entra ahí no es de ninguna empresa emisora y no
 * emite. Asignar no emite nada pagado antes de «Emitir desde» del RUC.
 */
export async function setAccountInvoiceIssuer(
  storeId: string,
  accountId: string,
  issuerId: string,
): Promise<SettingsState> {
  const ctx = await requireInvoiceAdmin(storeId);
  if (!ctx) return { error: SIN_PERMISO };
  const account = String(accountId ?? "").trim();
  const issuer = String(issuerId ?? "").trim();
  if (!account) return { error: "Falta la cuenta." };

  // La base también lo exige (trigger de 0257); aquí se dice con palabras.
  let issuerLabel: string | null = null;
  if (issuer) {
    const { data, error } = await ctx.admin
      .from("invoice_issuers")
      .select("id,ruc,legal_name")
      .eq("id", issuer)
      .eq("org_id", ctx.orgId)
      .maybeSingle();
    if (error) return { error: LECTURA_FALLIDA };
    if (!data) return { error: RUC_AJENO };
    const row = data as { ruc: string; legal_name: string };
    issuerLabel = `${row.legal_name} (RUC ${row.ruc})`;
  }

  const { data: row, error } = await ctx.admin
    .from("store_collection_accounts")
    .update({ invoice_issuer_id: issuer || null, updated_at: new Date().toISOString() })
    .eq("id", account)
    .eq("store_id", storeId)
    .select("id,label")
    .maybeSingle();
  if (error) {
    return { error: (error.message ?? "").includes("organización") ? RUC_AJENO : `No se pudo asignar: ${error.message}` };
  }
  if (!row) return { error: "No se encontró esa cuenta en esta tienda." };

  revalidatePath(settingsPath(storeId));
  const label = (row as { label: string }).label;
  return { notice: issuerLabel ? `«${label}» emite con ${issuerLabel} ✓` : `«${label}» queda sin comprobante ✓` };
}
