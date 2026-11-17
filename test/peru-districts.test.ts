import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  districtSearchKey,
  matchPeruDistrict,
  peruDistrictByUbigeo,
  peruDistrictCount,
  peruDistrictPlace,
  resolveOrderDistrict,
  searchPeruDistricts,
} from "@/lib/peru-districts";
import { PERU_UBIGEO_DEPARTMENTS, PERU_UBIGEO_DISTRICTS } from "@/lib/peru-ubigeo-data";
import { resolveLimaDistrict } from "@/lib/order-coverage";
import { districtPendingHint } from "@/components/district-picker";

const read = (path: string) => readFileSync(path, "utf8");
const names = (list: { name: string }[]) => list.map((d) => d.name);

describe("la lista oficial (MOM §37.10)", () => {
  it("trae los 1893 distritos con un ubigeo único de 6 dígitos", () => {
    const codes = PERU_UBIGEO_DISTRICTS.split("\n").map((l) => l.split("|")[0]);
    expect(peruDistrictCount()).toBe(1893);
    expect(new Set(codes).size).toBe(1893);
    expect(codes.every((c) => /^\d{6}$/.test(c ?? ""))).toBe(true);
  });

  it("los departamentos son los 25 de siempre, con tildes", () => {
    // Ordenado por código: «10»…«25» son claves numéricas y JS las pone primero.
    const byCode = Object.entries(PERU_UBIGEO_DEPARTMENTS).sort(([a], [b]) => a.localeCompare(b)).map(([, n]) => n);
    expect(byCode).toEqual([
      "Amazonas", "Áncash", "Apurímac", "Arequipa", "Ayacucho", "Cajamarca", "Callao", "Cusco",
      "Huancavelica", "Huánuco", "Ica", "Junín", "La Libertad", "Lambayeque", "Lima", "Loreto",
      "Madre de Dios", "Moquegua", "Pasco", "Piura", "Puno", "San Martín", "Tacna", "Tumbes", "Ucayali",
    ]);
  });

  it("muestra «Cercado de Lima», «Callao» y corrige la ortografía de la fuente", () => {
    expect(peruDistrictByUbigeo("150101")).toEqual({ ubigeo: "150101", name: "Cercado de Lima", province: "Lima", department: "Lima" });
    expect(peruDistrictByUbigeo("070106")).toMatchObject({ name: "Ventanilla", province: "Callao", department: "Callao" });
    expect(peruDistrictByUbigeo("150119")?.name).toBe("Lurín");
    expect(peruDistrictByUbigeo("030602")?.name).toBe("Anco Huallo");
    expect(peruDistrictByUbigeo("040801")?.province).toBe("La Unión");
    expect(peruDistrictByUbigeo("999999")).toBeNull();
  });

  it("cada distrito de Lima Metropolitana y del Callao lo reconoce la cobertura con su nombre de la lista", () => {
    const lima = PERU_UBIGEO_DISTRICTS.split("\n")
      .map((l) => l.split("|")[0] ?? "")
      .filter((c) => c.startsWith("1501") || c.startsWith("0701"));
    expect(lima).toHaveLength(50);
    for (const code of lima) {
      const d = peruDistrictByUbigeo(code)!;
      expect(resolveLimaDistrict(d.name), d.name).not.toBeNull();
    }
  });
});

