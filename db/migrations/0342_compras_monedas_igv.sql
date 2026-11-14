-- ============================================================================
-- 0342_compras_monedas_igv.sql — «Compras»: cada costo y cada pago en SU moneda
-- (USD o soles) y «Incluye IGV» en los costos (MOM §45.3, decisión del owner del
-- 14-11-2026).
--
-- POR QUÉ. Los cargos de nacionalización llegan en soles (la factura de DHL
-- Express Perú: gastos de nacionalización S/ 37.60, aforo físico S/ 114.50,
-- rectificación S/ 189.70, aranceles e impuestos pagados S/ 85.45 → S/ 427.25
-- sin IGV, IGV S/ 76.91, total S/ 504.16). Hasta la 0340 todo monto era USD:
-- había que convertirlo a mano al guardarlo y la ida y vuelta por el dólar
-- movía los centavos que después pasan a Costos en soles. Ahora cada costo y
-- cada pago se guarda tal como se escribió, en su moneda, y el cálculo convierte
-- con el tipo de cambio de la importación (`imports.fx_pen_per_usd`).
--
-- EL DISEÑO: `amount_usd` + `amount_pen`, uno por moneda. Se descartó agregar
-- un `amount` genérico al lado de `amount_usd`: habría dos columnas con el mismo
-- monto para cada fila en USD (que pueden desincronizarse) y un `amount_usd`
-- que dejaría de significar lo que dice. Así:
--   * `currency text not null default 'USD'` con CHECK USD | PEN. Las filas que
--     ya existen son todas USD: toman el default y quedan correctas, sin
--     backfill y sin tocar un solo monto.
--   * `amount_pen numeric(14, 2)`, nulo, > 0 si lo hay: el monto de una fila en
--     soles. `amount_usd` sigue siendo el monto de una fila en USD y conserva su
--     CHECK `> 0` de la 0340.
--   * `amount_usd` deja de ser NOT NULL: una fila en soles lo tiene nulo. Es el
--     único `drop` de la migración y va dentro del `alter table` (`drop not
--     null`, como la 0313): no borra datos ni columnas; la regla «siempre hay un
--     monto» pasa al CHECK `…_amount_currency_ck`, que es MÁS estricta: con
--     `currency = 'USD'`, `amount_usd` lleno y `amount_pen` nulo; con 'PEN', al
--     revés. Exactamente uno de los dos, y el de su moneda.
--   * El código anterior a esta migración sigue funcionando mientras sale el
--     nuevo: inserta `amount_usd` sin `currency` (→ 'USD') y el CHECK se cumple.
--
-- «INCLUYE IGV» (solo costos). `includes_igv boolean not null default false` y
-- `gross_amount numeric(14, 2)`: con la casilla marcada, `gross_amount` es el
-- monto CON IGV tal como se escribió y el de su moneda (`amount_usd` o
-- `amount_pen`) es lo que entra al costo, sin IGV: gross ÷ 1,18 a 2 decimales
-- (lib/compras.ts, `netOfIgv`; el 18 % es `IGV_RATE`). El CHECK
-- `…_igv_gross_ck` pide `gross_amount` con la casilla (y ≥ el monto sin IGV) y
-- nulo sin ella. La tasa no se fija en la base: el redondeo y la tasa son de la
-- aplicación, y el historial guarda los dos montos.
--
-- QUIÉN LEE Y ESCRIBE. Igual que en la 0340: solo el servidor (service_role),
-- después de comprobar «Montos de compras». Las tablas ya tienen RLS sin
-- políticas y sin privilegios para anon ni authenticated; las columnas nuevas
-- heredan eso. Se repite el revoke/grant para que quede escrito aquí.
--
-- No cambia datos existentes, no borra nada y correrla otra vez no cambia nada
-- (`if not exists`; las restricciones se agregan solo si faltan).
-- ============================================================================

-- ── Costos ─────────────────────────────────────────────────────────────────
alter table public.import_costs
  add column if not exists currency text not null default 'USD'
    constraint import_costs_currency_ck check (currency in ('USD', 'PEN'));

