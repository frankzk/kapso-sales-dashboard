// Entrega del tratamiento de v2: la lista de leads que hay que llamar, por
// Telegram, como trabajo normal.
//
// POR QUÉ NO ES UNA SEÑAL EN LA COLA. Se probaron dos y las dos salieron al
// revés: el empujón al principio de la lista (mediana 47 min hasta la llamada
// contra 17 del control) y el aviso 🧪 (23,5% de leads llamados contra 34,3%,
// p ≈ 0,04). Marcar un lead como "de la prueba" hace que se salte — se lee como
// "esto no es un pedido de verdad".
//
// Lo único que funcionó en toda la serie fue pedirle a una persona que llamara
// una lista: cumplió el 81% contra el 31% del resto del equipo. Esto es eso,
// pero con la lista sorteada por el sistema en vez de elegida a dedo.
//
// SIN DECIR QUE ES UNA PRUEBA. El mensaje pide llamar, y ya. Quien tiene que
// saber que hay un experimento es el análisis, no la asesora — y decírselo es
// justamente lo que rompió v1.
//
// CON ENLACE A LA FICHA, y esto no es comodidad: si la asesora llama desde su
// móvil sin pasar por Kapta, no queda fila en `lead_calls` y el lead cuenta como
// NO llamado. El experimento mediría cero cumplimiento con el trabajo hecho. El
// enlace `?open=` la lleva al lead dentro de la app, donde registrar la gestión
// es el camino natural.

import type { createAdminSupabase } from "@/lib/db";
import { ACTIVE_EXPERIMENT } from "@/lib/lead-experiment";
import { escapeHtml } from "@/lib/telegram";

type Admin = ReturnType<typeof createAdminSupabase>;

/** Cuántos leads entran en un mensaje. Con ~51 tratados al día y un envío cada
 *  dos horas salen ~8 por tanda: una lista que se puede trabajar de una
 *  sentada. Una de cincuenta se ignora entera, que es el fracaso que ya vimos
 *  con las señales visuales. */
export const PUSH_BATCH = 12;

/** No se manda nada por debajo de esto: dos mensajes al día con un lead cada uno
 *  enseñan a ignorar el canal. Se acumulan hasta que valga la pena mirar. */
export const PUSH_MIN_BATCH = 3;

export interface PendingLead {
  id: string;
  name: string | null;
  phone: string | null;
  first_seen_at: string | null;
}

/** Antigüedad en horas, redondeada, para el mensaje. PURA. */
export function ageLabel(firstSeenAt: string | null | undefined, nowMs: number): string {
  if (!firstSeenAt) return "";
  const t = Date.parse(firstSeenAt);
  if (!Number.isFinite(t)) return "";
  const h = (nowMs - t) / 3_600_000;
  // El suelo de 1 minuto cubre también la fecha del FUTURO (un desfase de reloj
  // en el ingreso): una edad negativa es `< 1`, así que cae en esta rama y sale
  // "1 min" en vez de "-37 min". No hace falta un `Math.max(0)` antes — lo tuvo,
  // y era código muerto que parecía estar defendiendo algo.
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 48) return `${Math.round(h)} h`;
  return `${Math.round(h / 24)} d`;
}

/**
 * El texto que se manda. PURO.
 *
 * Sin la palabra "prueba" ni nada que lo señale como experimento (ver cabecera).
 * El teléfono va en el texto para poder marcar sin entrar, pero el enlace va
 * primero porque es el camino que deja rastro.
 *
 * TODO LO QUE VIENE DE LA BASE VA ESCAPADO. `sendTelegramMessage` manda con
 * `parse_mode: "HTML"`, y los nombres los escribe el cliente por WhatsApp: uno
 * con `<` o `&` no rompe su línea, rompe el MENSAJE ENTERO —Telegram devuelve
 * 400 y no manda nada—, así que un solo nombre raro dejaría a toda la tanda sin
 * llamar y el experimento contaría esa cobertura como incumplimiento.
 */
export function formatCoverageMessage(
  tienda: string,
  leads: readonly PendingLead[],
  siteUrl: string,
  nowMs: number,
): string {
  const filas = leads.map((l) => {
    const quien = (l.name ?? "").trim() || l.phone || "sin nombre";
    const edad = ageLabel(l.first_seen_at, nowMs);
    const url = `${siteUrl}/dashboard/leads?open=${l.id}`;
    return `• ${escapeHtml(quien)}${edad ? ` · ${edad}` : ""}\n  ${escapeHtml(url)}`;
  });
  return (
    `📞 ${escapeHtml(tienda)} · ${leads.length} ${leads.length === 1 ? "lead por llamar" : "leads por llamar"}\n\n` +
    filas.join("\n") +
    `\n\nÁbrelos desde el enlace para que quede registrada la gestión.`
  );
}

export interface PushReport {
  pendientes: number;
  enviados: number;
}

