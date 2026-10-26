import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { orderNameIn, peruMobile, recordUnknownSwaypGuide, swaypGuideContact } from "@/lib/swayp-unknown-guides";
import { processSwaypWebhook } from "@/lib/swayp-ingest";

/**
 * «Guías de Swayp que Kapta no tiene» (MOM §11.2, 26-10-2026, 0282). El caso:
 * #KP143754 salió por Swayp desde su panel, Swayp avisó la entrega y el webhook
 * la descartó en silencio porque la guía no estaba en Kapta.
 */

describe("swaypGuideContact: lo que dice la guía, para sugerir el pedido", () => {
  it("destinatario, celular y el número de pedido escrito en la guía", () => {
    const contact = swaypGuideContact({
      guia: 50000150001,
      estado: "Entregada",
      destinatario: { nombre: "Daniel", telefono: "930 450 265", direccion: "JR Gerardo Unger 4090" },
      productos: [{ nombreProducto: "SUPER HUMAN Black Seed Oil", cantidad: 1 }],
      observacion: "Pedido #kp143754 · cobrar 129",
    });
    expect(contact).toEqual({ name: "Daniel", phone: "51930450265", reference: "#KP143754" });
  });

  it("sin número de pedido, la referencia queda como texto; nada que no se reconozca", () => {
    expect(swaypGuideContact({ cliente: "Ana", celular: "51987654321", referencia: "Frente al parque" })).toEqual({
      name: "Ana",
      phone: "51987654321",
      reference: "Frente al parque",
    });
    expect(swaypGuideContact(null)).toEqual({ name: null, phone: null, reference: null });
    expect(swaypGuideContact({ telefono: "01 234 5678" }).phone).toBeNull();
  });

  it("los ayudantes", () => {
    expect(peruMobile("+51 930-450-265")).toBe("51930450265");
    expect(peruMobile("930450265")).toBe("51930450265");
    expect(peruMobile("12345")).toBeNull();
    expect(orderNameIn("pedido AUR178665 ok")).toBe("#AUR178665");
    expect(orderNameIn("sin pedido")).toBeNull();
  });
});

/** Una base mínima: lee, inserta y actualiza `swayp_unknown_guides`. */
function fakeAdmin(existing: Record<string, unknown> | null, opts: { insertError?: { code?: string; message: string } } = {}) {
  const inserts: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const admin = {
    from(table: string) {
      expect(table).toBe("swayp_unknown_guides");
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: existing, error: null }) }) }),
        insert: async (row: Record<string, unknown>) => {
          inserts.push(row);
          return { error: opts.insertError ?? null };
        },
        update: (patch: Record<string, unknown>) => {
          updates.push(patch);
          return { eq: async () => ({ error: null }) };
        },
      };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { admin, inserts, updates };
}

describe("recordUnknownSwaypGuide", () => {
  const now = new Date("2026-10-26T05:00:00Z");

  it("la primera vez guarda la guía con lo que Swayp diga de ella", async () => {
    const { admin, inserts } = fakeAdmin(null);
    const fetchGuide = vi.fn(async () => ({ destinatario: { nombre: "Daniel", telefono: "930450265" }, nota: "#KP143754" }));
    const out = await recordUnknownSwaypGuide(admin, { guideNumber: "50000150001", state: 7, orgId: "org-1", now, fetchGuide });
    expect(out).toBe("nueva");
    expect(fetchGuide).toHaveBeenCalledWith("50000150001");
    expect(inserts[0]).toMatchObject({
      guide_number: "50000150001",
      org_id: "org-1",
      last_state: 7,
      notices: 1,
      customer_name: "Daniel",
      customer_phone: "51930450265",
      reference: "#KP143754",
    });
  });

  it("las siguientes solo suben la cuenta, el estado y la hora; no vuelve a preguntar", async () => {
    const { admin, inserts, updates } = fakeAdmin({ guide_number: "50000150001", notices: 2 });
    const fetchGuide = vi.fn();
    const out = await recordUnknownSwaypGuide(admin, { guideNumber: "50000150001", state: 7, orgId: "org-1", now, fetchGuide });
    expect(out).toBe("repetida");
    expect(inserts).toHaveLength(0);
    expect(fetchGuide).not.toHaveBeenCalled();
    expect(updates[0]).toEqual({ last_seen_at: now.toISOString(), last_state: 7, notices: 3 });
  });

  it("si Swayp no responde la guía, se guarda solo el número", async () => {
    const { admin, inserts } = fakeAdmin(null);
    const out = await recordUnknownSwaypGuide(admin, {
      guideNumber: "1",
      state: 7,
      orgId: null,
      now,
      fetchGuide: async () => {
        throw new Error("500");
      },
    });
    expect(out).toBe("nueva");
    expect(inserts[0]).toMatchObject({ customer_name: null, customer_phone: null, reference: null });
  });

  it("nunca lanza: un fallo de la base vuelve como «error»", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { admin } = fakeAdmin(null, { insertError: { message: "relation does not exist" } });
    await expect(recordUnknownSwaypGuide(admin, { guideNumber: "1", state: 7, orgId: null, now })).resolves.toBe("error");
    vi.restoreAllMocks();
  });
});

describe("el webhook ya no la descarta en silencio", () => {
  beforeEach(() => vi.stubEnv("SWAYP_WEBHOOK_TOKEN", "t"));
  afterEach(() => vi.unstubAllEnvs());

  it("una guía que Kapta no tiene se guarda y el webhook responde igual", async () => {
    vi.stubEnv("SWAYP_INVENTORY_ORG_ID", "org-1");
    const admin = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const recordUnknown = vi.fn(async () => "nueva" as const);
    const r = await processSwaypWebhook({ body: { token: "t", guide_number: " 50000150001 ", state: "7" }, admin, recordUnknown });
    expect(r).toEqual({ status: "ignored", reason: "no_shipment" });
    expect(recordUnknown).toHaveBeenCalledWith(admin, expect.objectContaining({ guideNumber: "50000150001", state: 7, orgId: "org-1" }));
  });

  it("un token inválido no guarda nada", async () => {
    const recordUnknown = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await processSwaypWebhook({ body: { token: "otro", guide_number: "1", state: "7" }, admin: {} as any, recordUnknown });
    expect(recordUnknown).not.toHaveBeenCalled();
  });
});

describe("la base, Envíos y el MOM", () => {
  it("la tabla con RLS por la organización de Swayp", () => {
    const sql = readFileSync(resolve(__dirname, "../db/migrations/0282_swayp_unknown_guides.sql"), "utf8");
    expect(sql).toContain("create table if not exists swayp_unknown_guides");
    expect(sql).toContain("enable row level security");
    expect(sql).toContain("using (org_id in (select auth_org_ids()))");
  });

  it("Envíos enseña la tarjeta y el MOM lo cuenta", () => {
    const page = readFileSync(resolve(__dirname, "../app/dashboard/envios/page.tsx"), "utf8");
    expect(page).toContain("getSwaypUnknownGuides(storeIds).catch(() => null)");
    const mom = readFileSync(resolve(__dirname, "../docs/mom/master-pedidos-v1.md"), "utf8");
    expect(mom).toContain("#### Guías de Swayp que Kapta no tiene (26-10-2026, pedido del owner)");
    expect(mom).toContain("`swayp_unknown_guides` (0282)");
  });
});
