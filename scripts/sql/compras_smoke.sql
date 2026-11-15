-- Compras: importaciones (0340, MOM §45). Sobre el clúster desechable, después
-- de todas las migraciones. Lo que fija:
--   a) Las formas: código IMP-AAAA-NNN único por organización, los estados,
--      el transporte, el enlace http(s), la cantidad, dañadas ≤ recibidas, el
--      tipo de costo, el reparto y el monto > 0 (§13.11 de la referencia).
--   b) Un hijo no cuelga de una importación de otra organización, y un costo
--      «a un producto» solo apunta a un producto de SU importación.
--   c) Quitar el producto deja el costo con item_id nulo: no desaparece.
--   d) El historial es append-only.
--   e) Solo el servidor: RLS encendida, sin privilegios para anon ni
--      authenticated; service_role sí (y el historial, solo leer y agregar).
--   f) Correrla dos veces es correrla una.
-- Todo dentro de una transacción que se deshace al final.

begin;
set local client_min_messages = warning;

insert into organizations (id, name) values
  ('34000000-0000-0000-0000-0000000000a1', 'Kapta (0340)'),
  ('34000000-0000-0000-0000-0000000000a2', 'Otra org (0340)');

insert into import_suppliers (id, org_id, name, country, whatsapp)
values ('34000000-0000-0000-0000-0000000000f1', '34000000-0000-0000-0000-0000000000a1', 'Yiwu Trading', 'China', '+8613800001111');

insert into imports (id, org_id, code, supplier_id, transport, status, tracking_url, fx_pen_per_usd)
values ('34000000-0000-0000-0000-0000000000b1', '34000000-0000-0000-0000-0000000000a1', 'IMP-2026-001',
        '34000000-0000-0000-0000-0000000000f1', 'air', 'en_transito', 'https://www.dhl.com/x', 3.7517);
insert into imports (id, org_id, code)
values ('34000000-0000-0000-0000-0000000000b2', '34000000-0000-0000-0000-0000000000a2', 'IMP-2026-001');

insert into import_items (id, org_id, import_id, sku, name, qty, unit_cost_usd, unit_weight_kg)
values
  ('34000000-0000-0000-0000-0000000000c1', '34000000-0000-0000-0000-0000000000a1', '34000000-0000-0000-0000-0000000000b1', 'SKU-A', 'A', 100, 2, 0.5),
  ('34000000-0000-0000-0000-0000000000c2', '34000000-0000-0000-0000-0000000000a1', '34000000-0000-0000-0000-0000000000b1', 'SKU-B', 'B', 50, 12, 0.2);
insert into import_items (id, org_id, import_id, name, qty)
values ('34000000-0000-0000-0000-0000000000c9', '34000000-0000-0000-0000-0000000000a2', '34000000-0000-0000-0000-0000000000b2', 'Z', 1);

insert into import_costs (id, org_id, import_id, kind, label, amount_usd, allocation, item_id)
values ('34000000-0000-0000-0000-0000000000d1', '34000000-0000-0000-0000-0000000000a1', '34000000-0000-0000-0000-0000000000b1',
        'adicional', 'Etiquetas B', 25, 'item', '34000000-0000-0000-0000-0000000000c2');

-- ── a) Las formas ────────────────────────────────────────────────────────────
do $$
declare
  v_org uuid := '34000000-0000-0000-0000-0000000000a1';
  v_imp uuid := '34000000-0000-0000-0000-0000000000b1';
