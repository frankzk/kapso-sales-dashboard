import { beforeAll, describe, expect, it, vi } from "vitest";

const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
beforeAll(() => {
  process.env.ENCRYPTION_KEY = KEY;
  process.env.SHALOM_API_KEY = "sk_test";
});

const { encrypt } = await import("@/lib/crypto");
const { readWithFreshSession } = await import("@/lib/shalom/session");
const { ShalomApiError } = await import("@/lib/shalom/types");

// `expires_at` no es señal suficiente: Shalom puede matar un token antes de su
// hora. Cuando eso pasa en mitad de armar una guía, el operador veía «vuelve a
// conectar la cuenta» y se quedaba clavado — pudiendo el panel renovar solo.
//
// El límite es lo importante y por eso se prueba: esto vale para LECTURAS.
// `POST /v1/orders` no es idempotente y no pasa por acá; reintentarlo
// despacharía el paquete dos veces.

const store = () => ({
  org_id: "org-1",
  shalom_pro_email: "tienda@ejemplo.com",
  shalom_pro_password_enc: encrypt("clave"),
  shalom_origin_terminal_id: 587,
  shalom_origin_terminal_name: "AV BOLIVAR",
  shalom_default_product_id: 1096,
  shalom_session_token_enc: encrypt("ssk_muerto"),
  shalom_session_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
});

/** Supabase mínimo: `stores` responde siempre la misma fila y traga updates. */
function fakeAdmin(row: ReturnType<typeof store>) {
  const q: any = {
    select: () => q,
    eq: () => q,
    neq: () => q,
    not: () => q,
    order: () => q,
    limit: () => q,
    maybeSingle: async () => ({ data: row }),
    update: () => q,
  };
  return { from: () => q } as any;
}

describe("readWithFreshSession", () => {
  it("renueva y reintenta cuando el token cacheado está muerto", async () => {
    const row = store();
    let intentos = 0;
    const run = vi.fn(async () => {
      intentos += 1;
      if (intentos === 1) {
        throw new ShalomApiError("token vencido", 401, "shalom_auth_failed");
      }
      return { ok: true };
    });

    // El re-login pasa por el camino `shared`: la fila que devuelve el fake ya
    // trae un token fresco, así que no hace falta salir a la red.
    await expect(readWithFreshSession(fakeAdmin(row), "store-1", row as any, run)).resolves.toEqual({
      ok: true,
    });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("no reintenta un fallo que no es de sesión: lo propaga tal cual", async () => {
    const row = store();
    const run = vi.fn(async () => {
      throw new ShalomApiError("no existe", 404, "not_found");
    });

    await expect(
      readWithFreshSession(fakeAdmin(row), "store-1", row as any, run),
    ).rejects.toBeInstanceOf(ShalomApiError);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("reintenta una sola vez: si el token nuevo también se rechaza, se rinde", async () => {
    const row = store();
    const run = vi.fn(async () => {
      throw new ShalomApiError("token vencido", 401, "shalom_auth_failed");
    });

    await expect(
      readWithFreshSession(fakeAdmin(row), "store-1", row as any, run),
    ).rejects.toBeInstanceOf(ShalomApiError);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
