/**
 * Devuelve a su pedido las guías que el teléfono enlazó al pedido equivocado.
 *
 * Uso local autorizado:
 *   pnpm exec tsx scripts/reenlazar-guias-por-codigo.ts           # solo diagnostica
 *   pnpm exec tsx scripts/reenlazar-guias-por-codigo.ts --apply   # escribe
 *
 * QUÉ PASÓ. El importador empareja por teléfono cuando la fila del reporte no
 * trae referencia de pedido, y exige que solo un pedido lleve ese número. Ese
 * «uno» se leía como *solo hay uno* cuando significaba *solo he ingerido uno*:
 * si el pedido de la guía aún no había llegado desde Shopify, el teléfono
 * señalaba a un pedido ANTERIOR del mismo cliente y la guía se colgaba de él.
 * Ocurrió 17 veces entre el 01-07 y el 23-07-2026; los 17 dueños reales
 * entraron al Master en la carga del 26-07 y nadie volvió a mirar los enlaces.
 *
 * QUÉ LO HACE REPARABLE SIN ADIVINAR. El código impreso de seis dígitos ES el
 * número del pedido —1.162 de 1.179 lo cumplen, y ninguna de las 2.853 guías de
 * 7 y 12 dígitos lo hace—, así que el propio paquete dice de quién era. Una
 * coincidencia de seis dígitos contra un pedido concreto es una entre un millón.
 *
 * AQUÍ NO HAY DATOS CONTAMINADOS. La fila describe al paquete, y el paquete
 * siempre fue el mismo: lo único que estaba mal era a qué pedido apuntaba. Se
 * reescribe el vínculo y nada más.
 *
 * LO QUE SÍ CAMBIA DE ESTADO, y hay que saberlo antes de correrlo: el pedido que
 * pierde la guía vuelve a figurar SIN salida. Si era su única guía, retrocede a
 * preparación. Es lo correcto —nunca despachó ese paquete— pero mueve 17 pedidos
 * en el Master, así que conviene avisar a la operación el mismo día.
 */
import { existsSync, readFileSync } from "node:fs";

function loadEnvFile(path: string) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (!key || process.env[key]) continue;
    let value = (rawValue ?? "").trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadEnvFile(".env.production.local");
loadEnvFile(".env.local");

const PAGE = 500;

