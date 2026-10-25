import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { districtLearnVerdict, guideProvinceFits, learnedDistrictFits } from "@/lib/district-learning";
import { departmentKey, departmentsConflict, provinceFitsDepartment } from "@/lib/peru-departamentos";
import { leadDeliveryProbe } from "@/lib/lead-delivery-coverage";
import { MOM_RESOLUTION_VERSION } from "@/lib/order-macro-stage";

/**
 * La provincia aprendida por nombre de distrito (25-10-2026, MOM §19.0).
 *
 * El caso: el 21-10-2026 una corrección correcta de un pedido de Miraflores de
 * Arequipa (#KP143187) dejó «miraflores → arequipa» en `peru_districts`, y los
 * de Miraflores de Lima (#KP143872, #AUR178625, #AUR178621, #KP143948)
 * salieron cuatro días con provincia «arequipa».
 */

const AREQUIPA = { province: "arequipa", department: "Arequipa" };
const LIMA = { province: "lima", department: "Lima" };

describe("departamentos y provincias", () => {
  it("las tres Limas y el Callao son la misma clave; lo desconocido, null", () => {
    expect(departmentKey("Lima (provincia)")).toBe("lima");
    expect(departmentKey("Lima (departamento)")).toBe("lima");
    expect(departmentKey("Callao")).toBe("lima");
    expect(departmentKey("Arequipa")).toBe("arequipa");
    expect(departmentKey("PROVINCIA")).toBeNull();
    expect(departmentsConflict("Lima (provincia)", "Arequipa")).toBe(true);
    expect(departmentsConflict("Lima", "Callao")).toBe(false);
    expect(departmentsConflict("Arequipa", null)).toBe(false);
  });

  it("en Lima solo valen sus provincias y el Callao", () => {
    expect(provinceFitsDepartment("LIMA", "Lima (provincia)")).toBe(true);
    expect(provinceFitsDepartment("Lima (departamento)", "Lima")).toBe(true);
    expect(provinceFitsDepartment("Cañete", "Lima (departamento)")).toBe(true);
    expect(provinceFitsDepartment("arequipa", "Lima")).toBe(false);
    expect(provinceFitsDepartment("HUARAZ", "Lima")).toBe(false);
    expect(provinceFitsDepartment("lince", "Lima (provincia)")).toBe(false);
  });

  it("fuera de Lima solo se descarta la que se llama como otro departamento", () => {
    expect(provinceFitsDepartment("arequipa", "Arequipa")).toBe(true);
    expect(provinceFitsDepartment("lima", "Arequipa")).toBe(false);
    expect(provinceFitsDepartment("Huaraz", "Áncash")).toBe(true);
    expect(provinceFitsDepartment("Ucayali", "Loreto")).toBe(true);
    expect(provinceFitsDepartment("cualquiera", null)).toBe(true);
  });
});

describe("districtLearnVerdict: qué se puede recordar", () => {
  it("el caso #KP143187: Miraflores de Arequipa no pisa la de Lima", () => {
    const v = districtLearnVerdict({ district: "Miraflores", province: "arequipa", department: "Arequipa" }, LIMA);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("ya está guardado como distrito de Lima");
  });

  it("el caso #KP142493: «HUARAZ» no es una provincia de Lima", () => {
    const v = districtLearnVerdict({ district: "Independencia", province: "HUARAZ", department: "Lima" }, null);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("no es una provincia de Lima");
  });

  it("un departamento que no se reconoce no se recuerda", () => {
    expect(districtLearnVerdict({ district: "Manchay", province: "CHOSICA", department: "CHOSICA" }, null).ok).toBe(false);
  });

  it("lo correcto se recuerda, también sobre una fila sin departamento reconocible", () => {
    expect(districtLearnVerdict({ district: "Miraflores", province: "lima", department: "Lima" }, LIMA).ok).toBe(true);
    expect(districtLearnVerdict({ district: "Jacobo Hunter", province: "Arequipa", department: "Arequipa" }, null).ok).toBe(true);
    expect(
      districtLearnVerdict({ district: "Chilca", province: "Cañete", department: "Lima (departamento)" }, { province: "Chilca", department: "Chilca" }).ok,
    ).toBe(true);
  });
});

describe("learnedDistrictFits: lo aprendido no manda sobre el departamento del pedido", () => {
  it("Miraflores de Lima con «arequipa» aprendido: no se usa", () => {
    expect(learnedDistrictFits(AREQUIPA, "Lima (provincia)", "Miraflores")).toBeNull();
  });

  it("Miraflores de Arequipa con «lima» aprendido: tampoco", () => {
    expect(learnedDistrictFits(LIMA, "Arequipa", "Miraflores")).toBeNull();
  });

  it("Independencia de Lima con «HUARAZ»: se queda el departamento, sin provincia", () => {
    expect(learnedDistrictFits({ province: "HUARAZ", department: "Lima" }, "Lima (provincia)", "Independencia")).toEqual({
      province: null,
      department: "Lima",
    });
  });

  it("fuera de Lima Metropolitana no se juzga: Huaraz con el desplegable en Lima sigue siendo Huaraz", () => {
    const huaraz = { province: "huaraz", department: "Áncash" };
    expect(learnedDistrictFits(huaraz, "Lima", "Huaraz")).toBe(huaraz);
  });

  it("lo que cabe se usa tal cual", () => {
    expect(learnedDistrictFits(LIMA, "Lima (provincia)", "Miraflores")).toBe(LIMA);
    expect(learnedDistrictFits(LIMA, null, "Miraflores")).toBe(LIMA);
  });
});

describe("guideProvinceFits: la provincia que una salida copió del Master", () => {
  it("«arequipa» en una salida de Miraflores de Lima no vuelve", () => {
    expect(guideProvinceFits("arequipa", "Lima (provincia)", "Miraflores")).toBe(false);
    expect(guideProvinceFits("LIMA", "Lima (provincia)", "Miraflores")).toBe(true);
    expect(guideProvinceFits("huaraz", "Lima", "Huaraz")).toBe(true);
    expect(guideProvinceFits(null, "Lima", "Miraflores")).toBe(false);
  });
});

describe("la cobertura de Leads usa la misma guarda", () => {
  it("un lead de Miraflores de Lima no se pregunta como de Arequipa", () => {
    const probe = leadDeliveryProbe({ district: "Miraflores", province: null, region: "Lima (provincia)" }, AREQUIPA, null);
    expect(probe?.region).toBe("Lima (provincia)");
    expect(probe?.province).toBeNull();
  });
});

describe("MOM y versión", () => {
  it("el MOM lo cuenta y la versión sube para que el cron recalcule", () => {
    const mom = readFileSync(resolve(__dirname, "../docs/mom/master-pedidos-v1.md"), "utf8");
    expect(mom).toContain("**Recordar la provincia de un distrito, con guarda (25-10-2026, `mom-v1.32`).**");
    expect(mom).toContain("`learnedDistrictFits`");
    expect(MOM_RESOLUTION_VERSION).toBe("mom-v1.32");
  });
});
