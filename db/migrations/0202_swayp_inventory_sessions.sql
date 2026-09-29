-- 0202_swayp_inventory_sessions.sql — la sesión del panel de Swayp que el sync
-- diario reutiliza mientras está vigente, y la llave de la extensión de Chrome
-- que la envía (MOM, «El mismo conteo, leído por API»).
--
-- Swayp no da (todavía) una credencial de API con acceso al inventario: la de
-- las guías responde 403 «No tienes autorización 7301», y el login del panel
-- exige reCAPTCHA, así que no se automatiza. Lo que sí se puede es REUTILIZAR
-- la sesión que una persona abrió: cuando alguien pega su token en Stock Swayp,
-- o abre el panel con la extensión instalada, Kapta la guarda cifrada hasta que
-- vence y la usa para sincronizar como mucho una vez al día.
--
-- Una fila por organización: la última sesión recibida reemplaza a la anterior.
-- El token va cifrado (lib/crypto.ts) y NINGÚN usuario lo puede leer: la tabla
-- no tiene política de lectura; sólo el servidor, con service_role.

create table if not exists swayp_inventory_sessions (
  org_id      uuid primary key references organizations(id) on delete cascade,
  token_enc   text not null,
  email       text not null,
  ruc         text not null,
  id_company  text not null,
  expires_at  timestamptz not null,
  source      text not null check (source in ('manual', 'extension')),
  saved_by    uuid references auth.users(id) on delete set null,
  saved_at    timestamptz not null default now()
);

comment on table swayp_inventory_sessions is
  'Sesión del panel de Swayp (token cifrado) que el sync diario de inventario reutiliza hasta que vence. Sólo service_role.';

alter table swayp_inventory_sessions enable row level security;
grant all privileges on swayp_inventory_sessions to service_role;

-- La llave con la que la extensión de Chrome se identifica ante Kapta. Se
-- guarda sólo su hash (sha256): la llave en claro vive dentro del zip que se
-- descargó, y descargar otro zip la reemplaza (la anterior deja de servir).
create table if not exists swayp_extension_keys (
  org_id       uuid primary key references organizations(id) on delete cascade,
  key_hash     text not null,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);

comment on table swayp_extension_keys is
  'Hash de la llave de la extensión de Chrome que envía la sesión de Swayp a Kapta. Una por organización. Sólo service_role.';

alter table swayp_extension_keys enable row level security;
grant all privileges on swayp_extension_keys to service_role;
