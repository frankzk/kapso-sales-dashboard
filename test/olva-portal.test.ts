import { describe, expect, it } from "vitest";
import {
  extractCsrfToken,
  extractPortalJwt,
  fetchOlvaPortalTrackings,
  isCloudflareChallenge,
  olvaPortalLogin,
  parsePortalTrackings,
  portalTrackingsUrl,
  type OlvaPortalRow,
} from "@/lib/olva/portal";
import {
  matchPortalRows,
  nameCovered,
  olvaAddressCore,
  normalizeText,
  type CotejoCandidate,
} from "@/lib/olva/portal-match";

// Las cinco filas que trajo el portal el 02-10-2026, con los nombres cambiados
// pero la MISMA forma de parecido y de diferencia que tenían las reales.
const PORTAL = {
  success: true,
  msg: "resultados obtenidos",
  data: [
    {
      tracking: "02649804/26",
      estado: "ASIGNADO",
      destinario: "CIRO ALEGRIA ALVARADO",
      departamento: "ANCASH",
      provincia: "HUARAZ",
      distrito: "INDEPENDENCIA",
      direccion: " AV LAS FLORES 322 URB NICRUPAMPA NRO null (Frente a la iglesia San Martín de Porres)",
      fecha_registro: "2026-10-01",
      doc_externo: "",
    },
    {
      tracking: "02649802/26",
      estado: "ASIGNADO",
      destinario: "HERNAN LUCIO CHAVEZ RODRIGUEZ",
      departamento: "ANCASH",
      provincia: "SANTA",
      distrito: "NUEVO CHIMBOTE",
      direccion: " URB. BELLA MAR MZ. B-13 PRIMERA ETAPA NUEVO CHIMBOTE NRO null (Frente a la puerta principal de la escuela)",
      fecha_registro: "2026-10-01",
      doc_externo: "",
    },
    {
      tracking: "02649806/26",
      estado: "DESPACHADO",
      destinario: "MARIBEL AMALIA ROSAS CHALCO",
      departamento: "APURIMAC",
      provincia: "ABANCAY",
      distrito: "ABANCAY",
      direccion: "OFICINA TIENDA ABANCAY - AV ELIAS NRO 118 (COSTADO DE ONP)",
      fecha_registro: "2026-10-01",
      doc_externo: "",
    },
    {
      tracking: "02649803/26",
      estado: "DESPACHADO",
      destinario: "JORGE CASAPINO GUZMAN",
      departamento: "AREQUIPA",
      provincia: "AREQUIPA",
      distrito: "JOSE LUIS BUSTAMANTE Y RIVERO",
      direccion: " URB ALTO DE LA LUNA Q30 JOSE LUIS BUSTAMANTE NRO null (A tres cuadras av estados unidos)",
      fecha_registro: "2026-10-01",
      doc_externo: "",
    },
    {
      tracking: "02649805/26",
      estado: "ASIGNADO",
      destinario: "MANUEL ALBERTO VERTIZ MALAGA",
      departamento: "LA LIBERTAD",
      provincia: "TRUJILLO",
      distrito: "TRUJILLO",
      direccion: " STO. TORIBIO DE MOGTOVEJO 640 SAN ANDRES NRO null (Recta de la pip)",
      fecha_registro: "2026-10-01",
      doc_externo: "",
    },
  ],
};

function cand(over: Partial<CotejoCandidate> & { shipmentId: string }): CotejoCandidate {
  return {
    storeId: "kenku",
    orderName: null,
    guideCode: null,
    customerName: null,
    address: null,
    district: null,
    createdAt: "2026-09-30T20:00:00Z",
    ...over,
  };
}

// Lo que Kapta tenía: las salidas creadas el 30-09 sin tracking.
const KAPTA: CotejoCandidate[] = [
  cand({ shipmentId: "s-ciro", orderName: "#KP137874", customerName: "Ciro Alegria Claro", address: "Av las flores 322 Urb Nicrupampa" }),
  cand({ shipmentId: "s-hernan", orderName: "#KP137860", customerName: "Hernan chavez Rodriguez", address: "Urb. BELLA MAR  Mz.  B-13  primera etapa  nuevo chimbote" }),
  cand({ shipmentId: "s-casapino", orderName: "#KP137871", customerName: "Ramiro casapino guzman", address: "Urb alto de la luna Q30 jose luis bustamante" }),
  cand({ shipmentId: "s-manuel", orderName: "#KP137896", customerName: "Manuel vertiz malaga", address: "Sto. Toribio de Mogtovejo 640 San Andres" }),
  cand({ shipmentId: "s-teylu", orderName: "#AUR177408", storeId: "aurela", customerName: "Teylu Cuellar Serrano", address: "Av prado bajo N 501", district: "Abancay" }),
];

