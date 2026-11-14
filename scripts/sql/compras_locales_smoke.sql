-- Compras: compras locales, cortesía y entregas parciales (0343, MOM
-- §45.12–§45.14). Sobre el clúster desechable, después de todas las
-- migraciones. Lo que fija:
--   a) El tipo y su serie: `IMP-` es importación, `LOC-` es compra local; lo de
--      antes (sin tipo) es importación con su `IMP-`. El código de la proforma
--      (MOM §45.15), opcional y de hasta 80 caracteres.
--   b) «Recibido parcial» en `imports.status` e `import_events.status`; un
--      estado inventado, no.
--   c) El costo por unidad en soles de una compra local: exactamente uno, el de
--      su moneda; un producto de antes (sin moneda) sigue en USD; la cortesía
--      es un entero ≥ 0.
--   d) Las entregas: los totales del producto son la suma de sus entregas
--      (trigger), al agregar, corregir y quitar; sin ninguna, nulos. Dañadas ≤
--      recibidas; nada cuelga de otra organización ni de otra importación.
--   e) Las fotos de una entrega son fotos; quitar la entrega deja la foto.
--   f) Un producto con entregas no se borra; la importación entera sí (en
--      cascada).
--   g) El backfill: una recepción de antes (totales escritos directo, sin
--      entregas) pasa a UNA entrega «legacy» con los mismos números y sin
--      tocar los totales; correrla otra vez no crea nada.
--   h) Solo el servidor: RLS encendida, sin políticas ni privilegios para anon
--      ni authenticated.
--   i) El IGV de cada costo (MOM §45.3): neto (por defecto), con_igv (=
--      «Incluye IGV») o inafecto; una fila del código anterior con
--      «Incluye IGV» queda con_igv; con_igv sin la casilla, no.
-- Todo dentro de una transacción que se deshace al final.

begin;
set local client_min_messages = warning;

insert into organizations (id, name) values
  ('34300000-0000-0000-0000-0000000000a1', 'Kapta (0343)'),
  ('34300000-0000-0000-0000-0000000000a2', 'Otra org (0343)');

-- a) Una importación como las de antes (sin tipo) y una compra local.
insert into imports (id, org_id, code) values
  ('34300000-0000-0000-0000-0000000000b1', '34300000-0000-0000-0000-0000000000a1', 'IMP-2026-001');
insert into imports (id, org_id, code, kind, status) values
  ('34300000-0000-0000-0000-0000000000b2', '34300000-0000-0000-0000-0000000000a1', 'LOC-2026-001', 'local', 'pagado');
insert into imports (id, org_id, code, kind) values
  ('34300000-0000-0000-0000-0000000000b9', '34300000-0000-0000-0000-0000000000a2', 'LOC-2026-001', 'local');

-- c) Un producto como los de antes (USD, sin moneda) y dos en soles con cortesía.
insert into import_items (id, org_id, import_id, name, qty, unit_cost_usd) values
  ('34300000-0000-0000-0000-0000000000c1', '34300000-0000-0000-0000-0000000000a1', '34300000-0000-0000-0000-0000000000b1', 'Funda', 100, 2);
insert into import_items (id, org_id, import_id, name, qty, courtesy_qty, unit_cost_currency, unit_cost_usd, unit_cost_pen) values
  ('34300000-0000-0000-0000-0000000000c2', '34300000-0000-0000-0000-0000000000a1', '34300000-0000-0000-0000-0000000000b2', 'Crema', 600, 50, 'PEN', null, 7.5),
  ('34300000-0000-0000-0000-0000000000c3', '34300000-0000-0000-0000-0000000000a1', '34300000-0000-0000-0000-0000000000b2', 'Gel', 200, 0, 'PEN', null, 4);
insert into import_items (id, org_id, import_id, name, qty, unit_cost_currency, unit_cost_usd, unit_cost_pen) values
  ('34300000-0000-0000-0000-0000000000c9', '34300000-0000-0000-0000-0000000000a2', '34300000-0000-0000-0000-0000000000b9', 'Z', 1, 'PEN', null, 1);

