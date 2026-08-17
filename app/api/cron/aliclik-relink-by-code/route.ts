import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createAdminSupabase } from "@/lib/db";
import { chunk } from "@/lib/access";
import { describeRecompute, recomputeOrderMasterSafe } from "@/lib/order-master";
import { orderRefInGuideCode } from "@/lib/shipment-match";
import {
  ordersTouchedBy,
  planRelinkByGuideCode,
  type RelinkOrder,
  type RelinkShipment,
} from "@/lib/aliclik-relink";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Reenganche de guías Aliclik al pedido que su código impreso nombra.
//
// DE UNA SOLA VEZ, NO EN EL CRON. Esto limpia un pasivo acotado: las guías que
// el importador enlazó por teléfono a un pedido anterior del mismo cliente
// porque el suyo aún no había llegado desde Shopify. El veto de `matchShipment`
// cierra esa puerta hacia adelante; esto repara lo que entró antes. No se agenda
// en vercel.json — se dispara a mano con el secreto. Es idempotente: una guía ya
// colgada de su pedido deja de aparecer en el plan.
//
// SIN ESCRITURA POR DEFECTO. La primera pasada informa qué haría. Con
// `?apply=true` ejecuta.
//
// LO QUE NO ES GRATIS, y por eso el ensayo lo dice antes: el pedido que pierde
// la guía vuelve a figurar SIN salida, y si era la única retrocede a
// preparación. Es lo correcto —nunca despachó ese paquete— pero mueve pedidos en
// el Master y la operación tiene que enterarse el mismo día.

/** Tamaño de página al recorrer las guías. */
const PAGE = 500;

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

  const admin = createAdminSupabase();
  const apply = req.nextUrl.searchParams.get("apply") === "true";

  // 1. Guías Aliclik con pedido cuyo código nombra un pedido (familia de 6
  //    dígitos). Las de 7 y 12 son identificadores de Aliclik y no dicen nada.
  const shipments: RelinkShipment[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from("shipments")
      .select("id,guide_code,order_id")
      .eq("courier", "aliclik")
      .ilike("guide_code", "AUR5X%")
      .not("order_id", "is", null)
      .order("created_at", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    const page = (data ?? []) as RelinkShipment[];
    for (const s of page) if (orderRefInGuideCode(s.guide_code)) shipments.push(s);
    if (page.length < PAGE) break;
  }

  // 2. Los pedidos en juego: del que cuelgan hoy, y el que el código nombra.
  const orders = new Map<string, RelinkOrder>();
  const put = (rows: RelinkOrder[] | null) => {
    for (const o of rows ?? []) orders.set(o.id, o);
  };
  for (const batch of chunk([...new Set(shipments.map((s) => s.order_id))], 200)) {
    const { data, error } = await admin
      .from("orders")
      .select("id,name,store_id,customer_phone")
      .in("id", batch);
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    put(data as RelinkOrder[] | null);
  }
  // El pedido que el código nombra puede no estar entre los anteriores —de eso
  // se trata—, así que se busca por su número. `ilike '%nnnnnn'` acota en la
  // base y el filtro exacto lo hace el plan.
  for (const ref of new Set(shipments.map((s) => orderRefInGuideCode(s.guide_code)!))) {
    const { data, error } = await admin
      .from("orders")
      .select("id,name,store_id,customer_phone")
      .ilike("name", `%${ref}`);
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    put(((data ?? []) as RelinkOrder[]).filter((o) => o.name.replace(/\D/g, "") === ref));
  }

  // 3. Plan (puro).
  const plan = planRelinkByGuideCode(shipments, [...orders.values()]);

  if (!apply) {
    return NextResponse.json({
      ok: true,
      dryRun: true,
      scanned: shipments.length,
      wouldRelink: plan.relink.length,
      relink: plan.relink,
      review: plan.review,
      ordersLosingTheirGuide: [...new Set(plan.relink.map((r) => r.fromOrderName))],
      hint: "Añade ?apply=true para ejecutar.",
    });
  }

  // 4. Reenlazar. El guard por `order_id` de origen protege ante una carrera: si
  //    algo la movió entre el plan y aquí, este UPDATE no encuentra fila.
  let relinked = 0;
  const failures: string[] = [];
  for (const r of plan.relink) {
    const { error, count } = await admin
      .from("shipments")
      .update(
        {
          order_id: r.toOrderId,
          order_name: r.toOrderName,
          store_id: r.toStoreId,
          matched: true,
          match_method: "guide_code",
        },
        { count: "exact" },
      )
      .eq("id", r.shipmentId)
      .eq("order_id", r.fromOrderId);
    if (error) {
      failures.push(`${r.guideCode}: ${error.message}`);
      continue;
    }
    if (count && count > 0) relinked += 1;
    else failures.push(`${r.guideCode}: la fila cambió durante el plan, no se tocó`);
  }

  // 5. Recalcular los DOS lados de cada mudanza. El Master es derivado: sin esto
  //    el pedido que gana la guía seguiría figurando sin salida y el que la
  //    pierde seguiría cargando el desenlace de un paquete ajeno.
  const touched = ordersTouchedBy(plan.relink);
  let recomputed = 0;
  const masterFailures: string[] = [];
  for (const batch of chunk(touched, 200)) {
    const outcome = await recomputeOrderMasterSafe(admin, batch);
    recomputed += outcome.written;
    const trace = describeRecompute(outcome);
    if (trace) masterFailures.push(trace);
  }

  return NextResponse.json({
    ok: true,
    dryRun: false,
    scanned: shipments.length,
    relinked,
    relinkFailures: failures.slice(0, 20),
    relinkFailureCount: failures.length,
    recomputeRequested: touched.length,
    recomputed,
    masterFailures: masterFailures.slice(0, 20),
    review: plan.review,
  });
}

export async function GET(req: NextRequest) {
  return run(req);
}
export async function POST(req: NextRequest) {
  return run(req);
}