function rows(): OlvaPortalRow[] {
  const r = parsePortalTrackings(PORTAL);
  if (!r.ok) throw new Error(r.error);
  return r.rows;
}

describe("la respuesta del portal", () => {
  it("lee el tracking con ceros y barra como el que guarda Kapta", () => {
    const first = rows()[0]!;
    expect(first.id).toEqual({ tracking: "2649804", emision: "26" });
    expect(first.rawTracking).toBe("02649804/26");
    expect(first.destinatario).toBe("CIRO ALEGRIA ALVARADO");
    expect(first.fechaRegistro).toBe("2026-10-01");
    expect(first.docExterno).toBeNull();
  });

  it("acepta solo el `data`, que es lo que alguien puede copiar", () => {
    const r = parsePortalTrackings(PORTAL.data);
    expect(r.ok && r.rows.length).toBe(5);
  });

  it("descarta lo ilegible y lo cuenta", () => {
    const r = parsePortalTrackings({ success: true, data: [{ tracking: "TG12", destinario: "X" }, { tracking: "02649804/26" }] });
    expect(r).toMatchObject({ ok: true, rows: [], skipped: 2 });
  });

  it("un success:false es un error con el mensaje de Olva", () => {
    expect(parsePortalTrackings({ success: false, msg: "token vencido" })).toMatchObject({ ok: false, error: expect.stringContaining("token vencido") });
    expect(parsePortalTrackings({ hola: 1 })).toMatchObject({ ok: false });
  });

  it("pide lo mismo que el portal, con el año de emisión a dos dígitos", () => {
    const url = new URL(portalTrackingsUrl({ ruc: "20556792829", desde: "2026-10-01", hasta: "2026-10-02" }));
    expect(url.host).toBe("reports.olvaexpress.pe");
    expect(url.searchParams.get("desde")).toBe("2026-10-01 00:00:00");
    expect(url.searchParams.get("hasta")).toBe("2026-10-02 23:59:59");
    expect(url.searchParams.get("documento")).toBe("20556792829");
    expect(url.searchParams.get("emision_tracking")).toBe("26");
    expect(url.searchParams.get("tipo_cliente")).toBe("CONTADO");
  });
});

