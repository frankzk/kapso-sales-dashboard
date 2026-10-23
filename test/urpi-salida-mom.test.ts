// La salida de Urpi rellenada lleva el día de la entrega, y la 0272 completa lo
// que ya estaba (23-10-2026): que lo que el MOM cita en §30.11 y §4 —los
// valores, la migración— sea lo que hacen el código y la migración. Las reglas,
// probadas en test/urpi-salida.test.ts y en scripts/sql/urpi_salida_fecha_smoke.sql.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { URPI_REPORT_CREATED_VIA, URPI_REPORT_DELIVERED_SOURCE, urpiSalidaRow } from "@/lib/urpi-salida";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const flat = (text: string) => text.replace(/\s+/g, " ");
const MOM = read("docs/mom/master-pedidos-v1.md");

/** El texto de una sección del MOM, desde su título hasta el siguiente del mismo nivel o superior. */
function section(title: string): string {
  const start = MOM.indexOf(title);
  expect(start, title).toBeGreaterThan(-1);
  const level = title.match(/^#+/)![0].length;
  const rest = MOM.slice(start + title.length);
  const next = rest.search(new RegExp(`\\n#{1,${level}} `));
  return flat(next === -1 ? rest : rest.slice(0, next));
}

describe("§30.11 la salida de Urpi se cierra el día de la entrega", () => {
  const s3011 = section("### 30.11 Resultados de entrega que reporta Urpi (05/10/2026)");

  it("los valores que cita son los que escribe el código", () => {
    const row = urpiSalidaRow("#KP1", "aaaaaaaa-0000-4000-8000-000000000001", "2026-08-10", "2026-08-12");
    expect(row).toMatchObject({ courier: "urpi", dispatched_at: "2026-08-10T17:00:00.000Z", closed_at: "2026-08-12T17:00:00.000Z" });
    expect(URPI_REPORT_CREATED_VIA).toBe("urpi_report");
    expect(URPI_REPORT_DELIVERED_SOURCE).toBe("urpi_report");
    expect(s3011).toContain(
      "con `dispatched_at` el mediodía de Lima del primer intento de Urpi y `closed_at` el mediodía de Lima de la fila más reciente, la «Entregado» (desde el 23-10-2026, abajo): cuando Kapta marca la entrega en ese mismo paso, es el mismo instante que su evento; en un pedido que ya estaba entregado (p. ej. por la carga histórica del cuaderno), es el día que dice Urpi, aunque el evento de su entrega sea de otro día.",
    );
    // El botón rellena cajas; no completa el `closed_at` de las ya rellenadas.
    expect(s3011).toContain(
      "La pantalla ofrece rellenar con el mismo botón las cajas «por definir» de los pedidos marcados antes de esta regla (05-10-2026); no completa el `closed_at` de las salidas ya rellenadas (eso lo hizo la 0272, abajo).",
    );
    // Sin fecha en esa fila, no se inventa una.
    expect(urpiSalidaRow("#KP1", "aaaaaaaa-0000-4000-8000-000000000001", "2026-08-10", null)).not.toHaveProperty("closed_at");
    expect(s3011).toContain("si esa fila no trae fecha, la salida se rellena sin `closed_at`, como antes.");
  });
  it("registra el porqué, lo medido y la migración", () => {
    expect(s3011).toContain("**El día de la entrega en la salida y las cajas viejas (23-10-2026).**");
    expect(s3011).toContain("el `delivered_at` de esos pedidos era el día en que se rellenó la caja, no el que dice Urpi.");
    expect(s3011).toContain("La migración 0272 lo completa en las 107 ya rellenadas (sin evento nuevo:");
    expect(s3011).toContain("32 pedidos entregados en Kapta y no anulados, con reportes del 10-08 al 22-08-2026");
    expect(s3011).toContain("Otros 13 con la misma caja no están entregados en Kapta (12 anulados en Shopify) y quedan fuera");
    expect(s3011).toContain("no se cierra ninguna liquidación");
    expect(s3011).toContain(
      "los 32 dejan «Salida adicional activa»: pasan a «Pendiente de liquidación», o a donde los lleve su liquidación si ya está cerrada;",
    );
    expect(s3011).toContain(
      "la 0272 —el `closed_at` de las 107 y el relleno de las 32— mueve el último movimiento de esos pedidos al día en que se aplica: es el día al que se imputa el costo (§14) y el que mira «Sin movimiento por 60 días» (§17.1).",
    );
  });
});

describe("§4 lo cita", () => {
  it("las dos cajas rellenadas ya entregadas llevan el día de la entrega", () => {
    expect(section("## 4. Identidad de las salidas")).toContain(
      "Las dos le escriben `closed_at` = el día de la entrega que dice el reporte o el cuaderno, que es de donde el Master saca el suyo.",
    );
  });
});

describe("el llamador pasa el día de la fila más reciente", () => {
  it("el mismo `latest` del que sale la entrega del Master", () => {
    const src = read("lib/urpi-report-apply.ts");
    expect(src).toContain("occurredAt: row.report_date ? `${row.report_date}T17:00:00.000Z` : new Date().toISOString(),");
    expect(src).toContain("dispatchedOn: firstDate.get(id) ?? null, deliveredOn: latest.get(id)!.report_date,");
  });
});

describe("0272: lo que escribe es lo que escribe el código", () => {
  const sql = read("db/migrations/0272_urpi_salida_fecha.sql");
  const code = sql.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");

  it("(1) closed_at de la fila más reciente «Entregado» con fecha, solo donde falta y sin evento", () => {
    // Los dos `latest` (pasos 1 y 2): la fila de mayor `urpi_row`, como el código.
    expect(code.match(/order by r\.order_id, r\.urpi_row desc/g)).toHaveLength(2);
    expect(code).toContain("set closed_at = (l.report_date + time '17:00') at time zone 'UTC'");
    for (const guard of [
      "and s.created_via = 'urpi_report'",
      "and s.delivery_status = 'entregado'",
      "and s.closed_at is null",
      "and l.result_code = 'entregado'",
      "and l.report_date is not null;",
    ]) expect(code).toContain(guard);
    // Un solo INSERT de eventos: el de (2), uno por salida rellenada.
    expect(code.match(/insert into order_events/g)).toHaveLength(1);
  });
  it("(2) mismos valores que urpiSalidaRow", () => {
    expect(code).toContain("set courier = 'urpi',");
    expect(code).toContain(`created_via = '${URPI_REPORT_CREATED_VIA}',`);
    expect(code).toContain(`delivered_source = '${URPI_REPORT_DELIVERED_SOURCE}',`);
    expect(code).toContain("delivery_status = 'entregado',");
    expect(code).toContain("status_category = 'delivered',");
    expect(code).toContain("dispatched_at = (t.first_on + time '17:00') at time zone 'UTC',");
    expect(code).toContain("closed_at = (t.delivered_on + time '17:00') at time zone 'UTC'");
    expect(code).toContain("'-URPI-'");
  });
  it("(2) la regla de planUrpiSalida, entregado en Kapta y no anulado", () => {
    for (const guard of [
      "where l.result_code = 'entregado'",
      "and om.general_status = 'entregado'",
      "and o.cancelled_at is null",
      "and not exists (select 1 from shipments y where y.order_id = om.order_id and y.courier = 'urpi' and y.delivery_status = 'entregado')",
      "where x.delivery_status in ('pendiente', 'en_ruta')",
      "and x.returned_at is null",
      "and coalesce(x.custody_state, '') <> 'devuelto'",
      "where l.n_live = 1",
      "and lower(btrim(l.courier)) = 'por_definir'",
      "and coalesce(l.custody_state, 'empresa') = 'empresa'",
    ]) expect(code).toContain(guard);
  });
  it("(2) las guardas de writeCourierGuide, sin choque de guía, y un evento por salida rellenada", () => {
    for (const guard of [
      "and s.delivery_status = 'pendiente'",
      "and s.courier = 'por_definir'",
      "and s.created_via = 'mom_manual_route'",
      "and s.custody_transferred_at is null",
      "and not exists (select 1 from shipments z where z.courier = 'urpi' and z.guide_code = t.guide_code)",
    ]) expect(code).toContain(guard);
    expect(code).toContain("select f.store_id, f.order_id, 'route_output_filled', now(), 'manual', 'urpi', f.guide_code, f.id,");
    expect(code).toContain("    from filled f;");
    expect(code).toContain("jsonb_build_object('outputCode', f.output_code, 'previousCourier', 'por_definir', 'backfill', true,");
    expect(code).toContain("'urpi_row', f.urpi_row, 'fecha', to_char(f.delivered_on, 'YYYY-MM-DD'))");
  });
  it("sin transacción ni bloqueos propios: los pone quien aplica", () => {
    expect(code).not.toMatch(/^\s*(begin|commit|rollback)\s*;/im);
    expect(code).not.toMatch(/^\s*drop\s/im);
    expect(code).not.toMatch(/lock_timeout/i);
  });
  it("verify-db corre su prueba", () => {
    expect(read("scripts/verify-db.sh")).toContain('$PSQL -f "$ROOT/scripts/sql/urpi_salida_fecha_smoke.sql"');
  });
});

describe("DEPLOY.md dice cómo aplicarla y qué esperar", () => {
  const deploy = read("DEPLOY.md");
  const entry = flat(deploy.slice(deploy.indexOf("### 23-10-2026 · La salida de Urpi lleva el día de la entrega")));

  it("aplicada después del código, con su transacción y los dos conteos previos", () => {
    expect(entry).toContain("**Migración `0272_urpi_salida_fecha.sql`, a mano y DESPUÉS del código.** **Ya aplicada en producción el 23-10-2026**, con el código ya desplegado");
    expect(entry).toContain("\\i db/migrations/0272_urpi_salida_fecha.sql");
    expect(entry).toContain("**Conteo previo 1** (solo lectura; el 23-10-2026, **107**,");
    expect(entry).toContain("**Conteo previo 2** (solo lectura; el 23-10-2026, **32**,");
    expect(entry).toContain("**Comprobación después** (solo lectura)");
  });
});
