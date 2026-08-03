import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createAdminSupabase } from "@/lib/db";
import { env } from "@/lib/env";
import { publicClient } from "@/lib/shalom/session";
import { describeShalomError } from "@/lib/shalom/client";
import { recomputeOrderMasterSafe } from "@/lib/order-master";
import {
  readShalomTracking,
  shalomNeedsTracking,
  shalomTrackingChanged,
  type ShalomTrackingStatus,
} from "@/lib/shalom/tracking";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Estados de las guías de Shalom creadas por API.
//
// OJO: «Shalom no tiene webhook» ERA FALSO, y sobre eso se justificó este cron.
// Su API expone `PUT /v1/webhooks` + `POST /v1/tracking/subscriptions`, y un
// atajo `"track": true` al crear la orden. Empujan el timeline completo firmado.
//
// El cron sigue haciendo falta igual, por ahora: el cupo son 50 suscripciones
// ACTIVAS a la vez y hay 93 guías vivas. Lo suyo es suscribir al crear y dejar
// esto de red para lo que no quepa o se pierda. Ver docs/shalom-estados-rastreo.md.
//
// POR QUÉ HACE FALTA HOY. La vía de entrada que existía
// —subir su reporte Excel— nunca se usó en esta operación: las guías creadas por
// API se quedaban congeladas en el estado con el que nacían. El Master decía
// "pendiente" para siempre, que no es un dato sino un vacío disfrazado.
//
// POR QUÉ SE PUEDE HACER BARATO. El «modo estado» del rastreo se contenta con la
// API KEY GLOBAL: no pide credenciales de Shalom Pro, así que no hay login de
// ~90 s, no hay sesión que renovar y no hace falta recorrer tienda por tienda.
// Una sola llamada cubre guías de cualquier tienda a la vez.
//
// Y `POST /v1/tracking/batch` acepta 50 guías por request, con un `custom_id`
// que devuelve verbatim — se manda el id del envío y el resultado se correlaciona
// sin adivinar. Un item que falla no tumba el batch: viene con `ok:false`.

/** Tope del endpoint. No es una elección nuestra. */
const BATCH_SIZE = 50;
/**
 * Techo de guías por pasada. Con el cupo compartido de 60 req/min entre TODAS
 * las tiendas, 20 batches son 20 llamadas: deja aire de sobra para que el panel
 * siga funcionando mientras el cron corre.
 */
const MAX_PER_RUN = BATCH_SIZE * 20;

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

interface LiveGuide {
  id: string;
  store_id: string;
  order_id: string | null;
  guide_code: string | null;
  /** Alfanumérico de 4. El rastreo NO resuelve sin él (ver más abajo). */
  shalom_codigo: string | null;
  shalom_ose_id: number | null;
  delivery_status: string;
  pickup_state: string | null;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return new NextResponse("unauthorized", { status: 401 });
  if (!env.shalomConfigured()) {
    // Sin API key no hay nada que preguntar. No es un fallo: es un despliegue
    // que todavía no tiene Shalom encendido.
    return NextResponse.json({ ok: true, skipped: "SHALOM_API_KEY no configurada" });
  }

  const admin = createAdminSupabase();

  // Solo las que pueden cambiar: las terminales ya no se mueven, y preguntarlas
  // gastaría cupo compartido a cambio de nada. El rastreo público necesita el
  // número de guía, NO el OSE ID ni una sesión de Shalom Pro. Por eso también
  // entran las guías creadas fuera de Kapta y vinculadas durante una caída.
  const { data, error } = await admin
    .from("shipments")
    .select("id,store_id,order_id,guide_code,shalom_codigo,shalom_ose_id,delivery_status,pickup_state")
    .eq("courier", "shalom")
    .not("guide_code", "is", null)
    .not("delivery_status", "in", "(entregado,anulado,transferido)")
    .order("updated_at", { ascending: true })
    .limit(MAX_PER_RUN);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  const live = ((data as LiveGuide[]) ?? []).filter((g) => shalomNeedsTracking(g.delivery_status));
  if (!live.length) return NextResponse.json({ ok: true, scanned: 0, applied: 0 });

  const client = publicClient();
  const byId = new Map(live.map((g) => [g.id, g]));
  const touchedOrders = new Set<string>();
  const errors: string[] = [];
  let applied = 0;
  let failed = 0;
  let reported = 0;
  /** Motivo de rechazo → cuántas y una guía de muestra para ir a comprobarla. */
  const rejected = new Map<string, { count: number; ejemplo: string | null }>();

