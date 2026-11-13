-- V2 resolves catalogue aliases. Positive first-touch facts remain immutable;
-- an ambiguous result can be clarified only with the SAME customer evidence.
create or replace function public.record_lead_products_v2(
  p_store_id uuid, p_conversation_id text, p_lead_id uuid, p_entry jsonb, p_signals jsonb
) returns void language plpgsql security invoker set search_path = '' as $$
declare l public.leads%rowtype; s jsonb;
begin
  perform public.record_lead_products(p_store_id,p_conversation_id,p_lead_id,p_entry,p_signals);
  select * into l from public.leads where store_id=p_store_id
    and (case when p_lead_id is not null then id=p_lead_id else kapso_conversation_id=p_conversation_id end) for update;
  if not found then return; end if;
  if l.entry_product->>'source'='ambiguous' and p_entry->>'handle' is not null
    and l.entry_product->>'evidence'=p_entry->>'evidence'
    and (l.entry_product->>'at')::timestamptz=(p_entry->>'at')::timestamptz then
    update public.leads set entry_product=p_entry where id=l.id;
  end if;
  for s in select value from jsonb_array_elements(coalesce(p_signals,'[]'::jsonb)) loop
    if l.interest_product->>'source'='ambiguous' and s->>'handle' is not null
      and l.interest_product->>'evidence'=s->>'evidence'
      and l.interest_product->>'message_id' is not distinct from s->>'message_id'
      and (l.interest_product->>'at')::timestamptz=(s->>'at')::timestamptz then
      update public.leads set interest_product=s where id=l.id;
    end if;
  end loop;
end $$;
revoke all on function public.record_lead_products_v2(uuid,text,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.record_lead_products_v2(uuid,text,uuid,jsonb,jsonb) to service_role;

-- Bounded batches avoid one HTTP round trip per historical lead. Each chunk is
-- atomic: a failed chunk cannot advance the application's resumable cursor.
create or replace function public.record_lead_product_openers_v2(p_store_id uuid,p_rows jsonb)
returns void language plpgsql security invoker set search_path = '' as $$
declare r jsonb;
begin
  if jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)>100 then raise exception 'Invalid product batch'; end if;
  for r in select value from jsonb_array_elements(p_rows) loop
    perform public.record_lead_products_v2(p_store_id,null,(r->>'id')::uuid,nullif(r->'entry','null'::jsonb),coalesce(r->'signals','[]'::jsonb));
  end loop;
end $$;
revoke all on function public.record_lead_product_openers_v2(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.record_lead_product_openers_v2(uuid,jsonb) to service_role;
