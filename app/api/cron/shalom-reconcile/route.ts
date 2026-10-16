import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createAdminSupabase } from "@/lib/db";
import { env } from "@/lib/env";
import { publicClient } from "@/lib/shalom/session";
import { describeShalomError, isShalomRateLimited, type ShalomRateLimit } from "@/lib/shalom/client";
import { recomputeOrderMasterSafe } from "@/lib/order-master";
import { shalomNeedsTracking, type ShalomTrackingStatus } from "@/lib/shalom/tracking";
import { applyShalomTracking, type ShalomLiveGuide } from "@/lib/shalom/reconcile";
import { enqueueTransitNotification, processTransitNotifications } from "@/lib/shalom/transit-notify";
import { enqueueDueReminders } from "@/lib/shalom/pickup-reminder";
import { backfillManualOseIds } from "@/lib/shalom/ose-backfill";
import { SHALOM_ORIGIN } from "@/lib/shalom/origin";
import { shalomTrackItem, TrackQuota, trackRetryAfterMs, type TrackItem } from "@/lib/shalom/track-pace";

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
/**
 * Tiempo para preguntar, contado desde que empieza el rastreo. Al ritmo del
 * cupo (120 guías por minuto, lib/shalom/track-pace.ts) son ~250 guías; el
 * resto de los 300 s es para el OSE ID manual y para drenar los avisos.
 */
const TRACK_BUDGET_MS = 90_000;
/** 429 seguidos con los que la pasada deja de preguntar. */
const MAX_RATE_LIMITED_IN_A_ROW = 3;

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

