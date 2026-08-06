import { beforeEach, describe, expect, it, vi } from "vitest";

const { createServerSupabaseMock } = vi.hoisted(() => ({
  createServerSupabaseMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  createServerSupabase: createServerSupabaseMock,
}));

import { getLeadQueueSnapshot } from "@/lib/leads-access";
import { scoringProfileFor, sortLeadsByPriorityScoped } from "@/lib/lead-priority";

/**
 * Cola combinada de varias tiendas ("Todas las tiendas").
 *
 * No mezcla nada por dentro: cada lead sigue siendo su fila con su `store_id`.
 * Lo único que cambia es que la consulta deja de acotarse a una tienda. Lo que
 * sí exige cuidado es lo que se deriva de la tienda — el perfil de puntaje — y
 * la firma del refresco en vivo.
 */

const lead = (id: string, store: string, over: Record<string, unknown> = {}) => ({
  id,
  store_id: store,
  status: "nuevo",
  inbound_count: 0,
  // El segmento "carrito" lo decide `cart_item_count` (o el draft de Shopify),
  // NO el monto: un `cart_value` suelto deja el lead en "frío" y el peso que se
  // compara pasa a ser otro.
  cart_item_count: 0,
  cart_value: null,
  district: null,
  first_inbound_text: null,
  last_interaction_at: new Date().toISOString(),
  first_seen_at: new Date().toISOString(),
  ...over,
});

describe("puntaje con perfil por tienda", () => {
  it("usa el perfil de la tienda DE CADA FILA, no uno solo para todas", () => {
    // Un carrito recién creado vale 44 en Aurela y 24 en Kenku, porque así
    // convierten de verdad. Con el perfil de una sola tienda aplicado a todo, la
    // mitad de la cola quedaría ordenada con la escala equivocada.
    const now = Date.now();
    const fresh = new Date(now - 10 * 60_000).toISOString();
    const leads = [
      lead("k", "kenku", { cart_item_count: 1, cart_value: 100, first_seen_at: fresh, last_interaction_at: fresh }),
      lead("a", "aurela", { cart_item_count: 1, cart_value: 100, first_seen_at: fresh, last_interaction_at: fresh }),
    ];
    const profiles: Record<string, ReturnType<typeof scoringProfileFor>> = {
      aurela: scoringProfileFor("Aurela"),
      kenku: scoringProfileFor("Kenku Peru"),
    };

    const sorted = sortLeadsByPriorityScoped(leads, (l) => profiles[l.store_id]!, now);
    expect(sorted.map((l) => l.id)).toEqual(["a", "k"]);
  });

  it("el orden combinado no depende del orden de entrada", () => {
    // Si dependiera, la cola bailaría en cada recarga y nadie confiaría en ella.
    const now = Date.now();
    const fresh = new Date(now - 5 * 60_000).toISOString();
    const profiles: Record<string, ReturnType<typeof scoringProfileFor>> = {
      aurela: scoringProfileFor("Aurela"),
      kenku: scoringProfileFor("Kenku Peru"),
    };
    const a = lead("a", "aurela", { cart_item_count: 1, cart_value: 100, first_seen_at: fresh, last_interaction_at: fresh });
    const k = lead("k", "kenku", { cart_item_count: 1, cart_value: 100, first_seen_at: fresh, last_interaction_at: fresh });

    const one = sortLeadsByPriorityScoped([a, k], (l) => profiles[l.store_id]!, now);
    const two = sortLeadsByPriorityScoped([k, a], (l) => profiles[l.store_id]!, now);
    expect(one.map((l) => l.id)).toEqual(two.map((l) => l.id));
  });

  it("una tienda desconocida cae al perfil por defecto en vez de romper", () => {
    // Una tienda nueva sin pesos medidos todavía no debe tumbar la cola entera.
    const leads = [lead("x", "tienda-nueva", { cart_item_count: 1, cart_value: 50 })];
    const sorted = sortLeadsByPriorityScoped(leads, () => scoringProfileFor(null));
    expect(sorted.map((l) => l.id)).toEqual(["x"]);
  });
});