/**
 * Leads del brazo de tratamiento que siguen sin llamar y no han salido todavía,
 * más antiguos primero.
 *
 * "Sin llamar" se mira DOS veces y a propósito. En `lead_calls` con los tipos de
 * PERSONA, que es lo mismo que mira el análisis —un drip o un winback no es una
 * llamada, y el 51% de esa tabla es `kind='system'`—, y en `status = 'nuevo'`,
 * que es lo que la cola entiende por "sin llamar". No sobra ninguna: la primera
 * no ve al lead que alguien trabajó sin registrar la gestión, y la segunda no ve
 * a quien tiene una llamada registrada pero sigue en `nuevo`. Además `status`
 * saca de la lista al que ya está cerrado —vendido, cancelado, lista negra—, al
 * que no hay que llamar por mucho que le tocara el tratamiento. Ese seguirá
 * contando como NO llamado en el análisis, que es lo correcto: el tratamiento no
 * se pudo administrar.
 */
export async function pendingCoverageLeads(
  admin: Admin,
  storeId: string,
  limit: number = PUSH_BATCH,
  experiment: string = ACTIVE_EXPERIMENT,
): Promise<PendingLead[]> {
  // LOS 400 MÁS RECIENTES, no los 400 más antiguos, y la diferencia es que el
  // envío siga vivo dentro de un mes. Los ya empujados se descartan aquí abajo,
  // en memoria, pero SIGUEN OCUPANDO SITIO en esta ventana: pidiendo los más
  // antiguos, a los ~8 días (~51 tratados/día) los 400 huecos serían todos leads
  // ya entregados y los nuevos no entrarían nunca. El envío se apagaría solo, sin
  // error, y el experimento se quedaría sin tratamiento — otra vez.
  //
  // Al revés se cura solo: un lead sale en la tanda siguiente a su asignación
  // —dos horas— y 400 huecos son ocho días de holgura por si el cron se cae.
  const { data: filas } = await admin
    .from("lead_experiments")
    .select("lead_id")
    .eq("experiment", experiment)
    .eq("arm", "tratamiento")
    .eq("store_id", storeId)
    .order("assigned_at", { ascending: false })
    .limit(400);
  const ids = ((filas ?? []) as { lead_id: string }[]).map((r) => r.lead_id);
  if (ids.length === 0) return [];

  // Quién ya salió en una lista. Sin esto un lead que nadie llama volvería a
  // salir cada dos horas para siempre: no es insistir, es enseñar a ignorar el
  // canal — y el canal es el tratamiento entero.
  const { data: empujados } = await admin
    .from("lead_coverage_pushes")
    .select("lead_id")
    .eq("experiment", experiment)
    .in("lead_id", ids);
  const yaEmpujados = new Set(((empujados ?? []) as { lead_id: string }[]).map((r) => r.lead_id));

  // Quién ya recibió un toque humano. Se resuelve en una consulta sobre el
  // conjunto, no lead a lead.
  const { data: tocados } = await admin
    .from("lead_calls")
    .select("lead_id")
    .in("lead_id", ids)
    .in("kind", ["call", "message", "sale"]);
  const yaLlamados = new Set(((tocados ?? []) as { lead_id: string }[]).map((r) => r.lead_id));

  const faltan = ids.filter((id) => !yaEmpujados.has(id) && !yaLlamados.has(id));
  if (faltan.length === 0) return [];

  const { data: leads } = await admin
    .from("leads")
    .select("id,name,phone,first_seen_at,status")
    .in("id", faltan.slice(0, 200))
    .eq("status", "nuevo")
    .order("first_seen_at", { ascending: true })
    .limit(limit);

  return ((leads ?? []) as (PendingLead & { status: string })[]).map(({ id, name, phone, first_seen_at }) => ({
    id,
    name,
    phone,
    first_seen_at,
  }));
}

/**
 * Deja constancia de que estos leads salieron.
 *
 * SE LLAMA DESPUÉS DE ENVIAR, no antes, y el orden importa. Si se apuntara
 * primero y el envío fallara, esos leads no volverían a salir NUNCA y el
 * tratamiento se perdería en silencio para ellos — que es exactamente cómo v1
 * se fue al traste sin que se notara. Al revés el peor caso es un mensaje
 * repetido: visible, molesto y recuperable.
 *
 * La PK (lead_id, experiment) hace el resto: dos pasadas simultáneas chocan en
 * vez de duplicar, así que el 23505 no es un fallo sino la garantía funcionando.
 */
export async function recordCoveragePush(
  admin: Admin,
  storeId: string,
  leadIds: readonly string[],
  experiment: string = ACTIVE_EXPERIMENT,
): Promise<number> {
  if (leadIds.length === 0) return 0;
  const { error } = await admin
    .from("lead_coverage_pushes")
    .insert(leadIds.map((lead_id) => ({ lead_id, store_id: storeId, experiment })));
  if (error && error.code !== "23505") return 0;
  return leadIds.length;
}