interface Ship {
  id: string;
  guide_code: string;
  order_id: string;
  order_name: string | null;
  store_id: string;
  match_method: string | null;
  delivery_status: string | null;
  created_at: string | null;
}
interface Order {
  id: string;
  name: string;
  store_id: string;
  customer_phone: string | null;
}

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const { createAdminSupabase } = await import("@/lib/db");
  const { orderRefInGuideCode } = await import("@/lib/shipment-match");
  const { normalizePhone } = await import("@/lib/phone");
  const { recomputeOrderMaster } = await import("@/lib/order-master");
  const admin = createAdminSupabase();

  // 1. Guías cuyo código nombra un pedido.
  const named: { ship: Ship; ref: string }[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from("shipments")
      .select("id,guide_code,order_id,order_name,store_id,match_method,delivery_status,created_at")
      .eq("courier", "aliclik")
      .ilike("guide_code", "AUR5X%")
      .not("order_id", "is", null)
      .order("created_at", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const page = (data ?? []) as Ship[];
    for (const ship of page) {
      const ref = orderRefInGuideCode(ship.guide_code);
      if (ref) named.push({ ship, ref });
    }
    if (page.length < PAGE) break;
  }
  console.log(`Guías cuyo código nombra un pedido: ${named.length}`);

  // 2. El pedido al que cuelgan hoy y el que el código nombra.
  const orders = new Map<string, Order>();
  const put = (rows: Order[] | null) => {
    for (const o of rows ?? []) orders.set(o.id, o);
  };
  for (const chunk of chunked([...new Set(named.map((n) => n.ship.order_id))], 200)) {
    const { data, error } = await admin
      .from("orders")
      .select("id,name,store_id,customer_phone")
      .in("id", chunk);
    if (error) throw error;
    put(data as Order[] | null);
  }
  const byDigits = new Map<string, Order[]>();
  for (const chunk of chunked([...new Set(named.map((n) => n.ref))], 100)) {
    for (const ref of chunk) {
      const { data, error } = await admin
        .from("orders")
        .select("id,name,store_id,customer_phone")
        .ilike("name", `%${ref}`);
      if (error) throw error;
      const exact = ((data ?? []) as Order[]).filter(
        (o) => o.name.replace(/\D/g, "") === ref,
      );
      byDigits.set(ref, exact);
      for (const o of exact) orders.set(o.id, o);
    }
  }

  // 3. Las que cuelgan de un pedido que NO es el que su código nombra.
  const repairs: { ship: Ship; from: Order; to: Order }[] = [];
  const unresolved: { ship: Ship; ref: string; reason: string }[] = [];
  for (const { ship, ref } of named) {
    const linked = orders.get(ship.order_id);
    if (!linked) continue;
    if (linked.name.replace(/\D/g, "") === ref) continue; // ya está en el suyo

    const owners = byDigits.get(ref) ?? [];
    if (owners.length !== 1) {
      unresolved.push({
        ship,
        ref,
        reason: owners.length ? `${owners.length} pedidos con el nº ${ref}` : `no existe el pedido ${ref}`,
      });
      continue;
    }
    const owner = owners[0]!;
    // El teléfono compartido es la firma del caso: el mismo cliente con dos
    // pedidos. Sin él, la guía llegó ahí por otro camino y no es este arreglo.
    if (normalizePhone(owner.customer_phone) !== normalizePhone(linked.customer_phone)) {
      unresolved.push({ ship, ref, reason: `${owner.name} tiene otro teléfono` });
      continue;
    }
    repairs.push({ ship, from: linked, to: owner });
  }

  console.log(`\n=== A reenlazar: ${repairs.length} ===`);
  for (const r of repairs) {
    console.log(
      `${r.ship.guide_code}  ${r.from.name} → ${r.to.name}` +
        `   (${r.ship.match_method}, ${r.ship.delivery_status}, ${r.ship.created_at})`,
    );
  }
  if (unresolved.length) {
    console.log(`\n=== Para revisar a mano: ${unresolved.length} ===`);
    for (const u of unresolved) console.log(`${u.ship.guide_code}: ${u.reason}`);
  }
  if (!repairs.length) return;

  console.log(
    `\nOJO: ${new Set(repairs.map((r) => r.from.id)).size} pedidos se quedan sin esta guía y` +
      " vuelven a figurar sin salida. Si era la única, retroceden a preparación.",
  );

  if (!apply) {
    console.log("\n(ensayo — volver a correr con --apply para escribir)");
    return;
  }

  let written = 0;
  for (const r of repairs) {
    const { data, error } = await admin
      .from("shipments")
      .update({
        order_id: r.to.id,
        order_name: r.to.name,
        store_id: r.to.store_id,
        matched: true,
        match_method: "guide_code",
      })
      .eq("id", r.ship.id)
      // Guarda contra una carrera: si algo lo movió mientras diagnosticábamos,
      // este UPDATE no encuentra fila y no pisa nada.
      .eq("order_id", r.from.id)
      .select("id");
    if (error) {
      console.log(`FALLÓ ${r.ship.guide_code}: ${error.message}`);
      continue;
    }
    if (!(data ?? []).length) {
      console.log(`SALTADA ${r.ship.guide_code}: la fila cambió durante el diagnóstico.`);
      continue;
    }
    written += 1;
  }
  console.log(`\nReenlazadas: ${written}`);

  // El Master es derivado: hay que recalcular los DOS lados de cada mudanza.
  const touched = [...new Set(repairs.flatMap((r) => [r.from.id, r.to.id]))];
  const result = await recomputeOrderMaster(admin, touched);
  console.log(`Master recalculado: ${result.written}/${result.requested} pedidos.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
