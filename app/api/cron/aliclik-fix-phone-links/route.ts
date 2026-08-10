import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createAdminSupabase } from "@/lib/db";
import { orderNameFromGuideCode } from "@/lib/aliclik-import";
import {
  planPhoneLinkRepairs,
  type PhoneLinkedGuide,
  type RepairOrderCandidate,
} from "@/lib/phone-link-repair";
import { recomputeOrderMasterSafe } from "@/lib/order-master";
import { chunk } from "@/lib/access";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Devuelve a su pedido las guías que se engancharon SOLO por teléfono (0119).
//
// Ver la cabecera de lib/phone-link-repair.ts para el porqué. En resumen: el
// respaldo por teléfono del emparejador acierta en el instante en que corre pero
// caduca —el pedido bueno puede llegar después—, y nadie revisaba esos vínculos.
// El número del pedido venía escrito en el código de guía desde el principio.
//
// ENSAYO POR DEFECTO. Sin `?apply=true` solo informa qué movería. Mover una guía
// reescribe a qué venta pertenece un paquete, y de ahí salen el cierre, el costo
// y la liquidación: esto se mira antes de dejarlo suelto. Por la misma razón no
// va en `vercel.json` todavía — se dispara a mano hasta que su informe salga
// aburrido varias veces seguidas.

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

/** Techo por pasada. Son 15 hoy; el tope es el seguro de siempre. */
const LIMIT = 200;