describe("el cotejo: solo lo que no admite duda", () => {
  it("las cinco del 02-10-2026: dos se vinculan, dos a revisar, una sin pareja", () => {
    const out = matchPortalRows(rows(), KAPTA, new Map());
    const byTracking = Object.fromEntries(out.map((o) => [o.row.rawTracking, o]));

    // Todos los nombres de Kapta están en Olva (que añade el segundo nombre) y
    // la dirección es la misma: no hay nada que interpretar.
    expect(byTracking["02649802/26"]).toMatchObject({ kind: "vincular", via: "nombre_direccion", candidate: { shipmentId: "s-hernan" } });
    expect(byTracking["02649805/26"]).toMatchObject({ kind: "vincular", via: "nombre_direccion", candidate: { shipmentId: "s-manuel" } });

    // Misma casa, un apellido distinto: casi seguro, pero lo decide una persona.
    expect(byTracking["02649804/26"]).toMatchObject({ kind: "revisar", hints: [{ candidate: { shipmentId: "s-ciro" } }] });
    const ciro = byTracking["02649804/26"];
    expect(ciro?.kind === "revisar" && ciro.hints[0]?.why).toContain("misma dirección");
    // Misma casa, otra persona recibiendo.
    expect(byTracking["02649803/26"]).toMatchObject({ kind: "revisar", hints: [{ candidate: { shipmentId: "s-casapino" } }] });

    // Abancay solo tiene una salida de otra clienta y otra dirección.
    expect(byTracking["02649806/26"]).toMatchObject({ kind: "sin_pareja" });
  });

  it("el Doc. externo con el número del pedido vincula aunque nada más coincida", () => {
    const ciro = rows()[0]!;
    const out = matchPortalRows([{ ...ciro, docExterno: "KP137874" }], KAPTA, new Map());
    expect(out[0]).toMatchObject({ kind: "vincular", via: "doc_externo", candidate: { shipmentId: "s-ciro" } });
    // Con almohadilla y espacios, igual.
    const again = matchPortalRows([{ ...ciro, docExterno: " #kp137874 " }], KAPTA, new Map());
    expect(again[0]).toMatchObject({ kind: "vincular", via: "doc_externo" });
  });

  it("un tracking que ya está en alguna salida no se toca", () => {
    const linked = new Map([["2649802-26", "#KP137860"]]);
    const out = matchPortalRows(rows(), KAPTA, linked);
    expect(out.find((o) => o.row.rawTracking === "02649802/26")).toMatchObject({ kind: "ya_vinculado", orderName: "#KP137860" });
  });

  it("dos salidas idénticas no se adivinan", () => {
    const gemela = { ...KAPTA[1]!, shipmentId: "s-hernan-2", orderName: "#KP137999" };
    const out = matchPortalRows(rows(), [...KAPTA, gemela], new Map());
    const hernan = out.find((o) => o.row.rawTracking === "02649802/26");
    expect(hernan).toMatchObject({ kind: "revisar", reason: expect.stringContaining("2 salidas") });
  });

  it("dos envíos de Olva hacia la misma salida tampoco", () => {
    const hernan = rows()[1]!;
    const segundo = { ...hernan, id: { tracking: "2649900", emision: "26" }, rawTracking: "02649900/26" };
    const out = matchPortalRows([hernan, segundo], KAPTA, new Map());
    expect(out.every((o) => o.kind === "revisar")).toBe(true);
  });

  it("una salida muy anterior al registro en Olva no es candidata", () => {
    const vieja = { ...KAPTA[1]!, createdAt: "2026-08-01T20:00:00Z" };
    const out = matchPortalRows(rows(), [vieja], new Map());
    expect(out.find((o) => o.row.rawTracking === "02649802/26")).toMatchObject({ kind: "sin_pareja" });
  });
});

describe("las piezas de la regla", () => {
  it("la dirección de Olva sin « NRO null» ni la referencia es la de Kapta", () => {
    expect(olvaAddressCore(" URB. BELLA MAR MZ. B-13 PRIMERA ETAPA NUEVO CHIMBOTE NRO null (Frente a la escuela)")).toBe(
      normalizeText("Urb. BELLA MAR  Mz.  B-13  primera etapa  nuevo chimbote"),
    );
    // Un número de verdad se queda: es parte de la dirección.
    expect(olvaAddressCore("AV ELIAS NRO 118 (COSTADO DE ONP)")).toBe("av elias nro 118");
  });

  it("todos los nombres de Kapta, al menos dos, y sin importar tildes", () => {
    expect(nameCovered("José Pérez", "JOSE ANTONIO PEREZ ROJAS")).toBe(true);
    expect(nameCovered("Carlos Carlos", "CARLOS QUISPE")).toBe(false);
    expect(nameCovered("Camilo", "CAMILO TORRES")).toBe(false);
    expect(nameCovered("Ciro Alegria Claro", "CIRO ALEGRIA ALVARADO")).toBe(false);
  });
});

