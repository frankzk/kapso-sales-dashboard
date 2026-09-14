import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * La cola no necesita el expediente entero de cada guía.
 *
 * Medido contra producción el 14-09-2026: recorrer las cinco pestañas movía
 * 11 MB (10.957 filas × ~1.100 bytes), y 4.483 kB de eso —el 38,2%— eran
 * columnas que la tabla no pinta nunca: la dirección y sus coordenadas, quién
 * la corrigió, las sugerencias de vinculación de la pantalla de Revisión y los
 * rastros de importación. El cajón las pide aparte, de una guía a la vez.
 *
 * Nota sobre lo que NO se hizo: paginar en el servidor. Los filtros de la cola
 * corren en el cliente sobre el conjunto completo, así que mandar 200 filas
 * haría que filtrar solo mirase esas 200. Paginar exige mover los filtros al
 * servidor, y medidos no lo justifican: el que viene encendido por defecto
 * («Sin contactar hoy») recorta 1 fila de 3.262, porque el equipo toca entre 11
 * y 60 guías por día.
 */

const access = readFileSync(resolve(process.cwd(), "lib/shipments-access.ts"), "utf8");
const ui = readFileSync(resolve(process.cwd(), "components/shipments.tsx"), "utf8");

const SOBRANTES = [
  "delivery_address",
  "delivery_reference",
  "latitude",
  "longitude",
  "address_override",
  "address_updated_at",
  "address_updated_by",
  "suggested_order_gid",
  "suggested_store_id",
  "suggested_order_name",
  "source_batch_id",
  "match_method",
  "last_report_at",
  "created_at",
];

describe("la consulta de la cola es más corta que la del expediente", () => {
  it("existe una lista propia y la de la lista sale de ella", () => {
    expect(access).toContain("const SHIPMENT_QUEUE_COLUMNS =");
    expect(access).toContain("const SHIPMENT_LIST_COLUMNS = `${SHIPMENT_QUEUE_COLUMNS},shipment_calls(count)`;");
  });

  it("ninguna columna que la tabla no pinta viaja en la cola", () => {
    const inicio = access.indexOf("const SHIPMENT_QUEUE_COLUMNS =");
    const cols = access.slice(inicio, access.indexOf("const SHIPMENT_LIST_COLUMNS"));
    for (const c of SOBRANTES) {
      expect(cols, c).not.toContain(`${c},`);
      expect(cols, c).not.toContain(`,${c}`);
    }
  });

  it("y el expediente completo sigue existiendo para el cajón", () => {
    expect(access).toContain("const SHIPMENT_COLUMNS =");
    expect(access).toContain("delivery_address");
    expect(access).toContain("suggested_order_name");
  });

  it("lo que la cola no pide se repone en nulo, no se deja ausente", () => {
    const defaults = access.slice(
      access.indexOf("function withEnhancementDefaults"),
      access.indexOf("/** Attach the date of the last gestión"),
    );
    for (const c of ["match_method", "source_batch_id", "last_report_at", "created_at", "suggested_order_gid"]) {
      expect(defaults, c).toContain(`${c}: null,`);
    }
  });
});

describe("el cliente no lee de la fila lo que la fila ya no trae", () => {
  it("la dirección se lee del detalle del cajón, no de la fila de la cola", () => {
    // Todas las referencias van contra `detail.shipment` / `shipment`, que
    // vienen de `loadShipmentDetail`, no contra la fila `s` de la tabla.
    expect(ui).not.toMatch(/\bs\.delivery_address\b/);
    expect(ui).not.toMatch(/\bs\.latitude\b/);
    expect(ui).not.toMatch(/\bs\.address_override\b/);
  });
});

describe("el departamento se agrupa normalizado", () => {
  it("el filtro usa la grafía canónica, no la cruda", () => {
    expect(ui).toContain("return normalizeDepartment(shipment.region) || SIN_DEPARTAMENTO;");
    expect(ui).toContain('import { normalizeDepartment } from "@/lib/peru-departamentos";');
  });

  it("y la importación la canoniza al entrar", () => {
    const imp = readFileSync(resolve(process.cwd(), "lib/aliclik-import.ts"), "utf8");
    expect(imp).toContain("region: normalizeDepartment(department),");
  });
});
