-- ============================================================================
-- 0245_district_aliases_sin_de.sql — los distritos que se escriben sin el «de»
-- o pegados.
--
-- DECISIÓN DEL OWNER (12-10-2026, «Reprogramación en Lima»):
--
--   * «San Juan Lurigancho» es San Juan de Lurigancho, NUNCA Lurigancho-Chosica.
--     Sin el «de» no era un alias, y la búsqueda dentro del texto encontraba el
--     distrito oficial más corto con que terminaba el texto: «lurigancho».
--   * «Pachamamac» es Pachacámac.
--   * «Cercado delima» y «Cercado Lima» son Lima (Cercado).
--   * Por lo mismo: «San Juan Miraflores» y «San Martín Porres».
--
-- QUÉ CAMBIA: solo `lima_district_aliases()`, con la misma firma y la lista de
-- la 0081 íntegra más las filas nuevas. `lima_search_terms()` y
-- `resolve_lima_district()` la leen al ejecutarse; ningún índice ni vista
-- depende de ella. Es el mismo cambio que `DISTRICT_ALIASES` en
-- `lib/order-coverage.ts`: las dos listas dicen lo mismo (MOM §9, grafías).
--
-- Huaraz (#KP130975) no es alias de nada: es Áncash y se corrige en la ficha
-- con «Corregir ubicación».
--
-- Idempotente. Sin `begin`/`commit` propios, como el resto de migraciones.
-- ============================================================================

create or replace function lima_district_aliases()
returns table(term text, district text)
language sql
immutable
parallel safe
as $$
  values
    ('agustino', 'el agustino'),
    ('ate vitarte', 'ate'),
    ('cercado', 'lima'),
    ('cercado de lima', 'lima'),
    ('cercado d elima', 'lima'),
    ('cercado delima', 'lima'),
    ('cercado lima', 'lima'),
    ('carmen de la legua', 'carmen de la legua reynoso'),
    ('chosica', 'lurigancho'),
    ('colonial', 'lima'),
    ('el cercado', 'lima'),
    ('huachipa', 'lurigancho'),
    ('jesus', 'jesus maria'),
    ('la colonial', 'lima'),
    ('lima cercado', 'lima'),
    ('magdalena', 'magdalena del mar'),
    ('molina', 'la molina'),
    ('pachamamac', 'pachacamac'),
    ('pantanos de villa', 'chorrillos'),
    ('puente de piedra', 'puente piedra'),
    ('s j l', 'san juan de lurigancho'),
    ('s j m', 'san juan de miraflores'),
    ('s m p', 'san martin de porres'),
    ('san juan de lurigancho sjl', 'san juan de lurigancho'),
    ('san juan lurigancho', 'san juan de lurigancho'),
    ('san juan miraflores', 'san juan de miraflores'),
    ('san martin de porras', 'san martin de porres'),
    ('san martin porres', 'san martin de porres'),
    ('sanjuan de lurigancho', 'san juan de lurigancho'),
    ('sanjuan de miraflores', 'san juan de miraflores'),
    ('sanjuan lurigancho', 'san juan de lurigancho'),
    ('santa beatriz', 'lima'),
    ('santa maria de huachipa', 'lurigancho'),
    ('sjl', 'san juan de lurigancho'),
    ('sjm', 'san juan de miraflores'),
    ('smp', 'san martin de porres'),
    ('surco', 'santiago de surco'),
    ('surco viejo', 'santiago de surco'),
    ('ves', 'villa el salvador'),
    ('villa maria', 'villa maria del triunfo'),
    ('vitarte', 'ate'),
    ('vmt', 'villa maria del triunfo');
$$;

revoke all on function lima_district_aliases() from public, anon, authenticated;
grant execute on function lima_district_aliases() to service_role;
