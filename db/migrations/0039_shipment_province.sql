-- Preserve the administrative PROVINCIA from Aliclik independently from
-- shipments.city, which is a normalized key used only for Fenix coverage.

alter table shipments add column if not exists province text;

-- Recover the exact province for historical Aliclik guides from the latest
-- imported source row. Older parsed payloads did not include this field, so
-- the raw Excel object is used as the fallback.
with extracted_source as (
  select
    ir.shipment_id,
    coalesce(
      nullif(btrim(ir.parsed ->> 'province'), ''),
      (
        select nullif(btrim(entry.value), '')
        from jsonb_each_text(ir.raw) as entry(key, value)
        where lower(btrim(entry.key)) = 'provincia'
        limit 1
      )
    ) as province,
    ir.created_at,
    ir.id
  from import_rows ir
  where ir.shipment_id is not null
),
ranked_source as (
  select
    shipment_id,
    province,
    row_number() over (
      partition by shipment_id
      order by created_at desc, id desc
    ) as source_rank
  from extracted_source
  where province is not null
)
update shipments shipment
set province = source.province
from ranked_source source
where source.shipment_id = shipment.id
  and source.source_rank = 1
  and source.province is not null
  and nullif(btrim(shipment.province), '') is null;

-- Fenix children inherit the source guide's administrative province.
update shipments child
set province = parent.province
from shipments parent
where parent.fenix_shipment_id = child.id
  and nullif(btrim(child.province), '') is null
  and nullif(btrim(parent.province), '') is not null;

-- Last-resort compatibility for rows whose original report had no province:
-- show the department/region, never the Fenix city (which may be a district).
update shipments
set province = region
where nullif(btrim(province), '') is null
  and nullif(btrim(region), '') is not null;

comment on column shipments.province is
  'Administrative province imported from Aliclik; independent from the normalized Fenix coverage city.';
