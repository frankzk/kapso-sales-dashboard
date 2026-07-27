import { describe, expect, it } from "vitest";

import { facetItems } from "@/lib/leads-facets";

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