do $$
begin
  if (select kind <> 'importacion' or proforma_number is not null from imports where id = '34300000-0000-0000-0000-0000000000b1') then
    raise exception 'una importación sin tipo (la de antes) es importación, sin código de proforma';
  end if;
  if (select unit_cost_currency <> 'USD' or courtesy_qty <> 0 or unit_cost_pen is not null
        from import_items where id = '34300000-0000-0000-0000-0000000000c1') then
    raise exception 'un producto sin moneda (el de antes) es USD, sin cortesía';
  end if;
  if not exists (select 1 from pg_attribute
                  where attrelid = 'public.import_items'::regclass and attname = 'unit_cost_usd' and not attnotnull) then
    raise exception 'unit_cost_usd tiene que poder ser nulo (un producto en soles)';
  end if;
end $$;

-- ── a), b) y c) Los CHECK ───────────────────────────────────────────────────
do $$
declare
  v_org uuid := '34300000-0000-0000-0000-0000000000a1';
  v_loc uuid := '34300000-0000-0000-0000-0000000000b2';
begin
  begin
    insert into imports (org_id, code, kind) values (v_org, 'IMP-2026-002', 'local');
    raise exception 'una compra local lleva LOC-';
  exception when check_violation then null;
  end;
  begin
    insert into imports (org_id, code) values (v_org, 'LOC-2026-002');
    raise exception 'una importación lleva IMP-';
  exception when check_violation then null;
  end;
  begin
    insert into imports (org_id, code, kind) values (v_org, 'LOC-26-1', 'local');
    raise exception 'el código es LOC-AAAA-NNN';
  exception when check_violation then null;
  end;
  begin
    insert into imports (org_id, code) values (v_org, 'IMP-26-1');
    raise exception 'el código sigue siendo IMP-AAAA-NNN';
  exception when check_violation then null;
  end;
  -- El código de la proforma: opcional, hasta 80 caracteres y no en blanco.
  insert into imports (org_id, code, proforma_number, platform_order) values (v_org, 'IMP-2026-010', 'PI-2026-0042', '2045123456789');
  begin
    insert into imports (org_id, code, proforma_number) values (v_org, 'IMP-2026-011', '   ');
    raise exception 'el código de la proforma no va en blanco';
  exception when check_violation then null;
  end;
  begin
    insert into imports (org_id, code, proforma_number) values (v_org, 'IMP-2026-012', repeat('x', 81));
    raise exception 'el código de la proforma es de hasta 80 caracteres';
  exception when check_violation then null;
  end;
  begin
    insert into imports (org_id, code, kind) values (v_org, 'LOC-2026-003', 'laboratorio');
    raise exception 'el tipo es importacion o local';
  exception when check_violation then null;
  end;
  begin
    insert into imports (org_id, code, kind) values (v_org, 'LOC-2026-001', 'local');
    raise exception 'el código se repite dentro de la organización';
  exception when unique_violation then null;
  end;
  -- La misma serie en otra org y las dos series a la vez: sí.
  insert into imports (org_id, code, kind, status) values (v_org, 'LOC-2026-004', 'local', 'recibido_parcial');
  insert into import_events (org_id, import_id, kind, status) values (v_org, v_loc, 'status', 'recibido_parcial');
  begin
    insert into imports (org_id, code, status) values (v_org, 'IMP-2026-005', 'listo');
    raise exception 'el estado es uno de la lista';
  exception when check_violation then null;
  end;
  begin
    insert into import_events (org_id, import_id, kind, status) values (v_org, v_loc, 'status', 'listo');
    raise exception 'el estado de un hecho es uno de la lista';
  exception when check_violation then null;
  end;
  begin
    insert into import_events (org_id, import_id, kind, status) values (v_org, v_loc, 'nota', 'recibido_parcial');
    raise exception 'solo un hecho de estado lleva estado';
  exception when check_violation then null;
  end;
  begin
    insert into import_items (org_id, import_id, name, qty, unit_cost_currency, unit_cost_usd, unit_cost_pen)
    values (v_org, v_loc, 'X', 1, 'PEN', 3, 3);
    raise exception 'un producto en soles no lleva costo en USD';
  exception when check_violation then null;
  end;
  begin
    insert into import_items (org_id, import_id, name, qty, unit_cost_currency, unit_cost_usd) values (v_org, v_loc, 'X', 1, 'PEN', null);
    raise exception 'un producto en soles lleva su costo en soles';
  exception when check_violation then null;
  end;
  begin
    insert into import_items (org_id, import_id, name, qty, unit_cost_pen) values (v_org, v_loc, 'X', 1, 3);
    raise exception 'un producto en USD no lleva costo en soles';
  exception when check_violation then null;
  end;
  begin
    insert into import_items (org_id, import_id, name, qty, unit_cost_currency, unit_cost_usd, unit_cost_pen)
    values (v_org, v_loc, 'X', 1, 'EUR', null, 3);
    raise exception 'la moneda del costo es USD o PEN';
  exception when check_violation then null;
  end;
  begin
    insert into import_items (org_id, import_id, name, qty, courtesy_qty) values (v_org, v_loc, 'X', 1, -1);
    raise exception 'la cortesía es un entero ≥ 0';
  exception when check_violation then null;
  end;