  for (let i = 0; i < live.length; i += BATCH_SIZE) {
    const slice = live.slice(i, i + BATCH_SIZE);
    let results;
    try {
      results = await client.trackBatch(
        // `numero` + `codigo`, Y NADA MÁS.
        //
        // `numero` solo no basta: el upstream contesta «Ingrese un código de
        // orden» —y con solo el código, «Ingrese un número de orden»—. Se
        // reclaman el uno al otro, y por separado los dos mensajes parecen decir
        // "esa guía no existe". Eso tuvo las 93 guías sin rastrear desde el
        // primer día.
        //
        // `ose_id` sirve de reserva para la guía que no tenga código —una
        // vinculada a mano, por ejemplo—, pero VA COMO STRING. Mandarlo como el
        // bigint que es en la base devuelve `400 body JSON inválido`, y ese 400
        // tumba el LOTE ENTERO, no el item: 50 guías sin rastrear por un tipo.
        //
        // Por lo mismo los campos se omiten cuando no hay valor en vez de ir
        // como null: un item incompleto falla solo, sin llevarse a los demás.
        slice.map((g) => {
          const item: {
            custom_id: string;
            numero?: string;
            codigo?: string;
            ose_id?: string;
          } = { custom_id: g.id };
          if (g.shalom_codigo) {
            item.numero = String(g.guide_code);
            item.codigo = g.shalom_codigo;
          } else if (g.shalom_ose_id) {
            item.ose_id = String(g.shalom_ose_id);
          } else {
            item.numero = String(g.guide_code);
          }
          return item;
        }),
      );
    } catch (err) {
      // Un batch caído no debe tumbar la pasada entera: se anota y se sigue con
      // el siguiente, que puede ser de otra tienda.
      errors.push(describeShalomError(err));
      continue;
    }

    // Guías por las que Shalom SÍ contestó, hayan cambiado o no. Se sella abajo
    // el `last_report_at` de todas juntas — ver el porqué antes del update.
    const answered: string[] = [];

    for (const r of results) {
      const guide = r.custom_id ? byId.get(r.custom_id) : undefined;
      if (!guide) continue;
      if (!r.ok) {
        // Quedarse solo con el CONTADOR de fallos no sirve para actuar: "92
        // rechazadas" no distingue "Shalom no conoce todavía estas guías porque
        // el paquete no se ha entregado en agencia" de "les estamos mandando el
        // número en un formato que no reconoce". Son diagnósticos opuestos y el
        // motivo viene en la respuesta, así que tirarlo era perder el dato justo
        // en el sitio donde se necesita.
        failed += 1;
        const why =
          [r.error?.code, r.error?.message].filter(Boolean).join(": ") || "sin motivo declarado";
        const seen = rejected.get(why);
        if (seen) seen.count += 1;
        // Un ejemplo por motivo permite ir a comprobarlo a mano contra
        // pro.shalom.pe sin tener que volver a lanzar el cron.
        else rejected.set(why, { count: 1, ejemplo: guide.guide_code });
        continue;
      }
      answered.push(guide.id);

      const next = readShalomTracking(r.tracking?.status as ShalomTrackingStatus | null);
      if (!shalomTrackingChanged(guide, next)) continue;

      const upd = await admin
        .from("shipments")
        .update({
          delivery_status: next.deliveryStatus,
          status_category: next.deliveryStatus === "entregado" ? "delivered" : "pending",
          pickup_state: next.pickupState,
          last_report_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", guide.id);
      if (upd.error) {
        errors.push(`${guide.guide_code}: ${upd.error.message}`);
        continue;
      }
      applied += 1;

      if (guide.order_id) {
        touchedOrders.add(guide.order_id);
        await admin.from("order_events").insert({
          store_id: guide.store_id,
          order_id: guide.order_id,
          kind: "courier_status",
          occurred_at: next.at ?? new Date().toISOString(),
          actor: null,
          source: "shalom",
          courier: "shalom",
          guide_code: guide.guide_code,
          new_status: next.deliveryStatus,
          new_operational: next.pickupState,
          note: `Shalom: ${next.pickupState}${next.delayed ? " (con demora declarada)" : ""}.`,
        });
      }
    }

    // Sellar que PREGUNTAMOS, aunque nada haya cambiado.
    //
    // POR QUÉ. Hasta acá `last_report_at` solo se escribía dentro del update de
    // una guía que cambiaba. Con todas las guías quietas —lo normal: un paquete
    // pasa días en el mismo hito— el cron podía correr cada 30 minutos durante
    // una semana y dejar `last_report_at` en null en las 79. Y entonces null no
    // distingue «el cron nunca corrió» de «el cron corre y no hay novedad»: son
    // el mismo dato y piden acciones opuestas (revisar Vercel, o no tocar nada).
    // Pasó de verdad: dimos por muerto un cron que no teníamos cómo ver vivo.
    //
    // Va en un solo update por lote y no uno por guía: son 50 filas por llamada
    // y esto corre cada media hora.
    if (answered.length) {
      const stamp = await admin
        .from("shipments")
        .update({ last_report_at: new Date().toISOString() })
        .in("id", answered);
      if (stamp.error) errors.push(`sello de rastreo: ${stamp.error.message}`);
      else reported += answered.length;
    }
  }

  if (touchedOrders.size) await recomputeOrderMasterSafe(admin, [...touchedOrders]);

  return NextResponse.json({
    ok: true,
    scanned: live.length,
    // `reported` = Shalom contestó. `applied` = además cambió algo. Separarlos
    // es lo que hace legible una corrida a mano: reported>0 y applied=0 significa
    // "todo bien, sin novedad", que antes se leía igual que "no corrió".
    reported,
    applied,
    failed,
    // Por qué las rechazó, agrupado. Con `failed` a secas no hay nada que hacer;
    // con el motivo y una guía de muestra se va directo a comprobarlo.
    ...(rejected.size
      ? {
          rechazos: Object.fromEntries(
            [...rejected.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 5),
          ),
        }
      : {}),
    ...(errors.length ? { errors: errors.slice(0, 10) } : {}),
  });
}
