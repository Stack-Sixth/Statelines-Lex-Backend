import { secrets } from "base44:runtime";
import { recordAuthority } from "../../shared/serverRecord.ts";
// Merchant cancellation PREFLIGHT (advisory, read-only).
//
// Asks the Statelines Domain Platform whether this shipment is still cancellable
// before the app cancels it. It never cancels anything itself — the mutation is
// cancelOrderOnDomain, which repeats every check here server-side.
//
// Rules:
//   • The domain call uses the AUTHENTICATED MERCHANT'S own verified dedicated
//     credential. The platform/admin service client is never substituted, so a
//     cancellation can never speak for another tenant.
//   • The path identifier is the canonical shipment identity (SHP_…), never
//     Render's internal row id (`render_id`, a UUID).
//   • The release gate must be open: an unverified merchant cannot send domain
//     commands, cancellation included.
//   • A local-only shipment (never reached the domain) may be cancelled locally;
//     there is nothing on the domain to ask about.

import { createClientFromRequest } from "npm:@base44/sdk@0.8.52";
import { callRender } from "../../shared/renderClient.ts";
import { loadVerifiedAuthority } from "../../shared/domainMerchant.ts";
import {
  evaluateCancellationPreflight,
  identityDriftFields,
  resolveCancellationPlan,
  type CancelPlan,
  type ReconcileOutcomeLike,
} from "../../shared/authorityRules.ts";
import { reconcileCanonicalShipment } from "../../shared/domainIds.ts";

export default async function (req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const shipmentId = body.shipment_id ? String(body.shipment_id) : null;
    if (!shipmentId)
      return Response.json({ error: "shipment_id required" }, { status: 400 });

    const sr = base44.asServiceRole;
    const ship = await sr.entities.Shipment.get(shipmentId).catch(() => null);
    if (!ship)
      return Response.json({ error: "shipment not found" }, { status: 404 });
    const proof = recordAuthority(
      secrets.get("MERCHANT_RECORD_SIGNING_SECRET"),
    );
    if (!(await proof.trusted("Shipment", ship)))
      return Response.json(
        {
          cancellable: false,
          pending: true,
          code: "legacy_identity_review_required",
        },
        { status: 202 },
      );
    if (ship.server_owner_user_id !== user.id && user.role !== "admin")
      return Response.json(
        { error: "Forbidden: not shipment owner" },
        { status: 403 },
      );

    const preflight = evaluateCancellationPreflight(ship);

    if (preflight.mode === "blocked") {
      return Response.json(
        {
          cancellable: false,
          code: preflight.code,
          message: preflight.message,
          shipment_id: shipmentId,
        },
        { status: 409 },
      );
    }

    // Proven never sent to the domain: nothing to gate, nothing to ask.
    if (preflight.mode === "local_only") {
      return Response.json({
        cancellable: true,
        mode: "local_only",
        reason: preflight.reason,
        evidence: preflight.evidence,
        shipment_id: shipmentId,
      });
    }

    // A domain command must be sent as the merchant who owns the shipment.
    // An admin acting cross-merchant has no verified scope for that tenant.
    if (ship.server_owner_user_id !== user.id) {
      return Response.json(
        {
          cancellable: false,
          code: "admin_not_merchant_owner",
          message:
            "Domain cancellation must be requested by the merchant that owns the shipment, using that merchant's verified credentials.",
          shipment_id: shipmentId,
        },
        { status: 403 },
      );
    }

    const authority = await loadVerifiedAuthority(sr, user);
    if (!authority.ready || !authority.identity || !authority.local.ok) {
      return Response.json(
        {
          cancellable: false,
          code: authority.code,
          message: authority.message,
          release_gate: authority.release_gate,
          shipment_id: shipmentId,
        },
        { status: 409 },
      );
    }

    const drifted = identityDriftFields(ship, authority.identity);
    if (drifted.length > 0) {
      return Response.json(
        {
          cancellable: false,
          code: "identity_drift",
          message: `This shipment was created under a different domain identity (${drifted.join(", ")}).`,
          shipment_id: shipmentId,
        },
        { status: 409 },
      );
    }

    // An ambiguous submission is settled by the same reconciliation the
    // mutation performs, so the preflight never tells the merchant "local only"
    // for a shipment that may already exist remotely.
    let plan: CancelPlan = preflight;
    if (preflight.mode === "ambiguous") {
      const reconcile = await reconcileCanonicalShipment(callRender, {
        merchant_id: String(
          ship.domain_merchant_scope || authority.identity.domain_merchant_id,
        ),
        order_id: String(ship.order_id || ""),
        credential: authority.local.credentials,
      });
      plan = resolveCancellationPlan(
        ship,
        reconcile as unknown as ReconcileOutcomeLike,
      );

      if (plan.mode === "blocked") {
        return Response.json(
          {
            cancellable: false,
            code: plan.code,
            message: plan.message,
            detail: plan.detail,
            reconciled: true,
            shipment_id: shipmentId,
          },
          { status: 409 },
        );
      }

      if (plan.mode === "local_only") {
        return Response.json({
          cancellable: true,
          mode: "local_only",
          reconciled: true,
          reason: plan.reason,
          evidence: plan.evidence,
          shipment_id: shipmentId,
        });
      }
    }

    if (plan.mode !== "domain") {
      return Response.json(
        {
          cancellable: false,
          code: "cancel_preflight_unresolved",
          message: "The cancellation could not be planned for this shipment.",
          shipment_id: shipmentId,
        },
        { status: 409 },
      );
    }

    const canonicalId = plan.canonical_shipment_id;
    const result = await callRender<{ cancellable?: boolean; reason?: string }>(
      {
        method: "GET",
        path: `/api/v1/shipments/${encodeURIComponent(canonicalId)}/cancellable`,
        timeoutMs: 10000,
        credential: authority.local.credentials,
      },
    );

    if (!result.ok) {
      return Response.json(
        {
          cancellable: false,
          error: result.message,
          code: result.code,
          status: result.status,
          request_id: result.requestId,
          shipment_id: shipmentId,
        },
        { status: result.status || 502 },
      );
    }

    const data = result.data || {};
    const cancellable = Boolean(data.cancellable);
    return Response.json({
      cancellable,
      mode: "domain",
      reason: cancellable ? null : data.reason || "past_cutoff",
      canonical_shipment_id: canonicalId,
      expected_version: plan.expected_version,
      reconciled: plan.adopted_from_reconcile,
      shipment_id: shipmentId,
    });
  } catch (error) {
    console.error("cancelOrderGate failed:", (error as Error).message);
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}