/**
 * La firma y los conteos combinados, contra la FUNCIÓN REAL.
 *
 * La primera versión de estos tests reimplementaba la concatenación dentro del
 * propio test: pasaban aunque `getLeadQueueSnapshot` hiciera otra cosa, que es
 * exactamente el tipo de test que da confianza falsa. Ahora se llama a la
 * función de verdad con un Supabase de mentira que responde el RPC por tienda.
 */
function mockQueueCounts(byStore: Record<string, Record<string, number | string>>) {
  const calls: string[] = [];
  createServerSupabaseMock.mockResolvedValue({
    rpc: (_name: string, args: { p_store_id: string }) => {
      calls.push(args.p_store_id);
      return {
        maybeSingle: async () => ({ data: byStore[args.p_store_id] ?? null, error: null }),
      };
    },
  });
  return calls;
}

const AURELA = { por_llamar: 10, handoff: 2, yape: 1, seguimientos: 3, ganados: 4, perdidos: 5, sin_llamar: 6, total: 31, last_change: "2026-08-06T10:00:00Z" };
const KENKU = { por_llamar: 7, handoff: 1, yape: 0, seguimientos: 2, ganados: 3, perdidos: 4, sin_llamar: 5, total: 22, last_change: "2026-08-06T09:00:00Z" };

describe("getLeadQueueSnapshot combinado", () => {
  beforeEach(() => {
    createServerSupabaseMock.mockReset();
  });

  it("suma los conteos de todas las tiendas del alcance", async () => {
    mockQueueCounts({ a: AURELA, k: KENKU });
    const snap = await getLeadQueueSnapshot(["a", "k"]);
    expect(snap.counts.por_llamar).toBe(17);
    expect(snap.counts.handoff).toBe(3);
    expect(snap.counts.sin_llamar).toBe(11);
  });

  it("con una sola tienda se comporta igual que antes", async () => {
    mockQueueCounts({ a: AURELA });
    const snap = await getLeadQueueSnapshot(["a"]);
    expect(snap.counts.por_llamar).toBe(10);
    expect(snap.signature).toBe("31:2026-08-06T10:00:00Z");
  });

  it("la firma cambia si cambia CUALQUIERA de las tiendas", async () => {
    // El fallo que esto evita es silencioso: si la firma se quedara con la de una
    // tienda, un lead nuevo en la otra no dispararía el refresco y la asesora
    // vería una cola vieja sin enterarse.
    mockQueueCounts({ a: AURELA, k: KENKU });
    const antes = (await getLeadQueueSnapshot(["a", "k"])).signature;

    mockQueueCounts({ a: AURELA, k: { ...KENKU, total: 23, last_change: "2026-08-06T09:30:00Z" } });
    const despues = (await getLeadQueueSnapshot(["a", "k"])).signature;
    expect(despues).not.toBe(antes);
  });

  it("la firma NO cambia si no cambió nada, venga en el orden que venga", async () => {
    // Las consultas salen en paralelo y resuelven en cualquier orden. Sin orden
    // fijo, la firma sería distinta en cada tick y el refresco recargaría los
    // ~2.500 leads dos veces por minuto — el goteo que la firma vino a eliminar.
    mockQueueCounts({ a: AURELA, k: KENKU });
    const uno = (await getLeadQueueSnapshot(["a", "k"])).signature;
    mockQueueCounts({ a: AURELA, k: KENKU });
    const dos = (await getLeadQueueSnapshot(["k", "a"])).signature;
    expect(dos).toBe(uno);
  });

  it("dos tiendas que se compensan NO dan la misma firma", async () => {
    // Sumar totales sería lo natural y estaría mal: +1 en una y −1 en la otra dan
    // el mismo total con una cola completamente distinta.
    mockQueueCounts({ a: AURELA, k: KENKU });
    const antes = (await getLeadQueueSnapshot(["a", "k"])).signature;

    mockQueueCounts({
      a: { ...AURELA, total: 32, last_change: "2026-08-06T11:00:00Z" },
      k: { ...KENKU, total: 21, last_change: "2026-08-06T11:00:00Z" },
    });
    expect((await getLeadQueueSnapshot(["a", "k"])).signature).not.toBe(antes);
  });

  it("un alcance vacío no consulta la base", async () => {
    const calls = mockQueueCounts({});
    const snap = await getLeadQueueSnapshot([]);
    expect(calls).toHaveLength(0);
    expect(snap.counts.por_llamar).toBe(0);
  });
});
