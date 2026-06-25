-- ============================================================================
-- seed_whatsapp_numbers.sql — friendly labels for the connected WhatsApp numbers
-- Resolved from Kapso (whatsapp_numbers list) on 2026-06-25. Re-runnable.
-- To refresh / add numbers: query Kapso for the phone_number_id, display name,
-- display phone and whether it's coexistence (Business app) or Cloud API.
-- ============================================================================
insert into whatsapp_numbers (phone_number_id, name, display_phone, kind) values
  ('1241790819006805', 'Aurela',                 '+51 917 173 327', 'api'),
  ('1022274334303691', 'Aurela Kenku Consultas', '+51 902 004 410', 'business'),
  ('597907523413541',  'Sandbox WhatsApp',        null,             'sandbox')
on conflict (phone_number_id) do update set
  name          = excluded.name,
  display_phone = excluded.display_phone,
  kind          = excluded.kind,
  fetched_at    = now();
