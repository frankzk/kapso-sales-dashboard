-- ============================================================================
-- 0187_sheets_rider_rls.sql — un motorizado solo lee SU hoja de Liquidaciones 2.
--
-- La pantalla del motorizado (/reparto/cuaderno, MOM §30.9) muestra su
-- cuaderno del día: las filas de la hoja de Reparto propio cuyo
-- `config->>'rider_id'` es su ficha. Hasta ahora las políticas de 0176 dejaban
-- leer a cualquier miembro de la organización todas las hojas, y un
-- motorizado es miembro (rol `motorizado`, 0066). Vería las hojas de sus
-- compañeros, el Consolidado y las observaciones de todos.
--
-- Regla: si la ÚNICA membresía del usuario en la organización es
-- `motorizado`, solo lee las hojas con su `rider_id` y lo que cuelga de ellas
-- (columnas, filas, alias, observaciones, historial). Los demás roles siguen
-- igual. La escritura ya pasa por server actions con guardas propias; las
-- políticas de escritura de 0176 (owner/admin) no cambian.
-- ============================================================================

create or replace function public.auth_is_rider_only()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from memberships where user_id = auth.uid())
     and not exists (
       select 1 from memberships where user_id = auth.uid() and role <> 'motorizado'
     );
$$;
revoke all on function public.auth_is_rider_only() from public, anon;
grant execute on function public.auth_is_rider_only() to authenticated;

-- Hojas visibles: todas para miembros normales; solo la propia para el motorizado.
create or replace function public.auth_sheet_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select s.id from sheets s
   where s.org_id in (select auth_org_ids())
     and (
       not auth_is_rider_only()
       or s.config->>'rider_id' = auth_rider_id()::text
     );
$$;
revoke all on function public.auth_sheet_ids() from public, anon;
grant execute on function public.auth_sheet_ids() to authenticated;

drop policy if exists sheets_select on sheets;
create policy sheets_select on sheets for select to authenticated
  using (id in (select auth_sheet_ids()));

drop policy if exists sheet_columns_select on sheet_columns;
create policy sheet_columns_select on sheet_columns for select to authenticated
  using (sheet_id in (select auth_sheet_ids()));

drop policy if exists sheet_rows_select on sheet_rows;
create policy sheet_rows_select on sheet_rows for select to authenticated
  using (sheet_id in (select auth_sheet_ids()));

drop policy if exists sheet_status_aliases_select on sheet_status_aliases;
create policy sheet_status_aliases_select on sheet_status_aliases for select to authenticated
  using (sheet_id in (select auth_sheet_ids()));

drop policy if exists sheet_observations_select on sheet_observations;
create policy sheet_observations_select on sheet_observations for select to authenticated
  using (sheet_id in (select auth_sheet_ids()));

drop policy if exists sheet_cell_history_select on sheet_cell_history;
create policy sheet_cell_history_select on sheet_cell_history for select to authenticated
  using (row_id in (select id from sheet_rows where sheet_id in (select auth_sheet_ids())));

-- Los dominios y sus estados son vocabulario, no datos de nadie: el motorizado
-- los necesita para el datalist de su pantalla. Siguen legibles por org.
