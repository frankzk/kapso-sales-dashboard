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

// El fake de arriba devuelve la MISMA fila para la tienda y para la búsqueda de
// una hermana con la misma cuenta, que es justo el escenario que rompió en
// producción: al renovar, el atajo `shared` copiaba de vuelta el token que
// Shalom acababa de rechazar —porque lo juzga por `expires_at`, que miente— y el
// reintento repetía el fallo idéntico. `force` salta ese atajo.

describe("readWithFreshSession", () => {
  it("NO readopta el token que acaban de rechazar: pide uno de verdad", async () => {
    const row = store();
    const run = vi.fn(async () => {
      throw new ShalomApiError("token vencido", 401, "shalom_auth_failed");
    });

    // La fila trae un `expires_at` en el futuro y un token cifrado, así que los
    // dos atajos de `mintSession` lo darían por bueno. Si el reintento los
    // usara, no habría ninguna llamada a `/v1/shalom/sessions` y volvería a
    // fallar con el mismo token — que es lo que pasaba.
    const createSession = vi.fn(async () => {
      throw new Error("login intentado");
    });
    const { ShalomClient } = await import("@/lib/shalom/client");
    const spy = vi.spyOn(ShalomClient.prototype, "createSession").mockImplementation(createSession);

    await expect(
      readWithFreshSession(fakeAdmin(row), "store-1", row as any, run),
    ).rejects.toBeTruthy();

    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
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

    // Login que sí devuelve un token: así el segundo intento llega a ocurrir y
    // se puede comprobar que NO hay un tercero. Sin este tope, cada lectura de
    // una cuenta con problemas encadenaría logins de 90 s.
    const { ShalomClient } = await import("@/lib/shalom/client");
    const spy = vi.spyOn(ShalomClient.prototype, "createSession").mockResolvedValue({
      session_token: "ssk_nuevo",
      expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    } as any);

    await expect(
      readWithFreshSession(fakeAdmin(row), "store-1", row as any, run),
    ).rejects.toBeInstanceOf(ShalomApiError);
    expect(run).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

