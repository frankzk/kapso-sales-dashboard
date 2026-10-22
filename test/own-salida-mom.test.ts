// La caja «por definir» de una entrega del cuaderno de Grupo GF pasa a su salida
// entregada (decisión del dueño del 19-10-2026): que lo que el MOM cita en §30.8,
// §29.13 y §4 —el módulo, los valores, la migración— sea lo que hace el código.
// Las reglas, probadas en test/own-salida-plan.test.ts y en
// scripts/sql/cuaderno_s01_fill_smoke.sql.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { OWN_NOTEBOOK_CREATED_VIA, OWN_NOTEBOOK_DELIVERED_SOURCE, ownSalidaRow } from "@/lib/own-salida";

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

describe("§30.8 la caja de Grupo GF se rellena", () => {
  const s308 = section("### 30.8 Cierre por pedido desde la hoja");

  it("registra la decisión, el módulo y la migración", () => {
    expect(s308).toContain("**La caja de Grupo GF se rellena (decisión del owner, 19-10-2026).**");
    expect(s308).toContain("(`lib/own-salida.ts`)");
    expect(s308).toContain("la migración 0270");
    expect(s308).toContain("**no se cierra ninguna liquidación**");
  });
  it("los valores que cita son los que escribe el código", () => {
    const row = ownSalidaRow("#KP1", "aaaaaaaa-0000-4000-8000-000000000001", "2026-08-03T17:00:00.000Z");
    expect(row.courier).toBe("propio");
    expect(s308).toContain(`courier \`propio\`, \`created_via\` y \`delivered_source\` \`${OWN_NOTEBOOK_CREATED_VIA}\``);
    expect(OWN_NOTEBOOK_DELIVERED_SOURCE).toBe(OWN_NOTEBOOK_CREATED_VIA);
    expect(row.guide_code).toBe("MOM-KP1-PROPIO-AAAAAAAA");
    expect(s308).toContain("la guía interna `MOM-<pedido>-PROPIO-<id>`");
    expect(row.dispatched_at).toBe(row.closed_at);
    expect(s308).toContain("`dispatched_at` = `closed_at` = el día del cuaderno a mediodía de Lima (17:00Z");
    // El costo no sale de `closed_at` sino del último movimiento, que el relleno mueve.
    expect(s308).toContain("La vigencia de la tarifa de Grupo GF no sale de ahí sino del último movimiento (§14).");
    expect(s308).toContain("toman la tarifa del Tarifario vigente ese día si su distrito la tiene");
    expect(s308).not.toContain("ownCostDay");
    // Una fecha futura del cuaderno se acota a hoy, como en la carga histórica.
    expect(s308).toContain("Una fecha futura del cuaderno es un error de tecleo: se acota a hoy");
  });
  it("cuándo no se toca", () => {
    expect(s308).toContain("**Solo si** es la única caja viva del pedido");
    expect(s308).toContain("una salida ya entregada (de cualquier courier) o filas del reporte de Urpi");
    expect(s308).toContain("es la misma guarda `cuaderno_contradicho` de la 0270");
    expect(s308).toContain("Una entrega de otro courier (Urpi incluido) no rellena nada.");
    // Lo que no se pudo actualizar no se reintenta al volver a aplicar: el
    // pedido ya está entregado (app/dashboard/liquidaciones-2/actions.ts).
    expect(s308).toContain("volver a aplicar no las reintenta, porque el pedido ya quedó entregado, así que también se revisan a mano.");
  });
});

describe("§29.13 y §4 lo citan", () => {
  it("§29.13: la salida propia rellenada por el cuaderno sí queda entregada", () => {
    expect(section("### 29.13 Despacho en dos pasos y el gesto único (19-09-2026)")).toContain(
      "salvo la caja «por definir» que rellena el cuaderno de Grupo GF (§30.8)",
    );
  });
  it("§4: quién rellena la caja «por definir» además de las guías de courier", () => {
    expect(section("## 4. Identidad de las salidas")).toContain(
      "**El reporte de Urpi y el cuaderno de Grupo GF también la rellenan, ya entregada**",
    );
  });
});
