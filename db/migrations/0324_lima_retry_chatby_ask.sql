-- ============================================================================
-- 0324_lima_retry_chatby_ask.sql — Reintentos Aliclik de Lima: «Pedir la
-- ubicación por WhatsApp» (MOM §9.5 y §40; owner, 08-11-2026).
--
-- POR QUÉ. Aliclik exige la coordenada. Un reintento de Lima sin pin, sin la
-- ubicación que la clienta ya mandó por WhatsApp y sin el edificio en Google
-- queda «Sin ubicación» hasta que una persona la consigue. El owner eligió
-- «pedirla si la ventana está abierta»: si la clienta escribió en las últimas
-- 23 h, Kapta le manda UN mensaje por Chatby pidiéndole su ubicación actual.
--
-- QUÉ AGREGA (aditiva: no reescribe ninguna fila).
--   * `lima_retry_auto_settings.chatby_ask_mode`: Apagado / Simulación /
--     Activo, por organización. Nace `apagado`. En `simulacion` la pasada dice
--     «habría pedido…» y no manda nada; en `activo` manda el mensaje.
--   * `lima_retry_chatby_asks`: la marca de cada pedida, una por pedido y
--     episodio (`episode_at` = el intento que falló). La pasada la escribe
--     ANTES de mandar: el único (pedido, episodio) es el candado de «una vez
--     por episodio», también con dos pasadas a la vez. Si Chatby no deja
--     mandar, la marca se borra y se vuelve a intentar. El mensaje queda
--     además en `order_events` (`chatby_message`, `payload.purpose =
--     'reintento_lima_ubicacion'`), que es solo de agregar.
--
-- Sin esta migración la pasada lo trata como Apagado y el panel muestra la
-- fila bloqueada. Correrla otra vez no cambia nada.
-- ============================================================================

alter table public.lima_retry_auto_settings
  add column if not exists chatby_ask_mode text not null default 'apagado';
alter table public.lima_retry_auto_settings drop constraint if exists lima_retry_auto_settings_chatby_ask_mode_check;
alter table public.lima_retry_auto_settings add constraint lima_retry_auto_settings_chatby_ask_mode_check
  check (chatby_ask_mode in ('apagado', 'simulacion', 'activo'));
comment on column public.lima_retry_auto_settings.chatby_ask_mode is
  'Pedir la ubicación por WhatsApp en los reintentos de Lima sin ubicación (0324): apagado | simulacion | activo.';

create table if not exists public.lima_retry_chatby_asks (
  id          bigserial primary key,
  org_id      uuid not null references public.organizations(id) on delete cascade,
  store_id    uuid not null references public.stores(id) on delete cascade,
  order_id    uuid not null references public.orders(id) on delete cascade,
  episode_at  timestamptz not null,
  status      text not null default 'enviando' check (status in ('enviando', 'enviado')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists lima_retry_chatby_asks_episode_uniq
  on public.lima_retry_chatby_asks (order_id, episode_at);

alter table public.lima_retry_chatby_asks enable row level security;
drop policy if exists lima_retry_chatby_asks_read on public.lima_retry_chatby_asks;
create policy lima_retry_chatby_asks_read on public.lima_retry_chatby_asks
  for select to authenticated using (store_id in (select auth_store_ids()));

grant select on public.lima_retry_chatby_asks to authenticated;
grant all on public.lima_retry_chatby_asks to service_role;
grant usage, select on sequence public.lima_retry_chatby_asks_id_seq to service_role;
