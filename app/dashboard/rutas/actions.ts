"use server";

// Armar la ruta del día, entregarla al motorizado y cerrarla.
//
// El cierre es la razón de ser de todo el módulo: convierte las paradas ya
// reportadas en una liquidación normal (0054), con sus líneas YA vinculadas a
// su pedido. Por eso la liquidación de un motorizado propio no tiene cola de
// revisión — no hay que adivinar de quién es cada fila, se sabe desde que se le
// asignó la parada.

import { revalidatePath } from "next/cache";
import { createAdminSupabase } from "@/lib/db";
import { getAccessibleStores, getCurrentUser } from "@/lib/access";
import { getMasterPermissions } from "@/lib/permissions-access";
import { getRouteDetail, getRouteTariffs } from "@/lib/routes-access";
import {
  computeRoutePayout,
  groupByStore,
  masterEffects,
  routeTotals,
  stopsToSettlementLines,
} from "@/lib/routes";
import { recomputeOrderMasterSafe } from "@/lib/order-master";
import { defaultOperationalFor } from "@/lib/order-status";

export interface RouteActionResult {
  ok: boolean;
  error?: string;
  message?: string;
  routeId?: string;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

async function guard() {
  const user = await getCurrentUser();
  if (!user) return { error: "No autenticado." as const };
  const perms = await getMasterPermissions();
  if (!perms.can("routes.manage")) {
    return { error: "Tu rol no permite armar rutas." as const };
  }
  return { user, admin: createAdminSupabase() };
}

/**
 * Crea la ruta del día de un motorizado, o devuelve la que ya tiene. Es
 * idempotente por (tienda, motorizado, día): añadir paradas dos veces no crea
 * dos rutas, que es lo que pasaría si el coordinador vuelve atrás y reasigna.
 */
export async function ensureRoute(input: {
  storeId: string;
  riderId: string;
  routeDate: string;
}): Promise<RouteActionResult> {
  const g = await guard();
  if ("error" in g) return { ok: false, error: g.error };

  const stores = await getAccessibleStores();
  const store = stores.find((s) => s.id === input.storeId);
  if (!store) return { ok: false, error: "Tienda inválida o sin acceso." };

  // Desde 0057 la ruta es del MOTORIZADO y del DÍA: si ya tiene una, se le
  // añaden paradas a esa, mezcle las tiendas que mezcle. Buscarla por tienda
  // crearía una segunda ruta que el índice único rechaza.
  const { data: existing } = await g.admin
    .from("delivery_routes")
    .select("id")
    .eq("org_id", store.org_id)
    .eq("rider_id", input.riderId)
    .eq("route_date", input.routeDate)
    .maybeSingle();
  if (existing?.id) return { ok: true, routeId: existing.id as string, message: "Ruta existente." };

  const { data, error } = await g.admin
    .from("delivery_routes")
    .insert({
      org_id: store.org_id,
      store_id: input.storeId,
      rider_id: input.riderId,
      route_date: input.routeDate,
      created_by: g.user.id,
    })
    .select("id")
    .single();
  if (error || !data?.id) return { ok: false, error: error?.message ?? "No se pudo crear la ruta." };

  revalidatePath("/dashboard/rutas");
  return { ok: true, routeId: data.id as string, message: "Ruta creada." };
}

/** Añade pedidos a una ruta. Los que ya estaban se ignoran, no fallan. */
export async function addStops(routeId: string, orderIds: string[]): Promise<RouteActionResult> {
  const g = await guard();
  if ("error" in g) return { ok: false, error: g.error };
  if (!orderIds.length) return { ok: false, error: "No elegiste ningún pedido." };

  const { data: route } = await g.admin
    .from("delivery_routes")
    .select("id,store_id,status")
    .eq("id", routeId)
    .maybeSingle();
  const r = route as { store_id?: string; status?: string } | null;
  const stores = await getAccessibleStores();
  if (!r?.store_id || !stores.some((s) => s.id === r.store_id)) {
    return { ok: false, error: "Ruta inexistente o sin acceso." };
  }
  if (r.status === "cerrada") return { ok: false, error: "La ruta ya está cerrada." };

  const { data: last } = await g.admin
    .from("delivery_stops")
    .select("seq")
    .eq("route_id", routeId)
    .order("seq", { ascending: false })
    .limit(1)
    .maybeSingle();
  let seq = ((last as { seq?: number } | null)?.seq ?? 0) + 1;

  // La tienda de la parada sale del PEDIDO, no de la ruta: una ruta puede
  // mezclar tiendas (0057) y es lo que luego agrupa las liquidaciones.
  const { data: orderRows } = await g.admin
    .from("orders")
    .select("id,store_id")
    .in("id", orderIds);
  const storeOf = new Map(
    ((orderRows ?? []) as { id: string; store_id: string }[]).map((o) => [o.id, o.store_id]),
  );
  const unknown = orderIds.filter((id) => !storeOf.has(id));
  if (unknown.length) {
    return { ok: false, error: `${unknown.length} pedido(s) no existen o no son accesibles.` };
  }

  const rows = orderIds.map((orderId) => ({
    route_id: routeId,
    order_id: orderId,
    store_id: storeOf.get(orderId)!,
    seq: seq++,
  }));
  // `upsert` con ignoreDuplicates: reasignar un pedido que ya estaba en la ruta
  // no debe romper la operación entera ni reiniciar su estado.
  const { error } = await g.admin
    .from("delivery_stops")
    .upsert(rows, { onConflict: "route_id,order_id", ignoreDuplicates: true });
  if (error) return { ok: false, error: error.message };

  revalidatePath("/dashboard/rutas");
  return { ok: true, message: `${rows.length} parada(s) añadida(s).` };
}

/** Quita una parada. Solo si nadie la reportó: lo reportado no se borra. */
export async function removeStop(stopId: string): Promise<RouteActionResult> {
  const g = await guard();
  if ("error" in g) return { ok: false, error: g.error };

  const { data: stop } = await g.admin
    .from("delivery_stops")
    .select("id,status,route_id")
    .eq("id", stopId)
    .maybeSingle();
  const s = stop as { status?: string } | null;
  if (!s) return { ok: false, error: "Parada inexistente." };
  if (s.status !== "pendiente") {
    return {
      ok: false,
      error: "Esa parada ya fue reportada por el motorizado; no se borra.",
    };
  }

  const { error } = await g.admin.from("delivery_stops").delete().eq("id", stopId);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/dashboard/rutas");
  return { ok: true, message: "Parada quitada." };
}

/** Entrega la ruta al motorizado: a partir de aquí la ve en su teléfono. */
export async function startRoute(routeId: string): Promise<RouteActionResult> {
  const g = await guard();
  if ("error" in g) return { ok: false, error: g.error };

  const detail = await getRouteDetail(routeId);
  if (!detail) return { ok: false, error: "Ruta inexistente o sin acceso." };
  if (detail.route.status !== "planificada") {
    return { ok: false, error: "La ruta ya fue entregada." };
  }
  if (!detail.stops.length) {
    return { ok: false, error: "La ruta no tiene paradas todavía." };
  }

  const { error } = await g.admin
    .from("delivery_routes")
    .update({ status: "en_curso", started_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", routeId);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/dashboard/rutas");
  return { ok: true, message: "Ruta entregada. Ya le aparece en su teléfono." };
}

/**
 * Cierra la ruta y genera su liquidación.
 *
 * Lo que declara el motorizado se convierte en líneas de liquidación con su
 * `order_id` puesto, así que el cuadre contra el Master sale directo. El efectivo
 * declarado es la suma de lo que reportó cobrar en efectivo — el coordinador lo
 * ajusta después si al contar el dinero sale otra cosa, y ESA diferencia es
 * justamente la que el cuadre del depósito tiene que enseñar.
 */
export async function closeRoute(
  routeId: string,
  opts: { force?: boolean } = {},
): Promise<RouteActionResult> {
  const g = await guard();
  if ("error" in g) return { ok: false, error: g.error };

  const detail = await getRouteDetail(routeId);
  if (!detail) return { ok: false, error: "Ruta inexistente o sin acceso." };
  const { route, stops } = detail;
  if (route.status === "cerrada") return { ok: false, error: "La ruta ya está cerrada." };

  const totals = routeTotals(stops);
  if (!totals.completa && !opts.force) {
    return {
      ok: false,
      error: `Quedan ${totals.pendientes} parada(s) sin reportar. Espera a que las cierre o ciérrala igual a conciencia.`,
    };
  }

  const stores = await getAccessibleStores();
  const { data: rider } = await g.admin
    .from("riders")
    .select("full_name")
    .eq("id", route.rider_id)
    .maybeSingle();
  const riderName = (rider as { full_name?: string } | null)?.full_name ?? null;

  // Una ruta puede mezclar tiendas (0057): el viaje es uno, pero el dinero y el
  // cuadre son por tienda, así que sale una liquidación por cada una.
  const byStore = groupByStore(stops);
  if (byStore.size === 0) {
    return { ok: false, error: "Las paradas no tienen tienda asignada." };
  }

  const created: string[] = [];
  const problems: string[] = [];

  for (const [storeId, storeStops] of byStore) {
    const store = stores.find((s) => s.id === storeId);
    if (!store) {
      problems.push("Hay paradas de una tienda a la que no tienes acceso; quedaron sin liquidar.");
      continue;
    }
    const t = routeTotals(storeStops);

    const { data: head, error: headErr } = await g.admin
      .from("rider_settlements")
      .insert({
        org_id: store.org_id,
        store_id: storeId,
        rider_id: route.rider_id,
        rider_name_raw: riderName,
        settlement_date: route.route_date,
        source: "ruta",
        route_id: routeId,
        // Solo el EFECTIVO pasa por sus manos y es lo que tiene que entregar.
        // El Yape cae a la cuenta de la empresa y el POS lo cobra el terminal:
        // contarlos como depósito suyo le sacaría un faltante inventado todos
        // los días, por el importe exacto de lo que cobró por esos canales.
        declared_cash: t.efectivo,
        declared_yape: 0,
        direct_collected: round2(t.yape + t.pos),
        note:
          t.yape + t.pos > 0
            ? `Cobrado directo a la empresa: S/ ${(t.yape + t.pos).toFixed(2)} ` +
              `(Yape S/ ${t.yape.toFixed(2)}, POS S/ ${t.pos.toFixed(2)}).`
            : null,
        created_by: g.user.id,
      })
      .select("id")
      .single();
    if (headErr || !head?.id) {
      problems.push(`${store.name}: ${headErr?.message ?? "no se pudo crear la liquidación"}`);
      continue;
    }
    const settlementId = head.id as string;

    const lines = stopsToSettlementLines(storeStops).map((l) => ({
      settlement_id: settlementId,
      order_id: l.order_id,
      guide_code: null,
      order_name: null,
      declared_status: l.declared_status,
      declared_amount: l.declared_amount,
      declared_fee: null,
      customer_name: null,
      district: null,
      match_status: l.match_status,
      raw: l.raw,
    }));
    if (lines.length) {
      const { error: linesErr } = await g.admin.from("rider_settlement_lines").insert(lines);
      if (linesErr) {
        // Sin líneas la liquidación mentiría (parecería un día sin entregas), así
        // que se deshace en vez de dejar una cabecera vacía.
        await g.admin.from("rider_settlements").delete().eq("id", settlementId);
        problems.push(`${store.name}: no se pudieron guardar las líneas (${linesErr.message}).`);
        continue;
      }
    }
    created.push(store.name);
  }

  if (!created.length) {
    return { ok: false, error: problems.join(" ") || "No se pudo crear ninguna liquidación." };
  }

  // El Master, por el camino de siempre: un evento por pedido y recálculo. Es
  // el único momento en que el Master se entera de lo que hizo un motorizado
  // propio, porque detrás no viene el reporte de ningún courier.
  const effects = masterEffects(stops);
  let applied = 0;
  if (effects.length) {
    const storeOf = new Map(stops.map((s) => [s.order_id, s.store_id]));
    const events = effects.map((e) => ({
      store_id: storeOf.get(e.order_id) ?? null,
      order_id: e.order_id,
      kind: "status_override",
      occurred_at: new Date().toISOString(),
      actor: g.user.id,
      source: "ruta",
      new_status: e.target,
      new_operational: defaultOperationalFor(e.target),
      reason: e.reason,
      payload: { route_id: routeId },
    }));
    const { error: evErr } = await g.admin.from("order_events").insert(events);
    if (evErr) problems.push(`No se pudo actualizar el Master: ${evErr.message}`);
    else {
      applied = effects.length;
      await recomputeOrderMasterSafe(
        g.admin,
        effects.map((e) => e.order_id),
      );
    }
  }

  await g.admin
    .from("delivery_routes")
    .update({
      status: "cerrada",
      closed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", routeId);

  const tariffs = await getRouteTariffs();
  const payout = computeRoutePayout(
    stops,
    tariffs,
    { storeId: byStore.keys().next().value as string, courier: null, region: null, province: null, district: null },
    route.route_date,
  );

  revalidatePath("/dashboard/rutas");
  revalidatePath("/dashboard/liquidaciones");
  revalidatePath("/dashboard/pedidos");

  const pago =
    payout.missingTariffs > 0
      ? " Falta definir la tarifa de entrega del motorizado en Costos para poder fijar su pago."
      : ` Le corresponden S/ ${payout.amount.toFixed(2)} por ${payout.entregas} entrega(s).`;

  return {
    ok: true,
    message:
      `Ruta cerrada. ${created.length} liquidación(es) creada(s) (${created.join(", ")}). ` +
      `${applied} pedido(s) actualizados en el Master.${pago}` +
      (problems.length ? ` Ojo: ${problems.join(" ")}` : ""),
  };
}

/**
 * Le da acceso web a un motorizado: crea (o encuentra) su usuario por correo,
 * lo hace `motorizado` de la organización y lo ata a su ficha.
 *
 * Es un solo botón a propósito. Hacerlo en dos pasos —invitar por Equipo y
 * luego atar la ficha— deja la puerta abierta a un motorizado con usuario pero
 * sin ficha, que entra a /reparto y no ve nada sin entender por qué.
 */
export async function linkRiderAccount(
  riderId: string,
  email: string,
): Promise<RouteActionResult> {
  const g = await guard();
  if ("error" in g) return { ok: false, error: g.error };

  const clean = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean)) {
    return { ok: false, error: "Ese correo no parece válido." };
  }

  const stores = await getAccessibleStores();
  if (!stores.length) return { ok: false, error: "Sin tiendas accesibles." };
  const orgId = stores[0]!.org_id;

  const { data: rider } = await g.admin
    .from("riders")
    .select("id,org_id,full_name")
    .eq("id", riderId)
    .maybeSingle();
  const r = rider as { org_id?: string; full_name?: string } | null;
  if (!r || r.org_id !== orgId) return { ok: false, error: "Motorizado inexistente o de otra organización." };

  // Buscar el usuario existente antes de invitar: invitar a alguien que ya
  // tiene cuenta le rompería la sesión que ya usa.
  let userId: string | null = null;
  for (let page = 1; page <= 10 && !userId; page++) {
    const { data, error } = await g.admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) break;
    const found = data?.users?.find((u) => (u.email ?? "").toLowerCase() === clean);
    if (found) userId = found.id;
    if (!data?.users?.length || data.users.length < 200) break;
  }

  let notice = "";
  if (!userId) {
    const { data, error } = await g.admin.auth.admin.inviteUserByEmail(clean);
    if (!error && data?.user) {
      userId = data.user.id;
      notice = ` Se le envió la invitación a ${clean}.`;
    } else {
      // Sin SMTP configurado se crea igual: podrá entrar con enlace mágico
      // desde la pantalla de acceso, que es como entra el resto del equipo.
      const created = await g.admin.auth.admin.createUser({ email: clean, email_confirm: false });
      if (created.error || !created.data?.user) {
        return { ok: false, error: `No se pudo crear el usuario: ${error?.message ?? created.error?.message}` };
      }
      userId = created.data.user.id;
      notice = ` Cuenta creada; que entre con "enlace mágico" usando ${clean}.`;
    }
  }

  const { error: memErr } = await g.admin
    .from("memberships")
    .upsert({ user_id: userId, org_id: orgId, role: "motorizado" }, { onConflict: "user_id,org_id" });
  if (memErr) return { ok: false, error: memErr.message };

  const { error: linkErr } = await g.admin
    .from("riders")
    .update({ user_id: userId, updated_at: new Date().toISOString() })
    .eq("id", riderId);
  if (linkErr) {
    const msg = linkErr.message.includes("riders_user_idx")
      ? "Ese correo ya está asociado a otro motorizado."
      : linkErr.message;
    return { ok: false, error: msg };
  }

  revalidatePath("/dashboard/rutas");
  return { ok: true, message: `${r.full_name} ya puede entrar a /reparto.${notice}` };
}