describe("el buscador", () => {
  it("encuentra el distrito mal escrito de #AUR900990", () => {
    expect(names(searchPeruDistricts("San Martín de portes"))[0]).toBe("San Martín de Porres");
    expect(names(searchPeruDistricts("san mar"))[0]).toBe("San Martín de Porres");
    expect(names(searchPeruDistricts("martin porres"))).toEqual(["San Martín de Porres"]);
  });

  it("no pide tildes ni mayúsculas, y entiende las siglas del equipo", () => {
    expect(names(searchPeruDistricts("BRENA"))[0]).toBe("Breña");
    expect(names(searchPeruDistricts("jesus maria"))).toEqual(["Jesús María"]);
    expect(names(searchPeruDistricts("smp"))).toEqual(["San Martín de Porres"]);
    expect(names(searchPeruDistricts("sjl"))).toEqual(["San Juan de Lurigancho"]);
    expect(names(searchPeruDistricts("surco"))[0]).toBe("Santiago de Surco");
    expect(names(searchPeruDistricts("cercado"))[0]).toBe("Cercado de Lima");
  });

  it("perdona una o dos letras, pero no ofrece parecidos cuando algo calza de verdad", () => {
    expect(names(searchPeruDistricts("chorrilos"))).toEqual(["Chorrillos"]);
    expect(names(searchPeruDistricts("los olibos"))).toEqual(["Los Olivos"]);
    expect(names(searchPeruDistricts("breña"))).toEqual(["Breña"]);
    expect(searchPeruDistricts("xq")).toEqual([]);
    expect(searchPeruDistricts("   ")).toEqual([]);
  });

  it("entre homónimos, primero el del departamento que vino con la dirección; si no, Lima", () => {
    const plain = searchPeruDistricts("miraflores");
    expect(peruDistrictPlace(plain[0]!)).toBe("Lima, Lima");
    const arequipa = searchPeruDistricts("miraflores", { department: "Arequipa" });
    expect(peruDistrictPlace(arequipa[0]!)).toBe("Arequipa, Arequipa");
    expect(searchPeruDistricts("miraflores", { limit: 2 })).toHaveLength(2);
    // El departamento se lee por palabras enteras: «Región Huancavelica» no es Ica.
    const huanca = searchPeruDistricts("el carmen", { department: "Región Huancavelica" });
    expect(huanca[0]?.department).toBe("Huancavelica");
  });
});

describe("un distrito escrito a mano contra la lista", () => {
  it("tal cual y sin otro igual: queda elegido", () => {
    expect(matchPeruDistrict("Santiago de Surco")).toMatchObject({ kind: "exact", district: { ubigeo: "150140" } });
    expect(matchPeruDistrict("cercado de lima")).toMatchObject({ kind: "exact", district: { name: "Cercado de Lima" } });
  });

  it("en el departamento de Lima gana el de Lima Metropolitana, como en la cobertura", () => {
    expect(matchPeruDistrict("Miraflores", "Lima")).toMatchObject({ kind: "exact", district: { ubigeo: "150122" } });
    expect(matchPeruDistrict("Miraflores", "Lima (provincia)")).toMatchObject({ kind: "exact", district: { ubigeo: "150122" } });
    expect(matchPeruDistrict("Surco", "Lima")).toMatchObject({ kind: "exact", district: { name: "Santiago de Surco" } });
    expect(matchPeruDistrict("Miraflores", "Arequipa")).toMatchObject({ kind: "exact", district: { ubigeo: "040110" } });
    // San Luis también es de Cañete: con «(departamento)» la cobertura tampoco decide.
    expect(matchPeruDistrict("San Luis", "Lima (departamento)")).toMatchObject({ kind: "ambiguous", name: "San Luis" });
  });

  it("repetido sin departamento: hay que elegir", () => {
    const m = matchPeruDistrict("Miraflores");
    expect(m.kind).toBe("ambiguous");
    if (m.kind === "ambiguous") expect(m.options.length).toBe(4);
  });

  it("mal escrito: nunca se corrige solo, se sugiere", () => {
    const m = matchPeruDistrict("San Martín de portes", "Lima");
    expect(m.kind).toBe("none");
    if (m.kind === "none") expect(names(m.suggestions)[0]).toBe("San Martín de Porres");
  });
});

