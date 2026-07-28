// Centralised, lazily-evaluated environment access. Functions (not eager
// constants) so importing this module never throws during build when a given
// secret is absent — it only throws at the call site that actually needs it.

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

export const env = {
  // --- public (safe for browser) ---
  supabaseUrl: () => required("NEXT_PUBLIC_SUPABASE_URL"),
  supabaseAnonKey: () => required("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
  siteUrl: () =>
    (process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000").replace(/\/$/, ""),

  // --- server-only secrets ---
  serviceRoleKey: () => required("SUPABASE_SERVICE_ROLE_KEY"),
  encryptionKey: () => required("ENCRYPTION_KEY"),
  cronSecret: () => required("CRON_SECRET"),

  // --- non-secret runtime config ---
  shopifyApiVersion: () => process.env.SHOPIFY_API_VERSION ?? "2025-01",
  kapsoApiBase: () =>
    (process.env.KAPSO_API_BASE ?? "https://api.kapso.ai/platform/v1").replace(/\/$/, ""),

  // --- Yape voucher vision check (optional; enables reading a silent voucher
  //     image instead of firing the alert on any screenshot). Without a key the
  //     detector stays text/caption-only (the safe default). Model is
  //     configurable so cost can be tuned (e.g. a cheaper model for this simple
  //     per-image classification) without a redeploy of code. ---
  anthropicApiKey: () => process.env.ANTHROPIC_API_KEY ?? "",
  anthropicApiBase: () =>
    (process.env.ANTHROPIC_API_BASE ?? "https://api.anthropic.com").replace(/\/$/, ""),
  // Modelo de visión (comprobantes Yape y hojas de liquidación fotografiadas).
  // Sonnet 5 lee una captura o un cuaderno con solvencia y cuesta bastante menos
  // que Opus, que es lo que importa cuando esto corre una vez por comprobante.
  // Se puede subir de gama con YAPE_VISION_MODEL sin tocar código.
  yapeVisionModel: () => process.env.YAPE_VISION_MODEL ?? "claude-sonnet-5",

  // --- Master de Pedidos: desde qué fecha traer los pedidos de Shopify que no
  //     son del bot. Sin esto la reconciliación pagina hasta el primer pedido de
  //     la tienda, que puede ser años atrás. Es una fecha (YYYY-MM-DD) y se
  //     puede mover sin redesplegar código. ---
  ordersSyncFrom: () => {
    const raw = (process.env.ORDERS_SYNC_FROM ?? "2026-06-01").trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : "2026-06-01";
  },
  yapeVisionEnabled: () => Boolean(process.env.ANTHROPIC_API_KEY),

  // --- Aliclik: API de integración (crear guías desde el Master) ---
  //     La documentación solo publica el host de DESARROLLO, así que la base es
  //     obligatoriamente configurable: pasar a producción no puede exigir un
  //     redespliegue de código.
  aliclikApiBase: () =>
    (process.env.ALICLIK_API_BASE ?? "https://api.aliclik-dev.com").replace(/\/$/, ""),
  //     Interruptor global de ESCRITURA hacia Aliclik. Apagado por defecto:
  //     crear una guía es irreversible y con ventanas de cancelación estrictas,
  //     así que hacen falta dos llaves deliberadas (esta y stores.aliclik_enabled)
  //     para que salga una sola petición.
  aliclikWriteEnabled: () => process.env.ALICLIK_WRITE_ENABLED === "true",
  //     Por dónde salen las peticiones a Aliclik.
  //
  //     `edge` ES EL VALOR POR DEFECTO, y no es una preferencia: la salida
  //     directa NO FUNCIONA. Cloudflare desafía las peticiones que salen de las
  //     funciones Node (IPs de centro de datos de AWS) y devuelve 403 sin que
  //     lleguen nunca a Aliclik — comprobado desde Virginia y desde São Paulo.
  //     Saliendo por el runtime Edge, que corre en otra red, la misma petición
  //     con el mismo token responde 200. Ver app/api/internal/aliclik-egress.
  //
  //     `ALICLIK_EGRESS=direct` vuelve a la salida directa, para el día en que
  //     Aliclik ajuste su WAF y se quiera quitar el salto intermedio.
  aliclikEgress: (): "direct" | "edge" =>
    process.env.ALICLIK_EGRESS === "direct" ? "direct" : "edge",

  // --- Shalom: wrapper de api.shalom-api-peru.com (crear preguías) ---
  //     La API key es de la cuenta de Kapso, NO del cliente: una sola sirve para
  //     todas las tiendas, y por eso vive en el entorno y no en `stores`. Lo que
  //     sí es por tienda son las credenciales de pro.shalom.pe, que identifican
  //     la cuenta que emite la guía (y que pueden repetirse entre tiendas).
  //
  //     Tiene fecha de vencimiento: cuando caduca, TODAS las tiendas dejan de
  //     poder crear guías a la vez. Renovarla es cambiar esta variable, sin tocar
  //     la configuración de ninguna tienda.
  //
  //     Se recorta el valor: pegar un secreto en el panel de Vercel arrastra un
  //     espacio o un salto de línea con muchísima facilidad, y Vercel no los
  //     limpia. Sin el trim ese blanco viaja dentro de la cabecera y Shalom
  //     responde «api key inválida» — un 401 idéntico al de una key caducada,
  //     que manda a pedirle una nueva al proveedor para arreglar un espacio.
  //     Pasó en producción, y despistó justamente porque la sonda del repo sí
  //     recortaba: la misma key funcionaba desde la terminal y fallaba aquí.
  shalomApiKey: () => (process.env.SHALOM_API_KEY ?? "").trim(),
  shalomApiBase: () =>
    (process.env.SHALOM_API_BASE ?? "https://api.shalom-api-peru.com").trim().replace(/\/$/, ""),
  shalomConfigured: () => Boolean((process.env.SHALOM_API_KEY ?? "").trim()),

  // --- Shopify OAuth app (optional; enables "Install on Shopify") ---
  shopifyAppApiKey: () => process.env.SHOPIFY_APP_API_KEY ?? "",
  shopifyAppApiSecret: () => process.env.SHOPIFY_APP_API_SECRET ?? "",
  shopifyOAuthConfigured: () =>
    Boolean(process.env.SHOPIFY_APP_API_KEY && process.env.SHOPIFY_APP_API_SECRET),
};