end $$;

-- ── d) Las entregas y sus totales ───────────────────────────────────────────
insert into import_deliveries (id, org_id, import_id, delivered_on, note) values
  ('34300000-0000-0000-0000-0000000000d1', '34300000-0000-0000-0000-0000000000a1', '34300000-0000-0000-0000-0000000000b2', '2026-11-10', 'Primera parte');
insert into import_delivery_lines (org_id, import_id, delivery_id, item_id, received, damaged, note) values
  ('34300000-0000-0000-0000-0000000000a1', '34300000-0000-0000-0000-0000000000b2', '34300000-0000-0000-0000-0000000000d1',
   '34300000-0000-0000-0000-0000000000c2', 400, 3, 'tres cajas golpeadas');

insert into import_deliveries (id, org_id, import_id, delivered_on) values
  ('34300000-0000-0000-0000-0000000000d2', '34300000-0000-0000-0000-0000000000a1', '34300000-0000-0000-0000-0000000000b2', '2026-11-12');
insert into import_delivery_lines (id, org_id, import_id, delivery_id, item_id, received, damaged) values
  ('34300000-0000-0000-0000-0000000000e1', '34300000-0000-0000-0000-0000000000a1', '34300000-0000-0000-0000-0000000000b2',
   '34300000-0000-0000-0000-0000000000d2', '34300000-0000-0000-0000-0000000000c2', 250, 0),
  ('34300000-0000-0000-0000-0000000000e2', '34300000-0000-0000-0000-0000000000a1', '34300000-0000-0000-0000-0000000000b2',
   '34300000-0000-0000-0000-0000000000d2', '34300000-0000-0000-0000-0000000000c3', 100, 1);

do $$
begin
  -- Crema: 400 + 250 = 650 (600 pedidas + 50 de cortesía), 3 dañadas.
  if (select received_qty <> 650 or damaged_qty <> 3 or reception_note <> 'tres cajas golpeadas' or received_at is null
        from import_items where id = '34300000-0000-0000-0000-0000000000c2') then
    raise exception 'los totales del producto son la suma de sus entregas';
  end if;
  if (select received_qty <> 100 or damaged_qty <> 1 from import_items where id = '34300000-0000-0000-0000-0000000000c3') then
    raise exception 'cada producto suma solo sus entregas';
  end if;
end $$;

-- Corregir una línea y quitar una entrega recalculan.
update import_delivery_lines set received = 200, damaged = 2 where id = '34300000-0000-0000-0000-0000000000e1';
do $$
begin
  if (select received_qty <> 600 or damaged_qty <> 5 from import_items where id = '34300000-0000-0000-0000-0000000000c2') then
    raise exception 'corregir una línea recalcula el total';
  end if;
end $$;

delete from import_deliveries where id = '34300000-0000-0000-0000-0000000000d2';
do $$
begin
  if (select received_qty <> 400 or damaged_qty <> 3 from import_items where id = '34300000-0000-0000-0000-0000000000c2') then
    raise exception 'quitar una entrega la saca del total';
  end if;
  if (select received_qty is not null or damaged_qty is not null or reception_note is not null or received_at is not null
        from import_items where id = '34300000-0000-0000-0000-0000000000c3') then
    raise exception 'un producto sin ninguna entrega queda sin contar (nulos)';
  end if;
end $$;

do $$
declare
  v_org uuid := '34300000-0000-0000-0000-0000000000a1';
  v_loc uuid := '34300000-0000-0000-0000-0000000000b2';
  v_d1 uuid := '34300000-0000-0000-0000-0000000000d1';
