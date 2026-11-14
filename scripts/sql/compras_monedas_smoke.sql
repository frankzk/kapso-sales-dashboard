-- Compras: cada costo y cada pago en su moneda, e «Incluye IGV» (0342, MOM
-- §45.3). Sobre el clúster desechable, después de todas las migraciones. Lo que
-- fija:
--   a) Una fila como las de antes (solo `amount_usd`, sin moneda: lo que escribe
--      el código anterior a la 0342) sigue entrando y queda en USD.
--   b) Un costo y un pago en soles: `amount_pen` lleno, `amount_usd` nulo.
--   c) Los CHECK: moneda USD | PEN; exactamente un monto, el de su moneda;
--      montos > 0; «Incluye IGV» con el monto con IGV (≥ el que entra) y sin la
--      casilla, sin él.
--   d) La factura de DHL: S/ 504.16 con IGV → S/ 427.25 sin IGV se guarda.
--   e) Sigue siendo solo del servidor: sin privilegios para anon ni
--      authenticated.
--   f) Correrla dos veces es correrla una.
-- Todo dentro de una transacción que se deshace al final.

begin;
set local client_min_messages = warning;

insert into organizations (id, name) values ('34200000-0000-0000-0000-0000000000a1', 'Kapta (0342)');
insert into imports (id, org_id, code, fx_pen_per_usd)
values ('34200000-0000-0000-0000-0000000000b1', '34200000-0000-0000-0000-0000000000a1', 'IMP-2026-001', 3.75);

-- a) Como lo escribe el código de antes: sin moneda.
insert into import_costs (id, org_id, import_id, kind, label, amount_usd, allocation)
values ('34200000-0000-0000-0000-0000000000c1', '34200000-0000-0000-0000-0000000000a1', '34200000-0000-0000-0000-0000000000b1',
        'envio', 'Flete', 120, 'weight');
insert into import_payments (id, org_id, import_id, amount_usd, paid_on, method)
values ('34200000-0000-0000-0000-0000000000d1', '34200000-0000-0000-0000-0000000000a1', '34200000-0000-0000-0000-0000000000b1',
        500, '2026-11-02', 'transferencia');

-- b) y d) En soles, tal cual; la factura de DHL con «Incluye IGV».
insert into import_costs (id, org_id, import_id, kind, label, currency, amount_pen, allocation)
values ('34200000-0000-0000-0000-0000000000c2', '34200000-0000-0000-0000-0000000000a1', '34200000-0000-0000-0000-0000000000b1',
        'importacion', 'Aforo físico', 'PEN', 114.50, 'value');
insert into import_costs (id, org_id, import_id, kind, label, currency, amount_pen, includes_igv, gross_amount, allocation)
values ('34200000-0000-0000-0000-0000000000c3', '34200000-0000-0000-0000-0000000000a1', '34200000-0000-0000-0000-0000000000b1',
        'importacion', 'DHL Express Perú', 'PEN', 427.25, true, 504.16, 'value');
insert into import_payments (id, org_id, import_id, currency, amount_pen, paid_on, method)
values ('34200000-0000-0000-0000-0000000000d2', '34200000-0000-0000-0000-0000000000a1', '34200000-0000-0000-0000-0000000000b1',
        'PEN', 504.16, '2026-11-14', 'transferencia');

do $$
begin
  if (select currency <> 'USD' or amount_pen is not null or includes_igv or gross_amount is not null
        from import_costs where id = '34200000-0000-0000-0000-0000000000c1') then
    raise exception 'un costo sin moneda (el de antes) es USD, sin soles y sin IGV';
  end if;
  if (select currency <> 'USD' or amount_pen is not null from import_payments where id = '34200000-0000-0000-0000-0000000000d1') then
    raise exception 'un pago sin moneda (el de antes) es USD';
  end if;
  if (select amount_usd is not null or amount_pen <> 427.25 or gross_amount <> 504.16
        from import_costs where id = '34200000-0000-0000-0000-0000000000c3') then
    raise exception 'el costo en soles guarda S/ 427.25 sin IGV y S/ 504.16 con IGV, sin USD';
  end if;
  if not exists (select 1 from pg_attribute
                  where attrelid = 'public.import_costs'::regclass and attname = 'amount_usd' and not attnotnull) then
    raise exception 'amount_usd tiene que poder ser nulo (una fila en soles)';
  end if;
end $$;

-- ── c) Los CHECK ────────────────────────────────────────────────────────────
do $$
declare
  v_org uuid := '34200000-0000-0000-0000-0000000000a1';
  v_imp uuid := '34200000-0000-0000-0000-0000000000b1';
