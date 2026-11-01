import { createClientFromRequest } from "npm:@base44/sdk@0.8.52";
import { secrets } from "base44:runtime";
import cancelOrderOnDomain from "../cancelOrderOnDomain/entry.ts";
import { recordAuthority, lifecycleWrite } from "../../shared/serverRecord.ts";
import { ClaimPending, claimResponse } from "../../shared/casBooking.ts";
import { loadVerifiedAuthority } from "../../shared/domainMerchant.ts";
import { callRender } from "../../shared/renderClient.ts";
export default async function (req: Request): Promise<Response> {
  try {
    const b = createClientFromRequest(req),
      user = await b.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const body = await req.json(),
      id = String(body.shipment_id || "");
    if (!id)
      return Response.json({ error: "shipment_id required" }, { status: 400 });
    const E = b.asServiceRole.entities.Shipment;
    let row = await E.get(id);
    const proof = recordAuthority(
        secrets.get("MERCHANT_RECORD_SIGNING_SECRET"),
      ),
      trusted = await proof.trusted("Shipment", row);
    if ((trusted ? row.server_owner_user_id : row.created_by_id) !== user.id)
      return Response.json({ error: "Not found" }, { status: 404 });
    if (!trusted) {
      // The cancellation handler performs read-only legacy reconciliation, not a blind mutation.
      const headers = new Headers(req.headers);
      headers.delete("content-length");
      return cancelOrderOnDomain(
        new Request(req.url, {
          method: "POST",
          headers,
          body: JSON.stringify({
            shipment_id: id,
            reason: "Customer requested archive",
          }),
        }),
      );
    }
    if (row.booking_intent && row.booking_ready !== true)
      throw new ClaimPending("local_finalization_pending");
    if (row.archived_at)
      return Response.json({ archived: true, shipment_id: id });
    let terminal = false,
      terminalEvidence: any = null;
    if (row.canonical_shipment_id) {
      const a = await loadVerifiedAuthority(b.asServiceRole, user);
      if (!a.ready || !a.identity || !a.local.ok)
        throw new ClaimPending("archive_authority_unverified");
      const r = await callRender<any>({
        method: "GET",
        path:
          "/api/v1/shipments/" + encodeURIComponent(row.canonical_shipment_id),
        credential: a.local.credentials,
      });
      const s = r.ok ? r.data?.shipment : null;
      if (
        !s ||
        !Number.isInteger(s.version) ||
        s.version < 1 ||
        s.shipment_id !== row.canonical_shipment_id ||
        s.merchant_id !== a.identity.domain_merchant_id ||
        s.order_id !== row.order_id ||
        (row.booking_command_claim?.payload?.sandbox_isolated === true &&
          s.sandbox_isolated !== true)
      )
        throw new ClaimPending("archive_canonical_evidence_missing");
      terminal = ["cancelled", "delivered"].includes(s.status);
      if (terminal)
        terminalEvidence = {
          status: s.status,
          domain_status: s.status,
          version: s.version,
        };
    }
    if (!terminal) {
      const headers = new Headers(req.headers);
      headers.delete("content-length");
      const result = await cancelOrderOnDomain(
        new Request(req.url, {
          method: "POST",
          headers,
          body: JSON.stringify({
            shipment_id: id,
            reason: "Customer requested archive",
          }),
        }),
      );
      const evidence = await result.clone().json();
      if (!result.ok || evidence.cancelled !== true) return result;
      row = await E.get(id);
    }
    const done = await lifecycleWrite(
      E,
      id,
      user.id,
      "shipment.archived",
      { ...(terminalEvidence || {}), archived_at: new Date().toISOString() },
      {
        archived_at: Object.hasOwn(row, "archived_at")
          ? row.archived_at
          : { $exists: false },
      },
    );
    if (!done) throw new ClaimPending("archive_settlement_pending");
    return Response.json({
      archived: true,
      shipment_id: id,
      canonical_shipment_id: row.canonical_shipment_id || null,
    });
  } catch (e) {
    const pending = claimResponse(e);
    if (pending) return pending;
    return Response.json(
      { error: "Archive failed; shipment retained" },
      { status: 409 },
    );
  }
}
