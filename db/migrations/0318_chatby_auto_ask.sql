-- ============================================================================
-- 0318_chatby_auto_ask.sql — Confirmación por Chatby: «Pedir sola la dirección
-- o la ubicación» (MOM §6.1 y §40; owner, 08-11-2026).
--
-- POR QUÉ. La clienta confirmó por Chatby y la guía no sale porque Google no
-- encuentra la dirección (`sin_ubicacion`) o porque la dirección está
-- incompleta (`direccion_incompleta`). Hasta hoy una asesora se la pedía desde
-- la ficha. El owner quiere que Kapta la pida sola y, con la respuesta, vuelva
-- a intentar la guía (la dirección nueva otra vez en Google; si tampoco, la
-- ubicación).
--
-- QUÉ AGREGA (aditiva: no reescribe ninguna fila).
--   * `chatby_auto_settings.ask_mode`: Apagado / Simulación / Activo, por
--     organización. Nace `apagado`: lo de hoy (la pide una persona desde la
--     ficha). En `simulacion` la pasada dice «habría pedido…» y no manda
--     nada; en `activo` manda el mensaje por el mismo envío que la ficha.
--
-- Lo demás no necesita columnas: la marca de la pedida va en
-- `chatby_auto_checks.evidence` (`asked_at`, `held_at`, `auto_asks`,
-- `corrected_at`), el mensaje en `order_events` (`chatby_message` con
-- `payload.auto = true`) y la dirección corregida en `order_geo_overrides`.
-- Sin esta migración la pasada lo trata como Apagado. Correrla otra vez no
-- cambia nada.
-- ============================================================================

alter table public.chatby_auto_settings
  add column if not exists ask_mode text not null default 'apagado';
alter table public.chatby_auto_settings drop constraint if exists chatby_auto_settings_ask_mode_check;
alter table public.chatby_auto_settings add constraint chatby_auto_settings_ask_mode_check
  check (ask_mode in ('apagado', 'simulacion', 'activo'));
comment on column public.chatby_auto_settings.ask_mode is
  'Pedir sola la dirección o la ubicación por WhatsApp cuando la guía de Chatby no sale (0318): apagado | simulacion | activo.';
