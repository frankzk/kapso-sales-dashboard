-- Compras: proveedores (0341, MOM §45.7). Sobre el clúster desechable, después
-- de todas las migraciones. Lo que fija:
--   a) Las columnas nuevas son opcionales: un proveedor de la 0340 sigue igual.
--   b) Sus formas con CHECK: contacto ≤ 120, correo con forma `a@b.c` ≤ 160,
--      condiciones de pago ≤ 200, y ninguno vacío.
--   c) Sigue siendo solo del servidor: sin privilegios para anon ni
--      authenticated.
--   d) Correrla dos veces es correrla una.
-- Todo dentro de una transacción que se deshace al final.

begin;
set local client_min_messages = warning;

insert into organizations (id, name) values ('34100000-0000-0000-0000-0000000000a1', 'Kapta (0341)');
insert into import_suppliers (id, org_id, name, country)
values ('34100000-0000-0000-0000-0000000000f1', '34100000-0000-0000-0000-0000000000a1', 'Yiwu Trading', 'China');

do $$
declare
  v_org uuid := '34100000-0000-0000-0000-0000000000a1';
  v_sup uuid := '34100000-0000-0000-0000-0000000000f1';
begin
  -- a) Sin las columnas nuevas, igual que antes.
  if (select contact_name is not null or email is not null or payment_terms is not null
        from import_suppliers where id = v_sup) then
    raise exception 'las columnas nuevas nacen nulas';
  end if;
  update import_suppliers
     set contact_name = 'Lily Chen', email = 'lily@yiwu-trading.cn', payment_terms = '30 % adelanto, 70 % al embarque'
   where id = v_sup;

  -- b) Las formas.
  begin
    update import_suppliers set email = 'sin-arroba' where id = v_sup;
    raise exception 'el correo necesita @ y dominio';
  exception when check_violation then null;
  end;
  begin
    update import_suppliers set email = 'a@b' where id = v_sup;
    raise exception 'el correo necesita un punto en el dominio';
  exception when check_violation then null;
  end;
  begin
    update import_suppliers set contact_name = '   ' where id = v_sup;
    raise exception 'el contacto no puede ser solo espacios';
  exception when check_violation then null;
  end;
  begin
    update import_suppliers set contact_name = repeat('x', 121) where id = v_sup;
    raise exception 'el contacto llega hasta 120';
  exception when check_violation then null;
  end;
  begin
    update import_suppliers set payment_terms = repeat('x', 201) where id = v_sup;
    raise exception 'las condiciones llegan hasta 200';
  exception when check_violation then null;
  end;
  begin
    update import_suppliers set email = repeat('x', 150) || '@dominio.com' where id = v_sup;
    raise exception 'el correo llega hasta 160';
  exception when check_violation then null;
  end;

  -- c) Solo el servidor.
  if has_table_privilege('anon', 'public.import_suppliers', 'select')
     or has_table_privilege('authenticated', 'public.import_suppliers', 'select')
     or has_table_privilege('authenticated', 'public.import_suppliers', 'update') then
    raise exception 'import_suppliers no puede tener privilegios para anon ni authenticated';
  end if;
  if not has_table_privilege('service_role', 'public.import_suppliers', 'update') then
    raise exception 'import_suppliers es del service role';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.import_suppliers'::regclass) then
    raise exception 'import_suppliers sigue con RLS';
  end if;
end $$;

-- ── d) Dos veces es una ─────────────────────────────────────────────────────
\ir ../../db/migrations/0341_compras_proveedores.sql
do $$
begin
  if (select email from import_suppliers where id = '34100000-0000-0000-0000-0000000000f1') <> 'lily@yiwu-trading.cn' then
    raise exception 'correr la 0341 otra vez cambió datos';
  end if;
end $$;

rollback;
