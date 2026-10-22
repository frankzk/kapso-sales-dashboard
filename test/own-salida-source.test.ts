import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { GF_NOTEBOOK_COURIERS, OWN_NOTEBOOK_CREATED_VIA, OWN_NOTEBOOK_DELIVERED_SOURCE } from "@/lib/own-salida";

// Quién rellena la caja «por definir» de una entrega del cuaderno de Grupo GF
// (lib/own-salida.ts, decisión del dueño del 19-10-2026): las dos puertas por
// las que entra esa entrega y el relleno de lo que ya estaba aplicado (0270).

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

function bodyOf(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, signature).toBeGreaterThan(-1);
  const rest = source.slice(start + signature.length);
  const end = rest.search(/\nexport (async )?function |\n\/\/ -{20,}/);
  return rest.slice(0, end === -1 ? undefined : end);
}

describe("Liquidaciones 2 «Aplicar al Master» rellena la caja de lo que entregó", () => {
  const body = bodyOf(read("app/dashboard/liquidaciones-2/actions.ts"), "export async function applyCuadernoRowsToMaster(");

  it("después de la puerta, solo con lo que la puerta entregó y con el día del cuaderno", () => {
    expect(body).toContain("if (hasNotebookDate(fecha)) boxes.push({ orderId, orderName: m.order_name, courier, deliveredAt: occurredAt });");
    expect(body).toContain("const done = new Set(door.applied);");
    expect(body).toContain("const ownBoxes = boxes.filter((box) => done.has(box.orderId));");
    expect(body).toContain("await fillOwnSalidas(g.admin, ownBoxes)");
    expect(body.indexOf("await applyDeliveriesToMaster(g.admin, items)")).toBeLessThan(body.indexOf("await fillOwnSalidas("));
  });
  it("el día de la caja es el del evento de la entrega, y una fecha futura se acota a hoy como en la carga histórica", () => {
    expect(body).toContain("const at = fecha ? `${fecha}T17:00:00.000Z` : now;");
    expect(body).toContain("const occurredAt = at > now ? now : at;");
    expect(body).toContain("      occurredAt,\n");
    expect(read("scripts/apply-cuaderno-history-to-master.ts")).toContain("return at > now ? now : at;");
  });
  it("recalcula lo rellenado y lo dice en el aviso; si no puede leer las cajas, la entrega queda y lo cuenta", () => {
    expect(body).toContain("if (salidas.filled.length) await recomputeOrderMasterSafe(g.admin, salidas.filled);");
    expect(body).toContain("...(summary.salidas ? ownSalidaNotice(summary.salidas) : []),");
    expect(body).toMatch(/\} catch \{\n\s+summary\.salidas = \{ filled: \[\], sinSalida: \[\], otraSalidaViva: \[\], porRevisar: \[\], errors: ownBoxes\.map/);
  });
  it("una entrega de Grupo GF sin día en la fila no rellena la caja y el aviso la cuenta para revisar a mano", () => {
    expect(body).toContain("else if (isGfNotebookCourier(courier)) undated.push(orderId);");
    expect(body).toContain("const undatedDone = undated.filter((orderId) => done.has(orderId));");
    expect(body).toContain("if (undatedDone.length) summary.salidas.porRevisar.push(...undatedDone);");
  });
});

describe("la carga histórica del cuaderno rellena la caja de lo que aplicó", () => {
  const src = read("scripts/apply-cuaderno-history-to-master.ts");

  it("por lote, después de la puerta, con el mismo courier y el mismo instante que el evento", () => {
    expect(src).toContain("const done = new Set(result.applied);");
    expect(src).toContain(".filter(({ row }) => done.has(row.order_id) && hasNotebookDate(row.values.fecha))");
    expect(src).toContain("courier: courierOf(row), deliveredAt: occurredAt(row)");
    expect(src.indexOf("const result = await applyDeliveriesToMaster(")).toBeLessThan(src.indexOf("await fillOwnSalidas(admin, boxes)"));
    expect(src).toContain("if (fill.filled.length) await recomputeOrderMasterSafe(admin, fill.filled);");
  });
  it("lee el nombre del pedido para la guía interna", () => {
    expect(src).toContain('.select("order_id,store_id,order_name,general_status,');
  });
});

describe("el código mira las mismas filas del cuaderno que la 0270", () => {
  const src = read("lib/own-salida.ts");

  it("las filas de todas las hojas del pedido, con el efecto del estado en el dominio de su hoja", () => {
    expect(src).toContain('.select("order_id,sheet_id,fecha:values->>fecha,estado:values->>estado")');
    expect(src).toContain('.from("sheets").select("id,domain_id")');
    expect(src).toContain('.select("domain_id,code,effect")');
    expect(src).toContain('new Set(["devolucion", "anulacion", "sin_salida"])');
  });
});

describe("0270: el relleno de lo ya aplicado escribe lo mismo que el código", () => {
  const sql = read("db/migrations/0270_cuaderno_s01_fill.sql");
  const code = sql.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");

  it("mismos valores que ownSalidaRow", () => {
    expect(code).toContain("set courier = 'propio',");
    expect(code).toContain(`created_via = '${OWN_NOTEBOOK_CREATED_VIA}',`);
    expect(code).toContain(`delivered_source = '${OWN_NOTEBOOK_DELIVERED_SOURCE}',`);
    expect(code).toContain("delivery_status = 'entregado',");
    expect(code).toContain("status_category = 'delivered',");
    expect(code).toContain("dispatched_at = (t.fecha || 'T17:00:00Z')::timestamptz,");
    expect(code).toContain("closed_at = (t.fecha || 'T17:00:00Z')::timestamptz");
    expect(code).toContain("'-PROPIO-'");
    expect(code).toContain(`ov.rider in (${GF_NOTEBOOK_COURIERS.map((c) => `'${c}'`).sort().join(", ")})`);
  });
  it("las guardas de writeCourierGuide y un evento por salida rellenada", () => {
    for (const guard of [
      "and s.delivery_status = 'pendiente'",
      "and s.courier = 'por_definir'",
      "and s.created_via = 'mom_manual_route'",
      "and s.custody_transferred_at is null",
    ]) expect(code).toContain(guard);
    expect(code).toContain("select f.store_id, f.order_id, 'route_output_filled', now(), 'manual', 'propio', f.guide_code, f.id,");
    expect(code).toContain("    from filled f;");
    expect(code).toContain("jsonb_build_object('outputCode', f.output_code, 'previousCourier', 'por_definir', 'backfill', true,");
  });
  it("solo el objetivo: Lima en «Salida adicional activa», única caja viva y en la empresa, sin otra entregada, sin Urpi, sin fila posterior que lo contradiga", () => {
    for (const guard of [
      "where om.coverage = 'lima'",
      "and om.macro_stage = 'por_cerrar'",
      "and om.macro_substage = 'salida_adicional_activa'",
      "and x.returned_at is null",
      "and coalesce(x.custody_state, '') <> 'devuelto'",
      "where a.n_live = 1",
      "and coalesce(a.custody_state, 'empresa') = 'empresa'",
      "and a.preparation_state = 'listo_despacho'",
      "and ov.new_status = 'entregado'",
      "and not exists (select 1 from shipments y where y.order_id = p.order_id and y.delivery_status = 'entregado')",
      "and not exists (select 1 from urpi_report_rows r where r.order_id = p.order_id)",
      "and st.effect in ('devolucion', 'anulacion', 'sin_salida')",
      "and o.cancelled_at is null",
    ]) expect(code).toContain(guard);
  });
  it("sin transacción ni bloqueos propios: los pone quien aplica", () => {
    expect(code).not.toMatch(/^\s*(begin|commit|rollback)\s*;/im);
    expect(code).not.toMatch(/^\s*drop\s/im);
    expect(code).not.toMatch(/lock_timeout/i);
  });
  it("verify-db corre su prueba", () => {
    expect(read("scripts/verify-db.sh")).toContain('$PSQL -f "$ROOT/scripts/sql/cuaderno_s01_fill_smoke.sql"');
  });
});
