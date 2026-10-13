-- Roles que se acumulan (0250, MOM §16). Sobre el clúster desechable, con la
-- org del fixture de rls_smoke.sql (3333…). Fija lo que decide la base:
-- `rider_pay_allowed` reconoce los roles con la regla de lib/permissions.ts, y
-- los roles se van cuando la persona sale de la organización.

do $$
declare
  v_org  uuid := '33333333-3333-3333-3333-333333333333';
  v_vend uuid := '00000000-0000-0000-0000-0000000000e1'; -- vendedora sin roles
  v_liq  uuid := '00000000-0000-0000-0000-0000000000e2'; -- vendedora con Liquidaciones
  v_n    int;
begin
  insert into auth.users(id, email) values (v_vend, 'vend@roles.test'), (v_liq, 'liq@roles.test') on conflict do nothing;
  insert into memberships(user_id, org_id, role) values (v_vend, v_org, 'vendedora'), (v_liq, v_org, 'vendedora');
  insert into membership_roles(user_id, org_id, role) values (v_liq, v_org, 'liquidaciones');

  -- 1. La vendedora sin roles arma rutas, como siempre.
  if not rider_pay_allowed(v_org, v_vend, 'routes.manage') then raise exception 'la vendedora sin roles debería armar rutas'; end if;
  if rider_pay_allowed(v_org, v_vend, 'settlements.close') then raise exception 'la vendedora sin roles no cierra liquidaciones'; end if;

  -- 2. Con Liquidaciones: cierra liquidaciones, y el paquete «vendedora» ya no
  --    suma (no arma rutas: eso es de Despacho).
  if not rider_pay_allowed(v_org, v_liq, 'settlements.close') then raise exception 'Liquidaciones debería cerrar liquidaciones'; end if;
  if rider_pay_allowed(v_org, v_liq, 'routes.manage') then raise exception 'con roles, el paquete vendedora no debería sumar'; end if;

  -- 3. Con Despacho, arma rutas otra vez.
  insert into membership_roles(user_id, org_id, role) values (v_liq, v_org, 'despacho');
  if not rider_pay_allowed(v_org, v_liq, 'routes.manage') then raise exception 'Despacho debería armar rutas'; end if;

  -- 4. Un rol que no existe no entra.
  begin
    insert into membership_roles(user_id, org_id, role) values (v_liq, v_org, 'superadmin');
    raise exception 'un rol desconocido no debería poder guardarse';
  exception when check_violation then null;
  end;

  -- 5. Sin membresía no hay rol: sale de la organización y sus roles se van.
  delete from memberships where user_id = v_liq and org_id = v_org;
  select count(*) into v_n from membership_roles where user_id = v_liq;
  if v_n <> 0 then raise exception 'los roles deberían irse con la membresía'; end if;

  delete from memberships where user_id = v_vend and org_id = v_org;
  delete from auth.users where id in (v_vend, v_liq);
  raise notice 'membership_roles: 5 comprobaciones OK';
end $$;
