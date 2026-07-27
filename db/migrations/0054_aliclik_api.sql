-- ============================================================================
-- 0054_aliclik_api.sql — credenciales y campos de la API de integración de
-- Aliclik.
--
-- Hasta aquí la relación con Aliclik era de UNA sola dirección y por archivo:
-- alguien descargaba un Excel del panel y lo subía (lib/aliclik-import.ts →
-- lib/aliclik-ingest.ts). Esta migración abre la dirección contraria: crear el
-- pedido en Aliclik desde el Master y recibir sus estados.
--
-- Las credenciales siguen el patrón de todo el repo — columna cifrada en
-- `stores` (lib/crypto.ts, AES-256-GCM), NO una tabla de integraciones. Ver
-- 0052 (clave de Anthropic) para el precedente más reciente.
--
-- LA DECISIÓN QUE IMPORTA está en `shipments.external_order_number`.
-- Aliclik tiene DOS identificadores para el mismo envío físico:
--   * `orderNumber` — "ALC000123456789", lo devuelve la API al crear.
--   * el código de guía — "AUR5X…", el que aparece en el Excel y va impreso
--     en el paquete; es el que el equipo busca y el que ya vive en `guide_code`
--     (único por courier, ver 0022).
-- Guardarlos en la misma columna crearía DOS filas para un solo envío en cuanto
-- se importe el Excel, y el Master contaría dos guías (courier_count,
-- attempt_count) para el mismo pedido. Así que son dos columnas: al crear por
-- API el `guide_code` lleva el ALC… de forma PROVISIONAL, y cuando el reporte
-- traiga el AUR5X… lib/aliclik-reconcile.ts lo promueve sobre la MISMA fila,
-- que conserva sus llamadas, su vínculo al pedido y su historial.
--
-- El ALC… provisional es seguro frente al detector por valor del importador
-- (`GUIDE_RE = /AUR5X[A-Za-z0-9]+/i`, lib/aliclik-import.ts:66): nunca puede
-- confundir uno con otro.
--
-- Aplicar DESPUÉS de supabase/policies.sql. Idempotente; no toca datos.
-- ============================================================================

-- ── Credenciales por tienda ──────────────────────────────────────────────────
alter table stores
  -- Bearer token de integración entregado por Aliclik. Cifrado.
  add column if not exists aliclik_api_token_enc      text,
  -- Secreto propio que viaja en la URL del webhook. La API de Aliclik NO firma
  -- sus notificaciones (ver 0057), así que este secreto es la única barrera.
  add column if not exists aliclik_webhook_secret_enc text,
  -- Interruptor por tienda. Junto con ALICLIK_WRITE_ENABLED del entorno, hacen
  -- falta DOS llaves deliberadas para que salga una sola petición de escritura.
  add column if not exists aliclik_enabled            boolean not null default false;

comment on column stores.aliclik_enabled is
  'Habilita la creación de guías en Aliclik para esta tienda. Junto con ALICLIK_WRITE_ENABLED.';

-- ── Identidad y costos de la guía ────────────────────────────────────────────
alter table shipments
  -- El orderNumber de Aliclik (ALC000…). Es la clave con la que se consulta
  -- GET /integration/order y con la que llegan los webhooks.
  add column if not exists external_order_number  text,
  -- Lo que Aliclik cotizó para ESTA guía. Es mejor dato que cualquier tarifa
  -- resuelta por cuadro, porque es el precio real de este envío concreto.
  add column if not exists quoted_delivery_cost   numeric(12, 2),
  add column if not exists quoted_return_cost     numeric(12, 2),
  add column if not exists aliclik_transport_id   integer,
  add column if not exists aliclik_transport_name text;

comment on column shipments.external_order_number is
  'orderNumber de Aliclik (ALC000…). Distinto de guide_code (AUR5X…): ver la cabecera de 0054.';

-- Único por courier, igual que guide_code (0022) y por la misma razón: el pool
-- de guías es multitienda. Parcial, porque solo las guías creadas por API lo
-- tienen — las importadas del Excel lo dejan nulo y no deben colisionar entre sí.
create unique index if not exists shipments_external_order_uniq
  on shipments(courier, external_order_number)
  where external_order_number is not null;

-- El webhook y el cron de reconciliación buscan SIEMPRE por este número, sin
-- conocer la tienda: el payload de Aliclik solo trae el orderNumber.
create index if not exists shipments_external_order_idx
  on shipments(external_order_number)
  where external_order_number is not null;
