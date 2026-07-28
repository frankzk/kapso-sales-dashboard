-- Permitir editar la nota de una gestión del historial dejando traza mínima de
-- que fue modificada (quién y cuándo). No se toca el estado, la fecha ni el
-- tipo de gestión: solo el texto libre de la nota.

alter table shipment_calls add column if not exists note_edited_at timestamptz;
alter table shipment_calls add column if not exists note_edited_by uuid references auth.users(id) on delete set null;

comment on column shipment_calls.note_edited_at is
  'When the free-text note was last edited (null = original, never edited).';
comment on column shipment_calls.note_edited_by is
  'User who last edited the note.';
