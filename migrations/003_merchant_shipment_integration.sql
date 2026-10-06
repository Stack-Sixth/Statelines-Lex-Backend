-- Merchant order identifiers remain external references; Shipment stays the
-- canonical logistics aggregate owned by the platform.
CREATE TABLE lex.merchant_shipment_refs (
  shipment_id uuid PRIMARY KEY REFERENCES lex.shipments(id),
  merchant_id text NOT NULL,
  order_id text NOT NULL,
  external_shipment_id text,
  correlation_id text NOT NULL,
  created_by text NOT NULL,
  command_id uuid NOT NULL UNIQUE REFERENCES lex.commands(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, order_id)
);

CREATE UNIQUE INDEX merchant_shipment_external_id_uq
  ON lex.merchant_shipment_refs(merchant_id, external_shipment_id)
  WHERE external_shipment_id IS NOT NULL;
CREATE INDEX merchant_shipment_refs_merchant_idx
  ON lex.merchant_shipment_refs(merchant_id, shipment_id);

-- Keep the mapping backend-owned, like the existing lex tables.
ALTER TABLE lex.merchant_shipment_refs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE lex.merchant_shipment_refs FROM PUBLIC;
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN
      EXECUTE format('REVOKE ALL ON TABLE lex.merchant_shipment_refs FROM %I', r);
    END IF;
  END LOOP;
END $$;
