-- Las cuentas a las que la tienda puede cobrar legítimamente.
--
-- Hasta ahora la cuenta esperada estaba escrita a mano y era UNA, global, dentro
-- de lib/yape-recipient.ts: «Grupo GF S.A.C.» con el celular terminado en 309.
-- El negocio cobra por más de una cuenta —las de las dos personas dueñas— y cada
-- comprobante a cualquiera de ellas quedaba marcado `revision_admin`, que es la
-- etiqueta que dice "el dinero se fue a OTRA cuenta". Diecisiete comprobantes en
-- tres semanas, ninguno validado jamás, y los pedidos salieron igual: el bloqueo
-- no protegía nada, solo enseñaba a no leer la alarma.
--
-- (El propio lib/vision.ts ya lo advertía —«a different store may cobrar to
-- another Yape account»— pero el dato vivía en otro archivo que no se enteró.)
--
-- REGLA QUE NO SE PUEDE ROMPER: una tienda SIN cuentas configuradas significa
-- "no sabemos contra qué contrastar", NO "el dinero se desvió". Si esta tabla
-- queda vacía, la verificación debe caer en `partial` —contraste manual— y nunca
-- en `mismatch`. Lo contrario convertiría un despiste de configuración en una
-- acusación de desvío sobre todos los cobros de la tienda.

create table if not exists store_collection_accounts (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id) on delete cascade,
  -- El nombre tal como lo escribe la app de esa cuenta. La comparación tolera
  -- recortes y enmascarado (ver lib/yape-recipient.ts); acá va el completo.
  label text not null,
  -- Otras formas de escribir la MISMA cuenta. La constancia del banco pone los
  -- apellidos primero («KASTNER CAM FRANKZ ALBERTO PAOLO») donde Yape los pone
  -- al final: es la misma persona y hay que declararlo, porque enseñarle a la
  -- comparación a ignorar el orden la volvería permisiva con cualquier nombre.
  aliases text[] not null default '{}',
  -- Últimos 3 dígitos del celular de la cuenta. Es la señal tajante: leída y
  -- distinta, es otra cuenta sin matices.
  phone_last_digits text not null check (phone_last_digits ~ '^[0-9]{3}$'),
  -- Para qué sirve la cuenta, en palabras del negocio. Sale en la interfaz.
  note text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Una cuenta no se repite dentro de la misma tienda.
create unique index if not exists store_collection_accounts_uniq
  on store_collection_accounts (store_id, phone_last_digits);

create index if not exists store_collection_accounts_store_idx
  on store_collection_accounts (store_id) where active;

alter table store_collection_accounts enable row level security;

comment on table store_collection_accounts is
  'Cuentas de cobro legítimas de cada tienda. Vacío = no se puede contrastar, '
  'nunca = desvío. Reemplaza la constante global de lib/yape-recipient.ts.';

-- Semilla: las tres cuentas por las que el negocio cobra hoy, para cada tienda.
-- Se siembran las tres en ambas tiendas porque son de la misma empresa y los
-- datos muestran cobros cruzados (la cuenta 147 aparece en Aurela y en Kenku).
insert into store_collection_accounts (store_id, label, aliases, phone_last_digits, note)
select s.id, v.label, v.aliases, v.digits, v.note
from stores s
cross join (values
  ('Grupo GF S.A.C.',                 '{}'::text[],                                  '309', 'Cuenta de la empresa'),
  ('Gabriela Reaño Vera',             '{}'::text[],                                  '147', 'Cuenta de una de las dueñas'),
  ('Frankz Alberto Paolo Kastner Cam','{"Kastner Cam Frankz Alberto Paolo"}'::text[],'481', 'Cuenta de uno de los dueños')
) as v(label, aliases, digits, note)
on conflict (store_id, phone_last_digits) do nothing;