begin
  -- El mismo código en la misma org choca; en otra org no (ya se insertó arriba).
  begin
    insert into imports (org_id, code) values (v_org, 'IMP-2026-001');
    raise exception 'el código se repite dentro de la organización';
  exception when unique_violation then null;
  end;
  begin
    insert into imports (org_id, code) values (v_org, 'IMP-26-1');
    raise exception 'el código es IMP-AAAA-NNN';
  exception when check_violation then null;
  end;
  begin
    insert into imports (org_id, code, status) values (v_org, 'IMP-2026-002', 'listo');
    raise exception 'el estado es uno de los diez';
  exception when check_violation then null;
  end;
  begin
    insert into imports (org_id, code, transport) values (v_org, 'IMP-2026-003', 'cohete');
    raise exception 'el transporte es courier, air, sea o land';
  exception when check_violation then null;
  end;
  begin
    insert into imports (org_id, code, tracking_url) values (v_org, 'IMP-2026-004', 'javascript:alert(1)');
    raise exception 'el enlace de seguimiento es http(s)';
  exception when check_violation then null;
  end;
  begin
    insert into imports (org_id, code, fx_pen_per_usd) values (v_org, 'IMP-2026-005', 0);
    raise exception 'el tipo de cambio es mayor que 0';
  exception when check_violation then null;
  end;
  begin
    insert into import_items (org_id, import_id, name, qty) values (v_org, v_imp, 'X', 0);
    raise exception 'la cantidad es de 1 a 10.000.000';
  exception when check_violation then null;
  end;
  begin
    insert into import_items (org_id, import_id, name, qty, received_qty, damaged_qty) values (v_org, v_imp, 'X', 5, 2, 3);
    raise exception 'dañadas ≤ recibidas';
  exception when check_violation then null;
  end;
  begin
    insert into import_items (org_id, import_id, name, qty, damaged_qty) values (v_org, v_imp, 'X', 5, 1);
    raise exception 'no hay dañadas sin recibidas';
  exception when check_violation then null;
  end;
  begin
    insert into import_costs (org_id, import_id, kind, label, amount_usd) values (v_org, v_imp, 'envio', 'Flete', 0);
    raise exception 'el monto de un costo es mayor que 0';
  exception when check_violation then null;
  end;
  begin
    insert into import_costs (org_id, import_id, kind, label, amount_usd) values (v_org, v_imp, 'flete', 'Flete', 5);
    raise exception 'el tipo de costo es envio, importacion o adicional';
  exception when check_violation then null;
  end;
  begin
    insert into import_costs (org_id, import_id, kind, label, amount_usd, allocation) values (v_org, v_imp, 'envio', 'Flete', 5, 'random');
    raise exception 'el reparto es value, units, weight o item';
  exception when check_violation then null;
  end;
  begin
    insert into import_costs (org_id, import_id, kind, label, amount_usd, allocation, item_id)
    values (v_org, v_imp, 'envio', 'Flete', 5, 'units', '34000000-0000-0000-0000-0000000000c1');
    raise exception 'solo un costo «a un producto» lleva producto';
  exception when check_violation then null;
  end;
  begin
    insert into import_payments (org_id, import_id, amount_usd, paid_on, method) values (v_org, v_imp, 10, '2026-11-01', 'bitcoin');
    raise exception 'el método de pago es de la lista';
  exception when check_violation then null;
  end;
  begin
    insert into import_documents (org_id, import_id, kind, storage_path, mime, size_bytes)
    values (v_org, v_imp, 'invoice', 'a/b.pdf', 'application/pdf', 26214401);
    raise exception 'un documento pesa hasta 25 MB';
  exception when check_violation then null;
  end;
  begin
    insert into import_documents (org_id, import_id, kind, storage_path, mime, size_bytes)
    values (v_org, v_imp, 'invoice', 'a/c.html', 'text/html', 10);
    raise exception 'un documento es PDF, JPG, PNG, WEBP o XLSX';
  exception when check_violation then null;
  end;
  begin
    insert into import_events (org_id, import_id, kind) values (v_org, v_imp, 'cualquiera');
    raise exception 'el tipo de hecho es de la lista';
  exception when check_violation then null;
  end;
  begin
    insert into import_suppliers (org_id, name) values (v_org, '  yiwu trading ');
    raise exception 'un proveedor por nombre (sin mayúsculas) en la organización';
  exception when unique_violation then null;
  end;
end $$;

-- ── b) Nada cuelga de otra organización ni de otra importación ──────────────
do $$
begin
  begin
    insert into import_items (org_id, import_id, name, qty)
    values ('34000000-0000-0000-0000-0000000000a2', '34000000-0000-0000-0000-0000000000b1', 'X', 1);
    raise exception 'un producto no cuelga de una importación de otra organización';
  exception when foreign_key_violation then null;
  end;
  begin
    insert into import_costs (org_id, import_id, kind, label, amount_usd, allocation, item_id)
    values ('34000000-0000-0000-0000-0000000000a1', '34000000-0000-0000-0000-0000000000b1', 'adicional', 'X', 5, 'item',
            '34000000-0000-0000-0000-0000000000c9');
    raise exception 'un costo «a un producto» apunta a un producto de su importación';
  exception when foreign_key_violation then null;
  end;