describe("el ingreso al portal", () => {
  const LOGIN_HTML = `<form action="/user/login_check" method="post">
    <input type="text" name="_username"><input type="password" name="_password">
    <input type="hidden" value="tok-123" name="_csrf_token"></form>`;
  const FOLLOW_HTML = `<a onclick="listar($('#followform'))">Listar</a>
    <input type="hidden" id="jwt" value="eyJ0eXAi.cuerpo.firma">`;

  it("lee el token del formulario y el JWT, sea cual sea el orden de los atributos", () => {
    expect(extractCsrfToken(LOGIN_HTML)).toBe("tok-123");
    expect(extractPortalJwt(FOLLOW_HTML)).toBe("eyJ0eXAi.cuerpo.firma");
    expect(extractPortalJwt(`<input id="jwt" value="">`)).toBeNull();
  });

  type Call = { url: string; method: string; body?: string; cookie?: string };

  function fakePortal(opts: { badPassword?: boolean; challenge?: boolean } = {}) {
    const calls: Call[] = [];
    const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url, method: init?.method ?? "GET", body: init?.body as string | undefined, cookie: headers.cookie });
      const path = new URL(url).pathname;
      if (opts.challenge) {
        return new Response("<title>Just a moment...</title>", { status: 403, headers: { "cf-mitigated": "challenge" } });
      }
      if (path === "/atc/user/login") {
        return new Response(LOGIN_HTML, { status: 200, headers: { "set-cookie": "PHPSESSID=uno; path=/; HttpOnly" } });
      }
      if (path === "/user/login_check") {
        const to = opts.badPassword ? "/user/failure" : "http://atc.olvaexpress.pe/user/redirect";
        return new Response(null, { status: 302, headers: { location: to, "set-cookie": "PHPSESSID=dos; path=/" } });
      }
      if (path === "/user/redirect") return new Response(null, { status: 302, headers: { location: "/atc/user/front" } });
      if (path === "/atc/user/front" || path === "/user/failure") return new Response("<html>ok</html>", { status: 200 });
      if (path === "/atc/follow") {
        return new Response(headers.cookie?.includes("PHPSESSID=dos") ? FOLLOW_HTML : LOGIN_HTML, { status: 200 });
      }
      if (path === "/atc/auth/getTrackingsClient") {
        if (headers.authorization !== "Bearer eyJ0eXAi.cuerpo.firma") return new Response("{}", { status: 401 });
        return new Response(JSON.stringify(PORTAL), { status: 200 });
      }
      return new Response("no", { status: 404 });
    }) as typeof fetch;
    return { calls, impl };
  }

  it("entra con usuario, contraseña y el token, con la cookie de sesión, y saca el JWT", async () => {
    const { calls, impl } = fakePortal();
    const r = await olvaPortalLogin({ username: "120000000001", password: "secreta" }, impl);
    expect(r).toEqual({ ok: true, jwt: "eyJ0eXAi.cuerpo.firma" });

    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe("https://atc.olvaexpress.pe/user/login_check");
    expect(post.cookie).toBe("PHPSESSID=uno");
    const form = new URLSearchParams(post.body);
    expect(form.get("_username")).toBe("120000000001");
    expect(form.get("_password")).toBe("secreta");
    expect(form.get("_csrf_token")).toBe("tok-123");
    expect(form.get("_target_path")).toBe("/user/redirect");
    // La redirección a http:// se sigue por https://.
    expect(calls.some((c) => c.url === "https://atc.olvaexpress.pe/user/redirect" && c.method === "GET")).toBe(true);
  });

  it("una contraseña mala se dice como tal", async () => {
    const { impl } = fakePortal({ badPassword: true });
    expect(await olvaPortalLogin({ username: "u", password: "mala" }, impl)).toMatchObject({ ok: false, kind: "auth" });
  });

  it("el desafío de Cloudflare se reconoce y no se reintenta", async () => {
    const { calls, impl } = fakePortal({ challenge: true });
    expect(await olvaPortalLogin({ username: "u", password: "p" }, impl)).toMatchObject({ ok: false, kind: "blocked" });
    expect(calls).toHaveLength(1);
    expect(isCloudflareChallenge(200, new Headers(), "<html>Just a moment</html>")).toBe(false);
  });

  it("con el JWT trae los envíos del rango", async () => {
    const { impl } = fakePortal();
    const r = await fetchOlvaPortalTrackings({ jwt: "eyJ0eXAi.cuerpo.firma", ruc: "20000000001", desde: "2026-10-01", hasta: "2026-10-02" }, impl);
    expect(r.ok && r.rows.map((x) => x.id.tracking)).toEqual(["2649804", "2649802", "2649806", "2649803", "2649805"]);
    const bad = await fetchOlvaPortalTrackings({ jwt: "otro", ruc: "1", desde: "2026-10-01", hasta: "2026-10-02" }, impl);
    expect(bad).toMatchObject({ ok: false, kind: "auth" });
  });
});
