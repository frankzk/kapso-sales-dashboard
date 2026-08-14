-- apply.sql — esquema completo + RLS, en orden, en un solo comando (generado).
--   psql "$DATABASE_URL" -f db/apply.sql
-- (las rutas de \ir son relativas a este archivo)
--
-- NO EDITAR A MANO: lo regenera `node scripts/gen-apply.mjs`.
\echo 'Applying 0001_init.sql'
\ir migrations/0001_init.sql
\echo 'Applying 0002_rollups.sql'
\ir migrations/0002_rollups.sql
\echo 'Applying 0003_refunds.sql'
\ir migrations/0003_refunds.sql
\echo 'Applying policies.sql'
\ir ../supabase/policies.sql
\echo 'Applying 0004_leads.sql'
\ir migrations/0004_leads.sql
\echo 'Applying 0005_message_timing.sql'
\ir migrations/0005_message_timing.sql
\echo 'Applying 0006_kapso_only_orders.sql'
\ir migrations/0006_kapso_only_orders.sql
\echo 'Applying 0007_lead_signals.sql'
\ir migrations/0007_lead_signals.sql
\echo 'Applying 0008_lead_source.sql'
\ir migrations/0008_lead_source.sql
\echo 'Applying 0009_lead_inbound.sql'
\ir migrations/0009_lead_inbound.sql
\echo 'Applying 0010_sin_stock_open.sql'
\ir migrations/0010_sin_stock_open.sql
\echo 'Applying 0011_meta_ads.sql'
\ir migrations/0011_meta_ads.sql
\echo 'Applying 0012_lead_wa_number.sql'
\ir migrations/0012_lead_wa_number.sql
\echo 'Applying 0013_draft_orders.sql'
\ir migrations/0013_draft_orders.sql
\echo 'Applying 0014_flow_webhook_secret.sql'
\ir migrations/0014_flow_webhook_secret.sql
\echo 'Applying 0015_browse_template_config.sql'
\ir migrations/0015_browse_template_config.sql
\echo 'Applying 0016_quick_replies.sql'
\ir migrations/0016_quick_replies.sql
\echo 'Applying 0017_telegram_summary.sql'
\ir migrations/0017_telegram_summary.sql
\echo 'Applying 0018_meta_marketing.sql'
\ir migrations/0018_meta_marketing.sql
\echo 'Applying 0019_meta_multi_account.sql'
\ir migrations/0019_meta_multi_account.sql
\echo 'Applying 0020_yape_routing.sql'
\ir migrations/0020_yape_routing.sql
\echo 'Applying 0021_yape_alert_sent.sql'
\ir migrations/0021_yape_alert_sent.sql
\echo 'Applying 0022_shipments.sql'
\ir migrations/0022_shipments.sql
\echo 'Applying 0023_shipment_calls.sql'
\ir migrations/0023_shipment_calls.sql
\echo 'Applying 0024_import_batches.sql'
\ir migrations/0024_import_batches.sql
\echo 'Applying 0025_fenix_stock.sql'
\ir migrations/0025_fenix_stock.sql
\echo 'Applying 0026_shipment_states_v2.sql'
\ir migrations/0026_shipment_states_v2.sql
\echo 'Applying 0027_shipment_suggestions.sql'
\ir migrations/0027_shipment_suggestions.sql
\echo 'Applying 0028_shipment_transferido.sql'
\ir migrations/0028_shipment_transferido.sql
\echo 'Applying 0029_winback_template_config.sql'
\ir migrations/0029_winback_template_config.sql
\echo 'Applying 0030_attribution.sql'
\ir migrations/0030_attribution.sql
\echo 'Applying 0031_yape_vision_checks.sql'
\ir migrations/0031_yape_vision_checks.sql
\echo 'Applying 0032_lead_ship_address.sql'
\ir migrations/0032_lead_ship_address.sql
\echo 'Applying 0033_kapso_webhook_secret.sql'
\ir migrations/0033_kapso_webhook_secret.sql
\echo 'Applying 0034_scope_label_tables.sql'
\ir migrations/0034_scope_label_tables.sql
\echo 'Applying 0035_seguimiento_drip.sql'
\ir migrations/0035_seguimiento_drip.sql
\echo 'Applying 0036_attention_waves.sql'
\ir migrations/0036_attention_waves.sql
\echo 'Applying 0037_whatsapp_outbox.sql'
\ir migrations/0037_whatsapp_outbox.sql
\echo 'Applying 0038_aliclik_reprogramming.sql'
\ir migrations/0038_aliclik_reprogramming.sql
\echo 'Applying 0039_shipment_province.sql'
\ir migrations/0039_shipment_province.sql
\echo 'Applying 0040_cart_sequence.sql'
\ir migrations/0040_cart_sequence.sql
\echo 'Applying 0041_fenix_stock_movements.sql'
\ir migrations/0041_fenix_stock_movements.sql
\echo 'Applying 0042_shipment_call_note_edit.sql'
\ir migrations/0042_shipment_call_note_edit.sql
\echo 'Applying 0043_fenix_direct_guides.sql'
\ir migrations/0043_fenix_direct_guides.sql
\echo 'Applying 0044_lead_first_inbound_text.sql'
\ir migrations/0044_lead_first_inbound_text.sql
\echo 'Applying 0045_order_master.sql'
\ir migrations/0045_order_master.sql
\echo 'Applying 0046_geo_peru.sql'
\ir migrations/0046_geo_peru.sql
\echo 'Applying 0047_shipment_gestion.sql'
\ir migrations/0047_shipment_gestion.sql
\echo 'Applying 0048_courier_reports.sql'
\ir migrations/0048_courier_reports.sql
\echo 'Applying 0049_yape_payments.sql'
\ir migrations/0049_yape_payments.sql
\echo 'Applying 0050_costs.sql'
\ir migrations/0050_costs.sql
\echo 'Applying 0051_order_geo.sql'
\ir migrations/0051_order_geo.sql
\echo 'Applying 0052_store_anthropic_key.sql'
\ir migrations/0052_store_anthropic_key.sql
\echo 'Applying 0053_revoke_default_grants.sql'
\ir migrations/0053_revoke_default_grants.sql
\echo 'Applying 0054_aliclik_api.sql'
\ir migrations/0054_aliclik_api.sql
\echo 'Applying 0055_aliclik_catalog.sql'
\ir migrations/0055_aliclik_catalog.sql
\echo 'Applying 0056_aliclik_order_requests.sql'
\ir migrations/0056_aliclik_order_requests.sql
\echo 'Applying 0057_aliclik_webhook_events.sql'
\ir migrations/0057_aliclik_webhook_events.sql
\echo 'Applying 0058_tanders.sql'
\ir migrations/0058_tanders.sql
\echo 'Applying 0059_lead_queue_counts.sql'
\ir migrations/0059_lead_queue_counts.sql
\echo 'Applying 0060_aliclik_collect_amount.sql'
\ir migrations/0060_aliclik_collect_amount.sql
\echo 'Applying 0061_shalom_api.sql'
\ir migrations/0061_shalom_api.sql
\echo 'Applying 0062_tanders_tracking.sql'
\ir migrations/0062_tanders_tracking.sql
\echo 'Applying 0063_tanders_label.sql'
\ir migrations/0063_tanders_label.sql
\echo 'Applying 0064_rider_settlements.sql'
\ir migrations/0064_rider_settlements.sql
\echo 'Applying 0065_settlement_fees.sql'
\ir migrations/0065_settlement_fees.sql
\echo 'Applying 0066_delivery_routes.sql'
\ir migrations/0066_delivery_routes.sql
\echo 'Applying 0067_routes_multistore.sql'
\ir migrations/0067_routes_multistore.sql
\echo 'Applying 0068_direct_collected.sql'
\ir migrations/0068_direct_collected.sql
\echo 'Applying 0069_master_search_trigram.sql'
\ir migrations/0069_master_search_trigram.sql
\echo 'Applying 0070_cost_tariffs_source.sql'
\ir migrations/0070_cost_tariffs_source.sql
\echo 'Applying 0071_meta_ad_product_mapping.sql'
\ir migrations/0071_meta_ad_product_mapping.sql
\echo 'Applying 0072_aliclik_tariffs_from_reports.sql'
\ir migrations/0072_aliclik_tariffs_from_reports.sql
\echo 'Applying 0073_shalom_order_draft.sql'
\ir migrations/0073_shalom_order_draft.sql
\echo 'Applying 0074_meta_ad_insights_daily.sql'
\ir migrations/0074_meta_ad_insights_daily.sql
\echo 'Applying 0075_meta_ad_performance.sql'
\ir migrations/0075_meta_ad_performance.sql
\echo 'Applying 0076_payment_total.sql'
\ir migrations/0076_payment_total.sql
\echo 'Applying 0077_settlement_row_matching.sql'
\ir migrations/0077_settlement_row_matching.sql
\echo 'Applying 0078_order_coverage.sql'
\ir migrations/0078_order_coverage.sql
\echo 'Applying 0079_coverage_region_first.sql'
\ir migrations/0079_coverage_region_first.sql
\echo 'Applying 0080_swayp_guides.sql'
\ir migrations/0080_swayp_guides.sql
\echo 'Applying 0081_coverage_district_aliases.sql'
\ir migrations/0081_coverage_district_aliases.sql
\echo 'Applying 0082_meta_campaign_data_quality.sql'
\ir migrations/0082_meta_campaign_data_quality.sql
\echo 'Applying 0083_coverage_owned_by_db.sql'
\ir migrations/0083_coverage_owned_by_db.sql
\echo 'Applying 0084_tanders_payment_check.sql'
\ir migrations/0084_tanders_payment_check.sql
\echo 'Applying 0085_ayacucho_huamanga_tariff_alias.sql'
\ir migrations/0085_ayacucho_huamanga_tariff_alias.sql
\echo 'Applying 0086_mom_phase1.sql'
\ir migrations/0086_mom_phase1.sql
\echo 'Applying 0087_mom_phase2_dispatch.sql'
\ir migrations/0087_mom_phase2_dispatch.sql
\echo 'Applying 0088_mom_macro_navigation.sql'
\ir migrations/0088_mom_macro_navigation.sql
\echo 'Applying 0089_order_master_mom_counts.sql'
\ir migrations/0089_order_master_mom_counts.sql
\echo 'Applying 0090_mom_phase3_routing.sql'
\ir migrations/0090_mom_phase3_routing.sql
\echo 'Applying 0091_canete_agency_coverage.sql'
\ir migrations/0091_canete_agency_coverage.sql
\echo 'Applying 0092_multiple_payment_differences.sql'
\ir migrations/0092_multiple_payment_differences.sql
\echo 'Applying 0093_settlement_line_corrections.sql'
\ir migrations/0093_settlement_line_corrections.sql
\echo 'Applying 0094_org_shopify_products.sql'
\ir migrations/0094_org_shopify_products.sql
\echo 'Applying 0095_dispatch_manifest_rider.sql'
\ir migrations/0095_dispatch_manifest_rider.sql
\echo 'Applying 0096_dispatch_route_kind.sql'
\ir migrations/0096_dispatch_route_kind.sql
\echo 'Applying 0097_dispatch_one_route_per_day.sql'
\ir migrations/0097_dispatch_one_route_per_day.sql
\echo 'Applying 0098_orders_shopify_note.sql'
\ir migrations/0098_orders_shopify_note.sql
\echo 'Applying 0099_merge_payment_required_substage.sql'
\ir migrations/0099_merge_payment_required_substage.sql
\echo 'Applying 0100_coverage_by_coordinates.sql'
\ir migrations/0100_coverage_by_coordinates.sql
\echo 'Applying 0101_order_master_phone_history.sql'
\ir migrations/0101_order_master_phone_history.sql
\echo 'Applying 0102_aliclik_health.sql'
\ir migrations/0102_aliclik_health.sql
\echo 'Applying 0103_leads_bsuid_identity.sql'
\ir migrations/0103_leads_bsuid_identity.sql
\echo 'Applying 0104_chatby_webhook_log.sql'
\ir migrations/0104_chatby_webhook_log.sql
\echo 'Applying 0105_leads_identity_sin_telefono.sql'
\ir migrations/0105_leads_identity_sin_telefono.sql
\echo 'Applying 0106_order_coverage_batch.sql'
\ir migrations/0106_order_coverage_batch.sql
\echo 'Applying 0107_ingest_anomalies.sql'
\ir migrations/0107_ingest_anomalies.sql
\echo 'Applying 0108_shalom_created_via.sql'
\ir migrations/0108_shalom_created_via.sql
\echo 'Applying 0109_aliclik_returned_backfill.sql'
\ir migrations/0109_aliclik_returned_backfill.sql
\echo 'Applying 0110_backfill_aliclik_report_status.sql'
\ir migrations/0110_backfill_aliclik_report_status.sql
\echo 'Applying 0111_api_owns_delivery_status.sql'
\ir migrations/0111_api_owns_delivery_status.sql
\echo 'Applying 0112_return_recovery.sql'
\ir migrations/0112_return_recovery.sql
\echo 'Applying 0113_wa_reply_templates.sql'
\ir migrations/0113_wa_reply_templates.sql
\echo 'Applying 0114_return_recovery_phone.sql'
\ir migrations/0114_return_recovery_phone.sql
\echo 'Applying 0115_order_prefix_por_tienda.sql'
\ir migrations/0115_order_prefix_por_tienda.sql
\echo 'Applying 0116_aliclik_sweep_state.sql'
\ir migrations/0116_aliclik_sweep_state.sql
\echo 'Done.'
