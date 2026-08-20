import { createHmac } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  metaSocialConfigured,
  metaSocialVerifyConfigured,
  processMetaSocialWebhook,
  readEnvelope,
  signatureMatches,
  verifyChallenge,
} from "@/lib/meta-social-ingest";

/**
 * Sonda de comentarios de Facebook e Instagram.
 *
 * Lo que se prueba es lo que puede hacer perder una entrega o dejar la puerta
 * abierta. La sonda no decide nada del negocio —guarda y calla— así que su
 * superficie de fallo es exactamente esa: autenticar bien, no perder nada, y no
 * inventarse el contenido.
 */

/** Stub mínimo de Supabase: solo from().insert().select().maybeSingle(). */
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
  const first = (): Record<string, unknown> => {
    const row = inserted[0];
    if (!row) throw new Error("no se registró ningún insert");
    return row;
  };
  return { admin, inserted, first };
}

const SECRET = "meta-app-secret";
const VERIFY = "token-que-yo-invento";

const sign = (body: string, secret = SECRET) =>
  `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
const headersFor = (body: string) => ({ "x-hub-signature-256": sign(body) });

beforeEach(() => {
  vi.stubEnv("META_APP_SECRET", SECRET);
  vi.stubEnv("META_WEBHOOK_VERIFY_TOKEN", VERIFY);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("apretón de manos de verificación", () => {
  it("devuelve el challenge cuando el token coincide", () => {
    expect(verifyChallenge({ mode: "subscribe", token: VERIFY, challenge: "1158201444" })).toEqual({
      ok: true,
      challenge: "1158201444",
    });
  });

  it("con el token equivocado NO devuelve el challenge", () => {
    // Devolverlo igualmente convertiría la URL en un verificador para
    // cualquiera: bastaría con llamarla para dar de alta un webhook ajeno.
    expect(verifyChallenge({ mode: "subscribe", token: "otro", challenge: "123" })).toEqual({
      ok: false,
      reason: "bad_token",
    });
  });

  it("sin token configurado no verifica a nadie", () => {
    vi.stubEnv("META_WEBHOOK_VERIFY_TOKEN", "");
    expect(verifyChallenge({ mode: "subscribe", token: VERIFY, challenge: "123" }).ok).toBe(false);
    expect(metaSocialVerifyConfigured()).toBe(false);
  });

  it("solo el modo `subscribe`", () => {
    expect(verifyChallenge({ mode: "unsubscribe", token: VERIFY, challenge: "123" })).toEqual({
      ok: false,
      reason: "bad_mode",
    });
  });
});

describe("firma", () => {
  const body = '{"object":"page","entry":[]}';

  it("acepta la firma correcta", () => {
    expect(signatureMatches(body, sign(body), SECRET)).toBe(true);
  });

  it("rechaza el cuerpo alterado aunque sea un espacio", () => {
    // ESTA es la trampa del webhook de Meta: el HMAC es sobre el cuerpo EXACTO.
    // Parsear y re-serializar cambia un espacio, tira la firma, y el 401 que
    // sale parece un secreto mal copiado cuando el secreto está bien. Por eso la
    // ruta lee `req.text()` y firma eso, nunca `req.json()`.
    const firma = sign(body);
    expect(signatureMatches('{"object":"page", "entry":[]}', firma, SECRET)).toBe(false);
    expect(signatureMatches(body, firma, SECRET)).toBe(true);
  });

  it("rechaza la firma de otro secreto", () => {
    expect(signatureMatches(body, sign(body, "otro-secreto"), SECRET)).toBe(false);
  });

  it("exige el prefijo `sha256=`", () => {
    const hex = createHmac("sha256", SECRET).update(body, "utf8").digest("hex");
    expect(signatureMatches(body, hex, SECRET)).toBe(false);
    expect(signatureMatches(body, `sha256=${hex}`, SECRET)).toBe(true);
  });

  it("no acepta un hex correcto anunciado como otro algoritmo", () => {
    // `sha512=` mide EXACTAMENTE lo mismo que `sha256=`: siete caracteres. Sin
    // comprobar el prefijo, recortar siete a ciegas dejaría pasar un HMAC-SHA256
    // correcto presentado como SHA-512 — confusión de algoritmo, y la clase de
    // agujero que no se ve leyendo el código porque el recorte "casi" lo tapa.
    //
    // Este caso lo destapó una mutación: quitar la comprobación del prefijo no
    // rompía ninguna prueba, así que la guarda estaba sin vigilar.
    const hex = createHmac("sha256", SECRET).update(body, "utf8").digest("hex");
    expect(signatureMatches(body, `sha512=${hex}`, SECRET)).toBe(false);
    expect(signatureMatches(body, `sha256=${hex}`, SECRET)).toBe(true);
  });

  it("acepta el hex en mayúsculas", () => {
    // Nadie promete el caso del hexadecimal, y compararlo tal cual daría un 401
    // intermitente imposible de atribuir.
    const hex = createHmac("sha256", SECRET).update(body, "utf8").digest("hex");
    expect(signatureMatches(body, `sha256=${hex.toUpperCase()}`, SECRET)).toBe(true);
  });

  it("sin secreto no valida nada", () => {
    expect(signatureMatches(body, sign(body), "")).toBe(false);
  });
});

describe("el sobre: lo único que se interpreta", () => {
  const entrega = {
    object: "instagram",
    entry: [
      {
        id: "17841400000000000",
        time: 1755000000,
        changes: [{ field: "comments", value: { id: "c1", text: "precio?" } }],
      },
    ],
  };

  it("lee objeto, cuenta y campo", () => {
    expect(readEnvelope(entrega)).toEqual({
      objectType: "instagram",
      entryIds: ["17841400000000000"],
      fields: ["comments"],
    });
  });

  it("no se inventa el contenido del comentario", () => {
    // La sonda existe justamente para NO adivinar la forma del payload. Si algún
    // día esto empieza a extraer el texto o el id del anuncio, deja de ser una
    // sonda y pasa a ser un parser escrito a ciegas — el error que este
    // repositorio ya pagó dos veces.
    const sobre = readEnvelope(entrega) as Record<string, unknown>;
    expect(Object.keys(sobre).sort()).toEqual(["entryIds", "fields", "objectType"]);
  });

  it("junta varias entradas y campos sin repetir", () => {
    expect(
      readEnvelope({
        object: "page",
        entry: [
          { id: "111", changes: [{ field: "feed" }, { field: "feed" }] },
          { id: "222", changes: [{ field: "mention" }] },
          { id: "111", changes: [{ field: "feed" }] },
        ],
      }),
    ).toEqual({ objectType: "page", entryIds: ["111", "222"], fields: ["feed", "mention"] });
  });

  it("marca los mensajes directos, que no vienen en `changes`", () => {
    // Aunque la sonda mire comentarios, si un día llegan DMs por este mismo sobre
    // hay que enterarse por los datos y no de golpe al construir la bandeja.
    expect(readEnvelope({ object: "instagram", entry: [{ id: "9", messaging: [{ sender: {} }] }] }).fields).toEqual([
      "messaging",
    ]);
  });

  it("un id numérico se guarda como texto", () => {
    // La columna es `text[]`. Meta manda strings, pero ha mandado números en
    // otros webhooks y un id perdido acá es una tienda que no se puede resolver.
    expect(readEnvelope({ object: "page", entry: [{ id: 111 }] }).entryIds).toEqual(["111"]);
  });

  it("un payload raro no lanza: devuelve el sobre vacío", () => {
    for (const raro of [null, undefined, 42, "texto", [], { entry: "no-es-lista" }]) {
      expect(() => readEnvelope(raro)).not.toThrow();
    }
    expect(readEnvelope({ entry: [{ changes: "no-es-lista" }] }).fields).toEqual([]);
  });
});

describe("autenticación de la entrega", () => {
  it("sin app secret configurado no entra nada (cerrado por defecto)", async () => {
    vi.stubEnv("META_APP_SECRET", "");
    const { admin, inserted } = fakeAdmin();
    expect(await processMetaSocialWebhook({ headers: {}, rawBody: "{}", admin })).toEqual({
      status: "unauthorized",
      reason: "not_configured",
    });
    expect(metaSocialConfigured()).toBe(false);
    expect(inserted).toHaveLength(0);
  });

  it("sin firma no entra nada", async () => {
    const { admin, inserted } = fakeAdmin();
    expect(await processMetaSocialWebhook({ headers: {}, rawBody: "{}", admin })).toEqual({
      status: "unauthorized",
      reason: "missing_signature",
    });
    expect(inserted).toHaveLength(0);
  });

  it("con firma mala NO se guarda", async () => {
    // Sin esta puerta, cualquiera que descubra la URL escribe en nuestra base.
    const { admin, inserted } = fakeAdmin();
    expect(
      await processMetaSocialWebhook({
        headers: { "x-hub-signature-256": sign("{}", "otro") },
        rawBody: "{}",
        admin,
      }),
    ).toEqual({ status: "unauthorized", reason: "bad_signature" });
    expect(inserted).toHaveLength(0);
  });

  it("la cabecera se busca sin importar mayúsculas", async () => {
    const body = '{"object":"page","entry":[]}';
    const { admin } = fakeAdmin();
    const res = await processMetaSocialWebhook({
      headers: { "X-Hub-Signature-256": sign(body) },
      rawBody: body,
      admin,
    });
    expect(res.status).toBe("stored");
  });
});

describe("guardar sin perder nada", () => {
  it("guarda el payload entero y el sobre por separado", async () => {
    const body = JSON.stringify({
      object: "page",
      entry: [{ id: "555", changes: [{ field: "feed", value: { item: "comment" } }] }],
    });
    const { admin, first } = fakeAdmin();
    const res = await processMetaSocialWebhook({ headers: headersFor(body), rawBody: body, admin });

    expect(res).toMatchObject({ status: "stored", objectType: "page", fields: ["feed"] });
    expect(first().payload).toEqual(JSON.parse(body));
    expect(first().entry_ids).toEqual(["555"]);
  });

  it("un cuerpo que no es JSON se conserva, no se descarta", async () => {
    // De una entrega perdida no hay forma de pedir copia. Vale más una fila con
    // `{"_raw": "…"}` que un 400 y un hueco en la semana de medición.
    const body = "esto no es json";
    const { admin, first } = fakeAdmin();
    const res = await processMetaSocialWebhook({ headers: headersFor(body), rawBody: body, admin });

    expect(res).toMatchObject({ status: "stored", parsed: false });
    expect(first().payload).toEqual({ _raw: body });
    expect(first().parsed).toBe(false);
  });

  it("un JSON que no es objeto se envuelve, porque la columna es jsonb", async () => {
    const body = "[1,2,3]";
    const { admin, first } = fakeAdmin();
    await processMetaSocialWebhook({ headers: headersFor(body), rawBody: body, admin });
    expect(first().payload).toEqual({ _payload: [1, 2, 3] });
  });

  it("guarda los NOMBRES de las cabeceras, nunca sus valores", async () => {
    // Uno de los valores es la firma, derivada de nuestro app secret. Y los
    // nombres son justamente lo que se quiere aprender: qué manda Meta de verdad
    // (id de entrega, reintentos) sin guardar nada que no debamos.
    const body = "{}";
    const { admin, first } = fakeAdmin();
    await processMetaSocialWebhook({
      headers: { "X-Hub-Signature-256": sign(body), "X-Custom": "valor-secreto" },
      rawBody: body,
      admin,
    });

    const names = first().header_names as string[];
    expect(names).toEqual(["x-custom", "x-hub-signature-256"]);
    expect(JSON.stringify(first())).not.toContain("valor-secreto");
    expect(JSON.stringify(first())).not.toContain(SECRET);
  });

  it("un fallo de la base se devuelve, no se traga", async () => {
    const { admin } = fakeAdmin({ message: "insert falló" });
    expect(await processMetaSocialWebhook({ headers: headersFor("{}"), rawBody: "{}", admin })).toEqual({
      status: "error",
      reason: "insert falló",
    });
  });
});