alter table public.import_costs
  add column if not exists amount_pen numeric(14, 2)
    constraint import_costs_amount_pen_pos check (amount_pen is null or amount_pen > 0);

alter table public.import_costs
  add column if not exists includes_igv boolean not null default false;

alter table public.import_costs
  add column if not exists gross_amount numeric(14, 2)
    constraint import_costs_gross_amount_pos check (gross_amount is null or gross_amount > 0);

-- Una fila en soles no tiene monto en USD (sigue el CHECK `amount_usd > 0`).
alter table public.import_costs alter column amount_usd drop not null;

do $costs$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'import_costs_amount_currency_ck' and conrelid = 'public.import_costs'::regclass
  ) then
    alter table public.import_costs add constraint import_costs_amount_currency_ck check (
      (currency = 'USD' and amount_usd is not null and amount_pen is null)
      or (currency = 'PEN' and amount_pen is not null and amount_usd is null));
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'import_costs_igv_gross_ck' and conrelid = 'public.import_costs'::regclass
  ) then
    alter table public.import_costs add constraint import_costs_igv_gross_ck check (
      (includes_igv and gross_amount is not null and gross_amount >= coalesce(amount_usd, amount_pen))
      or (not includes_igv and gross_amount is null));
  end if;
end
$costs$;

comment on column public.import_costs.currency is
  'Compras (MOM §45.3, 0342): la moneda del costo, USD o PEN, tal como se escribió. No se convierte al guardar.';
comment on column public.import_costs.amount_usd is
  'Compras (MOM §45.3): el monto de un costo en USD (sin IGV). Nulo si el costo es en soles.';
comment on column public.import_costs.amount_pen is
  'Compras (MOM §45.3, 0342): el monto de un costo en soles (sin IGV). Nulo si el costo es en USD.';
comment on column public.import_costs.includes_igv is
  'Compras (MOM §45.3, 0342): «Incluye IGV». El monto que entra al costo es gross_amount ÷ 1,18 (a 2 decimales).';
comment on column public.import_costs.gross_amount is
  'Compras (MOM §45.3, 0342): con «Incluye IGV», el monto CON IGV tal como se escribió, en la moneda del costo.';

-- ── Pagos ──────────────────────────────────────────────────────────────────
alter table public.import_payments
  add column if not exists currency text not null default 'USD'
    constraint import_payments_currency_ck check (currency in ('USD', 'PEN'));

alter table public.import_payments
  add column if not exists amount_pen numeric(14, 2)
    constraint import_payments_amount_pen_pos check (amount_pen is null or amount_pen > 0);

alter table public.import_payments alter column amount_usd drop not null;

do $payments$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'import_payments_amount_currency_ck' and conrelid = 'public.import_payments'::regclass
  ) then
    alter table public.import_payments add constraint import_payments_amount_currency_ck check (
      (currency = 'USD' and amount_usd is not null and amount_pen is null)
      or (currency = 'PEN' and amount_pen is not null and amount_usd is null));
  end if;
end
$payments$;

comment on column public.import_payments.currency is
  'Compras (MOM §45.3, 0342): la moneda del pago, USD o PEN, tal como se escribió.';
comment on column public.import_payments.amount_usd is
  'Compras (MOM §45.3): el monto de un pago en USD. Nulo si el pago es en soles.';
comment on column public.import_payments.amount_pen is
  'Compras (MOM §45.3, 0342): el monto de un pago en soles. Nulo si el pago es en USD.';

comment on table public.import_costs is
  'Compras (MOM §45): costos de una importación, cada uno en su moneda (USD o PEN, 0342) con su reparto e «Incluye IGV». Quitar el producto de un costo «a un producto» lo deja con item_id nulo: se reparte por valor, no desaparece. Solo service_role.';
comment on table public.import_payments is
  'Compras (MOM §45): pagos de una importación, cada uno en su moneda (USD o PEN, 0342). Solo service_role.';

-- ── Solo el servidor (como en la 0340) ─────────────────────────────────────
alter table public.import_costs    enable row level security;
alter table public.import_payments enable row level security;
revoke all on public.import_costs, public.import_payments from anon, authenticated;
grant all privileges on public.import_costs, public.import_payments to service_role;
