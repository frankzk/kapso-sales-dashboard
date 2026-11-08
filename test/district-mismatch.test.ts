// «Distrito por revisar» (MOM §19.0.3, owner 08-11-2026).
//
// #KP202409 llegó del formulario web con distrito «Arequipa» y dirección «AV
// solo 709 campo marte paucarpata». Kapta le pasó «Arequipa» a Swayp, que fue
// al cercado y anuló la guía. Lo que se fija aquí:
//   - la regla pura (`districtMismatch`): provincia (no Lima ni Agencia),
//     distrito = provincia, la dirección nombra otro distrito de la misma
//     provincia y departamento, de 5 letras o más, palabra entera;
//   - el cargador trae `peru_districts` de las provincias en UNA consulta;
//   - el aviso está antes de las guías Swayp (directa / «Swayp lo puede llevar
//     hoy», reenvío), Aliclik y Olva, corrige con `updateOrderGeo` (solo el
//     distrito y su nota) y deja crear igual tras «Crear con … igual»;
//   - el Master lo lista en «Distrito por revisar», sin sondeo propio.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  displayDistrictName,
  districtFixLabel,
  districtFixNote,
  districtKeepLabel,
  districtMismatch,
  districtMismatchText,
  normalizeGeoName,
  provinceIlikePattern,
  provincesToCheck,
  type DistrictMismatchOrder,
  type ProvinceDistrict,
} from "@/lib/district-mismatch";
import { districtReviewItems, loadProvinceDistricts } from "@/lib/district-mismatch-access";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const D = (district: string, province: string, department: string): ProvinceDistrict => ({
  district,
  province,
  department,
});

// Como está en `peru_districts`: texto libre, con filas en minúsculas o MAYÚSCULAS.
const DISTRICTS: ProvinceDistrict[] = [
  D("Arequipa", "Arequipa", "Arequipa"),
  D("Paucarpata", "Arequipa", "Arequipa"),
  D("Cerro Colorado", "Arequipa", "Arequipa"),
  D("cayma", "Arequipa", "Arequipa"),
  D("Jose Luis Bustamante y Rivero", "Arequipa", "Arequipa"),
  D("Yura", "Arequipa", "Arequipa"),
  D("Miraflores", "Arequipa", "Arequipa"),
  D("Huancayo", "huancayo", "Junín"),
  D("El Tambo", "Huancayo", "Junin"),
  D("Trujillo", "Trujillo", "La Libertad"),
  D("Huanchaco", "Trujillo", "La Libertad"),
  D("Piura", "Piura", "Piura"),
  D("Castilla", "Piura", "Piura"),
  D("San Jeronimo", "Huancayo", "Junín"),
  D("San Jeronimo de Tunan", "Huancayo", "Junín"),
  D("Miraflores", "Lima", "Lima"),
];

function order(partial: Partial<DistrictMismatchOrder>): DistrictMismatchOrder {
  return {
    district: "Arequipa",
    province: "Arequipa",
    region: "Arequipa",
    address: "",
    coverage: "provincia_cod",
    ...partial,
  };
}

