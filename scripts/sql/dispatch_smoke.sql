\set ON_ERROR_STOP on

insert into organizations (id, name)
values ('60000000-0000-0000-0000-000000000001', 'MOM smoke');

insert into stores (id, org_id, name, shopify_domain)
values (
  '60000000-0000-0000-0000-000000000002',
  '60000000-0000-0000-0000-000000000001',
  'MOM store',
  'mom-smoke.myshopify.com'
);

insert into orders (id, store_id, shopify_order_id, name)
values (
  '60000000-0000-0000-0000-000000000003',
  '60000000-0000-0000-0000-000000000002',
  'mom-1',
  '#MOM1'
);

insert into shipments (
  id, store_id, courier, guide_code, order_id, order_name,
  preparation_state, custody_state
)
values (
  '60000000-0000-0000-0000-000000000004',
  '60000000-0000-0000-0000-000000000002',
  'axel',
  'MOM-GUIA-1',
  '60000000-0000-0000-0000-000000000003',
  '#MOM1',
  'listo_despacho',
  'empresa'
);

insert into dispatch_manifests (
  id, org_id, courier, route_date, route_label
)
values (
  '60000000-0000-0000-0000-000000000005',
  '60000000-0000-0000-0000-000000000001',
  'axel',
  current_date,
  'Ruta smoke'
);

insert into dispatch_manifest_items (
  id, manifest_id, shipment_id, store_id
)
values (
  '60000000-0000-0000-0000-000000000006',
  '60000000-0000-0000-0000-000000000005',
  '60000000-0000-0000-0000-000000000004',
  '60000000-0000-0000-0000-000000000002'
);

-- La ruta incompleta jamás puede transferir custodia.
do $$
begin
  begin
    perform public.finalize_dispatch_manifest(
      '60000000-0000-0000-0000-000000000005', null
    );
    raise exception 'finalize aceptó una ruta incompleta';
  exception when others then
    if sqlerrm = 'finalize aceptó una ruta incompleta' then raise; end if;
  end;
  if (select custody_state from shipments where id = '60000000-0000-0000-0000-000000000004') <> 'empresa' then
    raise exception 'la custodia cambió antes del doble cotejo';
  end if;
end;
$$;

update dispatch_manifest_items
   set office_checked_at = now(), pickup_checked_at = now()
 where id = '60000000-0000-0000-0000-000000000006';

select public.finalize_dispatch_manifest(
  '60000000-0000-0000-0000-000000000005', null
);

do $$
begin
  if (select state from dispatch_manifests where id = '60000000-0000-0000-0000-000000000005') <> 'in_custody' then
    raise exception 'la ruta completa no cerró en in_custody';
  end if;
  if (select custody_state from shipments where id = '60000000-0000-0000-0000-000000000004') <> 'courier' then
    raise exception 'el paquete completo no transfirió custodia';
  end if;
  if not exists (
    select 1 from order_events
     where shipment_id = '60000000-0000-0000-0000-000000000004'
       and kind = 'custody_transferred'
  ) then
    raise exception 'faltó el evento auditable de custodia';
  end if;
end;
$$;


-- ---------------------------------------------------------------------------
-- Entrega al courier: sin motorizado que coteje, cierra el nombre de quien recoge.
--
-- Antes estas rutas quedaban trabadas para siempre esperando un segundo cotejo
-- que nadie del otro lado iba a hacer, y la custodia no pasaba nunca.
-- ---------------------------------------------------------------------------

insert into shipments (
  id, store_id, courier, guide_code, order_id, order_name,
  preparation_state, custody_state
)
values (
  '60000000-0000-0000-0000-000000000007',
  '60000000-0000-0000-0000-000000000002',
  'aliclik',
  'MOM-GUIA-2',
  '60000000-0000-0000-0000-000000000003',
  '#MOM1',
  'listo_despacho',
  'empresa'
);

insert into dispatch_manifests (id, org_id, courier, kind, route_date, route_label)
values (
  '60000000-0000-0000-0000-000000000008',
  '60000000-0000-0000-0000-000000000001',
  'aliclik',
  'entrega_courier',
  current_date,
  'Recojo Aliclik'
);

insert into dispatch_manifest_items (id, manifest_id, shipment_id, store_id, office_checked_at)
values (
  '60000000-0000-0000-0000-000000000009',
  '60000000-0000-0000-0000-000000000008',
  '60000000-0000-0000-0000-000000000007',
  '60000000-0000-0000-0000-000000000002',
  now()
);

-- Con el cotejo de oficina completo pero SIN saber quién recoge, no cierra:
-- sin nombre no hay a quién reclamarle una caja que no llegó.
do $$
begin
  begin
    perform public.finalize_dispatch_manifest(
      '60000000-0000-0000-0000-000000000008', null
    );
    raise exception 'finalize cerró una entrega sin saber quién recoge';
  exception when others then
    if sqlerrm = 'finalize cerró una entrega sin saber quién recoge' then raise; end if;
  end;
  if (select custody_state from shipments where id = '60000000-0000-0000-0000-000000000007') <> 'empresa' then
    raise exception 'la custodia cambió sin registrar quién recogió';
  end if;
end;
$$;

update dispatch_manifests
   set received_by = 'Rosa Quispe · DNI 12345678'
 where id = '60000000-0000-0000-0000-000000000008';

select public.finalize_dispatch_manifest(
  '60000000-0000-0000-0000-000000000008', null
);

do $$
begin
  if (select custody_state from shipments where id = '60000000-0000-0000-0000-000000000007') <> 'courier' then
    raise exception 'la entrega al courier no transfirió custodia';
  end if;
  if not exists (
    select 1 from order_events
     where shipment_id = '60000000-0000-0000-0000-000000000007'
       and kind = 'custody_transferred'
       and payload->>'received_by' = 'Rosa Quispe · DNI 12345678'
  ) then
    raise exception 'el evento no guardó quién recogió';
  end if;
end;
$$;
