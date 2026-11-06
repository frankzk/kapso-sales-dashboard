-- ============================================================================
-- 0311_anura_kapta_phone.sql — «Llamar con Anura», fase 2: el teléfono DENTRO
-- de Kapta (solo salidas).
--
-- QUÉ ES. En la fase 1 Click2Dial hace sonar el teléfono de Anura de la
-- asesora (la terminal principal de su anexo). En la fase 2 esa terminal
-- principal es la «<anexo>-websocket» y quien la usa es el propio navegador de
-- la asesora en Kapta: al pedir la llamada, Kapta se registra en Anura,
-- contesta sola el aviso de su propio Click2Dial y se desregistra al terminar.
-- Kapta NO recibe llamadas: un aviso que no es de una llamada que la persona
-- acaba de pedir se rechaza sin sonar. El flujo de estados, el webhook y las
-- grabaciones de la fase 1 no cambian.
--
-- QUÉ CREA.
--   * `anura_sip_settings`: por organización, lo que no es secreto de la
--     central: el dominio SIP (el que Anura muestra en «Obtener
--     credenciales»), la URL WebSocket (solo hosts de anura.pe; por defecto
--     wss://sipwss.anura.pe) y el puerto SIP (55090). La leen los miembros
--     de la org.
--   * `anura_sip_credentials`: por anexo, el usuario SIP (por defecto
--     `<anexo>-websocket`) y la contraseña SIP CIFRADA (AES-256-GCM,
--     lib/crypto.ts, formato «v1:…»). SOLO el servidor (service_role): no
--     puede ir en `anura_extensions`, que lee la org entera. Si Anura rechaza
--     la clave al llamar, queda «clave rechazada» (fecha y motivo) y Kapta no
--     vuelve a intentarlo con ella hasta que se guarde otra: varios intentos
--     fallidos hacen que Anura bloquee la IP.
--
-- LA CLAVE ES DEL ANEXO, NO DE LA PERSONA. Va colgada de la fila del anexo:
-- quitar el anexo borra la clave, y cambiarle el número a la fila también
-- (el disparador de abajo), porque la clave de la «101-websocket» no sirve
-- para la 102. Apagar el anexo no la borra.
--
-- Lectura por RLS: los ajustes SIP, los miembros de la org; las credenciales,
-- nadie desde el navegador. Escribe solo el servidor. No cambia datos.
-- Correrla otra vez no cambia nada.
-- ============================================================================

create table if not exists public.anura_sip_settings (
  org_id      uuid primary key references public.organizations(id) on delete cascade,
  -- El dominio de la central (sin «sip:», sin puerto, en minúsculas).
  sip_domain  text check (sip_domain is null or sip_domain ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'),
  -- Solo wss:// a un host de anura.pe y sin puerto: la CSP (connect-src) solo
  -- deja salir a wss://*.anura.pe por el puerto de siempre.
  ws_url      text not null default 'wss://sipwss.anura.pe'
                check (ws_url ~ '^wss://([a-z0-9-]+\.)*anura\.pe(/[A-Za-z0-9._~/-]*)?$'),
  sip_port    integer not null default 55090 check (sip_port between 1 and 65535),
  updated_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.anura_sip_settings is
  'La central de Anura de la org para el teléfono dentro de Kapta (fase 2): dominio SIP, URL WebSocket y puerto. No es secreto.';

drop trigger if exists anura_sip_settings_touch on public.anura_sip_settings;
create trigger anura_sip_settings_touch before update on public.anura_sip_settings
  for each row execute function public.touch_updated_at();

create table if not exists public.anura_sip_credentials (
  -- La fila del anexo (fase 1). Quitar el anexo borra la clave.
  extension_id     uuid primary key references public.anura_extensions(id) on delete cascade,
  org_id           uuid not null references public.organizations(id) on delete cascade,
  -- El número del anexo cuando se guardó: si la fila cambia de número, la
  -- clave se borra (disparador) y el servidor tampoco la entrega si no
  -- coincide.
  extension        text not null check (extension ~ '^[0-9]{2,6}$'),
  -- El usuario SIP de la terminal web (`101-websocket`).
  sip_user         text not null check (sip_user ~ '^[A-Za-z0-9._+-]{1,64}$'),
  -- La contraseña SIP cifrada con ENCRYPTION_KEY (lib/crypto.ts). Nunca en
  -- claro, nunca en una tabla que lea el navegador.
  password_cipher  text not null check (password_cipher like 'v1:%'),
  saved_by         uuid references auth.users(id) on delete set null,
  saved_at         timestamptz not null default now(),
  -- «Clave rechazada»: Anura no aceptó esta clave al llamar. Kapta no la
  -- vuelve a usar hasta que se guarde otra (guardar limpia las dos).
  rejected_at      timestamptz,
  rejected_reason  text check (rejected_reason is null or length(rejected_reason) <= 200),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint anura_sip_credentials_rejected_ck check ((rejected_at is null) = (rejected_reason is null))
);

comment on table public.anura_sip_credentials is
  'Usuario y contraseña SIP (cifrada) de la terminal web de cada anexo de Anura (fase 2). Solo el servidor.';

create index if not exists anura_sip_credentials_org_idx on public.anura_sip_credentials (org_id);

drop trigger if exists anura_sip_credentials_touch on public.anura_sip_credentials;
create trigger anura_sip_credentials_touch before update on public.anura_sip_credentials
  for each row execute function public.touch_updated_at();

-- Cambiar el número de un anexo deja sin valor su clave: se borra.
create or replace function public.anura_extension_number_changed()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if new.extension is distinct from old.extension then
    delete from public.anura_sip_credentials where extension_id = new.id;
  end if;
  return new;
end
$fn$;

revoke all on function public.anura_extension_number_changed() from public, anon, authenticated;

drop trigger if exists anura_extensions_number_changed on public.anura_extensions;
create trigger anura_extensions_number_changed after update of extension on public.anura_extensions
  for each row execute function public.anura_extension_number_changed();

alter table public.anura_sip_settings enable row level security;
alter table public.anura_sip_credentials enable row level security;

drop policy if exists anura_sip_settings_read on public.anura_sip_settings;
create policy anura_sip_settings_read on public.anura_sip_settings
  for select to authenticated using (org_id in (select auth_org_ids()));
-- anura_sip_credentials: sin política y sin grant. Solo el servidor.

revoke all on public.anura_sip_settings, public.anura_sip_credentials from anon, authenticated;
grant select on public.anura_sip_settings to authenticated;
grant all on public.anura_sip_settings, public.anura_sip_credentials to service_role;