begin
  begin
    insert into import_delivery_lines (org_id, import_id, delivery_id, item_id, received, damaged)
    values (v_org, v_loc, v_d1, '34300000-0000-0000-0000-0000000000c3', 2, 3);
    raise exception 'dañadas ≤ recibidas';
  exception when check_violation then null;
  end;
  begin
    insert into import_delivery_lines (org_id, import_id, delivery_id, item_id, received)
    values (v_org, v_loc, v_d1, '34300000-0000-0000-0000-0000000000c2', 1);
    raise exception 'un producto va una sola vez por entrega';
  exception when unique_violation then null;
  end;
  begin
    insert into import_delivery_lines (org_id, import_id, delivery_id, item_id, received)
    values (v_org, v_loc, v_d1, '34300000-0000-0000-0000-0000000000c1', 1);
    raise exception 'una línea no apunta a un producto de otra importación';
  exception when foreign_key_violation then null;
  end;
  begin
    insert into import_delivery_lines (org_id, import_id, delivery_id, item_id, received)
    values (v_org, '34300000-0000-0000-0000-0000000000b1', v_d1, '34300000-0000-0000-0000-0000000000c1', 1);
    raise exception 'una línea no cuelga de una entrega de otra importación';
  exception when foreign_key_violation then null;
  end;
  begin
    insert into import_deliveries (org_id, import_id, delivered_on) values ('34300000-0000-0000-0000-0000000000a2', v_loc, '2026-11-10');
    raise exception 'una entrega no cuelga de una compra de otra organización';
  exception when foreign_key_violation then null;
  end;
  begin
    insert into import_deliveries (org_id, import_id) values (v_org, v_loc);
    raise exception 'una entrega lleva su fecha';
  exception when not_null_violation then null;
  end;
end $$;

-- ── e) Las fotos de una entrega ─────────────────────────────────────────────
insert into import_documents (id, org_id, import_id, kind, storage_path, mime, size_bytes, delivery_id) values
  ('34300000-0000-0000-0000-0000000000f1', '34300000-0000-0000-0000-0000000000a1', '34300000-0000-0000-0000-0000000000b2',
   'photo', 'x/0343/foto1.jpg', 'image/jpeg', 100, '34300000-0000-0000-0000-0000000000d1');
do $$
begin
  begin
    insert into import_documents (org_id, import_id, kind, storage_path, mime, size_bytes, delivery_id)
    values ('34300000-0000-0000-0000-0000000000a1', '34300000-0000-0000-0000-0000000000b2', 'invoice', 'x/0343/f.pdf', 'application/pdf', 10,
            '34300000-0000-0000-0000-0000000000d1');
    raise exception 'solo una foto va ligada a una entrega';
  exception when check_violation then null;
  end;
  begin
    insert into import_documents (org_id, import_id, kind, storage_path, mime, size_bytes, delivery_id)
    values ('34300000-0000-0000-0000-0000000000a1', '34300000-0000-0000-0000-0000000000b1', 'photo', 'x/0343/g.jpg', 'image/jpeg', 10,
            '34300000-0000-0000-0000-0000000000d1');
    raise exception 'la foto es de una entrega de SU importación';
  exception when foreign_key_violation then null;
  end;
end $$;

-- ── f) Un producto con entregas no se borra; la entrega sí, y deja la foto ──
do $$
begin
  begin
    delete from import_items where id = '34300000-0000-0000-0000-0000000000c2';
    raise exception 'un producto con entregas no se borra';
  exception when foreign_key_violation then null;
  end;
end $$;

delete from import_deliveries where id = '34300000-0000-0000-0000-0000000000d1';
do $$
begin
  if (select delivery_id is not null from import_documents where id = '34300000-0000-0000-0000-0000000000f1') then
    raise exception 'quitar la entrega deja la foto en Documentos, sin entrega';
  end if;
  if (select received_qty is not null from import_items where id = '34300000-0000-0000-0000-0000000000c2') then
    raise exception 'sin entregas, el producto queda sin contar';
  end if;
end $$;

-- La compra entera sí se borra en cascada (las entregas y sus líneas también).
insert into import_deliveries (id, org_id, import_id, delivered_on) values
  ('34300000-0000-0000-0000-0000000000d9', '34300000-0000-0000-0000-0000000000a2', '34300000-0000-0000-0000-0000000000b9', '2026-11-11');
insert into import_delivery_lines (org_id, import_id, delivery_id, item_id, received) values
  ('34300000-0000-0000-0000-0000000000a2', '34300000-0000-0000-0000-0000000000b9', '34300000-0000-0000-0000-0000000000d9',
   '34300000-0000-0000-0000-0000000000c9', 1);
