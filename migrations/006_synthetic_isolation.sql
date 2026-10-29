-- Existing production rows keep their normal processing. Only admin-provisioned,
-- server-allowlisted synthetic accounts produce permanently isolated shipments.
ALTER TABLE merchant.accounts ADD COLUMN sandbox_isolated boolean NOT NULL DEFAULT false;
ALTER TABLE lex.shipments ADD COLUMN sandbox_isolated boolean NOT NULL DEFAULT false;
ALTER TABLE lex.outbox ADD COLUMN sandbox_isolated boolean NOT NULL DEFAULT false;
