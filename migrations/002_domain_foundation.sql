-- Fail on pre-existing target schemas so unrelated objects/grants cannot be claimed.
-- Additive namespace/identity foundation. No legacy table moves or data rewrites.
CREATE SCHEMA core;
CREATE SCHEMA merchant;
CREATE SCHEMA carrier;
CREATE SCHEMA pudo;
CREATE SCHEMA operations;
CREATE SCHEMA billing;
CREATE SCHEMA audit;
CREATE SCHEMA integration;

-- Views are projections, not a second source of shipment/event truth.
-- Full UUID encoding is injective and covers existing and future rows automatically.
CREATE VIEW core.shipment_identifiers AS
SELECT id, 'SHP_' || replace(id::text, '-', '') AS public_id, tracking_id
FROM lex.shipments;
CREATE VIEW carrier.carrier_identifiers AS
SELECT id, 'CAR_' || replace(id::text, '-', '') AS public_id
FROM lex.carriers;
CREATE VIEW integration.event_identifiers AS
SELECT id, 'EVT_' || replace(id::text, '-', '') AS public_id
FROM lex.outbox;

-- No client database access. Views are accessible only to the trusted backend owner.
DO $$
DECLARE s text; r text;
BEGIN
  FOREACH s IN ARRAY ARRAY['core','merchant','carrier','pudo','operations','billing','audit','integration'] LOOP
    EXECUTE format('REVOKE ALL ON SCHEMA %I FROM PUBLIC', s);
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM PUBLIC', s);
    FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
      IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN
        EXECUTE format('REVOKE ALL ON SCHEMA %I FROM %I', s, r);
        EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM %I', s, r);
      END IF;
    END LOOP;
  END LOOP;
END $$;
