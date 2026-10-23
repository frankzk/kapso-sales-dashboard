// Tiendas con su app propia de Shopify (MOM §36, decisión del owner del
// 23-10-2026). La promesa que importa es la de §36.6: Kenku Peru, Aurela y las
// tiendas `clientes` no cambian. Vive repartida entre la 0271 (lo que la base
// acepta), lib/shopify-own-app.ts (alcances y plazos), el cron y DEPLOY.md, y
// ninguno falla solo si se separa del MOM. Estas pruebas atan cada nombre y
// cada cifra del MOM a lo que de verdad corre. Las reglas, a fondo, en
// test/shopify-own-app*.test.ts y scripts/sql/shopify_app_propia_smoke.sql.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CLIENT_APP_WEBHOOK_TOPICS, SHOPIFY_CLIENT_APP_SCOPES } from "@/lib/shopify";
import * as ownApp from "@/lib/shopify-own-app";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const flat = (text: string) => text.replace(/\s+/g, " ");
const MOM = read("docs/mom/master-pedidos-v1.md");
const MIGRATION_PATH = "db/migrations/0271_shopify_app_propia.sql";
const MIGRATION = read(MIGRATION_PATH);
/** La migración sin comentarios: lo que de verdad corre. */
const MIGRATION_SQL = MIGRATION.replace(/--.*$/gm, "");
const DEPLOY = read("DEPLOY.md");

