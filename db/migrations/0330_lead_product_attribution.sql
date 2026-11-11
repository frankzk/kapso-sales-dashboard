-- Customer evidence is separate from first-touch acquisition and funnel stage.
alter table public.leads add column if not exists entry_product jsonb;
alter table public.leads add column if not exists interest_product jsonb;
alter table public.leads add column if not exists product_attribution_checked_at timestamptz;
alter table public.leads add column if not exists product_conversation_checked_at timestamptz;
create index if not exists leads_product_backfill_idx on public.leads(store_id,id)
  where product_attribution_checked_at is null;
create index if not exists leads_product_conversation_idx on public.leads(store_id,product_conversation_checked_at)
  where category in ('open','hot') and kapso_conversation_id is not null;

create table if not exists public.lead_product_signals (
  lead_id uuid not null references public.leads(id) on delete cascade,
  fingerprint text not null,
  signal jsonb not null,
  recorded_at timestamptz not null default now(),
  primary key (lead_id,fingerprint)
);
alter table public.lead_product_signals enable row level security;
revoke all on public.lead_product_signals from anon,authenticated;
revoke all on public.lead_product_signals from service_role;
grant select,insert on public.lead_product_signals to service_role;

-- Invoker + explicit grants: ingestion only, never an authenticated browser RPC.
create or replace function public.record_lead_products(
  p_store_id uuid, p_conversation_id text, p_lead_id uuid,
  p_entry jsonb, p_signals jsonb
) returns void language plpgsql security invoker set search_path = '' as $$
declare
  l public.leads%rowtype;
  s jsonb;
  latest jsonb;
begin
  if (p_conversation_id is null) = (p_lead_id is null) then
    raise exception 'Provide one lead identity';
  end if;
  select * into l from public.leads where store_id = p_store_id
    and (case when p_lead_id is not null then id = p_lead_id
      else kapso_conversation_id = p_conversation_id end) for update;
  if not found then return; end if;
  latest := l.interest_product;
  for s in select value from jsonb_array_elements(coalesce(p_signals,'[]'::jsonb)) loop
    if s->>'source' not in ('customer_url','customer_text','ambiguous')
      or s->>'at' is null or s->>'evidence' is null then raise exception 'Invalid product evidence'; end if;
    insert into public.lead_product_signals(lead_id,fingerprint,signal)
      values(l.id,md5(s::text),s) on conflict do nothing;
    if latest is null or (s->>'at')::timestamptz > (latest->>'at')::timestamptz
      or ((s->>'at')::timestamptz = (latest->>'at')::timestamptz
        and coalesce(s->>'message_id','') > coalesce(latest->>'message_id','')) then latest := s; end if;
  end loop;
  if p_entry is not null then
    if p_entry->>'source' not in ('customer_url','customer_text','ambiguous')
      or p_entry->>'at' is null or p_entry->>'evidence' is null then raise exception 'Invalid entry product evidence'; end if;
    insert into public.lead_product_signals(lead_id,fingerprint,signal)
      values(l.id,md5(p_entry::text),p_entry) on conflict do nothing;
  end if;
  update public.leads set entry_product = coalesce(l.entry_product,p_entry),
    interest_product = latest,
    product_attribution_checked_at = now(),
    product_conversation_checked_at = case when p_conversation_id is not null then now() else l.product_conversation_checked_at end
    where id = l.id;
end $$;
revoke all on function public.record_lead_products(uuid,text,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.record_lead_products(uuid,text,uuid,jsonb,jsonb) to service_role;

create or replace function public.guard_lead_product_evidence()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if current_user not in ('postgres','service_role','supabase_admin') and
    (case when tg_op = 'INSERT' then new.entry_product is not null or new.interest_product is not null
      or new.product_attribution_checked_at is not null or new.product_conversation_checked_at is not null
     else new.entry_product is distinct from old.entry_product or new.interest_product is distinct from old.interest_product
      or new.product_attribution_checked_at is distinct from old.product_attribution_checked_at
      or new.product_conversation_checked_at is distinct from old.product_conversation_checked_at end) then
    raise exception 'Product evidence is ingestion-owned' using errcode='42501';
  end if;
  return new;
end $$;
drop trigger if exists guard_lead_product_evidence on public.leads;
create trigger guard_lead_product_evidence before insert or update on public.leads
  for each row execute function public.guard_lead_product_evidence();
