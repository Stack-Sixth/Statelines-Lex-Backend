CREATE SCHEMA IF NOT EXISTS lex;
CREATE TABLE lex.commands (
  id uuid PRIMARY KEY,
  actor_id text NOT NULL,
  fingerprint text NOT NULL,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE lex.carriers (
  id uuid PRIMARY KEY,
  user_id text NOT NULL UNIQUE,
  name text NOT NULL,
  origin text NOT NULL,
  destination text NOT NULL,
  service_levels text[] NOT NULL,
  package_sizes text[] NOT NULL,
  departure_at timestamptz NOT NULL,
  arrival_at timestamptz NOT NULL CHECK (arrival_at > departure_at),
  capacity_kg numeric(12,3) NOT NULL CHECK (capacity_kg > 0),
  reserved_kg numeric(12,3) NOT NULL DEFAULT 0 CHECK (reserved_kg >= 0 AND reserved_kg <= capacity_kg),
  total_deliveries integer NOT NULL DEFAULT 0 CHECK (total_deliveries >= 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE lex.shipments (
  id uuid PRIMARY KEY,
  tracking_id text NOT NULL UNIQUE,
  owner_user_id text NOT NULL,
  origin text NOT NULL,
  destination text NOT NULL CHECK (destination <> origin),
  weight_kg numeric(12,3) NOT NULL CHECK (weight_kg > 0),
  package_size text NOT NULL CHECK (package_size IN ('small','medium','large','xl')),
  service_level text NOT NULL CHECK (service_level IN ('standard','express','same_day','overnight')),
  pickup_deadline timestamptz NOT NULL,
  delivery_deadline timestamptz NOT NULL CHECK (delivery_deadline > pickup_deadline),
  status text NOT NULL DEFAULT 'created' CHECK (status IN ('created','matched','picked_up','in_transit','at_node','out_for_delivery','delivered','cancelled','exception','return_in_transit','returned')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  assigned_carrier_id uuid REFERENCES lex.carriers(id),
  capacity_reserved boolean NOT NULL DEFAULT false,
  CHECK (NOT capacity_reserved OR assigned_carrier_id IS NOT NULL),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE lex.shipment_history (
  id uuid PRIMARY KEY,
  shipment_id uuid NOT NULL REFERENCES lex.shipments(id),
  version integer NOT NULL,
  from_status text,
  to_status text NOT NULL,
  actor_id text NOT NULL,
  actor_role text NOT NULL,
  command_id uuid NOT NULL REFERENCES lex.commands(id),
  note text,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(shipment_id, version)
);
CREATE TABLE lex.outbox (
  id uuid PRIMARY KEY,
  event_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  aggregate_version integer NOT NULL,
  envelope jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz
);
CREATE INDEX outbox_pending_idx ON lex.outbox(created_at) WHERE dispatched_at IS NULL;
CREATE TABLE lex.destinations (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  client_id text NOT NULL,
  url text NOT NULL,
  secret_ref text NOT NULL,
  event_types text[] NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE lex.deliveries (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES lex.outbox(id),
  destination_id uuid NOT NULL REFERENCES lex.destinations(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','retrying','accepted','processed','dead_letter')),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL CHECK (max_attempts > 0),
  replay_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_until timestamptz,
  last_error text,
  accepted_at timestamptz,
  processed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(event_id, destination_id)
);
CREATE INDEX deliveries_due_idx ON lex.deliveries(next_attempt_at) WHERE status IN ('pending','retrying','running');
CREATE TABLE lex.delivery_attempts (
  id uuid PRIMARY KEY,
  delivery_id uuid NOT NULL REFERENCES lex.deliveries(id),
  attempt integer NOT NULL,
  replay_count integer NOT NULL,
  http_status integer,
  outcome text NOT NULL,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(delivery_id, replay_count, attempt)
);
CREATE TABLE lex.wallet_approvals (
  id uuid PRIMARY KEY,
  shipment_id uuid NOT NULL UNIQUE REFERENCES lex.shipments(id),
  carrier_id uuid NOT NULL REFERENCES lex.carriers(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  command_id uuid NOT NULL REFERENCES lex.commands(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE lex.audit_log (
  id uuid PRIMARY KEY,
  actor_id text NOT NULL,
  action text NOT NULL,
  entity_id text NOT NULL,
  command_id uuid NOT NULL REFERENCES lex.commands(id),
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE lex.worker_heartbeats (
  name text PRIMARY KEY,
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
-- Browser/Supabase Data API roles must never write engine-owned tables directly.
REVOKE ALL ON SCHEMA lex FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA lex FROM PUBLIC;
DO $$
DECLARE t record; r text;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'lex' LOOP
    EXECUTE format('ALTER TABLE lex.%I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA lex FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA lex FROM %I', r);
    END IF;
  END LOOP;
END $$;