end $$;

-- ── c) Quitar el producto no borra el costo ─────────────────────────────────
delete from import_items where id = '34000000-0000-0000-0000-0000000000c2';
do $$
declare
  v_item uuid;
  v_n int;
begin
  select item_id, count(*) over () into v_item, v_n from import_costs where id = '34000000-0000-0000-0000-0000000000d1';
  if v_n is distinct from 1 then
    raise exception 'el costo «a un producto» desapareció al quitar el producto (§13.4)';
  end if;
  if v_item is not null then
    raise exception 'el costo debería quedar sin producto (item_id nulo)';
  end if;
end $$;

-- ── d) Append-only ──────────────────────────────────────────────────────────
insert into import_events (id, org_id, import_id, kind, status, note)
values ('34000000-0000-0000-0000-0000000000e1', '34000000-0000-0000-0000-0000000000a1',
        '34000000-0000-0000-0000-0000000000b1', 'status', 'en_transito', 'Salió de Shenzhen');
do $$
begin
  begin
    update import_events set note = 'otra cosa' where id = '34000000-0000-0000-0000-0000000000e1';
    raise exception 'import_events aceptó un UPDATE';
  exception when sqlstate 'P0001' then
    if sqlerrm not like '%append-only%' then raise; end if;
  end;
  begin
    delete from import_events where id = '34000000-0000-0000-0000-0000000000e1';
    raise exception 'import_events aceptó un DELETE';
  exception when sqlstate 'P0001' then
    if sqlerrm not like '%append-only%' then raise; end if;
  end;
  begin
    insert into import_events (org_id, import_id, kind, status) values
      ('34000000-0000-0000-0000-0000000000a1', '34000000-0000-0000-0000-0000000000b1', 'nota', 'recibido');
    raise exception 'solo un hecho de estado lleva estado';
  exception when check_violation then null;
  end;
end $$;

-- ── e) Solo el servidor ─────────────────────────────────────────────────────
do $$
declare
  t text;
begin
  foreach t in array array['import_suppliers', 'imports', 'import_items', 'import_documents', 'import_costs', 'import_payments', 'import_events'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception '% tiene que tener RLS encendida', t;
    end if;
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t) then
      raise exception '% no lleva políticas: solo la lee el servidor', t;
    end if;
    if has_table_privilege('anon', 'public.' || t, 'select')
       or has_table_privilege('anon', 'public.' || t, 'insert')
       or has_table_privilege('authenticated', 'public.' || t, 'select')
       or has_table_privilege('authenticated', 'public.' || t, 'insert')
       or has_table_privilege('authenticated', 'public.' || t, 'update')
       or has_table_privilege('authenticated', 'public.' || t, 'delete') then
      raise exception '% no puede tener privilegios para anon ni authenticated', t;
    end if;
    if not (has_table_privilege('service_role', 'public.' || t, 'select')
            and has_table_privilege('service_role', 'public.' || t, 'insert')) then
      raise exception '% es del service role', t;
    end if;
  end loop;
  if has_table_privilege('service_role', 'public.import_events', 'update')
     or has_table_privilege('service_role', 'public.import_events', 'delete')
     or has_table_privilege('service_role', 'public.import_events', 'truncate') then
    raise exception 'el historial no se reescribe, tampoco con el service role';
  end if;
end $$;

-- ── f) Dos veces es una ─────────────────────────────────────────────────────
\ir ../../db/migrations/0340_compras_importaciones.sql
do $$
begin
  if (select count(*) from imports where org_id = '34000000-0000-0000-0000-0000000000a1') <> 1
     or (select count(*) from import_costs where id = '34000000-0000-0000-0000-0000000000d1') <> 1 then
    raise exception 'correr la 0340 otra vez cambió datos';
  end if;
end $$;

rollback;
