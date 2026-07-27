-- ============================================================================
-- 0059_shalom_api.sql — crear guías de Shalom por API desde el Master.
--
-- Shalom ya estaba en el sistema, pero solo de ENTRADA: sus reportes Excel se
-- suben y los parsea el adaptador de agencia (lib/couriers/agency.ts). Esta
-- migración habilita la dirección contraria — crear la preguía por API, como ya
-- se hace con Tanders (0058) — usando el wrapper api.shalom-api-peru.com.
--
-- Las guías creadas así son envíos normales: viven en `shipments` con
-- courier='shalom' y se cruzan con el reporte del día siguiente por `guide_code`
-- como cualquier otra. No hay tabla nueva de envíos.
--
-- DOS credenciales por tienda, no una:
--   * la API key del wrapper (sk_…), que es de la cuenta de Kapso;
--   * el email + password de pro.shalom.pe DEL CLIENTE, que es lo que el
--     wrapper usa para entrar a su panel.
-- Ambas cifradas con AES-256-GCM (lib/crypto.ts), como el resto de secretos.
--
-- Aplicar DESPUÉS de supabase/policies.sql.
-- ============================================================================

alter table stores
  add column if not exists shalom_api_key_enc         text,
  add column if not exists shalom_pro_email           text,
  add column if not exists shalom_pro_password_enc    text,
  -- Agencia desde la que despacha esta tienda. Shalom la pide como
  -- `origin_terminal_id` en cada orden y no la deriva de la cuenta. El nombre se
  -- guarda al lado solo para poder mostrarlo sin llamar a la API.
  add column if not exists shalom_origin_terminal_id  integer,
  add column if not exists shalom_origin_terminal_name text,
  -- Tipo de paquete por defecto (id de GET /v1/products: 3 = Sobre). El
  -- catálogo es por cuenta, así que el id no se puede fijar en el código.
  add column if not exists shalom_default_product_id  integer,
  -- ── Caché de la sesión ────────────────────────────────────────────────────
  -- El wrapper hace un login REAL contra pro.shalom.pe la primera vez: ~90 s,
  -- hasta 2 min. El token `ssk_…` dura 2 horas, así que guardarlo evita pagar
  -- ese login en cada guía. En serverless la memoria del proceso no sobrevive
  -- entre invocaciones — por eso va en la base y no en un módulo.
  add column if not exists shalom_session_token_enc   text,
  add column if not exists shalom_session_expires_at  timestamptz;

comment on column stores.shalom_api_key_enc is
  'enc: API key (sk_…) de api.shalom-api-peru.com. Cifrada AES-256-GCM.';
comment on column stores.shalom_pro_password_enc is
  'enc: password de la cuenta pro.shalom.pe del cliente. El wrapper la canjea por un token de sesión.';
comment on column stores.shalom_origin_terminal_id is
  'id de agencia (GET /v1/agencies) desde la que despacha esta tienda: origin_terminal_id de la orden.';
comment on column stores.shalom_session_token_enc is
  'enc: token ssk_ de Shalom, TTL 2 h. Caché para no pagar el login de ~90 s en cada guía.';
comment on column stores.shalom_session_expires_at is
  'Vencimiento del token ssk_. Pasada esa hora se pide uno nuevo.';

-- ----------------------------------------------------------------------------
-- Identificadores del envío en Shalom
--
-- Shalom devuelve cuatro y NO son intercambiables (ver "Identificadores" en su
-- documentación). `guide_code` ya guarda la `guia`, que es la que va impresa y
-- la que trae el reporte Excel — así el cruce con la ingesta sigue funcionando.
-- Los otros tres necesitan columna propia porque cada uno abre una puerta
-- distinta y adivinarlos después es imposible.
-- ----------------------------------------------------------------------------

alter table shipments
  -- Alfanumérico de 4 caracteres que asigna Shalom. Va junto a la guia para
  -- rastrear en modo detallado.
  add column if not exists shalom_codigo        text,
  -- ID interno del envío en Shalom (OSE/SUNAT). Es el handle de /label,
  -- /voucher, /events y /grt: sin él no se puede descargar el rótulo.
  add column if not exists shalom_ose_id        bigint,
  -- ID de la orden DENTRO de la cuenta empresarial. Es el único que sirve para
  -- DELETE /v1/orders/{id}; se conoce recién al listar las órdenes.
  add column if not exists shalom_order_id      bigint,
  -- Prefijo del talonario ("v872"). Informativo, pero es lo que el cliente lee
  -- en el comprobante físico cuando reclama.
  add column if not exists shalom_serie         text,
  -- Respuesta cruda de la API al crear la guía. Auditoría: si un envío se
  -- comporta raro, esto es la evidencia de qué contestó de verdad.
  add column if not exists shalom_raw           jsonb;

comment on column shipments.shalom_ose_id is
  'ID OSE del envío en Shalom. Handle de /label, /voucher, /events y /grt.';
comment on column shipments.shalom_order_id is
  'ID de la orden en la cuenta Shalom Pro. El ÚNICO que acepta DELETE /v1/orders/{id}.';
comment on column shipments.shalom_raw is
  'Respuesta cruda de POST /v1/orders. Auditoría de la creación de la guía.';

-- La guía se busca por `codigo` cuando el cliente solo tiene el comprobante
-- físico a mano y no sabe leer cuál de los números es la guía.
create index if not exists shipments_shalom_codigo_idx
  on shipments(store_id, shalom_codigo) where shalom_codigo is not null;

-- ----------------------------------------------------------------------------
-- Sin tabla nueva para la clave de recojo: `shalom_pickup_keys` (0049) ya es
-- exactamente eso, y sigue siendo ilegible por RLS (0053). La diferencia es de
-- dónde sale la clave — antes la escribía un administrador a mano copiándola de
-- pro.shalom.pe, ahora la elegimos nosotros al crear la orden y la guardamos
-- cifrada en el mismo sitio. El flujo de Yape → validación → revelar la clave no
-- cambia ni una línea.
-- ----------------------------------------------------------------------------
