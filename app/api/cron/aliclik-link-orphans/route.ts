import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createAdminSupabase } from "@/lib/db";
import { chunk } from "@/lib/access";
import { describeRecompute, recomputeOrderMasterSafe } from "@/lib/order-master";
import {
  planOrphanLinks,
  type MasterOrder,
  type OrphanShipment,
} from "@/lib/aliclik-orphans";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Reenganche de guías Aliclik huérfanas a su pedido.
//
// DE UNA SOLA VEZ, NO EN EL CRON DIARIO. Esto limpia un pasivo histórico: las
// guías que entraron por reportes y el importador no logró casar. No se agenda
// en vercel.json — se dispara a mano con el secreto, en tandas (`?limit=`),
// hasta que `pendientes` llegue a cero. Es idempotente: una guía ya enganchada
// deja de ser huérfana y no se vuelve a tocar.
//
// La raíz —por qué el importador deja huérfanas— es harina de otro costal y se
// aborda aparte; esto solo repara lo ya acumulado.

/** Tamaño de tanda por defecto. Acotado para no pasarse de `maxDuration`. */
const BATCH = 400;

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
  const limit = Math.min(
    2000,
    Math.max(1, Number(req.nextUrl.searchParams.get("limit") ?? BATCH) || BATCH),
  );
  // Sin escritura por defecto: la primera pasada informa qué haría. Con
  // `?apply=true` ejecuta. Evita un backfill de miles de filas por un clic.
  const apply = req.nextUrl.searchParams.get("apply") === "true";

  // 1. Guías Aliclik huérfanas: existen, con estado, pero sin pedido.
  const { data: orphanRows, error: orphanErr } = await admin
    .from("shipments")
    .select("id,order_name,store_id")
    .ilike("courier", "%ali%")
    .is("order_id", null)
    .not("order_name", "is", null)
    .limit(limit);
  if (orphanErr) return NextResponse.json({ ok: false, error: orphanErr.message }, { status: 500 });
  const orphans = (orphanRows ?? []) as OrphanShipment[];

  // 2. Sus pedidos en el Master, por nombre (único global).
  const names = [...new Set(orphans.map((o) => o.order_name))];
  const masters: MasterOrder[] = [];
  for (const batch of chunk(names, 200)) {
    const { data, error } = await admin
      .from("order_master")
      .select("order_id,order_name,store_id,guide_code")
      .in("order_name", batch);
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    masters.push(...((data ?? []) as MasterOrder[]));
  }

  // 3. Plan (puro).
  const plan = planOrphanLinks(orphans, masters);

  if (!apply) {
    return NextResponse.json({
      ok: true,
      dryRun: true,
      scanned: orphans.length,
      wouldLink: plan.link.length,
      skipped: plan.skipped,
      hint: "Añade ?apply=true para ejecutar.",
    });
  }

  // 4. Enganchar. El guard `order_id is null` protege ante una carrera: si otra
  //    operación ya la enganchó entre el SELECT y aquí, no se pisa.
  let linked = 0;
  const failures: string[] = [];
  const affectedOrders: string[] = [];
  for (const l of plan.link) {
    const { error, count } = await admin
      .from("shipments")
      .update(
        { order_id: l.orderId, store_id: l.storeId, matched: true, match_method: "report_backfill" },
        { count: "exact" },
      )
      .eq("id", l.shipmentId)
      .is("order_id", null);
    if (error) {
      failures.push(`${l.shipmentId}: ${error.message}`);
      continue;
    }
    if (count && count > 0) {
      linked += 1;
      affectedOrders.push(l.orderId);
    }
  }

  // 5. Recalcular el Master de los pedidos tocados (por tandas: la función lee
  //    las guías de cada pedido y reescribe su fila denormalizada).
  //
  //    Se cuenta lo ESCRITO, no lo pedido. Antes se informaba
  //    `recomputed: affectedOrders.length`, que es la lista de entrada: salía
  //    igual tanto si el recálculo funcionaba como si se caía entero, y una
  //    guía enganchada a un pedido cuyo Master no se refresca deja el pedido
  //    enseñando que nunca salió.
  let recomputed = 0;
  const masterFailures: string[] = [];
  for (const batch of chunk(affectedOrders, 200)) {
    const outcome = await recomputeOrderMasterSafe(admin, batch);
    recomputed += outcome.written;
    const trace = describeRecompute(outcome);
    if (trace) masterFailures.push(trace);
  }

  return NextResponse.json({
    ok: true,
    dryRun: false,
    scanned: orphans.length,
    linked,
    recomputeRequested: affectedOrders.length,
    recomputed,
    masterFailures: masterFailures.slice(0, 20),
    skipped: plan.skipped,
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