describe("districtMismatch: la capital como distrito y otro en la dirección", () => {
  it("#KP202409: «AV solo 709 campo marte paucarpata» con distrito Arequipa", () => {
    expect(districtMismatch(order({ address: "AV solo 709 campo marte paucarpata" }), DISTRICTS)).toEqual({
      current: "Arequipa",
      suggested: ["Paucarpata"],
    });
  });

  it("Cerro Colorado, en mayúsculas", () => {
    expect(districtMismatch(order({ address: "Calle Los Pinos 123, CERRO COLORADO" }), DISTRICTS)?.suggested).toEqual([
      "Cerro Colorado",
    ]);
  });

  it("Cayma (la fila de la tabla en minúsculas sale con mayúscula)", () => {
    expect(districtMismatch(order({ address: "Urb. La Libertad Mz B lote 4 - Cayma" }), DISTRICTS)?.suggested).toEqual([
      "Cayma",
    ]);
  });

  it("José Luis Bustamante y Rivero, con tilde en la dirección", () => {
    expect(
      districtMismatch(order({ address: "Av. Dolores 200, José Luis Bustamante y Rivero" }), DISTRICTS)?.suggested,
    ).toEqual(["Jose Luis Bustamante y Rivero"]);
  });

  it("El Tambo (Huancayo, Junín con y sin tilde)", () => {
    expect(
      districtMismatch(
        order({ district: "Huancayo", province: "huancayo", region: "Junín", address: "Jr. Los Andes 450 El Tambo" }),
        DISTRICTS,
      ),
    ).toEqual({ current: "Huancayo", suggested: ["El Tambo"] });
  });

  it("Huanchaco (Trujillo, La Libertad)", () => {
    expect(
      districtMismatch(
        order({ district: "trujillo", province: "Trujillo", region: "La Libertad", address: "Av La Ribera 300 huanchaco" }),
        DISTRICTS,
      ),
    ).toEqual({ current: "trujillo", suggested: ["Huanchaco"] });
  });

  it("Castilla (Piura)", () => {
    expect(
      districtMismatch(
        order({ district: "Piura", province: "Piura", region: "Piura", address: "Calle Junín 12, castilla" }),
        DISTRICTS,
      )?.suggested,
    ).toEqual(["Castilla"]);
  });

  it("dos distritos en la dirección: los dos, y el texto los nombra", () => {
    const m = districtMismatch(order({ address: "Paucarpata, cerca al óvalo de Cayma" }), DISTRICTS);
    expect(m?.suggested).toEqual(["Cayma", "Paucarpata"]);
    expect(districtMismatchText(m!)).toBe("La dirección dice Cayma o Paucarpata y el distrito es Arequipa.");
  });

  it("el nombre largo gana al corto que contiene", () => {
    expect(
      districtMismatch(
        order({ district: "Huancayo", province: "Huancayo", region: "Junín", address: "Av. Central, San Jerónimo de Tunán" }),
        DISTRICTS,
      )?.suggested,
    ).toEqual(["San Jeronimo de Tunan"]);
  });

  it("el distrito y la provincia se comparan sin tildes ni mayúsculas", () => {
    expect(
      districtMismatch(order({ district: "AREQUIPA", province: "arequipa", address: "paucarpata" }), DISTRICTS)?.current,
    ).toBe("AREQUIPA");
  });
});

describe("districtMismatch: lo que no avisa", () => {
  it("cobertura Lima", () => {
    expect(
      districtMismatch(
        order({ district: "Lima", province: "Lima", region: "Lima", address: "Av. Larco 100 Miraflores", coverage: "lima" }),
        DISTRICTS,
      ),
    ).toBeNull();
  });

  it("cobertura Agencia", () => {
    expect(districtMismatch(order({ address: "paucarpata", coverage: "agencia" }), DISTRICTS)).toBeNull();
  });

  it("la dirección no nombra ningún otro distrito", () => {
    expect(districtMismatch(order({ address: "Calle Mercaderes 120, cercado" }), DISTRICTS)).toBeNull();
  });

  it("el distrito ya es el correcto", () => {
    expect(districtMismatch(order({ district: "Paucarpata", address: "AV solo 709 paucarpata" }), DISTRICTS)).toBeNull();
  });

  it("solo palabra entera: «Caymana» no es Cayma", () => {
    expect(districtMismatch(order({ address: "Calle Caymana 12" }), DISTRICTS)).toBeNull();
  });

  it("nombres de menos de 5 letras no cuentan (Yura)", () => {
    expect(districtMismatch(order({ address: "Km 12 carretera a Yura" }), DISTRICTS)).toBeNull();
  });

  it("solo distritos de la MISMA provincia y departamento", () => {
    // Miraflores de Lima no cuenta para Piura.
    expect(
      districtMismatch(order({ district: "Piura", province: "Piura", region: "Piura", address: "Miraflores 200" }), DISTRICTS),
    ).toBeNull();
    // Provincia Arequipa pero departamento distinto: no se juzga.
    expect(districtMismatch(order({ region: "Moquegua", address: "paucarpata" }), DISTRICTS)).toBeNull();
  });

  it("sin dirección, sin distrito o sin departamento", () => {
    expect(districtMismatch(order({ address: null }), DISTRICTS)).toBeNull();
    expect(districtMismatch(order({ district: null, address: "paucarpata" }), DISTRICTS)).toBeNull();
    expect(districtMismatch(order({ region: null, address: "paucarpata" }), DISTRICTS)).toBeNull();
  });
});