describe("el distrito con el que se crea el pedido", () => {
  it("manda el ubigeo elegido y guarda el nombre y la región de la lista", () => {
    expect(resolveOrderDistrict({ ubigeo: "150135", district: "San Martín de Porres", province: "Lima" })).toEqual({
      ok: true,
      district: { ubigeo: "150135", name: "San Martín de Porres", province: "Lima", department: "Lima" },
    });
    // La región que vino escrita no manda: sale del distrito.
    expect(resolveOrderDistrict({ ubigeo: "040110", district: "miraflores", province: "Lima" })).toMatchObject({
      ok: true,
      district: { name: "Miraflores", department: "Arequipa" },
    });
  });

  it("un ubigeo que no existe o que no es el del nombre se vuelve a elegir", () => {
    expect(resolveOrderDistrict({ ubigeo: "999999", district: "Lince" })).toEqual({
      ok: false,
      error: "Ese distrito no está en la lista oficial. Vuelve a elegirlo.",
    });
    expect(resolveOrderDistrict({ ubigeo: "150116", district: "Lince 2" })).toMatchObject({ ok: false });
  });

  it("sin ubigeo (un formulario de antes): solo pasa un nombre exacto", () => {
    expect(resolveOrderDistrict({ district: "lince", province: "Lima" })).toMatchObject({ ok: true, district: { name: "Lince" } });
    expect(resolveOrderDistrict({ district: "" })).toEqual({ ok: false, error: "El distrito es obligatorio." });
    expect(resolveOrderDistrict({ district: "San Martín de portes", province: "Lima" })).toEqual({
      ok: false,
      error: "«San Martín de portes» no está en la lista oficial de distritos. ¿Es San Martín de Porres (Lima, Lima)? Elígelo de la lista.",
    });
    expect(resolveOrderDistrict({ district: "Miraflores" })).toEqual({
      ok: false,
      error: "Hay 4 distritos «Miraflores». Elige de la lista el de la entrega.",
    });
  });
});

describe("el aviso del campo", () => {
  it("dice qué falta mientras no se elija", () => {
    expect(districtPendingHint("", "Lima")).toBeNull();
    expect(districtPendingHint("San Martín de portes", "Lima")).toMatchObject({
      message: "«San Martín de portes» no está en la lista.",
      suggestion: { name: "San Martín de Porres" },
    });
    expect(districtPendingHint("Miraflores", null)?.message).toBe("Hay 4 distritos «Miraflores»: elige el de la entrega.");
    expect(districtPendingHint("qqqqqq", null)?.message).toBe("Ningún distrito se llama así. Revisa cómo se escribe y elígelo de la lista.");
  });

  it("la clave de búsqueda ignora tildes, mayúsculas y signos", () => {
    expect(districtSearchKey("  San Martín-de PORRES ")).toBe("san martin de porres");
    expect(districtSearchKey("Breña")).toBe("brena");
  });
});

describe("el formulario y la acción usan la lista", () => {
  it("«Generar pedido» elige el distrito y manda su ubigeo; la región sale del distrito", () => {
    const drawer = read("components/leads-drawer.tsx");
    expect(drawer).toContain("<DistrictPicker");
    expect(drawer).not.toContain('label="Distrito *"');
    expect(drawer).not.toContain("PERU_REGIONS");
    const body = drawer.slice(drawer.indexOf("const res = await generateOrder(leadId, {"), drawer.indexOf("if (res.requiereConfirmacion"));
    expect(body).toContain("district: chosen.name,");
    expect(body).toContain("province: chosen.department,");
    expect(body).toContain("ubigeo: chosen.ubigeo,");
    expect(drawer).toContain("place !== null &&");
  });

  it("generateOrder resuelve el distrito antes de leer nada y sigue con el oficial", () => {
    const src = read("app/dashboard/leads/actions.ts");
    const gen = src.slice(src.indexOf("export async function generateOrder("));
    const resolve = gen.indexOf("const place = resolveOrderDistrict({ ubigeo: input.ubigeo, district: input.district, province: input.province });");
    expect(resolve).toBeGreaterThan(0);
    expect(resolve).toBeLessThan(gen.indexOf("createAdminSupabase()"));
    expect(gen).toContain("input = { ...input, district, province: place.district.department };");
  });
});
