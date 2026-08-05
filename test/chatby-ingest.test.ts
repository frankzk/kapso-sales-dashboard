import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  chatbyWebhookConfigured,
  findUserNs,
  processChatbyWebhook,
  readChatbySecret,
} from "@/lib/chatby-ingest";

/**
 * Minimal Supabase stub: solo la cadena que usa processChatbyWebhook —
 * from().insert().select().maybeSingle().
 */
function fakeAdmin(error: { message: string } | null = null) {
  const inserted: Array<Record<string, unknown>> = [];
  const admin = {
    from() {
      return {
        insert(row: Record<string, unknown>) {
          inserted.push(row);
          return {
            select() {
              return {
                maybeSingle: async () => ({ data: error ? null : { id: "log-1" }, error }),
              };
            },
          };
        },
      };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  /** La fila escrita, con un fallo legible si no se escribió ninguna. */
  const first = (): Record<string, unknown> => {
    const row = inserted[0];
    if (!row) throw new Error("no se registró ningún insert");
    return row;
  };
  return { admin, inserted, first };
}

const SECRET = "chatby-webhook-secret";
const authed = { "x-webhook-secret": SECRET };

beforeEach(() => {
  vi.stubEnv("CHATBY_WEBHOOK_SECRET", SECRET);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("auth", () => {
  it("rejects everything when no secret is configured (closed by default)", async () => {
    vi.stubEnv("CHATBY_WEBHOOK_SECRET", "");
    const { admin, inserted } = fakeAdmin();
    expect(
      await processChatbyWebhook({ headers: authed, rawBody: "{}", admin }),
    ).toEqual({ status: "unauthorized", reason: "not_configured" });
    expect(chatbyWebhookConfigured()).toBe(false);
    // Y no escribe: sin poder autenticar, nada entra a la bitácora.
    expect(inserted).toHaveLength(0);
  });

  it("distinguishes a missing header from a wrong secret", async () => {
    const { admin } = fakeAdmin();
    // Los dos son 401, pero quien configura esto está en un panel de ajustes sin
    // ver nuestras variables: "te falta la cabecera" y "el valor está mal" son
    // dos arreglos distintos.
    expect(await processChatbyWebhook({ headers: {}, rawBody: "{}", admin })).toEqual({
      status: "unauthorized",
      reason: "missing_secret",
    });
    expect(
      await processChatbyWebhook({
        headers: { "x-webhook-secret": "nope" },
        rawBody: "{}",
        admin,
      }),
    ).toEqual({ status: "unauthorized", reason: "bad_secret" });
  });

  it("accepts both header forms Chatby's panel invites", () => {
    // El placeholder del campo Custom Header dice `Authorization: Bearer XXXXXX`,
    // así que es lo primero que una persona teclea. Sin esto, seguir el ejemplo
    // del propio Chatby daría 401.
    expect(readChatbySecret({ "x-webhook-secret": SECRET })).toBe(SECRET);
    expect(readChatbySecret({ authorization: `Bearer ${SECRET}` })).toBe(SECRET);
    expect(readChatbySecret({ authorization: `bearer ${SECRET}` })).toBe(SECRET);
    // Valor pelado: Chatby no valida el formato de la cabecera personalizada.
    expect(readChatbySecret({ authorization: SECRET })).toBe(SECRET);
    expect(readChatbySecret({ Authorization: `Bearer ${SECRET}` })).toBe(SECRET);
  });

  it("survives whitespace around the secret", async () => {
    // Se pega a mano en dos paneles distintos; un salto de línea al borde daría
    // 401 siempre, indistinguible de haberlo copiado mal.
    const { admin } = fakeAdmin();
    const res = await processChatbyWebhook({
      headers: { "x-webhook-secret": `  ${SECRET}\n` },
      rawBody: "{}",
      admin,
    });
    expect(res.status).toBe("stored");
  });
});

describe("no pierde entregas", () => {
  it("stores the payload verbatim", async () => {
    const { admin, first } = fakeAdmin();
    const body = { event: "message", user_ns: "u123", text: "hola" };
    const res = await processChatbyWebhook({
      headers: authed,
      rawBody: JSON.stringify(body),
      admin,
    });

    expect(res).toEqual({ status: "stored", id: "log-1", userNs: "u123", parsed: true });
    expect(first().payload).toEqual(body);
    expect(first().parsed).toBe(true);
  });

  it("keeps a non-JSON body instead of dropping it", async () => {
    // Este webhook es la ÚNICA fuente del texto de las conversaciones y no hay
    // endpoint para pedir lo perdido: una entrega descartada es historia que no
    // vuelve. Un cuerpo raro se guarda crudo y se mira después.
    const { admin, first } = fakeAdmin();
    const res = await processChatbyWebhook({ headers: authed, rawBody: "no soy json", admin });

    expect(res.status).toBe("stored");
    expect(first().parsed).toBe(false);
    expect(first().payload).toEqual({ _raw: "no soy json" });
  });

  it("wraps a JSON body that isn't an object", async () => {
    const { admin, first } = fakeAdmin();
    await processChatbyWebhook({ headers: authed, rawBody: "[1,2]", admin });
    expect(first().payload).toEqual({ _payload: [1, 2] });
  });

  it("surfaces a write failure instead of swallowing it", async () => {
    // Un 200 con la fila sin escribir sería la peor respuesta posible: Chatby
    // daría la entrega por buena y ese mensaje no existiría en ningún lado.
    const { admin } = fakeAdmin({ message: "insert failed" });
    expect(await processChatbyWebhook({ headers: authed, rawBody: "{}", admin })).toEqual({
      status: "error",
      reason: "insert failed",
    });
  });
});

describe("cabeceras", () => {
  it("records header names but never their values", async () => {
    // Uno de los valores es nuestro propio secreto. Los nombres sí sirven: dicen
    // si Chatby manda alguna firma o id de idempotencia aprovechable.
    const { admin, first } = fakeAdmin();
    await processChatbyWebhook({
      headers: { "X-Webhook-Secret": SECRET, "Content-Type": "application/json" },
      rawBody: "{}",
      admin,
    });

    expect(first().header_names).toEqual(["content-type", "x-webhook-secret"]);
    expect(JSON.stringify(first())).not.toContain(SECRET);
  });
});

describe("findUserNs", () => {
  it("finds user_ns nested inside the payload", () => {
    // El formato del payload no está documentado, así que `user_ns` puede venir
    // en la raíz o colgando de un objeto/array intermedio.
    expect(findUserNs({ user_ns: "u1" })).toBe("u1");
    expect(findUserNs({ data: { subscriber: { user_ns: "u2" } } })).toBe("u2");
    expect(findUserNs({ items: [{ other: 1 }, { user_ns: "u3" }] })).toBe("u3");
    expect(findUserNs({ user_ns: "  u4  " })).toBe("u4");
  });

  it("returns null instead of guessing", () => {
    expect(findUserNs({ userNs: "u1" })).toBeNull();
    expect(findUserNs({ user_ns: 42 })).toBeNull();
    expect(findUserNs({ user_ns: "" })).toBeNull();
    expect(findUserNs(null)).toBeNull();
    expect(findUserNs("texto")).toBeNull();
  });

  it("stops recursing on deeply nested payloads", () => {
    // Cota de profundidad: el payload viene de un tercero y no hay razón para
    // recorrer una estructura arbitrariamente honda en cada entrega.
    let deep: Record<string, unknown> = { user_ns: "hondo" };
    for (let i = 0; i < 10; i++) deep = { nested: deep };
    expect(findUserNs(deep)).toBeNull();
  });
});
