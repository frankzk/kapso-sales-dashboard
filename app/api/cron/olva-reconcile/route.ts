import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createAdminSupabase } from "@/lib/db";
import { env } from "@/lib/env";
import { recomputeOrderMasterSafe } from "@/lib/order-master";
import { describeOlvaError, fetchOlvaTracking } from "@/lib/olva/client";
import { enqueueTransitNotification, processTransitNotifications } from "@/lib/shalom/transit-notify";
import {
  formatOlvaTracking,
  olvaNeedsTracking,
  olvaPickupDeadline,
  olvaTrackingChanged,
  readOlvaTracking,
} from "@/lib/olva/tracking";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Estados de las salidas de Olva con tracking registrado (MOM §12).
//
// OLVA NO TIENE API. Lo que hay es la llamada que hace su página pública de
// seguimiento, con una apikey fija que ella misma publica; `lib/olva/client.ts`
// la repite tal cual. Por eso este cron es más frágil que el de Shalom: el día
// que Olva rote la key o cambie la forma de la respuesta, esto empieza a fallar
// —y lo que hace entonces es REPORTAR y no tocar nada, para que el marcado a
// mano del drawer siga siendo verdad y no lo pise un estado inventado.
//
// POR QUÉ HACE FALTA. Olva devuelve el paquete a los 6 días de llegar a la
// oficina de destino (Shalom da 28). Con el estado marcado a mano «cuando
// alguien se acordaba», la ventana se pasaba sin que el Master avisara. El
// tracking se registra en la salida desde el drawer; sin él no hay nada que
// preguntar, y esas salidas simplemente no entran aquí.
//
// UNA GUÍA POR LLAMADA, en tandas pequeñas en paralelo. El servicio no tiene
// lote, y son decenas de guías vivas, no miles.

/** Cuántas guías se preguntan a la vez. Es la página de un courier, no la API de uno. */
const CONCURRENCY = 4;
/** Techo por pasada. Muy por encima de las salidas vivas de Olva que hay hoy. */
const MAX_PER_RUN = 300;
/** Presupuesto de tiempo para el rastreo; lo que no quepa espera a la siguiente pasada. */
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

interface LiveGuide {
  id: string;
  store_id: string;
  order_id: string | null;
  guide_code: string | null;
  output_code: string | null;
  olva_tracking: string;
  olva_emision: string;
  olva_status: string | null;
  delivery_status: string;
  pickup_state: string | null;
  agency_branch: string | null;
  agency_arrived_at: string | null;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return new NextResponse("unauthorized", { status: 401 });
  if (!env.olvaTrackingConfigured()) {
    // Sin apikey no hay nada que preguntar. No es un fallo: es un despliegue
    // que todavía no tiene el rastreo de Olva encendido.
    return NextResponse.json({ ok: true, skipped: "OLVA_TRACKING_APIKEY no configurada" });
  }

  const admin = createAdminSupabase();

  // Solo las que pueden cambiar: las terminales ya no se mueven. Y solo las que
  // tienen tracking: sin él no hay pregunta posible.
  const { data, error } = await admin
    .from("shipments")
    .select(
      "id,store_id,order_id,guide_code,output_code,olva_tracking,olva_emision,olva_status,delivery_status,pickup_state,agency_branch,agency_arrived_at",
    )
    .eq("courier", "olva")
    .not("olva_tracking", "is", null)
    .not("delivery_status", "in", "(entregado,anulado,transferido)")
    .order("updated_at", { ascending: true })
    .limit(MAX_PER_RUN);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  const live = ((data as LiveGuide[]) ?? []).filter(
    (g) => g.olva_tracking && g.olva_emision && olvaNeedsTracking(g.delivery_status),
  );
  if (!live.length) return NextResponse.json({ ok: true, scanned: 0, applied: 0 });

  const startedAt = Date.now();
  const apiKey = env.olvaTrackingApiKey();
  const baseUrl = env.olvaTrackingApiBase();
  const touchedOrders = new Set<string>();
  const errors: string[] = [];
  const answered: string[] = [];
  let applied = 0;
  let failed = 0;
  let skippedByBudget = 0;
  let queued = 0;
  /** Olva contestó, pero no reconoce la guía: motivo → cuántas y una de muestra. */
  const rejected = new Map<string, { count: number; ejemplo: string }>();
  /**
   * Estados que Olva dijo y Kapta no conoce. Es EL dato que hace crecer el
   * traductor: se añaden a `lib/olva/tracking.ts` con su significado, con un
   * ejemplo real para ir a mirarlo en la página de Olva.
   */
  const unknown = new Map<string, { count: number; ejemplo: string }>();