delete from imports where id = '34300000-0000-0000-0000-0000000000b9';
do $$
begin
  if exists (select 1 from import_deliveries where id = '34300000-0000-0000-0000-0000000000d9')
     or exists (select 1 from import_items where id = '34300000-0000-0000-0000-0000000000c9') then
    raise exception 'borrar la compra se lleva sus entregas y productos';
  end if;
end $$;

-- ── g) El backfill de la recepción de antes ─────────────────────────────────
-- Como lo dejaba el código anterior a la 0343: totales escritos directo.
insert into import_items (id, org_id, import_id, name, qty, unit_cost_usd, received_qty, damaged_qty, reception_note, received_at) values
  ('34300000-0000-0000-0000-0000000000c4', '34300000-0000-0000-0000-0000000000a1', '34300000-0000-0000-0000-0000000000b1',
   'Audífonos', 50, 12, 48, 1, 'una caja golpeada', '2026-11-09T20:00:00Z'),
  ('34300000-0000-0000-0000-0000000000c5', '34300000-0000-0000-0000-0000000000a1', '34300000-0000-0000-0000-0000000000b1',
   'Cable', 10, 1, null, null, null, null);
update imports set status = 'recibido', arrived_on = '2026-11-09' where id = '34300000-0000-0000-0000-0000000000b1';

\ir ../../db/migrations/0343_compras_locales_entregas.sql

do $$
declare
  v_delivery uuid;
begin
  select id into v_delivery from import_deliveries where import_id = '34300000-0000-0000-0000-0000000000b1' and legacy;
  if v_delivery is null
     or (select count(*) from import_deliveries where import_id = '34300000-0000-0000-0000-0000000000b1') <> 1
     or (select delivered_on <> '2026-11-09' from import_deliveries where id = v_delivery) then
    raise exception 'la recepción de antes pasa a UNA entrega legacy, con la fecha de llegada';
  end if;
  if (select received <> 48 or damaged <> 1 or note <> 'una caja golpeada'
        from import_delivery_lines where delivery_id = v_delivery and item_id = '34300000-0000-0000-0000-0000000000c4') then
    raise exception 'la línea legacy copia recibidas, dañadas y nota tal cual';
  end if;
  if exists (select 1 from import_delivery_lines where item_id = '34300000-0000-0000-0000-0000000000c5') then
    raise exception 'un producto sin contar no recibe línea';
  end if;
  if (select received_qty <> 48 or damaged_qty <> 1 or reception_note <> 'una caja golpeada'
        from import_items where id = '34300000-0000-0000-0000-0000000000c4')
     or (select received_qty is not null from import_items where id = '34300000-0000-0000-0000-0000000000c5') then
    raise exception 'el backfill no cambia los totales (ni los pone en cero)';
  end if;
  -- La compra local, sin recepción de antes, no recibe entrega legacy.
  if exists (select 1 from import_deliveries where import_id = '34300000-0000-0000-0000-0000000000b2' and legacy) then
    raise exception 'sin recepción de antes, no hay entrega legacy';
  end if;
end $$;

-- ── Dos veces es una ────────────────────────────────────────────────────────
\ir ../../db/migrations/0343_compras_locales_entregas.sql
do $$
begin
  if (select count(*) from import_deliveries where import_id = '34300000-0000-0000-0000-0000000000b1') <> 1
     or (select count(*) from import_delivery_lines where import_id = '34300000-0000-0000-0000-0000000000b1') <> 1
     or (select received_qty from import_items where id = '34300000-0000-0000-0000-0000000000c4') <> 48 then
    raise exception 'correr la 0343 otra vez cambió datos';
  end if;
  if (select count(*) from pg_constraint
       where conrelid = 'public.imports'::regclass and contype = 'c'
         and (pg_get_constraintdef(oid) like '%^IMP-%' or pg_get_constraintdef(oid) like '%en_camino_bodega%')) <> 2
     or (select count(*) from pg_constraint
          where conrelid = 'public.import_events'::regclass and contype = 'c'
            and pg_get_constraintdef(oid) like '%en_camino_bodega%') <> 1
     or (select count(*) from pg_constraint
          where conrelid = 'public.import_items'::regclass
            and conname in ('import_items_unit_cost_ck', 'import_items_unit_cost_currency_ck', 'import_items_unit_cost_pen_ck',
                            'import_items_courtesy_qty_ck')) <> 4
     or (select count(*) from pg_constraint
          where conrelid = 'public.import_documents'::regclass
            and conname in ('import_documents_delivery_fk', 'import_documents_delivery_photo_ck')) <> 2
     or (select count(*) from pg_constraint
          where conrelid = 'public.import_costs'::regclass
            and conname in ('import_costs_igv_treatment_ck', 'import_costs_igv_treatment_matches_ck')) <> 2 then
    raise exception 'correr la 0343 otra vez duplicó o perdió restricciones';
  end if;
  if (select count(*) from pg_trigger where tgrelid = 'public.import_delivery_lines'::regclass and tgname = 'import_delivery_lines_sync') <> 1 then
    raise exception 'el trigger de los totales, una sola vez';
  end if;
