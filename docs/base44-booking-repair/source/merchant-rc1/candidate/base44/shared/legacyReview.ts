// Untrusted legacy row fields are lookup hints, NEVER authority to adopt or cancel.
import { reconcileCanonicalShipment } from "./domainIds.ts";
export async function legacyReview(
  ship: any,
  identity: any,
  credential: any,
  callRender: any,
) {
  const hint = typeof ship.order_id === "string" ? ship.order_id : "";
  let outcome: any = { ok: false, reason: "no_trusted_lookup_key" };
  if (hint)
    outcome = await reconcileCanonicalShipment(callRender, {
      merchant_id: identity.domain_merchant_id,
      order_id: hint,
      credential,
    });
  return Response.json(
    {
      pending: true,
      code: "legacy_identity_review_required",
      shipment_id: ship.id,
      reconciliation: outcome.ok
        ? "candidate_found_not_adopted"
        : outcome.reason || "read_error",
      detail:
        "No command or canonical linkage changed. Browser-era identifiers require operator verification against protected records/audit.",
    },
    { status: 202 },
  );
}
