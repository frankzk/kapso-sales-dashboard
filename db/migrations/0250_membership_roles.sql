-- ============================================================================
-- 0250_membership_roles.sql — roles que se acumulan (MOM §16, 12-10-2026).
--
-- QUÉ ES. Hasta hoy cada persona tenía UN rol por organización
-- (`memberships.role`: owner, admin, vendedora, viewer, motorizado). Doce
-- personas eran admin para poder hacer una o dos cosas que la vendedora no
-- traía, y con eso recibían unos cuarenta permisos que no usaban. Ahora, encima
-- de ese acceso, una persona puede tener varios roles por función —Asesora,
-- Almacén, Despacho y Grupo GF, Liquidaciones, Cobranza, Supervisión,
-- Administración— y sus permisos se suman (lib/permissions.ts,
-- `FUNCTIONAL_ROLES`).
--
-- Una fila por persona, organización y rol. Si la persona sale de la
-- organización, sus roles se van con ella (la clave foránea a `memberships`).
-- Solo el servidor escribe, y solo el dueño asigna (lib/team.ts).
--
-- `rider_pay_allowed` (0162) repite en SQL el mapa de rol a permiso para tres
-- permisos —armar rutas, cerrar liquidaciones y costos—. Se le enseñan los
-- roles nuevos con la misma regla que lib/permissions.ts: quien es vendedora y
-- tiene roles recibe solo lo de sus roles. test/membership-roles.test.ts
-- comprueba que las dos definiciones digan lo mismo.
-- ============================================================================

create table if not exists membership_roles (
  user_id uuid not null,
  org_id uuid not null,
  role text not null check (role in ('asesora', 'almacen', 'despacho', 'liquidaciones', 'cobranza', 'supervision', 'administracion')),
  granted_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (user_id, org_id, role),
  foreign key (user_id, org_id) references memberships(user_id, org_id) on delete cascade
);

create index if not exists membership_roles_org_idx on membership_roles (org_id);

comment on table membership_roles is
  'Roles acumulables por persona y organización (MOM §16). Sus permisos se suman a los del acceso de memberships.role; los asigna solo el dueño desde Equipo.';

alter table membership_roles enable row level security;

-- Como `user_permissions`: cada quien ve los suyos, y owner/admin los de su
-- organización para pintar Equipo.
create policy membership_roles_select on membership_roles
  for select to authenticated
  using (user_id = auth.uid() or org_id in (select auth_admin_org_ids()));

revoke all on membership_roles from anon, authenticated;
grant select on membership_roles to authenticated;
grant all privileges on membership_roles to service_role;

create or replace function rider_pay_allowed(p_org uuid, p_actor uuid, p_permission text)
returns boolean language sql stable set search_path = public as $$
  select coalesce((select coalesce(
    (select granted from user_permissions where org_id = p_org and user_id = p_actor and permission = p_permission),
    m.role in ('owner', 'admin')
    -- El paquete «vendedora» solo cuenta mientras la persona no tenga roles.
    or (m.role = 'vendedora' and p_permission = 'routes.manage'
        and not exists (select 1 from membership_roles r where r.org_id = p_org and r.user_id = p_actor))
    or exists (
      select 1 from membership_roles r
      where r.org_id = p_org and r.user_id = p_actor and (
           (p_permission = 'routes.manage' and r.role = 'despacho')
        or (p_permission = 'settlements.close' and r.role = 'liquidaciones')
        or (p_permission = 'costs.manage' and r.role = 'administracion'))))
    from memberships m where m.org_id = p_org and m.user_id = p_actor), false);
$$;
