-- ============================================================================
-- 0052_store_anthropic_key.sql — clave de Anthropic POR TIENDA.
--
-- Hasta ahora la lectura de comprobantes Yape usaba una única
-- `ANTHROPIC_API_KEY` de entorno, así que el gasto de las dos tiendas caía en la
-- misma cuenta y no había forma de separarlo. Con la clave en la tienda, cada
-- una consume (y paga) lo suyo.
--
-- Se guarda cifrada con AES-256-GCM (lib/crypto.ts), igual que el token de
-- Shopify, el secreto de sus webhooks, la API key de Kapso y el token de Meta:
-- se descifra solo en el servidor y nunca viaja al cliente.
--
-- La variable de entorno sigue funcionando como RESPALDO para las tiendas que
-- no tengan clave propia — así nada deja de funcionar al aplicar esto.
-- ============================================================================

alter table stores
  add column if not exists anthropic_api_key_enc text,
  -- Modelo por tienda: permite abaratar una tienda sin tocar la otra ni
  -- redesplegar (p. ej. un modelo más económico para la clasificación simple).
  add column if not exists anthropic_model        text;

comment on column stores.anthropic_api_key_enc is
  'enc: API key de Anthropic de ESTA tienda (lectura de comprobantes Yape). Cifrada AES-256-GCM. Respaldo: ANTHROPIC_API_KEY del entorno.';
comment on column stores.anthropic_model is
  'Modelo de visión para esta tienda. Vacío = el valor por defecto del entorno.';
