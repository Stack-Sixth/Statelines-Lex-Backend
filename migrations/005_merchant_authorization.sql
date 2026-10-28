-- No legacy Shipment, reference, command or event is reassigned by this migration.
CREATE TABLE merchant.accounts (
  merchant_id text PRIMARY KEY CHECK (merchant_id ~ '^MER_[0-9a-f]{32}$'),
  external_reference text NOT NULL UNIQUE,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE merchant.service_clients (
  client_id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES merchant.accounts(merchant_id),
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX merchant_clients_merchant_idx ON merchant.service_clients(merchant_id);
CREATE TABLE merchant.client_subjects (
  client_id text NOT NULL REFERENCES merchant.service_clients(client_id),
  subject_id text NOT NULL,
  PRIMARY KEY (client_id, subject_id)
);
CREATE TABLE merchant.shipment_scopes (
  shipment_id uuid PRIMARY KEY REFERENCES lex.shipments(id),
  merchant_id text NOT NULL REFERENCES merchant.accounts(merchant_id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX merchant_shipment_scope_idx ON merchant.shipment_scopes(merchant_id, shipment_id);
-- Scoped order reconciliation also uses the existing unique (merchant_id, order_id) index.
ALTER TABLE merchant.accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE merchant.service_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE merchant.client_subjects ENABLE ROW LEVEL SECURITY;
ALTER TABLE merchant.shipment_scopes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA merchant FROM PUBLIC;
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA merchant FROM %I', r);
    END IF;
  END LOOP;
END $$;
