// LEX → Supabase mirror. Admin-only. Reads LEX entities and upserts them into
// the matching Supabase tables via PostgREST (service_role key, merge on id).
//
// Clean mappings (synced):
//   smart_nodes          ← SmartNode   (id, code, city, address, latitude, longitude)
//   wallet_transactions  ← WalletEvent (id, carrier_id, date, amount, kind, bundle_id)
//
// Skipped tables (reported, not written) — their Supabase schemas require fields
// LEX does not own (carrier contact details, pickup windows, service levels,
// dimensions, pickup codes). Add them on request with an agreed derivation.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.40";
import { resolveSupabase, upsertRows, projectInfo, nowIso } from "../../shared/lexSupabase.ts";

function slug(s) {
  return String(s || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "NODE";
}

function cityFromAddress(address, name) {
  const a = String(address || "").trim();
  if (!a) return String(name || "—");
  const parts = a.split(",").map((p) => p.trim()).filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 1] : parts[0];
}

function mapSmartNode(n) {
  return {
    id: n.id,
    code: slug(n.name) || n.id,
    city: cityFromAddress(n.address, n.name),
    address: n.address || "",
    latitude: Number(n.lat ?? 0),
    longitude: Number(n.lng ?? 0),
    created_at: n.created_date || nowIso(),
  };
}

function mapWalletEvent(e) {
  if (!e.carrier_id) return null; // carrier_id is NOT NULL in Supabase
  return {
    id: e.id,
    carrier_id: e.carrier_id,
    date: e.published_at || e.created_date || nowIso(),
    amount: Number(e.amount ?? 0),
    kind: e.event_type || "adjustment",
    bundle_id: e.related_entity_id || null,
    is_pending: false,
  };
}

const SKIPPED = [
  { table: "carriers", source: "CommunityCarrier", reason: "requires email, phone, emergency_contact_name, emergency_contact_phone — not stored in LEX" },
  { table: "trips", source: "CommunityCarrier", reason: "requires vehicle_identifier, seat, dimensions — not stored in LEX" },
  { table: "bundles", source: "SmartBundle", reason: "requires compensation, pickup windows, service_level, dimensions, distance_miles — not stored in LEX" },
  { table: "accepted_bundles", source: "SmartBundle", reason: "requires pickup_code and custody certification fields — not stored in LEX" },
];

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (user.role !== "admin") return Response.json({ error: "Forbidden" }, { status: 403 });

    const ctx = await resolveSupabase(base44);

    // SmartNode → smart_nodes
    const nodes = await base44.asServiceRole.entities.SmartNode.list("-created_date", 1000);
    const nodeRows = (nodes || []).map(mapSmartNode);
    const nodeResult = await upsertRows(ctx, "smart_nodes", nodeRows);

    // WalletEvent → wallet_transactions
    const events = await base44.asServiceRole.entities.WalletEvent.list("-created_date", 1000);
    const walletRows = (events || []).map(mapWalletEvent).filter(Boolean);
    const walletResult = await upsertRows(ctx, "wallet_transactions", walletRows);

    return Response.json({
      generated_at: nowIso(),
      project: projectInfo(ctx.project),
      synced: {
        smart_nodes: { source: "SmartNode", read: nodeRows.length, written: nodeResult.written, error: nodeResult.error },
        wallet_transactions: { source: "WalletEvent", read: events.length, skipped_no_carrier: events.length - walletRows.length, written: walletResult.written, error: walletResult.error },
      },
      skipped_tables: SKIPPED,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}