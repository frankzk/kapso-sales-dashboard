-- Guardar el PRIMER mensaje que escribió el cliente (texto o caption), para que
-- la asesora tenga un anzuelo concreto con el que abrir la conversación en vez
-- de un "hola" en blanco. Es un extracto corto (no un transcript): la fuente de
-- verdad de la conversación sigue siendo Kapso.

alter table leads add column if not exists first_inbound_text text;

comment on column leads.first_inbound_text is
  'First inbound message the customer sent (text or media caption), trimmed. Opener context for the advisor.';
