import {settleBookingDeclaration} from "../../shared/declarationProjection.ts";
import { recordAuthority } from "../../shared/serverRecord.ts";
import { legacyReview } from "../../shared/legacyReview.ts";
import {
  acquireCommand,
  retryCommand,
  markCommand,
  claimResponse,
  ClaimPending,
  expected,
  absent,
} from "../../shared/casBooking.ts";
// Hands canonical shipment creation off to the Statelines Domain Platform.
//
// ENFORCEMENT ORDER (nothing below may be reordered):
//   1. authentication + shipment ownership
//   2. SHARED AUTHORIZATION — merchant's own mapping, dedicated credential,
//      live merchant-context probe, recorded verification stamp
//   3. authoritative business equality (the shipment's merchant IS the resolved
//      merchant, not merely the same account)
//   4. classification: SYNTHETIC (registered exception business) or PRODUCTION
//   5. exactly one release:
//        PRODUCTION → ordinary global release (BOOKING_RELEASE_ENABLED) and then
//                     the saved-card preflight (the only Stripe I/O here)
//        SYNTHETIC  → the controlled test exception, independently; NO payment
//                     provider call of any kind
//   6. identity drift, weight, command claim (persisted before the POST)
//   7. POST through the TRUSTED LEX_API_URL with the dedicated credential
//   8. canonical read; never a second POST
//
// A synthetic command is QUARANTINED: it is not payment authority, not a carrier
// hand-off, and never a release of ordinary or LEX booking.

import { createClientFromRequest } from "npm:@base44/sdk@0.8.52";
import { secrets } from "base44:runtime";
import { callRender, isReachable } from "../../shared/renderClient.ts";
import {
  loadVerifiedAuthority,
  provisioningSyncMessage,
} from "../../shared/domainMerchant.ts";
import { identityDriftFields } from "../../shared/authorityRules.ts";
import { resolveCallerMerchant } from "../../shared/portalMemberships.ts";
import { resolveSavedCard } from "../../shared/stripeCustomer.ts";
import {
  evaluateForAuthority,
  exceptionContext,
} from "../../shared/bookingExceptionRuntime.ts";
import { findExceptionByMerchant } from "../../shared/bookingException.ts";
import { resolvePaymentConfiguration } from "../../shared/paymentMode.ts";
import {
  normalizeWeight,
  generateCorrelationId,
  generateCommandId,
  isValidCommandId,
  mapToRenderShipment,
  extractCanonicalFromCreate,
  reconcileCanonicalShipment,
} from "../../shared/domainIds.ts";

