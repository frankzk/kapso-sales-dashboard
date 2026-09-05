import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { facetItems } from "@/lib/leads-facets";
import { LEAD_SEGMENTS, countLeadSegments } from "@/lib/leads";

type Row = { id: string; src: string; state: string; hot: boolean };

const rows: Row[] = [
  { id: "a", src: "meta", state: "nuevo", hot: true },
  { id: "b", src: "meta", state: "gestionado", hot: false },
  { id: "c", src: "organico", state: "nuevo", hot: false },
  { id: "d", src: "organico", state: "gestionado", hot: true },
];

const ids = (list: Row[]) => list.map((r) => r.id);

describe("facetItems", () => {
  it("`all` son los que pasan todas las facetas", () => {
    const facets = facetItems(rows, {
      src: (r) => r.src === "meta",
      state: (r) => r.state === "nuevo",
    });
    expect(ids(facets.all)).toEqual(["a"]);
  });

  it("`except` deja pasar los que solo fallan esa faceta (un grupo no se filtra a sí mismo)", () => {
    const facets = facetItems(rows, {
      src: (r) => r.src === "meta",
      state: (r) => r.state === "nuevo",
    });
    // Saltándose la fuente: los `nuevo` de cualquier fuente.
    expect(ids(facets.except("src"))).toEqual(["a", "c"]);
    // Saltándose el estado: los de Meta en cualquier estado.
    expect(ids(facets.except("state"))).toEqual(["a", "b"]);
    // Saltándose las dos: todos.
    expect(ids(facets.except("src", "state"))).toEqual(["a", "b", "c", "d"]);
  });

  it("da exactamente lo mismo que filtrar grupo a grupo (la forma cara de antes)", () => {
    const predicates = {
      src: (r: Row) => r.src === "meta",
      state: (r: Row) => r.state === "nuevo",
      hot: (r: Row) => r.hot,
    };
    const keys = Object.keys(predicates) as (keyof typeof predicates)[];
    const facets = facetItems(rows, predicates);

    const naiveAll = rows.filter((r) => keys.every((k) => predicates[k](r)));
    expect(ids(facets.all)).toEqual(ids(naiveAll));

    for (const skip of keys) {
      const naive = rows.filter((r) => keys.every((k) => k === skip || predicates[k](r)));
      expect(ids(facets.except(skip))).toEqual(ids(naive));
    }
  });

  it("evalúa cada predicado UNA sola vez por elemento (es el punto de todo esto)", () => {
    let calls = 0;
    const facets = facetItems(rows, {
      src: (r) => {
        calls += 1;
        return r.src === "meta";
      },
      state: (r) => r.state === "nuevo",
    });
    // Cuatro filas × una evaluación. Derivar las bases después no vuelve a llamar.
    expect(calls).toBe(4);
    facets.except("src");
    facets.except("state");
    expect(facets.all.length).toBe(1);
    expect(calls).toBe(4);
  });

  it("`matchesAll` reaplica el mismo criterio a filas que no venían en la lista", () => {
    const facets = facetItems(rows, { src: (r: Row) => r.src === "meta" });
    expect(facets.matchesAll({ id: "z", src: "meta", state: "nuevo", hot: false })).toBe(true);
    expect(facets.matchesAll({ id: "z", src: "organico", state: "nuevo", hot: false })).toBe(false);
  });

  it("sin facetas, todo pasa", () => {
    const facets = facetItems(rows, {} as Record<string, (r: Row) => boolean>);
    expect(ids(facets.all)).toEqual(["a", "b", "c", "d"]);
  });

  it("se niega a trabajar con más facetas de las que caben en la máscara", () => {
    const predicates: Record<string, (r: Row) => boolean> = {};
    for (let i = 0; i < 32; i++) predicates[`f${i}`] = () => true;
    expect(() => facetItems(rows, predicates)).toThrow(/31 facetas/);
  });
});

describe("los chips de segmento no pueden divergir de la lista canónica", () => {
  // EL FALLO QUE ESTO VIGILA. La fila estaba escrita a mano —["frio",
  // "converso", "distrito", "carrito"]— con un `as LeadSegment[]` que
  // silenciaba al compilador. Al fusionar `distrito` dentro de `interes`, el
  // tipo cazó los siete sitios que enumeran segmentos PERO NO ESTE, por culpa
  // del cast: la fila siguió pidiendo una clave que ya no existía y el chip del
  // balde nuevo —con 490 leads dentro— no se dibujó. Los segmentos dejaron de
  // sumar el total y no había forma de filtrarlos.
  const SOURCE = readFileSync(resolve(process.cwd(), "components/leads.tsx"), "utf8");

  it("la fila se deriva de LEAD_SEGMENTS, no de una lista escrita al lado", () => {
    expect(SOURCE).toContain("[...LEAD_SEGMENTS].reverse().map(({ key })");
  });

  it("ningún `as LeadSegment[]` vuelve a silenciar al compilador acá", () => {
    // El cast es lo que dejó pasar el fallo: sin él, TypeScript rechaza una
    // clave que ya no existe en el tipo, que es justo lo que hace falta.
    //
    // Exige el `]` de cierre delante para matchear el cast de VERDAD y no la
    // mención entre comillas del comentario que explica esto en leads.tsx.
    // Sin esa ancla, la prueba fallaba con el arreglo ya puesto.
    expect(SOURCE).not.toMatch(/\]\s*as LeadSegment\[\]/);
  });

  it("el contador devuelve exactamente un balde por segmento de la lista", () => {
    // La otra mitad del mismo riesgo: si `countLeadSegments` y `LEAD_SEGMENTS`
    // se desincronizan, un chip queda sin número o sobra un balde que nadie
    // pinta. Acá se comprueba de verdad, no leyendo el fuente.
    const counts = countLeadSegments([]);
    expect(Object.keys(counts).sort()).toEqual(LEAD_SEGMENTS.map((s) => s.key).sort());
  });

  it("y los baldes suman el total, sin dejar leads fuera", () => {
    const leads = [
      { status: "nuevo", cart_item_count: 2 },
      { status: "nuevo", district: "Surco" },
      { status: "nuevo", first_inbound_text: "https://kenku.pe/products/x hola" },
      { status: "nuevo", inbound_count: 3 },
      { status: "nuevo" },
    ];
    const counts = countLeadSegments(leads);
    const suma = LEAD_SEGMENTS.reduce((n, s) => n + counts[s.key], 0);
    expect(suma).toBe(leads.length);
  });
});