begin
  begin
    insert into import_costs (org_id, import_id, kind, label, currency, amount_usd) values (v_org, v_imp, 'envio', 'X', 'EUR', 5);
    raise exception 'la moneda es USD o PEN';
  exception when check_violation then null;
  end;
  begin
    insert into import_costs (org_id, import_id, kind, label, currency, amount_pen) values (v_org, v_imp, 'envio', 'X', 'USD', 5);
    raise exception 'un costo en USD lleva amount_usd, no amount_pen';
  exception when check_violation then null;
  end;
  begin
    insert into import_costs (org_id, import_id, kind, label, currency, amount_usd) values (v_org, v_imp, 'envio', 'X', 'PEN', 5);
    raise exception 'un costo en soles lleva amount_pen, no amount_usd';
  exception when check_violation then null;
  end;
  begin
    insert into import_costs (org_id, import_id, kind, label, currency, amount_usd, amount_pen) values (v_org, v_imp, 'envio', 'X', 'PEN', 5, 5);
    raise exception 'exactamente un monto, el de su moneda';
  exception when check_violation then null;
  end;
  begin
    insert into import_costs (org_id, import_id, kind, label) values (v_org, v_imp, 'envio', 'X');
    raise exception 'un costo sin ningún monto';
  exception when check_violation then null;
  end;
  begin
    insert into import_costs (org_id, import_id, kind, label, currency, amount_pen) values (v_org, v_imp, 'envio', 'X', 'PEN', 0);
    raise exception 'el monto en soles es mayor que 0';
  exception when check_violation then null;
  end;
  begin
    insert into import_costs (org_id, import_id, kind, label, currency, amount_pen, includes_igv) values (v_org, v_imp, 'envio', 'X', 'PEN', 10, true);
    raise exception 'con «Incluye IGV» se guarda el monto con IGV';
  exception when check_violation then null;
  end;
  begin
    insert into import_costs (org_id, import_id, kind, label, currency, amount_pen, gross_amount) values (v_org, v_imp, 'envio', 'X', 'PEN', 10, 11.80);
    raise exception 'sin «Incluye IGV» no hay monto con IGV';
  exception when check_violation then null;
  end;
  begin
    insert into import_costs (org_id, import_id, kind, label, currency, amount_pen, includes_igv, gross_amount)
    values (v_org, v_imp, 'envio', 'X', 'PEN', 10, true, 9);
    raise exception 'el monto con IGV no es menor que el que entra al costo';
  exception when check_violation then null;
  end;
  begin
    insert into import_payments (org_id, import_id, currency, amount_usd, paid_on, method) values (v_org, v_imp, 'PEN', 10, '2026-11-01', 'otro');
    raise exception 'un pago en soles lleva amount_pen';
  exception when check_violation then null;
  end;
  begin
    insert into import_payments (org_id, import_id, currency, amount_pen, paid_on, method) values (v_org, v_imp, 'CNY', 10, '2026-11-01', 'otro');
    raise exception 'la moneda de un pago es USD o PEN';
  exception when check_violation then null;
  end;
  begin
    insert into import_payments (org_id, import_id, paid_on, method) values (v_org, v_imp, '2026-11-01', 'otro');
    raise exception 'un pago sin monto';
  exception when check_violation then null;
  end;
  -- Un costo en USD con «Incluye IGV» también vale (factura peruana en dólares).
  insert into import_costs (org_id, import_id, kind, label, currency, amount_usd, includes_igv, gross_amount)
  values (v_org, v_imp, 'adicional', 'Almacén', 'USD', 84.75, true, 100);
end $$;

-- ── e) Solo el servidor ─────────────────────────────────────────────────────
do $$
declare
  t text;
begin
  foreach t in array array['import_costs', 'import_payments'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception '% tiene que tener RLS encendida', t;
    end if;
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t) then
      raise exception '% no lleva políticas: solo la lee el servidor', t;
    end if;
    if has_table_privilege('anon', 'public.' || t, 'select')
       or has_table_privilege('authenticated', 'public.' || t, 'select')
       or has_column_privilege('authenticated', 'public.' || t, 'amount_pen', 'select')
       or has_column_privilege('anon', 'public.' || t, 'currency', 'select') then
      raise exception '% no puede tener privilegios para anon ni authenticated', t;
    end if;
    if not (has_table_privilege('service_role', 'public.' || t, 'select')
            and has_table_privilege('service_role', 'public.' || t, 'insert')) then
      raise exception '% es del service role', t;
    end if;
  end loop;
end $$;

-- ── f) Dos veces es una ─────────────────────────────────────────────────────
\ir ../../db/migrations/0342_compras_monedas_igv.sql
do $$
begin
  if (select count(*) from import_costs where org_id = '34200000-0000-0000-0000-0000000000a1') <> 4
     or (select count(*) from import_payments where org_id = '34200000-0000-0000-0000-0000000000a1') <> 2
     or (select amount_pen from import_costs where id = '34200000-0000-0000-0000-0000000000c3') <> 427.25 then
    raise exception 'correr la 0342 otra vez cambió datos';
  end if;
  if (select count(*) from pg_constraint
       where conrelid = 'public.import_costs'::regclass
         and conname in ('import_costs_amount_currency_ck', 'import_costs_igv_gross_ck', 'import_costs_currency_ck',
                         'import_costs_amount_pen_pos', 'import_costs_gross_amount_pos')) <> 5
     or (select count(*) from pg_constraint
          where conrelid = 'public.import_payments'::regclass
            and conname in ('import_payments_amount_currency_ck', 'import_payments_currency_ck', 'import_payments_amount_pen_pos')) <> 3 then
    raise exception 'correr la 0342 otra vez duplicó o perdió restricciones';
  end if;
end $$;

rollback;
