-- 0088_mom_macro_navigation.sql
-- Activa el MOM como navegación principal y clasifica una sola vez las filas
-- históricas que 0059 dejó con el valor inicial de modo sombra. Las fuentes
-- originales no cambian; los recálculos TypeScript posteriores siguen siendo
-- la resolución autoritativa y reemplazan esta inferencia conservadora.

with base as (
  select
    id,
    general_status,
    operational_status,
    shipping_mode,
    payment_state,
    pickup_state,
    dispatched_at,
    returned_at,
    status_since,
    order_created_at,
    updated_at,
    lower(coalesce(region, '')) as region_key,
    lower(coalesce(province, '')) as province_key
  from order_master
  where macro_since is null
), classified as (
  select
    base.*,
    case
      when shipping_mode = 'agency' then 'agencia'
      when region_key in ('lima', 'callao') or province_key in ('lima', 'callao') then 'lima'
      else 'provincia_cod'
    end as inferred_operation,
    case
      when general_status = 'entregado'
        and shipping_mode = 'agency'
        and payment_state = 'pago_completo' then 'finalizado'
      when general_status = 'entregado' then 'por_cerrar'
      when general_status = 'anulado' and dispatched_at is null then 'finalizado'
      when general_status in ('anulado', 'devuelto') then 'por_cerrar'
      when general_status = 'en_proceso' and operational_status = 'asignado_a_courier'
        and dispatched_at is null then 'preparacion'
      when general_status = 'en_proceso' then 'en_curso'
      when operational_status in ('preparado_sin_despachar', 'sin_asignar_courier', 'nunca_salio_a_reparto')
        then 'por_despachar'
      when operational_status in ('confirmado_sin_preparar', 'pendiente_de_envio', 'detenido_sin_informacion')
        then 'preparacion'
      when region_key in ('lima', 'callao') or province_key in ('lima', 'callao')
        then 'preparacion'
      else 'por_confirmar'
    end as inferred_stage
  from base
), resolved as (
  select
    classified.*,
    case inferred_stage
      when 'finalizado' then
        case
          when general_status = 'entregado' and inferred_operation = 'agencia' then 'recogido_cerrado'
          when general_status = 'entregado' then 'entregado_cerrado'
          when general_status = 'devuelto' then 'devuelto_cerrado'
          else 'anulado_cerrado'
        end
      when 'por_cerrar' then
        case
          when general_status = 'entregado' and inferred_operation = 'agencia'
            and payment_state is distinct from 'pago_completo' then 'recogido_sin_pago_completo'
          when general_status = 'entregado' then 'pendiente_liquidacion'
          when returned_at is not null then 'devolucion_pendiente_inventario'
          else 'devolucion_fisica_pendiente'
        end
      when 'en_curso' then
        case
          when operational_status in ('en_reparto', 'intento_de_entrega') then 'en_reparto'
          when operational_status in ('disponible_para_recojo', 'cliente_notificado', 'pendiente_de_recojo', 'proximo_a_vencer')
            and payment_state is distinct from 'pago_completo' then 'pendiente_pago_diferencia'
          when operational_status in ('disponible_para_recojo', 'cliente_notificado', 'pendiente_de_recojo', 'proximo_a_vencer')
            then 'disponible_para_recojo'
          when operational_status in ('pendiente_de_reprogramacion', 'reprogramado', 'pendiente_nuevo_courier', 'espera_respuesta_cliente')
            and inferred_operation = 'lima' then 'por_reprogramar_lima'
          when operational_status in ('pendiente_de_reprogramacion', 'reprogramado', 'pendiente_nuevo_courier', 'espera_respuesta_cliente')
            then 'gestion_reproprovincia'
          when operational_status in ('retorno_iniciado', 'en_proceso_de_retorno') then 'en_retorno'
          when operational_status in ('registrado_en_agencia') then 'en_destino'
          when operational_status in ('en_ruta', 'enviado_a_agencia', 'en_transito', 'en_traslado', 'despachado')
            then 'en_transito'
          else 'recibido_por_courier'
        end
      when 'por_despachar' then 'listo_para_asignar'
      when 'preparacion' then
        case
          when operational_status = 'detenido_sin_informacion' then 'incidencia_preparacion'
          when operational_status = 'asignado_a_courier' then 'por_armar'
          else 'por_generar_rotulo'
        end
      else 'sin_llamar'
    end as inferred_substage
  from classified
)
update order_master as target
set
  macro_stage = resolved.inferred_stage,
  macro_substage = resolved.inferred_substage,
  macro_reasons = case resolved.inferred_stage
    when 'por_cerrar' then array[resolved.inferred_substage]::text[]
    else '{}'::text[]
  end,
  macro_operation = resolved.inferred_operation,
  macro_version = 'mom-v1',
  macro_since = coalesce(resolved.status_since, resolved.order_created_at, resolved.updated_at, now())
from resolved
where target.id = resolved.id;

comment on column order_master.macro_stage is
  'Macroetapa MOM usada por la navegación principal del Master; general_status se conserva como compatibilidad.';