end $$;

-- ── i) El IGV de cada costo ─────────────────────────────────────────────────
insert into import_costs (id, org_id, import_id, kind, label, amount_usd, allocation) values
  ('34300000-0000-0000-0000-0000000000a5', '34300000-0000-0000-0000-0000000000a1', '34300000-0000-0000-0000-0000000000b1', 'envio', 'Flete', 120, 'weight');
insert into import_costs (id, org_id, import_id, kind, label, amount_usd, allocation, igv_treatment) values
  ('34300000-0000-0000-0000-0000000000a6', '34300000-0000-0000-0000-0000000000a1', '34300000-0000-0000-0000-0000000000b1', 'envio', 'Flete internacional', 300, 'weight', 'inafecto');
-- Como lo escribe el código anterior a la 0343: solo «Incluye IGV».
insert into import_costs (id, org_id, import_id, kind, label, currency, amount_pen, includes_igv, gross_amount, allocation) values
  ('34300000-0000-0000-0000-0000000000a7', '34300000-0000-0000-0000-0000000000a1', '34300000-0000-0000-0000-0000000000b1',
   'importacion', 'DHL Express Perú', 'PEN', 427.25, true, 504.16, 'value');
do $$
declare
  v_org uuid := '34300000-0000-0000-0000-0000000000a1';
  v_imp uuid := '34300000-0000-0000-0000-0000000000b1';
begin
  if (select igv_treatment from import_costs where id = '34300000-0000-0000-0000-0000000000a5') <> 'neto'
     or (select igv_treatment from import_costs where id = '34300000-0000-0000-0000-0000000000a6') <> 'inafecto'
     or (select igv_treatment from import_costs where id = '34300000-0000-0000-0000-0000000000a7') <> 'con_igv' then
    raise exception 'neto por defecto, inafecto tal cual y «Incluye IGV» del código anterior = con_igv';
  end if;
  begin
    insert into import_costs (org_id, import_id, kind, label, amount_usd, igv_treatment) values (v_org, v_imp, 'envio', 'X', 5, 'exonerado');
    raise exception 'el IGV es neto, con_igv o inafecto';
  exception when check_violation then null;
  end;
  begin
    insert into import_costs (org_id, import_id, kind, label, amount_usd, igv_treatment) values (v_org, v_imp, 'envio', 'X', 5, 'con_igv');
    raise exception 'con_igv lleva «Incluye IGV» y su monto con IGV';
  exception when check_violation then null;
  end;
  begin
    insert into import_costs (org_id, import_id, kind, label, amount_usd, includes_igv, gross_amount, igv_treatment)
    values (v_org, v_imp, 'envio', 'X', 5, true, 5.9, 'inafecto');
    raise exception 'inafecto no lleva «Incluye IGV»';
  exception when check_violation then null;
  end;
end $$;

-- ── h) Solo el servidor ─────────────────────────────────────────────────────
do $$
declare
  t text;
begin
  foreach t in array array['import_deliveries', 'import_delivery_lines', 'imports', 'import_items', 'import_documents'] loop
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
            and has_table_privilege('service_role', 'public.' || t, 'insert')
            and has_table_privilege('service_role', 'public.' || t, 'delete')) then
      raise exception '% es del service role', t;
    end if;
  end loop;
  if (select prosecdef from pg_proc where oid = 'public.import_delivery_lines_sync()'::regprocedure)
     or (select prosecdef from pg_proc where oid = 'public.import_costs_igv_treatment_fill()'::regprocedure) then
    raise exception 'los triggers de la 0343 no son security definer';
  end if;
end $$;

rollback;
