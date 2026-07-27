-- ============================================================================
-- 0054_tanders.sql — Tanders como courier propio de Lima.
--
-- Tanders convive con Aliclik / Shalom / Olva: no los reemplaza. La diferencia
-- con todos ellos es la dirección del flujo. Los otros couriers ENTRAN al
-- sistema por reporte (un Excel que se sube y se ingesta); Tanders SALE — el
-- equipo crea el pedido desde el Master y su API devuelve el código de guía.
-- Por eso no hay adaptador en lib/couriers/ (esos parsean reportes) sino un
-- cliente en lib/tanders/.
--
-- Credenciales POR TIENDA: Tanders no emite API keys, solo el usuario y la
-- contraseña de la cuenta. Se guardan cifradas con AES-256-GCM (lib/crypto.ts),
-- igual que el token de Shopify y la API key de Kapso — se descifran solo en el
-- servidor y nunca viajan al cliente.
--
-- Aplicar DESPUÉS de supabase/policies.sql.
-- ============================================================================

alter table stores
  add column if not exists tanders_email            text,
  add column if not exists tanders_password_enc     text,
  -- Origen del despacho: el almacén desde el que sale el paquete. Tanders lo
  -- exige en cada pedido como texto + coordenadas, y no lo deriva de la cuenta,
  -- así que hay que llevarlo nosotros. Es el mismo para todos los envíos de la
  -- tienda hasta que el equipo lo cambie.
  add column if not exists tanders_origin_address   text,
  add column if not exists tanders_origin_lat       double precision,
  add column if not exists tanders_origin_lng       double precision;

comment on column stores.tanders_password_enc is
  'enc: contraseña de la cuenta Tanders de esta tienda. Cifrada AES-256-GCM. Tanders no emite API keys.';
comment on column stores.tanders_origin_address is
  'Dirección del almacén de origen tal como la reconoce Google Maps (Tanders la guarda literal).';

-- ----------------------------------------------------------------------------
-- La guía Tanders es un envío más: vive en `shipments` con courier='tanders' y
-- guide_code = el id que devuelve su API (un cuid, p. ej. cms2mftih0018...).
-- Solo hacen falta dos datos que ningún otro courier tiene.
-- ----------------------------------------------------------------------------

alter table shipments
  -- URL de la etiqueta PDF que devuelve Tanders. Nullable a propósito: al crear
  -- el pedido nace "Pendiente" y la etiqueta puede no estar lista todavía.
  add column if not exists label_url          text,
  -- Última respuesta cruda de su API. Tanders no tiene documentación: cuando un
  -- envío se comporte raro, esto es la única evidencia de qué contestó de verdad.
  add column if not exists tanders_raw        jsonb;

comment on column shipments.label_url is
  'Etiqueta PDF del courier (Tanders). Puede tardar en existir: la guía nace Pendiente.';
comment on column shipments.tanders_raw is
  'Respuesta cruda de la API de Tanders al crear la guía. Auditoría — su API no está documentada.';