function pendingReconciliation(message: string) {
  return {
    sync_status: "pending" as const,
    sync_message: `pending_reconciliation: ${message}`.slice(0, 280),
  };
}
function ambiguousReconciliation(message: string) {
  return {
    sync_status: "pending" as const,
    sync_message: `ambiguous_reconciliation: ${message}`.slice(0, 280),
  };
}

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
    const trusted = await proof.trusted("Shipment", ship);
    const actualOwner = trusted
      ? ship.server_owner_user_id
      : ship.created_by_id;
    if (actualOwner !== user.id)
      return Response.json({ error: "Forbidden" }, { status: 403 });
    if (!trusted) {
      const reviewAuthority = await loadVerifiedAuthority(sr, user);
      if (
        !reviewAuthority.ready ||
        !reviewAuthority.identity ||
        !reviewAuthority.local.ok
      )
        throw new ClaimPending("legacy_authority_unverified");
      return await legacyReview(
        ship,
        reviewAuthority.identity,
        reviewAuthority.local.credentials,
        callRender,
      );
    }
    if (ship.status === "cancelled")
      throw new ClaimPending("shipment_cancelled");
    if (ship.booking_intent && ship.booking_ready !== true)
      throw new ClaimPending("local_finalization_pending");
    if (actualOwner !== user.id && user.role !== "admin")
      return Response.json(
        { error: "Forbidden: not shipment owner" },
        { status: 403 },
      );

    if (!isReachable()) {
      await sr.entities.Shipment.update(shipmentId, {
        sync_status: "failed",
        sync_message: "Render credentials not configured",
      });
      return Response.json({ error: "Render not configured" }, { status: 503 });
    }

    // 2. SHARED AUTHORIZATION — unchanged requirements for every branch.
    const authority = await loadVerifiedAuthority(sr, user);
    if (!authority.ready || !authority.identity || !authority.local.ok) {
      console.error(
        "createOrderOnRender: release gate closed",
        authority.code,
        authority.merchant_id,
      );
      await sr.entities.Shipment.update(shipmentId, {
        sync_status: "failed",
        sync_message: provisioningSyncMessage({ message: authority.message }),
      });
      return Response.json(
        {
          error: "merchant_not_provisioned",
          code: authority.code,
          message: authority.message,
          action: authority.action,
          release_gate: authority.release_gate,
          local_configuration: {
            ok: authority.local.ok,
            code: authority.local.ok ? "configured" : authority.local.code,
            message: authority.local.ok
              ? "Local merchant configuration is complete."
              : authority.local.message,
          },
          verified_authorization: {
            status: authority.verification.status,
            code: authority.verification.code,
            message: authority.verification.message,
          },
          shipment_id: shipmentId,
          order_id: ship.order_id,
        },
        { status: 409 },
      );
    }
    const domainCredential = authority.local.credentials;
    const domainIdentity = authority.identity;

    // 3. Authoritative business equality.
    const merchant = await resolveCallerMerchant(sr, user);
    if (!merchant || merchant.id !== authority.merchant_id) {
      console.error(
        "createOrderOnRender: resolved merchant does not match authority",
        authority.merchant_id,
      );
      await sr.entities.Shipment.update(shipmentId, {
        sync_status: "failed",
        sync_message:
          "business_authorization_mismatch: resolved merchant does not match this authority",
      });
      return Response.json(
        {
          error: "business_authorization_mismatch",
          code: "business_authorization_mismatch",
          message:
            "This shipment's business does not match the authorized merchant.",
          shipment_id: shipmentId,
        },
        { status: 409 },
      );
    }
    if (ship.merchant_id && ship.merchant_id !== merchant.id) {
      console.error(
        "createOrderOnRender: shipment belongs to another business",
        ship.merchant_id,
        merchant.id,
      );
      await sr.entities.Shipment.update(shipmentId, {
        sync_status: "failed",
        sync_message:
          "business_authorization_mismatch: shipment merchant differs from the resolved merchant",
      });
      return Response.json(
        {
          error: "business_authorization_mismatch",
          code: "business_authorization_mismatch",
          message:
            "This shipment belongs to a different business than the authorized merchant.",
          shipment_id: shipmentId,
        },
        { status: 409 },
      );
    }

    // 4. Classification + 5. exactly one release.
    const controlled = evaluateForAuthority(
      authority,
      { id: user.id },
      merchant,
      exceptionContext(),
    );
    const registered = findExceptionByMerchant({
      local_merchant_id: merchant.id,
      canonical_merchant_id: domainIdentity.domain_merchant_id,
      client_id: domainIdentity.client_id,
    });
    const synthetic = Boolean(registered);
    const paymentConfiguration = resolvePaymentConfiguration(
      (name) => secrets.get(name) || "",
    );

    if (synthetic) {
      // A registered synthetic business NEVER falls through to ordinary booking,
      // whatever the global switch says.
      if (!controlled.open) {
        console.error(
          "createOrderOnRender: controlled test not released",
          controlled.code,
          controlled.synthetic_label,
        );
        await sr.entities.Shipment.update(shipmentId, {
          sync_status: "failed",
          sync_message:
            `controlled_test_not_released: ${controlled.code}`.slice(0, 280),
        });
        return Response.json(
          {
            error: "controlled_test_not_released",
            code: controlled.code,
            message: controlled.message,
            action:
              "This business is registered for the controlled test but its exception is not released.",
            synthetic_label: controlled.synthetic_label,
            prerequisites: controlled.entry?.prerequisites || null,
            release: {
              ordinary_global_release: authority.booking_release.open,
              controlled_test_release: false,
              lex_booking: false,
            },
            shipment_id: shipmentId,
          },
          { status: 409 },
        );
      }
    } else {
      if (!authority.booking_release.open) {
        console.error(
          "createOrderOnRender: booking release closed",
          authority.booking_release.code,
          authority.merchant_id,
        );
        await sr.entities.Shipment.update(shipmentId, {
          sync_status: "failed",
          sync_message:
            `booking_release_closed: ${authority.booking_release.message}`.slice(
              0,
              280,
            ),
        });
        return Response.json(
          {
            error: "booking_release_closed",
            code: authority.booking_release.code,
            message: authority.booking_release.message,
            action:
              "Booking stays disabled until Statelines completes the coordinated booking, payment and cancellation checks and switches booking on.",
            release_gate: authority.release_gate,
            booking_release: authority.booking_release,
            release: {
              ordinary_global_release: false,
              controlled_test_release: controlled.open,
              lex_booking: false,
            },
            shipment_id: shipmentId,
          },
          { status: 409 },
        );
      }

      // Payment provider I/O happens ONLY here: after authorization AND after
      // the ordinary release is open. Admins are not exempt.
      const key = secrets.get("STRIPE_SECRET_KEY");
      const card = key
        ? await resolveSavedCard(base44, {
            key,
            merchant,
            preferredId: ship.payment_method_id,
          })
        : { error: "No saved payment method on this account" };
      if (card.error) {
        console.error(
          "createOrderOnRender: blocked, no saved payment method for merchant",
          merchant.id,
        );
        await sr.entities.Shipment.update(shipmentId, {
          sync_status: "failed",
          sync_message: "Blocked: no saved payment method on this account",
        });
        return Response.json(
          {
            error: "payment_method_required",
            message:
              "Add a saved payment method to the account before booking this shipment with a carrier.",
          },
          { status: 402 },
        );
      }
    }

    if (!synthetic) {
      if(ship.compliance_evidence?.status!=='permitted')throw new ClaimPending('compliance_evidence_required');
      await settleBookingDeclaration(sr.entities,ship,secrets.get('MERCHANT_RECORD_SIGNING_SECRET')!);
    }

    // 6. Identity drift.
    const drifted = identityDriftFields(ship, domainIdentity);
    if (drifted.length > 0) {
      console.error("createOrderOnRender: domain identity drift", drifted);
      await sr.entities.Shipment.update(shipmentId, {
        sync_status: "failed",
        sync_message:
          `identity_drift: ${drifted.join(", ")} changed since this command was created`.slice(
            0,
            280,
          ),
      });
      return Response.json(
        {
          error: "domain_identity_drift",
          code: "identity_drift",
          message:
            "This merchant's domain identity changed after this booking command was created.",
          action:
            "Ask Statelines to review this command's domain identity before retrying it.",
          shipment_id: shipmentId,
        },
        { status: 409 },
      );
    }

    const weights = normalizeWeight(ship.weight_lb);
    if (!weights) {
      await sr.entities.Shipment.update(shipmentId, {
        sync_status: "failed",
        sync_message: "Invalid weight_lb",
      });
      return Response.json({ error: "Invalid weight_lb" }, { status: 400 });
    }

    // Existing local Shipment is the shared boundary for a canonical command.
    // A legacy command without a frozen payload cannot safely be reconstructed.
    if (ship.command_id && !ship.booking_command_claim)
      throw new ClaimPending("legacy_command_requires_reconciliation", {
        command_id: ship.command_id,
      });
    const commandId =
      ship.booking_command_claim?.command_id || generateCommandId();
    const correlationId =
      ship.booking_command_claim?.payload?.correlation_id ||
      ship.correlation_id ||
      generateCorrelationId();
    let payload =
      ship.booking_command_claim?.payload ||
      mapToRenderShipment(
        {
          ...ship,
          external_shipment_id: shipmentId,
          weight_kg: weights.weight_kg,
          command_id: commandId,
        },
        correlationId,
      );
    if (!payload) {
      await sr.entities.Shipment.update(shipmentId, {
        sync_status: "failed",
        sync_message:
          "Missing required domain fields (origin, destination, weight, deadlines)",
      });
      return Response.json(
        { error: "Missing required domain fields" },
        { status: 400 },
      );
    }
    payload.merchant_id = domainIdentity.domain_merchant_id;

    if (synthetic) {
      // Do not rely on an unexported verification-stamp field: probe the backend.
      const context = await callRender<any>({
        method: "GET",
        path: "/api/v1/merchant-context",
        credential: domainCredential,
      });
      const ctx = context.ok ? context.data : null;
      if (
        !ctx ||
        ctx.merchant_id !== domainIdentity.domain_merchant_id ||
        ctx.client_id !== domainIdentity.client_id ||
        ctx.subject !== domainIdentity.signing_subject ||
        ctx.sandbox_isolated !== true
      )
        throw new ClaimPending("isolation_context_not_verified");
    }
    const proposed = {
      command_id: payload.command_id,
      payload: synthetic ? { ...payload, sandbox_isolated: true } : payload,
      merchant_id: domainIdentity.domain_merchant_id,
      client_id: domainIdentity.client_id,
      subject: domainIdentity.signing_subject,
    };
    const claim = ship.booking_command_claim
      ? { owner: false, claim: ship.booking_command_claim }
      : await acquireCommand(
          sr.entities.Shipment,
          shipmentId,
          "booking_command",
          proposed,
          { status: expected(ship, "status"), cancel_command_claim: absent },
        );
    const persisted = claim.claim;
    if (
      persisted.merchant_id !== domainIdentity.domain_merchant_id ||
      persisted.client_id !== domainIdentity.client_id ||
      persisted.subject !== domainIdentity.signing_subject
    )
      throw new ClaimPending("claim_scope_conflict");
    payload = persisted.payload;
    await sr.entities.Shipment.update(shipmentId, {
      command_id: persisted.command_id,
      correlation_id: persisted.payload.correlation_id,
      domain_merchant_scope: persisted.merchant_id,
      domain_client_id: persisted.client_id,
      domain_signing_subject: persisted.subject,
    });
    let maySend = claim.owner;
    if (!maySend)
      maySend = await retryCommand(
        sr.entities.Shipment,
        shipmentId,
        "booking_command",
        persisted,
      );
    // Losers and crash recovery only read. Explicit retryable outcomes acquire CAS
    // and may resend the SAME full frozen command, never a newly generated one.
    let createResult: any = {
      ok: false,
      status: 0,
      code: "pending_reconciliation",
    };
    if (maySend) {
      try {
        createResult = await callRender<unknown>({
          method: "POST",
          path: "/api/v1/shipments",
          body: payload,
          timeoutMs: 15000,
          credential: domainCredential,
        });
      } catch {
        createResult = { ok: false, status: 0, code: "transport_unknown" };
      }
      await markCommand(
        sr.entities.Shipment,
        shipmentId,
        "booking_command",
        persisted,
        createResult.ok
          ? "accepted"
          : !createResult.status || createResult.status >= 500
            ? "retryable"
            : "rejected",
      );
    }
    const now = new Date().toISOString();

    const fromCreate = extractCanonicalFromCreate(createResult.data);
    const reconcile = await reconcileCanonicalShipment(callRender, {
      merchant_id: domainIdentity.domain_merchant_id,
      order_id: payload.order_id,
      credential: domainCredential,
      requireIsolation: synthetic,
    });

    if (!reconcile.ok) {
      const state =
        reconcile.reason === "ambiguous"
          ? ambiguousReconciliation(reconcile.detail)
          : pendingReconciliation(reconcile.detail);
      await sr.entities.Shipment.update(shipmentId, {
        ...state,
        ...(fromCreate
          ? {
              canonical_shipment_id: fromCreate.canonical_shipment_id,
              tracking_id: fromCreate.tracking_id,
              render_id: fromCreate.render_id,
            }
          : {}),
      });
      return Response.json(
        {
          ok: false,
          reason: reconcile.reason,
          detail: reconcile.detail,
          matches: reconcile.matches ?? 0,
          shipment_id: shipmentId,
          order_id: payload.order_id,
          command_id: payload.command_id,
          correlation_id: payload.correlation_id,
          http_status: createResult.status,
          quarantined: synthetic,
          timestamp: now,
        },
        { status: 202 },
      );
    }

    if (
      fromCreate &&
      (fromCreate.canonical_shipment_id !==
        reconcile.canonical.canonical_shipment_id ||
        fromCreate.tracking_id !== reconcile.canonical.tracking_id)
    )
      throw new ClaimPending("canonical_identity_conflict");
    const canonical = reconcile.canonical;
    await sr.entities.Shipment.update(shipmentId, {
      sync_status: "synced",
      sync_message: synthetic ? "synthetic_quarantined_command" : null,
      synced_at: now,
      canonical_shipment_id: canonical.canonical_shipment_id,
      tracking_id: canonical.tracking_id,
      render_id: canonical.render_id,
      domain_status: canonical.domain_status,
      version: canonical.version,
      etag: canonical.etag || undefined,
      ...(synthetic ? { payment_capture_status: "not_captured" as const } : {}),
    });

    return Response.json({
      ok: true,
      shipment_id: shipmentId,
      order_id: payload.order_id,
      canonical_shipment_id: canonical.canonical_shipment_id,
      tracking_id: canonical.tracking_id,
      render_id: canonical.render_id,
      domain_status: canonical.domain_status,
      version: canonical.version,
      correlation_id: canonical.correlation_id || payload.correlation_id,
      command_id: payload.command_id,
      reconciled: !fromCreate,
      quarantined: synthetic,
      synthetic_label: controlled.synthetic_label,
      payment: synthetic
        ? {
            capture_status: "not_captured",
            configuration: {
              mode: paymentConfiguration.mode,
              enabled: paymentConfiguration.enabled,
              code: paymentConfiguration.code,
              message: paymentConfiguration.message,
            },
          }
        : { capture_status: "not_captured" },
      release: {
        ordinary_global_release: synthetic
          ? false
          : authority.booking_release.open,
        controlled_test_release: synthetic ? controlled.open : false,
        lex_booking: false,
      },
      timestamp: now,
    });
  } catch (error) {
    const pending = claimResponse(error);
    if (pending) return pending;
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}
