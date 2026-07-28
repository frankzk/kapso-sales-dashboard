import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";

// Runtime EDGE a propósito: es la única razón de que este archivo exista.
//
// EL PROBLEMA. Cloudflare desafía nuestras peticiones a la API de Aliclik
// (HTTP 403, página "Just a moment") y nunca llegan a su servidor. Se probó
// desde Virginia y desde São Paulo con el mismo resultado, así que no es
// geografía — pero las dos son IPs de centro de datos de AWS, que es la clase
// de IP que Cloudflare puntúa peor.
//
// LA IDEA. Las funciones Edge de Vercel NO corren en la misma red que las
// funciones Node: salen por la red de borde (históricamente, la de Cloudflare).
// Una petición hacia un sitio protegido por Cloudflare que sale desde esa red
// se evalúa con una reputación distinta. Puede bastar, o puede no bastar: es
// una hipótesis barata de probar, no una certeza.
//
// Esto NO es evadir su WAF: no se falsifica nada ni se resuelve ningún desafío.
// Solo se cambia desde qué red sale la petición, que es una decisión de
// arquitectura tan legítima como elegir la región.
//
// NO ES UN PROXY ABIERTO. Tres cerraduras:
//   1. El host de destino NUNCA viene de la petición: sale de la configuración.
//   2. Solo se permiten rutas /integration/*.
//   3. Hace falta el secreto interno (CRON_SECRET). Es el mismo criterio que
//      los crons —nuestra propia infraestructura llamándose a sí misma— y no el
//      caso del webhook de Aliclik, donde el secreto lo tendría un tercero.
//      Sin esta cerradura estaríamos ofreciendo a cualquiera un relé para
//      saltarse SU propio bloqueo, usando nuestra reputación.

export const runtime = "edge";
export const dynamic = "force-dynamic";

/** Comparación en tiempo constante sin depender de node:crypto (no hay en Edge). */
function secretEquals(provided: string | null, expected: string): boolean {
  if (!provided || provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

interface EgressRequest {
  /** Ruta relativa, siempre bajo /integration/. */
  path?: string;
  method?: string;
  /** Cuerpo ya serializado por quien llama, o null en los GET. */
  body?: string | null;
}

export async function POST(req: NextRequest) {
  if (!secretEquals(req.headers.get("x-internal-secret"), env.cronSecret())) {
    return NextResponse.json({ egressError: "no autorizado" }, { status: 401 });
  }

  let payload: EgressRequest;
  try {
    payload = (await req.json()) as EgressRequest;
  } catch {
    return NextResponse.json({ egressError: "cuerpo inválido" }, { status: 400 });
  }

  const path = (payload.path ?? "").trim();
  // Cerradura 2: solo el módulo de integración. Nada de rutas arbitrarias, y
  // nada de "//host" ni "\\host" que puedan reinterpretarse como autoridad.
  if (!path.startsWith("/integration/") || path.includes("//") || path.includes("\\")) {
    return NextResponse.json({ egressError: "ruta no permitida" }, { status: 400 });
  }

  const method = (payload.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "POST") {
    return NextResponse.json({ egressError: "método no permitido" }, { status: 400 });
  }

  const auth = req.headers.get("x-aliclik-authorization");
  if (!auth) {
    return NextResponse.json({ egressError: "falta el token de Aliclik" }, { status: 400 });
  }

  // Cerradura 1: el host sale de la configuración, jamás de la petición.
  const target = env.aliclikApiBase().replace(/\/$/, "") + path;

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method,
      headers: {
        Authorization: auth,
        "Content-Type": "application/json",
        "x-aliclik-origin": "aliclik-web",
        Accept: "application/json",
        "User-Agent": "kapso-sales-dashboard/1.0 (+integracion-aliclik)",
      },
      body: method === "POST" ? (payload.body ?? "{}") : undefined,
      signal: AbortSignal.timeout(18_000),
    });
  } catch (e) {
    return NextResponse.json(
      { egressError: `Edge no pudo contactar con Aliclik: ${e instanceof Error ? e.message : "error de red"}` },
      { status: 502 },
    );
  }

  const text = await upstream.text().catch(() => "");

  // Se devuelve la respuesta de Aliclik TAL CUAL —mismo estado, mismo cuerpo—
  // para que el cliente la interprete igual que si hubiera salido directo. El
  // cf-ray se propaga porque es lo que identifica el bloqueo si vuelve a haberlo.
  const headers = new Headers({
    "content-type": upstream.headers.get("content-type") ?? "application/json",
    // Marca que el tramo hasta Aliclik sí ocurrió: distingue un 401 de Aliclik
    // de un 401 de esta misma ruta.
    "x-egress": "edge",
  });
  const ray = upstream.headers.get("cf-ray");
  if (ray) headers.set("cf-ray", ray);

  return new NextResponse(text, { status: upstream.status, headers });
}
