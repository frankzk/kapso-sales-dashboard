import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { processSwaypWebhook, swaypWebhookConfigured } from "@/lib/swayp-ingest";

/**
 * Minimal Supabase stub: only the chain processSwaypWebhook actually uses —
 * from().select().eq().maybeSingle() to read and from().update().eq() to write.
 */
function fakeAdmin(shipment: Record<string, unknown> | null) {
  const updates: Array<Record<string, unknown>> = [];
  const admin = {
    from() {
      return {
        select() {
          return {
            eq() {
              return { maybeSingle: async () => ({ data: shipment }) };
            },
          };
        },
        update(patch: Record<string, unknown>) {
          updates.push(patch);
          return { eq: async () => ({ error: null }) };
        },
      };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { admin, updates };
}

const TOKEN = "swayp-webhook-secret";

beforeEach(() => {
  vi.stubEnv("SWAYP_WEBHOOK_TOKEN", TOKEN);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("auth", () => {
  it("rejects a wrong or missing token", async () => {
    const { admin } = fakeAdmin({ id: "s1", delivery_status: "pendiente", swayp_state: 1 });
    expect(await processSwaypWebhook({ body: { token: "nope", guide_number: "1", state: "7" }, admin }))
      .toEqual({ status: "unauthorized", reason: "bad_token" });
    expect(await processSwaypWebhook({ body: { guide_number: "1", state: "7" }, admin }))
      .toEqual({ status: "unauthorized", reason: "bad_token" });
  });

  it("rejects everything when no token is configured (closed by default)", async () => {
    vi.stubEnv("SWAYP_WEBHOOK_TOKEN", "");
    const { admin } = fakeAdmin({ id: "s1", delivery_status: "pendiente", swayp_state: 1 });
    // El motivo distingue "falta configurar" de "token equivocado": los dos son
    // 401, y sin distinguirlos la puesta en marcha con Swayp se vuelve adivinar.
    expect(await processSwaypWebhook({ body: { token: "x", guide_number: "1", state: "7" }, admin }))
      .toEqual({ status: "unauthorized", reason: "not_configured" });
  });

  it("reports whether the token is configured, without revealing it", async () => {
    expect(swaypWebhookConfigured()).toBe(true);
    vi.stubEnv("SWAYP_WEBHOOK_TOKEN", "");
    expect(swaypWebhookConfigured()).toBe(false);
  });
});

describe("state updates", () => {
  it("applies a delivered notification", async () => {
    const { admin, updates } = fakeAdmin({ id: "s1", delivery_status: "en_ruta", swayp_state: 5 });
    const r = await processSwaypWebhook({
      body: { token: TOKEN, guide_number: "10000022753", state: "7" },
      admin,
      now: new Date("2026-07-27T12:00:00Z"),
    });
    expect(r).toMatchObject({ status: "updated", shipmentId: "s1", deliveryStatus: "entregado" });
    expect(updates[0]).toMatchObject({
      delivery_status: "entregado",
      status_category: "delivered",
      swayp_state: 7,
      swayp_synced_at: "2026-07-27T12:00:00.000Z",
    });
  });

  it("moves a guide into en_ruta when the courier takes it", async () => {
    const { admin, updates } = fakeAdmin({ id: "s1", delivery_status: "pendiente", swayp_state: 3 });
    await processSwaypWebhook({ body: { token: TOKEN, guide_number: "1", state: "4" }, admin });
    expect(updates[0]).toMatchObject({ delivery_status: "en_ruta", status_category: "in_route" });
  });

  it("brings a novedad back to the workable queue", async () => {
    const { admin, updates } = fakeAdmin({ id: "s1", delivery_status: "en_ruta", swayp_state: 5 });
    await processSwaypWebhook({ body: { token: TOKEN, guide_number: "1", state: "6" }, admin });
    expect(updates[0]).toMatchObject({ delivery_status: "pendiente", swayp_state: 6 });
  });

  it("records the raw state even when two states map to the same delivery_status", async () => {
    // 6 (Novedad) and 8 (Revisión) both map to 'pendiente'; swayp_state is what
    // keeps them distinguishable.
    const { admin, updates } = fakeAdmin({ id: "s1", delivery_status: "pendiente", swayp_state: 6 });
    const r = await processSwaypWebhook({ body: { token: TOKEN, guide_number: "1", state: "8" }, admin });
    expect(r.status).toBe("updated");
    expect(updates[0]).toMatchObject({ delivery_status: "pendiente", swayp_state: 8 });
  });
});

describe("defensive handling", () => {
  it("is a no-op when the same state is redelivered (their retries are safe)", async () => {
    const { admin, updates } = fakeAdmin({ id: "s1", delivery_status: "entregado", swayp_state: 7 });
    const r = await processSwaypWebhook({ body: { token: TOKEN, guide_number: "1", state: "7" }, admin });
    expect(r).toEqual({ status: "ignored", reason: "no_change" });
    expect(updates).toHaveLength(0);
  });

  it("ignores a guide we don't know", async () => {
    const { admin, updates } = fakeAdmin(null);
    const r = await processSwaypWebhook({ body: { token: TOKEN, guide_number: "999", state: "7" }, admin });
    expect(r).toEqual({ status: "ignored", reason: "no_shipment" });
    expect(updates).toHaveLength(0);
  });

  it("ignores an unknown state instead of blanking the status", async () => {
    const { admin, updates } = fakeAdmin({ id: "s1", delivery_status: "en_ruta", swayp_state: 5 });
    for (const state of ["99", "abc", ""]) {
      const r = await processSwaypWebhook({ body: { token: TOKEN, guide_number: "1", state }, admin });
      expect(r, state).toEqual({ status: "ignored", reason: "unknown_state" });
    }
    expect(updates).toHaveLength(0);
  });

  it("ignores a payload with no guide number", async () => {
    const { admin } = fakeAdmin({ id: "s1", delivery_status: "en_ruta", swayp_state: 5 });
    const r = await processSwaypWebhook({ body: { token: TOKEN, state: "7" }, admin });
    expect(r).toEqual({ status: "ignored", reason: "bad_payload" });
  });

  it("accepts a numeric guide_number (their docs show it both ways)", async () => {
    const { admin, updates } = fakeAdmin({ id: "s1", delivery_status: "en_ruta", swayp_state: 5 });
    const r = await processSwaypWebhook({ body: { token: TOKEN, guide_number: 10000022753, state: 7 }, admin });
    expect(r.status).toBe("updated");
    expect(updates[0]).toMatchObject({ delivery_status: "entregado" });
  });
});