  async function track(guide: LiveGuide): Promise<void> {
    const id = { tracking: guide.olva_tracking, emision: guide.olva_emision };
    const label = formatOlvaTracking(id);
    let result;
    try {
      result = await fetchOlvaTracking(id, { apiKey, baseUrl });
    } catch (err) {
      failed += 1;
      errors.push(`${label}: ${describeOlvaError(err)}`);
      return;
    }
    if (!result.ok) {
      failed += 1;
      const seen = rejected.get(result.reason);
      if (seen) seen.count += 1;
      else rejected.set(result.reason, { count: 1, ejemplo: label });
      return;
    }
    answered.push(guide.id);

    const next = readOlvaTracking(result.payload);
    if (!next.known && next.rawStatus) {
      const seen = unknown.get(next.rawStatus);
      if (seen) seen.count += 1;
      else unknown.set(next.rawStatus, { count: 1, ejemplo: label });
    }
    if (!olvaTrackingChanged(guide, next)) return;

    const now = new Date().toISOString();
    const patch: Record<string, unknown> = {
      olva_status: next.rawStatus,
      olva_raw: result.payload.data?.general ?? null,
      last_report_at: now,
      updated_at: now,
    };
    if (next.known) {
      patch.delivery_status = next.deliveryStatus;
      patch.status_category = next.deliveryStatus === "entregado" ? "delivered" : "pending";
      patch.pickup_state = next.pickupState;
      if (next.agencyBranch && !guide.agency_branch) patch.agency_branch = next.agencyBranch;
      // Llegó a la oficina de destino: desde aquí corren los 6 días de Olva.
      // Solo la primera vez —si ya tenía fecha de llegada, se respeta—.
      if (next.pickupState === "disponible_para_recojo" && !guide.agency_arrived_at) {
        const arrived = next.at ?? now;
        patch.agency_arrived_at = arrived;
        patch.agency_expires_at = olvaPickupDeadline(arrived);
      }
    }

    const upd = await admin.from("shipments").update(patch).eq("id", guide.id);
    if (upd.error) {
      errors.push(`${label}: ${upd.error.message}`);
      return;
    }
    applied += 1;

    if (guide.order_id) {
      touchedOrders.add(guide.order_id);
      await admin.from("order_events").insert({
        store_id: guide.store_id,
        order_id: guide.order_id,
        kind: "courier_status",
        occurred_at: next.at ?? now,
        actor: null,
        source: "olva",
        courier: "olva",
        guide_code: guide.guide_code,
        // Sin traducción conocida NO se escribe un estado nuevo: se deja el
        // crudo en la nota, que es lo único que se sabe.
        new_status: next.known ? next.deliveryStatus : null,
        new_operational: next.known ? next.pickupState : null,
        note: next.known
          ? `Olva: ${next.pickupState} (${next.rawStatus?.toLowerCase() ?? "sin estado"})${
              next.returnFlagged ? " — Olva lo marca como devolución" : ""
            }.`
          : `Olva informa «${next.rawStatus ?? "sin estado"}», un estado que Kapta todavía no traduce; el estado del Master no se movió.`,
      });

      // Los dos avisos a la clienta (0175): «va en camino» al despachar y «ya
      // está en la oficina» al llegar. Se ENCOLAN nada más; el envío va aparte,
      // abajo, con reintentos. Misma cola que Shalom, con el courier marcado
      // para que salga la plantilla de Olva. La unique (shipment_id, kind)
      // garantiza uno de cada por guía.
      if (next.known) {
        const avisoDe: Record<string, "transito" | "disponible" | undefined> = {
          en_transito: "transito",
          disponible_para_recojo: "disponible",
        };
        const kind = avisoDe[next.pickupState];
        if (kind) {
          const ok = await enqueueTransitNotification(admin, {
            storeId: guide.store_id,
            shipmentId: guide.id,
            orderId: guide.order_id,
            kind,
            courier: "olva",
          });
          if (ok) queued += 1;
        }
      }
    }
  }

  // Tandas de CONCURRENCY, hasta agotar el presupuesto de tiempo.
  for (let i = 0; i < live.length; i += CONCURRENCY) {
    if (Date.now() - startedAt > BUDGET_MS) {
      skippedByBudget = live.length - i;
      break;
    }
    await Promise.all(live.slice(i, i + CONCURRENCY).map(track));
  }

  // Sellar que PREGUNTAMOS, aunque nada haya cambiado: `last_report_at` en
  // null no distingue «el cron nunca corrió» de «corre y no hay novedad».
  if (answered.length) {
    const stamp = await admin
      .from("shipments")
      .update({ last_report_at: new Date().toISOString() })
      .in("id", answered);
    if (stamp.error) errors.push(`sello de rastreo: ${stamp.error.message}`);
  }

  if (touchedOrders.size) await recomputeOrderMasterSafe(admin, [...touchedOrders]);

  // Drenar la cola de avisos con lo que quede de presupuesto, después del
  // rastreo: el rastreo es lo que no puede esperar, y un aviso que se queda en
  // cola sale en la pasada siguiente. Drena la cola entera —también Shalom—,
  // igual que el cron de Shalom drena la de Olva: es una sola cola.
  const elapsed = Date.now() - startedAt;
  const avisos = await processTransitNotifications(admin, {
    budgetMs: Math.max(20_000, 270_000 - elapsed),
  });
  errors.push(...avisos.errors);

  const top = <T>(m: Map<string, T>) =>
    Object.fromEntries(
      [...m.entries()]
        .sort((a, b) => (b[1] as { count: number }).count - (a[1] as { count: number }).count)
        .slice(0, 5),
    );

  return NextResponse.json({
    ok: true,
    scanned: live.length,
    // `reported` = Olva contestó. `applied` = además cambió algo.
    reported: answered.length,
    applied,
    failed,
    // Avisos por WhatsApp: cuántos entraron a la cola y cómo quedó tras drenarla.
    avisos: { encolados: queued, ...avisos },
    ...(skippedByBudget ? { skippedByBudget } : {}),
    ...(rejected.size ? { rechazos: top(rejected) } : {}),
    // Si aparece algo aquí, hay que añadirlo al traductor con su significado.
    ...(unknown.size ? { estadosSinTraducir: top(unknown) } : {}),
    ...(errors.length ? { errors: errors.slice(0, 10) } : {}),
  });
}