interface LiveGuide extends ShalomLiveGuide {
  /** Alfanumérico de 4. El rastreo por número NO resuelve sin él (track-pace.ts). */
  shalom_codigo: string | null;
  shalom_ose_id: number | null;
  created_via: string | null;
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
  //
  // PRIMERO LA QUE HACE MÁS QUE NO CONTESTA (15-10-2026). Se ordenaba por
  // `updated_at`, que mueve CUALQUIER cambio de la fila: corregirle el código a
  // una guía la mandaba al final de la fila. Y como cada pasada solo consigue
  // respuesta para las primeras ~75-120 de ~460, #KP137651 —recién corregida,
  // con el paquete ya en la agencia— quedaba a ~2,5 h de su primera respuesta.
  // `last_report_at` es cuándo contestó Shalom por última vez: la que nunca
  // contestó va primero, y después la que lleva más tiempo sin hacerlo.
  const { data, error } = await admin
    .from("shipments")
    .select("id,store_id,order_id,guide_code,shalom_codigo,shalom_ose_id,created_via,delivery_status,pickup_state")
    .eq("courier", "shalom")
    .not("guide_code", "is", null)
    .not("delivery_status", "in", "(entregado,anulado,transferido)")
    .order("last_report_at", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: true })
    .limit(MAX_PER_RUN);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  const live = ((data as LiveGuide[]) ?? []).filter((g) => shalomNeedsTracking(g.delivery_status));
  if (!live.length) return NextResponse.json({ ok: true, scanned: 0, applied: 0 });

  const startedAt = Date.now();
  const client = publicClient();
  const byId = new Map(live.map((g) => [g.id, g]));
  const touchedOrders = new Set<string>();
  const errors: string[] = [];
  let applied = 0;
  /** «Entregados» que eran el retorno de la caja, no un recojo (MOM §12). */
  let retornos = 0;
  let failed = 0;
  let reported = 0;
  let queued = 0;
  /** Motivo de rechazo → cuántas y una guía de muestra para ir a comprobarla. */
  const rejected = new Map<string, { count: number; ejemplo: string | null }>();
  /**
   * Qué pasó con cada lote (15-10-2026). La respuesta del cron no se guarda en
   * ningún sitio, así que la línea `[shalom-reconcile]` de la bitácora es lo
   * único que dice por qué una guía no se preguntó. Así se encontró el cupo
   * del rastreo (lib/shalom/track-pace.ts).
   */
  const lotes: {
    guias: number;
    ok: number;
    rechazadas: number;
    /** Lo que se esperó al cupo antes de pedirlo. */
    esperaMs: number;
    ms: number;
    error?: string;
    cupo: ShalomRateLimit;
  }[] = [];
  /** Por qué no se preguntó por todas: el tiempo de la pasada, o Shalom sin cupo. */
  let cortadoPor: "tiempo" | "cupo" | null = null;
  let preguntadas = 0;

  // Sin código ni OSE ID no hay cómo preguntar: no se gasta cupo en ella.
  const trackable: TrackItem[] = [];
  let sinIdentificador = 0;
  for (const g of live) {
    const item = shalomTrackItem(g, SHALOM_ORIGIN.manual);
    if (item) trackable.push(item);
    else sinIdentificador += 1;
  }

  // AL RITMO DEL CUPO (16-10-2026). Shalom rastrea 120 guías por minuto,
  // contadas guía a guía. Los lotes salían seguidos, el tercero chocaba con un
  // 429 y la pasada terminaba en 4 s habiendo preguntado por 100 de 459. Ahora
  // cada lote espera lo que le falta al cupo, y un 429 espera lo que Shalom
  // dice y repite el MISMO lote. Hasta `TRACK_BUDGET_MS`: lo que queda del
  // tiempo de la función es para los avisos. Lo que no entra va primero en la
  // pasada siguiente, porque la fila va por quién contestó hace más tiempo.
  const quota = new TrackQuota();
  const trackDeadline = startedAt + TRACK_BUDGET_MS;
  let seguidos429 = 0;
  let i = 0;
  while (i < trackable.length) {
    const slice = trackable.slice(i, i + BATCH_SIZE);
    const espera = quota.waitFor(slice.length);
    if (Date.now() + espera > trackDeadline) {
      cortadoPor = "tiempo";
      break;
    }
    if (espera > 0) await new Promise((resolve) => setTimeout(resolve, espera));
    const loteStart = Date.now();
    quota.spend(slice.length);
    let results;
    try {
      results = await client.trackBatch(slice);
    } catch (err) {
      const message = describeShalomError(err);
      lotes.push({
        guias: slice.length,
        ok: 0,
        rechazadas: 0,
        esperaMs: espera,
        ms: Date.now() - loteStart,
        error: message,
        cupo: { ...client.rateLimit },
      });
      if (isShalomRateLimited(err)) {
        // Sin cupo: se espera lo que Shalom pide y se repite este mismo lote.
        // Tres seguidos es que algo más está gastando el cupo: se deja.
        seguidos429 += 1;
        quota.exhausted(trackRetryAfterMs(err instanceof Error ? err.message : null), slice.length);
        if (seguidos429 >= MAX_RATE_LIMITED_IN_A_ROW) {
          errors.push(message);
          cortadoPor = "cupo";
          break;
        }
        continue;
      }
      // Un batch caído no debe tumbar la pasada entera: se anota y se sigue con
      // el siguiente, que puede ser de otra tienda.
      errors.push(message);
      seguidos429 = 0;
      i += slice.length;
      preguntadas += slice.length;
      continue;
    }
    seguidos429 = 0;
    i += slice.length;
    preguntadas += slice.length;
    const lote = {
      guias: slice.length,
      ok: 0,
      rechazadas: 0,
      esperaMs: espera,
      ms: Date.now() - loteStart,
      cupo: { ...client.rateLimit },
    };
    lotes.push(lote);

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
        lote.rechazadas += 1;
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
      lote.ok += 1;

      // Leer el hito, decidir si un «entregado» fue el recojo o el retorno, y
      // escribirlo en la guía y en la línea de tiempo: lib/shalom/reconcile.ts.
      const outcome = await applyShalomTracking(admin, guide, r.tracking?.status as ShalomTrackingStatus | null);
      if (outcome.kind === "sin_cambio") continue;
      if (outcome.kind === "error") {
        errors.push(outcome.message);
        continue;
      }
      applied += 1;
      if (outcome.retorno) retornos += 1;

      if (guide.order_id) {
        touchedOrders.add(guide.order_id);

        // El paquete salió de viaje: es el momento de avisarle a la clienta
        // (MOM §12). Se ENCOLA nada más; el envío va aparte, abajo, porque
        // puede tardar y puede fallar, y esta transición no se repite. Una
        // guía que ya estaba en tránsito antes de que existiera esto no entra:
        // el cron solo ve el cambio.
        // Dos momentos, dos avisos (0169). El de tránsito dice «va en camino»;
        // el de llegada dice «ya está en la agencia, tienes hasta el día X».
        // Son la misma cola y el mismo número, pero plantillas e interruptores
        // distintos — y la unique es (shipment_id, kind), así que una guía
        // recibe cada uno una sola vez.
        const avisoDe: Record<string, "transito" | "disponible" | undefined> = {
          en_transito: "transito",
          disponible_para_recojo: "disponible",
        };
        const kind = avisoDe[outcome.pickupState];
        if (kind) {
          const ok = await enqueueTransitNotification(admin, {
            storeId: guide.store_id,
            shipmentId: guide.id,
            orderId: guide.order_id,
            kind,
          });
          if (ok) queued += 1;
        }
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

  // Drenar la cola de avisos con lo que quede de presupuesto. Corre después
  // del rastreo a propósito: el rastreo es lo que no puede esperar, y un
  // aviso que se queda en cola sale en la pasada siguiente, media hora después.
  // Antes de drenar: el OSE ID de las guías creadas a mano en Shalom Pro, para
  // que sus avisos puedan llevar el ticket (lib/shalom/ose-backfill.ts). Sin
  // guías manuales pendientes es una consulta y vuelve.
  const ose = await backfillManualOseIds(admin);
  errors.push(...ose.errores);

  // Cotejar Shalom (MOM §12) ya NO corre aquí: tiene su propio cron
  // (/api/cron/shalom-cotejo). Colgado del final de esta pasada se quedaba sin
  // tiempo para bajar el listado de la cuenta (10-10-2026, 16:00).

  // El recordatorio de recojo (0242): día 3 y día 7 en la agencia, a quien
  // todavía debe. Se ENCOLA antes de drenar para que salga en esta misma
  // pasada, con el mismo tope y horario que los otros avisos. Con el
  // recordatorio apagado en todas las tiendas es una consulta y vuelve.
  const recordatorios = await enqueueDueReminders(admin, { courier: "shalom" });
  errors.push(...recordatorios.errores);

  const elapsed = Date.now() - startedAt;
  const avisos = await processTransitNotifications(admin, {
    budgetMs: Math.max(20_000, 240_000 - elapsed),
  });
  errors.push(...avisos.errors);

  const topRechazos = Object.fromEntries(
    [...rejected.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 5),
  );
  // La respuesta del cron no se guarda en ningún sitio; la bitácora sí. Una
  // línea por pasada con lo que hace falta para leer el rastreo sin relanzarlo.
  console.info(
    "[shalom-reconcile]",
    JSON.stringify({
      vivas: live.length,
      sinIdentificador,
      preguntadas,
      reported,
      applied,
      failed,
      cortadoPor,
      lotes,
      rechazos: topRechazos,
      encolados: queued,
      errors: errors.slice(0, 5),
      ms: Date.now() - startedAt,
    }),
  );

  return NextResponse.json({
    ok: true,
    scanned: live.length,
    // Sin código ni OSE ID: no hay cómo preguntar por ellas.
    sinIdentificador,
    preguntadas,
    // Si se cortó antes de preguntar por todas, por qué («tiempo» o «cupo»).
    cortadoPor,
    lotes,
    // Avisos de tránsito: cuántos entraron a la cola en esta pasada y cómo
    // quedó la cola tras drenarla.
    avisos: { encolados: queued, ...avisos },
    // Recordatorios de recojo: cuántos tocaban y entraron, cuántos esperan
    // por el techo de la cola y por qué no entró el resto.
    recordatorios: {
      tiendas: recordatorios.tiendas,
      guias: recordatorios.guias,
      encolados: recordatorios.encolados,
      porTope: recordatorios.porTope,
      motivos: recordatorios.motivos,
    },
    oseManual: { buscadas: ose.buscadas, resueltas: ose.resueltas, sinResolver: ose.sinResolver.length },
    // `reported` = Shalom contestó. `applied` = además cambió algo. Separarlos
    // es lo que hace legible una corrida a mano: reported>0 y applied=0 significa
    // "todo bien, sin novedad", que antes se leía igual que "no corrió".
    reported,
    applied,
    // De los aplicados, los «entregado» que se leyeron como retorno (MOM §12).
    retornos,
    failed,
    // Por qué las rechazó, agrupado. Con `failed` a secas no hay nada que hacer;
    // con el motivo y una guía de muestra se va directo a comprobarlo.
    ...(rejected.size ? { rechazos: topRechazos } : {}),
    ...(errors.length ? { errors: errors.slice(0, 10) } : {}),
  });
}
