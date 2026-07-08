-- ============================================================================
-- 0034_scope_label_tables.sql — stop leaking label tables across tenants.
-- `meta_ads` (0011) and `whatsapp_numbers` (0012) had a SELECT policy of
-- `using (true)`, so ANY authenticated user could read every tenant's Meta
-- campaign/ad names and WhatsApp business numbers. Low sensitivity (metadata,
-- no spend/tokens) but still a cross-tenant read.
--
-- The dashboard resolves these labels server-side (getAdNames/getWaNumbers) for
-- ids that already belong to the caller's own RLS-scoped leads, so we can drop
-- the public SELECT entirely: with RLS enabled and no permissive policy,
-- `authenticated` default-denies, while the service-role label lookup (and
-- ingestion) bypasses RLS. No cross-tenant leak, labels still resolve.
-- ============================================================================
drop policy if exists meta_ads_select on meta_ads;
drop policy if exists whatsapp_numbers_select on whatsapp_numbers;
