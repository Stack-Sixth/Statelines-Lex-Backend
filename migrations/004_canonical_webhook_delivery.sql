-- Additive: retain every existing legacy envelope and destination contract.
-- Old events have no canonical snapshot and are never reconstructed/replayed here.
ALTER TABLE lex.outbox ADD COLUMN canonical_envelope jsonb;
ALTER TABLE lex.destinations ADD COLUMN envelope_format text NOT NULL DEFAULT 'legacy_v1'
  CHECK (envelope_format IN ('legacy_v1', 'canonical_v1'));