describe("textos y ayudas", () => {
  it("los textos del aviso y de la corrección", () => {
    const m = { current: "Arequipa", suggested: ["Paucarpata"] };
    expect(districtMismatchText(m)).toBe("La dirección dice Paucarpata y el distrito es Arequipa.");
    expect(districtFixLabel("Paucarpata")).toBe("Corregir a Paucarpata");
    expect(districtFixNote("Paucarpata")).toBe("Distrito corregido: la dirección dice Paucarpata.");
    expect(districtKeepLabel(m)).toBe("Crear con Arequipa igual");
  });

  it("nombres de la tabla en minúsculas o mayúsculas", () => {
    expect(displayDistrictName("cayma")).toBe("Cayma");
    expect(displayDistrictName("LA BANDA DE SHILCAYO")).toBe("La Banda de Shilcayo");
    expect(displayDistrictName("Jose Luis Bustamante y Rivero")).toBe("Jose Luis Bustamante y Rivero");
  });

  it("el patrón ilike casa la provincia con o sin tildes", () => {
    const toRegex = (p: string) => new RegExp(`^${p.replace(/_/g, ".")}$`, "i");
    const pattern = provinceIlikePattern("Huánuco")!;
    expect(toRegex(pattern).test("Huanuco")).toBe(true);
    expect(toRegex(pattern).test("HUÁNUCO")).toBe(true);
    expect(toRegex(provinceIlikePattern("San Martín")!).test("san martin")).toBe(true);
    expect(provinceIlikePattern("  ")).toBeNull();
  });

  it("solo hacen falta las provincias de pedidos con la capital como distrito", () => {
    expect(
      provincesToCheck([
        order({}),
        order({ district: "arequipa", province: "AREQUIPA" }),
        order({ district: "Paucarpata" }),
        order({ district: "Lima", province: "Lima", coverage: "lima" }),
        order({ district: "Piura", province: "Piura", region: "Piura" }),
      ]),
    ).toEqual(["Arequipa", "Piura"]);
    expect(normalizeGeoName("  José  Luis-Bustamante ")).toBe("jose luis bustamante");
  });
});

