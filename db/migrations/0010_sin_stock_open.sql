-- ============================================================================
-- 0010_sin_stock_open.sql — "Sin stock" becomes recoverable (stays in the queue)
-- The disposition no longer marks a lead as lost: it returns to "Por llamar" so
-- the team can re-contact when stock is back (filterable under Gestión → 📦 Sin
-- stock, and no longer counted as a loss). Move existing rows accordingly.
-- ============================================================================
update leads set category = 'open' where status = 'sin_stock' and category <> 'open';