async function run(req: NextRequest) {
  if (!authorized(req)) return new NextResponse("unauthorized", { status: 401 });
  const apply = req.nextUrl.searchParams.get("apply") === "true";
  const admin = createAdminSupabase();

  const { data: storeRows, error: storeErr } = await admin
    .from("stores")
    .select("id,order_prefix")
    .not("order_prefix", "is", null);
  if (storeErr) return NextResponse.json({ ok: false, error: storeErr.message }, { status: 500 });
  const prefixByStore = new Map(
    ((storeRows ?? []) as { id: string; order_prefix: string | null }[]).map((s) => [
      s.id,
      s.order_prefix,
    ]),
  );
  if (!prefixByStore.size) {
    return NextResponse.json({ ok: true, scanned: 0, note: "Ninguna tienda tiene prefijo." });
  }

  // Solo las vinculadas por teléfono: es el único método cuya respuesta caduca.
  // Las de `order_name`/`order_name_phone` se decidieron con el número delante.
  const { data: guideRows, error: guideErr } = await admin
    .from("shipments")
    .select("id,guide_code,store_id,order_id,customer_phone")
    .eq("courier", "aliclik")
    .eq("match_method", "phone")
    .not("order_id", "is", null)
    .in("store_id", [...prefixByStore.keys()])
    .limit(LIMIT);
  if (guideErr) return NextResponse.json({ ok: false, error: guideErr.message }, { status: 500 });

  const guides: PhoneLinkedGuide[] = ((guideRows ?? []) as Omit<PhoneLinkedGuide, "derived_order_name">[])
    .map((g) => ({
      ...g,
      derived_order_name: orderNameFromGuideCode(g.guide_code, prefixByStore.get(g.store_id)),
    }));

  const wanted = [...new Set(guides.map((g) => g.derived_order_name).filter((n): n is string => Boolean(n)))];
  const orders: RepairOrderCandidate[] = [];
  for (const batch of chunk(wanted, 200)) {
    const { data, error } = await admin
      .from("orders")
      .select("id,store_id,name,customer_phone")
      .in("name", batch);
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    orders.push(
      ...((data ?? []) as Omit<RepairOrderCandidate, "guide_count">[]).map((o) => ({
        ...o,
        guide_count: 0,
      })),
    );
  }

  // Cuántas guías tiene ya cada candidato. Se cuenta aparte porque PostgREST no
  // agrega, y es la guarda que distingue «pedido huérfano de su guía» —lo que
  // esto arregla— de «pedido que ya tiene la suya», donde mover es decisión
  // de una persona.
  for (const batch of chunk(orders.map((o) => o.id), 200)) {
    const { data } = await admin.from("shipments").select("order_id").in("order_id", batch);
    for (const row of (data ?? []) as { order_id: string | null }[]) {
      const target = orders.find((o) => o.id === row.order_id);
      if (target) target.guide_count++;
    }
  }

  const plan = planPhoneLinkRepairs(guides, orders);
  const skippedByReason = plan.skipped.reduce<Record<string, number>>((acc, s) => {
    acc[s.reason] = (acc[s.reason] ?? 0) + 1;
    return acc;
  }, {});

  if (!apply) {
    return NextResponse.json({
      ok: true,
      dryRun: true,
      scanned: guides.length,
      wouldMove: plan.move.length,
      moves: plan.move,
      skipped: skippedByReason,
      hint: "Añade ?apply=true para ejecutar.",
    });
  }

  let moved = 0;
  const failures: string[] = [];
  const affected = new Set<string>();
  for (const m of plan.move) {
    const target = orders.find((o) => o.id === m.toOrderId);
    // `match_method` pasa a 'manual': el vínculo ya no lo sostiene el teléfono
    // sino el número escrito en la guía, contrastado. Dejarlo en 'phone' haría
    // que la siguiente pasada volviera a examinarlo para siempre.
    //
    // La guarda `eq(order_id, fromOrderId)` protege de una carrera: si alguien
    // la movió entre el plan y esto, no se pisa su decisión.
    const { error, count } = await admin
      .from("shipments")
      .update(
        {
          order_id: m.toOrderId,
          order_name: m.toOrderName,
          store_id: target?.store_id,
          matched: true,
          match_method: "manual",
        },
        { count: "exact" },
      )
      .eq("id", m.shipmentId)
      .eq("order_id", m.fromOrderId);
    if (error) {
      failures.push(`${m.guideCode}: ${error.message}`);
      continue;
    }
    if (!count) continue;
    moved++;
    affected.add(m.fromOrderId);
    affected.add(m.toOrderId);

    // El movimiento queda escrito en los DOS pedidos: al que la pierde también
    // le cambia el desenlace, y sin la nota su historial tendría un hueco.
    await admin.from("order_events").insert([
      {
        store_id: target?.store_id,
        order_id: m.fromOrderId,
        kind: "comment",
        occurred_at: new Date().toISOString(),
        source: "system",
        courier: "aliclik",
        guide_code: m.guideCode,
        shipment_id: m.shipmentId,
        reason: "guia_reasignada",
        note: `La guía ${m.guideCode} se movió a ${m.toOrderName}: estaba acá solo por coincidencia de teléfono y su código señala ese pedido.`,
        payload: {},
      },
      {
        store_id: target?.store_id,
        order_id: m.toOrderId,
        kind: "comment",
        occurred_at: new Date().toISOString(),
        source: "system",
        courier: "aliclik",
        guide_code: m.guideCode,
        shipment_id: m.shipmentId,
        reason: "guia_reasignada",
        note: `La guía ${m.guideCode} se reasignó a este pedido; colgaba de otro por coincidencia de teléfono.`,
        payload: {},
      },
    ]);
  }

  // Los dos extremos de cada movimiento cambian de etapa: uno pierde una guía y
  // el otro estrena la suya.
  const master = await recomputeOrderMasterSafe(admin, [...affected]);

  return NextResponse.json({
    ok: true,
    dryRun: false,
    scanned: guides.length,
    moved,
    skipped: skippedByReason,
    masterRecomputed: master.written,
    masterFailed: master.failed,
    failures: failures.slice(0, 20),
    failureCount: failures.length,
  });
}

export async function GET(req: NextRequest) {
  return run(req);
}
export async function POST(req: NextRequest) {
  return run(req);
}