describe("cargador: peru_districts en UNA consulta", () => {
  it("una sola lectura con todas las provincias", async () => {
    const calls: { table: string; or?: string }[] = [];
    const sb: any = {
      from(table: string) {
        const call: { table: string; or?: string } = { table };
        calls.push(call);
        const q: any = {
          select: () => q,
          or: (value: string) => {
            call.or = value;
            return q;
          },
          limit: async () => ({ data: DISTRICTS, error: null }),
        };
        return q;
      },
    };
    const rows = await loadProvinceDistricts(sb, ["Arequipa", "arequipa", "Huánuco"]);
    expect(rows).toHaveLength(DISTRICTS.length);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.table).toBe("peru_districts");
    expect(calls[0]!.or).toBe("province.ilike._r_q__p_,province.ilike.h__n_c_");
    expect(await loadProvinceDistricts(sb, [])).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("la lista del Master sale de una pasada sobre lo leído", () => {
    const base = { store_id: "s1", current_courier: null, guide_code: null, region: "Arequipa", province: "Arequipa" };
    const items = districtReviewItems(
      [
        { ...base, order_id: "a", order_name: "#KP202409", district: "Arequipa", address: "AV solo 709 campo marte paucarpata", coverage: "provincia_cod" },
        { ...base, order_id: "b", order_name: "#KP200001", district: "Paucarpata", address: "paucarpata", coverage: "provincia_cod" },
        { ...base, order_id: "c", order_name: "#KP200002", district: "Arequipa", address: "cerro colorado", coverage: "agencia" },
        { ...base, order_id: "d", order_name: "#KP200003", district: "Arequipa", address: "Cayma y Paucarpata", coverage: null, current_courier: "aliclik", guide_code: "AUR5X1" },
      ],
      DISTRICTS,
    );
    expect(items.map((i) => [i.orderName, i.current, i.suggested])).toEqual([
      ["#KP202409", "Arequipa", ["Paucarpata"]],
      ["#KP200003", "Arequipa", ["Cayma", "Paucarpata"]],
    ]);
    expect(items[1]!.guideCode).toBe("AUR5X1");
  });

  it("lee pedidos abiertos de provincia, sin Lima ni Agencia, y sin sondeo", () => {
    const access = read("lib/district-mismatch-access.ts");
    expect(access).toContain('"pendiente", "en_proceso"');
    expect(access).toContain('.or("coverage.is.null,coverage.not.in.(lima,agencia)")');
    expect(access).toContain("createServerSupabase");
    expect(access).not.toMatch(/setInterval|setTimeout/);
    const page = read("app/dashboard/pedidos/page.tsx");
    expect(page).toContain("searching ? Promise.resolve(null) : getDistrictReview(storeIds)");
    expect(page).toContain("districtReview={districtReview}");
  });
});

describe("el aviso antes de crear la guía", () => {
  const warning = read("components/district-mismatch-warning.tsx");

  it("corrige con updateOrderGeo, solo el distrito y su nota, y recarga", () => {
    expect(warning).toContain("updateOrderGeo(orderId, { ...keep, district, note: districtFixNote(district) })");
    // Lo que ya tuviera la corrección del pedido se conserva.
    expect(warning).toContain("loadOrderGeo(orderId)");
    expect(warning).toContain("router.refresh()");
    expect(warning).toContain('tone="warn"');
    expect(warning).toContain("districtFixLabel(district)");
    expect(warning).toContain("districtKeepLabel(mismatch)");
    expect(warning).toContain("blocking: !!mismatch && !acknowledged");
    expect(warning).not.toMatch(/setInterval/);
  });

  it("Swayp directa y «Swayp lo puede llevar hoy» (el mismo modal)", () => {
    const modal = read("components/direct-fenix-guide-modal.tsx");
    expect(modal).toContain("useDistrictMismatchCheck(preview?.orderId ?? null)");
    expect(modal).toContain("!districtCheck.blocking &&");
    expect(modal).toContain("<DistrictMismatchWarning");
    expect(read("components/swayp-desde-confirmacion-offer.tsx")).toContain("DirectFenixGuideModal");
  });

  it("reenvío por Swayp: mira el destino de la salida", () => {
    const shipments = read("components/shipments.tsx");
    expect(shipments).toContain("useDistrictMismatchCheck(");
    expect(shipments).toContain("district: shipment.district ?? null");
    expect(shipments).toContain("!districtCheck.blocking &&\n    cancelledExceptionTienePedido");
    expect(shipments).toContain("<DistrictMismatchWarning");
  });

  it("Aliclik: el botón de crear espera y corregir pide recotizar", () => {
    const aliclik = read("components/aliclik-guide-panel.tsx");
    expect(aliclik).toContain("useDistrictMismatchCheck(orderId)");
    expect(aliclik).toContain("districtCheck.blocking\n            ? DISTRICT_MISMATCH_BLOCK_REASON");
    expect(aliclik).toContain("<DistrictMismatchWarning");
  });

  it("Olva: solo en la salida Olva", () => {
    const olva = read("components/manual-route-output-modal.tsx");
    expect(olva).toContain('useDistrictMismatchCheck(route.key === "olva" ? orderId : null)');
    expect(olva).toContain("|| districtCheck.blocking}");
  });
});

describe("la lista «Distrito por revisar» del Master", () => {
  it("píldora como «Programado sin ubicación», lista con Corregir y lote", () => {
    const master = read("components/orders-master.tsx");
    expect(master).toContain("label={DISTRICT_REVIEW_LABEL}");
    expect(master).toContain("districtReviewCount={districtReview ? districtReview.length : null}");
    expect(master).toContain("<DistrictReviewPanel");
    const panel = read("components/district-review-panel.tsx");
    expect(panel).toContain("applyDistrictFix(item.orderId, district)");
    expect(panel).toContain("Corregir seleccionados");
    expect(panel).toContain("item.suggested.length === 1");
    expect(panel).not.toMatch(/setInterval/);
  });

  it("el MOM y el runbook lo cuentan", () => {
    const mom = read("docs/mom/master-pedidos-v1.md");
    expect(mom).toContain("### 19.0.3 Distrito por revisar");
    expect(mom).toContain("La dirección dice Paucarpata y el distrito es Arequipa.");
    const deploy = read("DEPLOY.md");
    // Ya no es la primera entrada (la del ubigeo del formulario, del mismo día, va encima).
    expect(deploy).toContain("### 08-11-2026 · Distrito por revisar: aviso antes de la guía y lista en el Master");
    expect(deploy).toContain("bulk=district_review_20261108");
  });
});
