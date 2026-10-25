// Grupo GF cobra lo de su Tarifario (mom-v1.31; decisión del dueño del
// 19-10-2026): que lo que el MOM cita en §14, §29.8 y §9.3 —funciones,
// pantalla, permiso, la fecha de la vigencia— sea lo que hace el código. Las
// reglas, probadas a fondo en test/gf-tariff-resolve.test.ts y
// test/gf-tariff-master.test.ts.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GF_TARIFF_PERMISSION_LABEL,
  GF_TARIFF_SCREEN_LABEL,
  liquidationCostBlock,
} from "@/lib/closure-blocks";
import { costDay } from "@/lib/costs";
import { MOM_RESOLUTION_VERSION } from "@/lib/order-macro-stage";

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

describe("§14 Grupo GF cobra lo de su Tarifario (v1.31)", () => {
  const s14 = section("## 14. Liquidaciones");

  it("el MOM registra la decisión, la función y la versión", () => {
    expect(s14).toContain("**Grupo GF cobra lo de su Tarifario (v1.31, decisión del owner del 19-10-2026).**");
    expect(s14).toContain("(`resolveGfCostTariff`, `lib/gf-tariff.ts`)");
    expect(s14).toContain("`MOM_RESOLUTION_VERSION` sube a `mom-v1.31`");
    expect(MOM_RESOLUTION_VERSION).toBe("mom-v1.32");
    // La regla vieja ya no está.
    expect(s14).not.toContain("no alimenta este costo");
  });

  it("qué tarifa: el resolver de la Mesa de ruta, con el distrito canónico y el contrato de la tienda", () => {
    expect(s14).toContain("(`riderPayDistrictKey`: Surco → Santiago de Surco; Chosica y Lurigancho Chosica → Lurigancho)");
    expect(s14).toContain("(`logistics_service_agreements` activo ese día)");
    expect(s14).toContain("(`resolveDistrictTariff`)");
  });

  it("intento adicional solo de sus propias salidas, pendiente del owner; sin devolución aparte", () => {
    expect(s14).toContain("**Intento adicional:** el mismo importe por cada intento adicional de sus propias salidas");
    expect(s14).toContain("no los de una guía anterior de Aliclik, Swayp u otro courier");
    expect(s14).toContain("así que el costo de Grupo GF es el del primer intento");
    expect(s14).toContain("**Pendiente del owner:** si cada visita adicional «no entregada» (no estaba, no contesta) también se cobra");
    expect(s14).toContain("**Sin devolución aparte.** Grupo GF no cobra la devolución");
  });

  it("sin tarifa: el aviso manda al Tarifario y nombra el permiso que lo edita", () => {
    expect(s14).toContain(`El aviso manda a ${GF_TARIFF_SCREEN_LABEL} y nombra el permiso que lo edita («${GF_TARIFF_PERMISSION_LABEL}», \`logistics.manage\`)`);
    expect(s14).toContain("«Abrir Tarifario»");
    const block = liquidationCostBlock({ cost: null, missing: ["primer_intento"], courier: "propio", district: "Ate", canManageLogistics: false })!;
    expect(block).toContain(GF_TARIFF_SCREEN_LABEL);
    expect(block).toContain(`(«${GF_TARIFF_PERMISSION_LABEL}»)`);
  });

  it("antes de la vigencia dice la fecha que tiene el Tarifario y no la extiende", () => {
    expect(s14).toContain("(«la de ese distrito rige desde el DD-MM-AAAA»)");
    expect(s14).toContain("(`saveDistrictTariff`)");
    expect(s14).toContain("Kapta no extiende la vigencia en código: lo decide el owner.");
    // El reparto medido con la fecha de la entrega no es el de esta regla.
    expect(s14).not.toContain("564");
    expect(s14).not.toContain("2.269");
    const block = liquidationCostBlock({
      cost: null,
      missing: ["primer_intento"],
      courier: "propio",
      district: "Ate",
      day: "2026-08-20",
      tarifario: { reason: "antes_de_vigencia", since: "2026-08-31" },
    })!;
    expect(block).toContain("la de ese distrito rige desde el 31-08-2026");
  });

  it("el día del costo es el último movimiento, también con Grupo GF: la 0270 lo lleva al día en que se aplica", () => {
    expect(s14).toContain("**El día es el del último movimiento, como con cualquier courier.**");
    expect(s14).toContain("(`costDay`, arriba: la regla del 16-10-2026, sin cambio)");
    expect(s14).toContain("así que toman la tarifa del Tarifario vigente ese día");
    expect(s14).toContain("**Un último movimiento anterior al 31-08-2026 sigue «falta tarifa».**");
    expect(s14).toContain(
      "**Pendiente del owner:** qué vigencia toca a los pedidos de Grupo GF cuyo último movimiento es anterior al 31-08-2026.",
    );
    // Lo que se dijo antes y es falso: el día no es el de la entrega.
    expect(s14).not.toContain("ownCostDay");
    expect(s14).not.toContain("Lo entregado antes del 31-08-2026");
    // El bloqueo no aguanta solo hasta que decida el owner: cualquier movimiento
    // posterior lleva el día del costo a ese día (test/gf-tariff-master.test.ts).
    expect(s14).toContain(
      "cualquier movimiento posterior del pedido —«Observar liquidación», un comentario, el relleno de la 0270— es su nuevo último movimiento y lleva el día del costo a ese día",
    );
    expect(s14).toContain("o el bloqueo tiene que aguantar hasta que lo decida.");
    expect(s14).not.toContain("Hasta entonces esos pedidos no se concilian");
    expect(costDay({ last_movement_at: "2026-10-21T11:00:00Z", order_created_at: "2026-08-15T10:00:00Z" })).toBe("2026-10-21");
  });

  it("una lectura fallida del Tarifario no se recuerda ni se dice «no está activado»", () => {
    expect(s14).toContain("una lectura que falló no se recuerda");
    expect(s14).toContain("(`sin_lectura`)");
    const block = liquidationCostBlock({
      cost: null,
      missing: ["primer_intento"],
      courier: "propio",
      district: "Ate",
      tarifario: { reason: "sin_lectura", since: null },
    })!;
    expect(block).toContain(`No se pudo leer ${GF_TARIFF_SCREEN_LABEL}`);
  });

  it("la Mesa avisa antes del clic con lo que lee la ficha, y no pide cargar la que ya está", () => {
    expect(s14).toContain("(`gfCostTariffGap`)");
    expect(s14).toContain("sin enseñar «Abrir Tarifario» (`vigente`)");
    expect(read("lib/orders-master-access.ts")).toContain("gfCostTariffGap: GfTariffCheck | null;");
  });
});

describe("§29.8 y §9.3 lo citan", () => {
  it("§29.8: el costo logístico de Grupo GF sale del Tarifario", () => {
    const s298 = section("### 29.8 Tarifas por distrito y comisión Yape");
    expect(s298).toContain("**El costo logístico de Grupo GF sale de esta tabla (v1.31, 19-10-2026).**");
    expect(s298).toContain("sin devolución aparte: el rechazo ya paga el distrito");
    expect(s298).toContain("(cualquier movimiento posterior, también observar la liquidación o un comentario, le da la tarifa vigente ese día; §14)");
    expect(s298).not.toContain("hasta que el owner decida su vigencia");
  });

  it("§9.3: los intentos de la columna no cambian el costo, tampoco el de Grupo GF", () => {
    expect(flat(MOM)).toContain(
      "Grupo GF cobra desde v1.31 con su Tarifario (§14) solo los intentos que reportan sus propias salidas: ni los de otro courier ni estas visitas.",
    );
  });
});