/** El texto de una sección del MOM, desde su título hasta el siguiente del mismo nivel o superior. */
function section(title: string): string {
  const start = MOM.indexOf(title);
  expect(start, title).toBeGreaterThan(-1);
  const level = title.match(/^#+/)![0].length;
  const rest = MOM.slice(start + title.length);
  const next = rest.search(new RegExp(`\\n#{1,${level}} `));
  return flat(next === -1 ? rest : rest.slice(0, next));
}

const NEW_COLUMNS = [
  "shopify_client_id",
  "shopify_client_secret_enc",
  "shopify_token_expires_at",
  "shopify_token_renewed_at",
  "shopify_token_error",
  "shopify_token_retry_at",
  "shopify_webhook_secret_prev_enc",
  "shopify_webhook_secret_prev_set_at",
] as const;

const HOUR_MS = 60 * 60 * 1000;

describe("§36 Tiendas conectadas con su app propia de Shopify (owner 23-10-2026)", () => {
  const s36 = section("## 36. Tiendas conectadas con su app propia de Shopify (23-10-2026)");

  it("registra la decisión del owner, la fecha y que Kenku y Aurela no se desconectan", () => {
    expect(s36).toContain("Estado: decisión del owner del 23-10-2026.");
    expect(s36).toContain("Primera tienda: «Súper Human Perú».");
    expect(s36).toContain(
      "«sí, empieza con el cambio para la app propia. Ojo: Aun no estoy dejando los otros shopify: Kenku Peru y Aurela. no vayas a desconectar nada, estoy conectando»",
    );
  });

  it("tres apps y ninguna otra: las mismas que admite la 0271", () => {
    expect(s36).toContain("`interna`: la app de Kapta para Kenku Peru y Aurela");
    expect(s36).toContain("`clientes`: la app pública «Kapta» para tiendas cliente");
    expect(s36).toContain("`propia`: la app que la organización de Shopify de la tienda creó en su Dev Dashboard");
    expect(s36).toContain("No hay otro valor, y una tienda no cambia de app sola.");
    expect(flat(MIGRATION_SQL)).toContain("check (shopify_app in ('interna', 'clientes', 'propia'))");
    expect(MIGRATION_SQL.match(/check \(shopify_app in \(/g)).toHaveLength(1);
  });

  it("§29.15.9 ya no dice que solo hay dos apps", () => {
    const s2915 = section("#### 29.15.9 Datos personales del comprador (aprobado el 08-10-2026)");
    expect(s2915).toContain(
      "`interna` (la app actual de Aurela y Kenku), `clientes` (la app pública) o, desde el 23-10-2026, `propia`",
    );
    expect(s2915).toContain("(la app que la organización de Shopify de la tienda creó en su Dev Dashboard, §36)");
    expect(s2915).toContain("la app de clientes no toma una tienda que ya está con la interna ni con una app propia");
  });

  it("el token: client credentials, ~24 h, renovado cada hora con 12 h de margen y al usarlo con 15 min", () => {
    expect(s36).toContain("(*client credentials grant*)");
    expect(s36).toContain("Cada token dura unas **24 horas**.");
    expect(s36).toContain("Pedir uno nuevo no invalida el anterior: el anterior sirve hasta que vence.");
    expect(s36).toContain("menos de **12 horas** (`OWN_APP_RENEW_BEFORE_MS`)");
    expect(ownApp.OWN_APP_RENEW_BEFORE_MS).toBe(12 * HOUR_MS);
    expect(s36).toContain("menos de **15 minutos** (`OWN_APP_RENEW_ON_USE_MS`)");
    expect(ownApp.OWN_APP_RENEW_ON_USE_MS).toBe(15 * 60 * 1000);
    expect(s36).toContain("Si esa renovación falla y el token todavía vale, usa el que tiene.");
    expect(s36).toContain("Una renovación nunca reemplaza un token por otro que vence antes.");
    expect(s36).toContain("La tienda **no** se deshabilita por eso");
  });

  it("el cron de cada hora existe, en vercel.json, sin caer en el minuto 0", () => {
    expect(s36).toContain(
      "Un cron (`/api/cron/shopify-own-app-tokens`) renueva el token de cada tienda `active` o `paused` con app `propia`",
    );
    expect(read("app/api/cron/shopify-own-app-tokens/route.ts")).toContain('.in("status", [...OWN_APP_RENEWABLE_STATUSES])');
    expect(existsSync(resolve(process.cwd(), "app/api/cron/shopify-own-app-tokens/route.ts"))).toBe(true);
    const crons = (JSON.parse(read("vercel.json")).crons ?? []) as { path: string; schedule: string }[];
    const cron = crons.filter((c) => c.path === "/api/cron/shopify-own-app-tokens");
    expect(cron).toHaveLength(1);
    const [minute, ...rest] = cron[0]!.schedule.split(" ");
    expect(rest).toEqual(["*", "*", "*", "*"]);
    expect(Number(minute)).toBeGreaterThan(0);
    expect(Number(minute)).toBeLessThan(60);
  });

  it("en pausa renueva, deshabilitada no: lo mismo en el MOM y en el código", () => {
    expect(s36).toContain("una tienda `paused` renueva igual que una `active`. Solo una `disabled` (por ejemplo, desinstalada) no renueva.");
    expect([...ownApp.OWN_APP_RENEWABLE_STATUSES]).toEqual(["active", "paused"]);
    expect(ownApp.isOwnAppRenewableStatus("paused")).toBe(true);
    expect(ownApp.isOwnAppRenewableStatus("disabled")).toBe(false);
  });

  it("el freno de la renovación al usar: 5 minutos, 15 tras un fallo de red; el cron no lo mira", () => {
    expect(s36).toContain("no pide otro token en los **5 minutos** siguientes a un intento (`OWN_APP_ON_USE_RETRY_MS`)");
    expect(ownApp.OWN_APP_ON_USE_RETRY_MS).toBe(5 * 60 * 1000);
    expect(s36).toContain("ni en los **15 minutos** siguientes a un fallo de red o a un 429/5xx de Shopify (`OWN_APP_ON_USE_RETRY_AFTER_RED_MS`)");
    expect(ownApp.OWN_APP_ON_USE_RETRY_AFTER_RED_MS).toBe(15 * 60 * 1000);
    expect(s36).toContain("(`shopify_token_retry_at`): si dos usos llegan juntos, solo uno sale a Shopify.");
    expect(s36).toContain("El cron y «Renovar ahora» no miran el freno.");
  });

  it("primero se autentica: los webhooks leen sin renovar y renuevan después, solo donde usan el token", () => {
    expect(s36).toContain("lee la tienda **sin** renovar: primero comprueba su firma o su secreto.");
    expect(s36).toContain("Una petición falsa no hace salir el Client secret.");
    const ingest = read("lib/ingest.ts");
    expect(ingest.match(/getStoreCreds\(params\.storeId, admin, \{ renewOwnApp: false \}\)/g)).toHaveLength(2);
    expect(ingest).toContain("const creds = await getStoreCreds(storeId, admin, { renewOwnApp: false });");
    for (const route of ["app/api/webhooks/aliclik/[storeId]/route.ts", "app/api/webhooks/flowcl/[storeId]/route.ts"]) {
      const src = read(route);
      expect(src.match(/getStoreCreds\(/g)?.length, route).toBe(src.match(/getStoreCreds\(storeId, undefined, \{ renewOwnApp: false \}\)/g)?.length);
    }
  });

  it("un fallo viejo no pisa un éxito nuevo", () => {
    expect(s36).toContain("El motivo solo se guarda si nadie renovó después de que empezó ese intento");
  });

  it("rotar el secreto: el anterior firma webhooks 48 h o hasta confirmar; otra app registra sus webhooks", () => {
    expect(s36).toContain("Shopify sigue firmando los webhooks con el secreto **más viejo que no se revocó**");
    expect(s36).toContain("durante **48 horas** (`OWN_APP_PREV_WEBHOOK_SECRET_GRACE_MS`)");
    expect(ownApp.OWN_APP_PREV_WEBHOOK_SECRET_GRACE_MS).toBe(48 * HOUR_MS);
    expect(s36).toContain(
      "Los pasos, en orden: rotar en el Dev Dashboard, pegar el nuevo en Ajustes, revocar el anterior en el Dev Dashboard y confirmar en Ajustes.",
    );
    expect(s36).toContain("«Ya revoqué el secreto anterior»");
    expect(s36).toContain("Kapta registra los webhooks de la app nueva (pedidos, borradores y `app/uninstalled`)");
    expect(s36).toContain("La firma de los webhooks de Kenku, Aurela y las tiendas `clientes` se comprueba exactamente como antes");
  });

  it("Ajustes: el título del aviso sale del contenido, y sin acceso que valga no dice «vence»", () => {
    expect(s36).toContain("«Faltan permisos en la app»");
    expect(ownApp.ownAppErrorTitle(ownApp.missingScopesMessage(["write_orders"]))).toBe("Faltan permisos en la app");
    expect(s36).toContain("«App propia · app desinstalada el DD/MM a las HH:MM»");
    expect(s36).toContain("Una zona que no se entiende («Lima», «GMT-5») no rompe Ajustes");
    expect(s36).toContain("el servidor los rechaza sin guardar nada, y el OAuth de la app interna (instalar y su vuelta) no toca una tienda propia.");
  });

  it("los alcances del MOM son los de la app de clientes, y un write_X cuenta como read_X", () => {
    const scopes = SHOPIFY_CLIENT_APP_SCOPES.split(",");
    expect(scopes).toHaveLength(6);
    const listed = s36.match(/`read_orders`, `read_draft_orders`, `write_draft_orders`, `read_products`, `read_customers` y `write_orders`/);
    expect(listed).not.toBeNull();
    for (const scope of scopes) expect(s36).toContain(`\`${scope}\``);
    expect([...ownApp.OWN_APP_REQUIRED_SCOPES].sort()).toEqual([...scopes].sort());
    expect(s36).toContain("Un `write_X` cuenta también como `read_X`.");
    // write_orders y write_draft_orders cubren read_orders y read_draft_orders.
    expect(ownApp.missingScopes(["write_orders", "write_draft_orders", "read_products", "read_customers"])).toEqual([]);
    expect(ownApp.missingScopes(["read_orders", "read_draft_orders", "write_draft_orders", "read_products", "read_customers"])).toEqual([
      "write_orders",
    ]);
  });

  it("conectar: mismo permiso que crear una tienda, nunca toca una tienda que ya está, y webhooks con APP_UNINSTALLED", () => {
    expect(s36).toContain("«Conectar con app propia de Shopify», al lado de crear una tienda.");
    expect(s36).toContain("«Administrar tiendas» (`stores.manage`: owner, admin o Administración)");
    expect(s36).toContain(
      "«Para tiendas cuya organización de Shopify creó su propia app en el Dev Dashboard. Kapta renueva el acceso cada día.»",
    );
    expect(s36).toContain("Si ya hay una tienda con ese dominio en Kapta, con cualquier app, no conecta y **no la toca**.");
    // Se mira después del token: nadie averigua qué tiendas son de Kapta.
    expect(s36).toContain("Se mira recién después del token");
    expect(s36.indexOf("2. Pide un token.")).toBeGreaterThan(-1);
    expect(s36.indexOf("4. Si ya hay una tienda con ese dominio en Kapta")).toBeGreaterThan(s36.indexOf("2. Pide un token."));
    expect(s36).toContain("«Conectar tienda» muestra arriba «Conectar con app propia de Shopify»");
    expect(s36).toContain("las credenciales no son válidas, la app no está instalada en esa tienda, o la tienda no es de la organización que creó la app");
    expect(s36).toContain("El secreto de sus webhooks es el Client secret, porque Shopify firma con él los webhooks de la app.");
    expect(s36).toContain("Registra los webhooks de pedidos y `app/uninstalled`.");
    expect(CLIENT_APP_WEBHOOK_TOPICS).toContain("APP_UNINSTALLED");
  });

  it("desinstalar deshabilita y el cron no la resucita", () => {
    expect(s36).toContain("borra el token, la tienda pasa a `disabled` y se anota la fecha de desinstalación");
    expect(s36).toContain("Una tienda desinstalada no vuelve a tener token sola");
  });

  it("lo que no cambia: Kenku, Aurela y clientes, sostenido por la 0271 sin tocar filas", () => {
    expect(s36).toContain("**Kenku Peru y Aurela (`interna`) y las tiendas `clientes` quedan exactamente igual:**");
    expect(s36).toContain("Nada de esta sección las desconecta, les registra webhooks, les cambia el token ni les escribe una columna.");
    expect(s36).toContain("La 0271 no actualiza ninguna fila.");
    expect(s36).toContain("(`stores_own_app_columns_check`)");
    expect(s36).toContain("(`stores_own_app_shop_uniq`)");
    expect(s36).toContain("**Sin migración de datos.** Ninguna tienda existente pasa a app propia.");

    // Ninguna escritura de filas en la migración: ni UPDATE, ni INSERT, ni DELETE.
    expect(MIGRATION_SQL).not.toMatch(/\b(update|insert\s+into|delete\s+from)\b/i);
    // La protección de los secretos es la de siempre en `stores`: cifrado y RLS.
    // (Una sentencia, no la palabra: el comentario del secreto dice «client credentials grant».)
    expect(MIGRATION_SQL).not.toMatch(/^\s*(grant|revoke)\s/im);
    expect(MIGRATION_SQL).not.toMatch(/\bcreate\s+(or\s+replace\s+)?view\b/i);

    for (const column of NEW_COLUMNS) {
      expect(s36).toContain(`\`${column}\``);
      expect(MIGRATION_SQL).toContain(`add column if not exists ${column}`);
      expect(MIGRATION_SQL).toContain(`${column} is null`);
      expect(MIGRATION_SQL).toContain(`comment on column stores.${column} is`);
    }
    expect(flat(MIGRATION_SQL)).toContain("add constraint stores_own_app_columns_check check ( shopify_app = 'propia' or (");
    expect(flat(MIGRATION_SQL)).toContain(
      "create unique index if not exists stores_own_app_shop_uniq on stores (lower(shopify_domain)) where shopify_app = 'propia';",
    );
  });

  it("la cabecera de la 0271 dice qué pasaba, qué cambia y a quién no", () => {
    expect(MIGRATION).toContain("-- QUÉ PASABA.");
    expect(MIGRATION).toContain("-- QUÉ CAMBIA.");
    expect(MIGRATION).toContain("-- A QUIÉN NO. Kenku Peru y Aurela ('interna') y las tiendas 'clientes' quedan");
    expect(MIGRATION).toContain("MOM §36");
  });

  it("cada archivo y cada función que nombra §36.7 existe", () => {
    const s367 = section("### 36.7 Implementación");
    for (const path of [
      MIGRATION_PATH,
      "lib/shopify-own-app.ts",
      "lib/ingest.ts",
      "lib/invoicing/shopify-order.ts",
      "app/api/cron/shopify-own-app-tokens/route.ts",
      "app/dashboard/stores/new/actions.ts",
      "components/forms.tsx",
      "app/dashboard/[storeId]/settings/actions.ts",
      "components/store-settings.tsx",
      "test/shopify-own-app.test.ts",
      "test/shopify-own-app-cron.test.ts",
      "test/shopify-own-app-connect.test.ts",
      "test/shopify-own-app-webhooks.test.ts",
      "test/shopify-app-propia-mom.test.ts",
      "scripts/sql/shopify_app_propia_smoke.sql",
    ]) {
      expect(s367).toContain(`\`${path}\``);
      expect(existsSync(resolve(process.cwd(), path)), path).toBe(true);
    }
    for (const name of [
      "requestClientCredentialsToken",
      "missingScopes",
      "shouldRenew",
      "renewOwnAppToken",
      "ownAppTokenForUse",
      "ownAppStatusLine",
      "ownAppAccessHint",
      "ownAppErrorTitle",
    ] as const) {
      expect(s367).toContain(`\`${name}\``);
      expect(typeof ownApp[name], name).toBe("function");
    }
    // Las acciones y el formulario que nombra, en el archivo que dice.
    for (const [name, path] of [
      ["connectOwnAppStore", "app/dashboard/stores/new/actions.ts"],
      ["ConnectOwnAppStoreForm", "components/forms.tsx"],
      ["saveOwnAppCredentials", "app/dashboard/[storeId]/settings/actions.ts"],
      ["renewOwnAppTokenNow", "app/dashboard/[storeId]/settings/actions.ts"],
      ["clearOwnAppPreviousSecret", "app/dashboard/[storeId]/settings/actions.ts"],
      ["ownAppCredsForUse", "lib/ingest.ts"],
      ["verifyStoreShopifyHmac", "lib/ingest.ts"],
    ] as const) {
      expect(s367).toContain(`\`${name}\``);
      expect(read(path), name).toMatch(new RegExp(`export (async )?function ${name}\\b`));
    }
    for (const path of ["app/api/shopify/install/route.ts", "app/api/shopify/callback/route.ts"]) {
      expect(s367).toContain(`\`${path}\``);
      expect(read(path), path).toContain('shopify_app === "propia"');
    }
    expect(s367).toContain("`getStoreCreds` (`lib/ingest.ts`)");
    expect(read("lib/ingest.ts")).toContain("getStoreCreds");
    // La prueba en la base corre en verify-db.sh.
    expect(read("scripts/verify-db.sh")).toContain('$PSQL -f "$ROOT/scripts/sql/shopify_app_propia_smoke.sql"');
  });
});

describe("DEPLOY.md, entrada del 23-10-2026 (0271)", () => {
  const start = DEPLOY.indexOf("### 23-10-2026 · Tiendas con su app propia de Shopify (0271, MOM §36)");
  const entry = flat(start === -1 ? "" : (DEPLOY.slice(start).split(/\n### /)[0] ?? ""));

  it("existe, a mano y antes del código, y dice que Kenku y Aurela no cambian", () => {
    expect(start).toBeGreaterThan(-1);
    expect(entry).toContain("**Kenku y Aurela no cambian.**");
    expect(entry).toContain("**Migración `0271_shopify_app_propia.sql`, a mano y ANTES del código.**");
    expect(entry).toContain("\\i db/migrations/0271_shopify_app_propia.sql");
    expect(entry).toContain("set local lock_timeout = '15s';");
  });

  it("dice cómo rotar el secreto y qué formulario usar", () => {
    expect(entry).toContain("**no** el de «Crear tienda con token de Admin API»");
    expect(entry).toContain("**Rotar el Client secret de una tienda propia**");
    expect(entry).toContain("pulsar «Ya revoqué el secreto anterior»");
  });

  it("trae la huella de antes y después, el cron y la marcha atrás", () => {
    expect(entry).toContain("as huella");
    expect(entry).toContain("la huella (c) tiene que dar lo mismo que antes");
    expect(entry).toContain("`/api/cron/shopify-own-app-tokens`");
    expect(entry).toContain("protegido con `CRON_SECRET`");
    expect(entry).toContain("**Marcha atrás.** Revertir el código basta");
    for (const column of NEW_COLUMNS) expect(entry).toContain(column);
  });
});
