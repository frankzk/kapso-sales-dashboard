-- ============================================================================
-- 0282_swayp_unknown_guides.sql — las guías de las que Swayp avisa y que Kapta
-- no tiene (MOM §11.2, «Guías de Swayp que Kapta no tiene», 26-10-2026, pedido del
-- owner).
--
-- EL HUECO. El webhook de Swayp manda `{guide_number, state}` y Kapta busca la
-- guía en `shipments.swayp_guide`. Si no está —porque alguien la creó directo
-- en el panel de Swayp y no la registró en Kapta— el aviso se descartaba en
-- silencio (`no_shipment`). Pasó con #KP143754 (26-10-2026): la caja se armó el
-- 24-10 «sin courier definido», salió por Swayp desde su panel, Swayp avisó la
-- entrega y Kapta siguió viéndola «Por despachar».
--
-- AHORA el aviso se guarda aquí, una fila por número de guía, y Envíos lo
-- enseña hasta que la guía se registra en Kapta o alguien la descarta («no es
-- nuestra»). Solo el número, el estado y lo que Swayp diga de la guía al verla
-- por primera vez (`GET /v2/guias/<n>`: destinatario y celular, para sugerir
-- el pedido). Nunca se crea una guía ni se toca un pedido desde aquí.
--
-- `org_id`: la cuenta de Swayp es una para toda la operación, la misma que el
-- stock (`SWAYP_INVENTORY_ORG_ID`, 0201). La ve quien es de esa organización.
--
-- EL CÓDIGO NO LA NECESITA PARA ARRANCAR: sin la tabla, el webhook sigue
-- descartando como antes (el error se registra y no rompe la respuesta) y
-- Envíos no enseña la tarjeta.
-- ============================================================================

create table if not exists swayp_unknown_guides (
  guide_number   text primary key,
  org_id         uuid references organizations(id) on delete cascade,
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  -- El último estado que avisó Swayp (sus códigos: 7 = entregada).
  last_state     integer not null,
  notices        integer not null default 1,
  -- Lo que Swayp dijo de la guía al verla por primera vez, si respondió.
  customer_name  text,
  customer_phone text,
  reference      text,
  -- «No es nuestra» o «ya la resolví»: deja de salir en Envíos.
  dismissed_at   timestamptz,
  dismissed_by   uuid references auth.users(id) on delete set null,
  dismiss_note   text
);

create index if not exists swayp_unknown_guides_open_idx
  on swayp_unknown_guides(org_id, last_seen_at desc) where dismissed_at is null;

comment on table swayp_unknown_guides is
  'Avisos del webhook de Swayp de guías que no están en shipments (creadas en el panel de Swayp sin registrarlas en Kapta). Envíos las muestra hasta registrarlas o descartarlas (0282, MOM §11.2).';

alter table swayp_unknown_guides enable row level security;
drop policy if exists swayp_unknown_guides_select on swayp_unknown_guides;
create policy swayp_unknown_guides_select on swayp_unknown_guides for select to authenticated
  using (org_id in (select auth_org_ids()));
grant select on swayp_unknown_guides to authenticated;
grant all privileges on swayp_unknown_guides to service_role;
