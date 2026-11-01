import { secrets } from "base44:runtime";
import { recordAuthority, lifecycleWrite } from "../../shared/serverRecord.ts";
import { legacyReview } from "../../shared/legacyReview.ts";
import {
  acquireCommand,
  retryCommand,
  markCommand,
  claimResponse,
  ClaimPending,
  cas,
  absent,
  expected,
} from "../../shared/casBooking.ts";
// Merchant cancellation MUTATION: sends the cancel command to the Statelines
// Domain Platform, then confirms the outcome through the canonical read.
//
// Invariants (each one fails closed):
//   • The authenticated merchant's OWN verified dedicated credential is used.
//     The platform/admin service client is never substituted.
//   • The command is addressed by the canonical shipment identity (SHP_…);
//     Render's internal row id is never used as the path identifier.
//   • The release gate must be open for that merchant.
//   • The shipment's recorded domain identity must still match the merchant's
//     current identity (no tenant switch mid-command).
//   • The command payload is the full handoff: command_id, expected_version,
//     correlation_id and reason. All four are persisted before the POST and
//     reused on every retry, so a retry is the same command, not a new one.
//   • expected_version is the canonical shipment version the cancellation was
//     planned against; a changed canonical version blocks the retry instead of
//     applying a stale cancel.
//   • A missing canonical id is NOT proof of non-submission. When the row shows
//     any trace of a create command (command_id / correlation_id / tracking /
//     sync attempt), the shipment is reconciled against the canonical read with
//     its persisted merchant + order before anything is decided. It is cancelled
//     locally ONLY when no create command was ever recorded: a read that finds
//     no match proves nothing, because the create may still be processing or
//     commit afterwards, and no command-status contract exists to settle it.
//   • A lost cancellation response can have moved the canonical version, so the
//     canonical state is read first: a confirmed remote cancellation settles the
//     local row without sending a second command.
//
// The cancel endpoint itself is only as confirmed as the cancellable read that
// preceded it; a 404/405 is reported as-is, never retried.

import { createClientFromRequest } from "npm:@base44/sdk@0.8.52";
import { callRender } from "../../shared/renderClient.ts";
import {
  loadVerifiedAuthority,
  provisioningSyncMessage,
} from "../../shared/domainMerchant.ts";
import {
  evaluateCancellationPreflight,
  identityDriftFields,
  planCancelCommand,
  resolveCancellationPlan,
  resolveCancellationRetry,
  type CancelPlan,
  type ReconcileOutcomeLike,
} from "../../shared/authorityRules.ts";
import {
  reconcileCanonicalShipment,
  generateCommandId,
  generateCorrelationId,
} from "../../shared/domainIds.ts";

function readCanonicalState(body: unknown): {
  status: string | null;
  version: number | null;
} {
  const root = (body && typeof body === "object" ? body : {}) as Record<
    string,
    unknown
  >;
  const target = (
    root.shipment && typeof root.shipment === "object" ? root.shipment : root
  ) as Record<string, unknown>;
  return {
    status: typeof target.status === "string" ? target.status : null,
    version: typeof target.version === "number" ? target.version : null,
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
    // Mutation is owner-only: a cancellation must speak for the merchant's own
    // tenant, so an admin cannot cancel it on their behalf.
    if (actualOwner !== user.id)
      return Response.json(
        {
          error:
            "Forbidden: only the shipment's merchant can cancel it on the domain",
        },
        { status: 403 },
      );

    if (ship.status === "cancelled") {
      return Response.json({
        cancelled: true,
        already_cancelled: true,
        shipment_id: shipmentId,
      });
    }

    if (ship.booking_command_claim && !ship.command_id) {
      ship.command_id = ship.booking_command_claim.command_id;
      ship.correlation_id = ship.booking_command_claim.payload.correlation_id;
    }
    const preflight = evaluateCancellationPreflight(ship);

    if (preflight.mode === "blocked") {
      return Response.json(
        {
          cancelled: false,
          code: preflight.code,
          message: preflight.message,
          shipment_id: shipmentId,
        },
        { status: 409 },
      );
    }

    // Proven never submitted: no create command identity was ever recorded, so
    // there is nothing on the domain to cancel.
    if (preflight.mode === "local_only") {
      const won = await cas(
        sr.entities.Shipment,
        shipmentId,
        {
          booking_command_claim: absent,
          command_id: absent,
          status: expected(ship, "status"),
          lifecycle_revision: expected(ship, "lifecycle_revision"),
        },
        {
          status: "cancelled",
          lifecycle_revision: (Number(ship.lifecycle_revision) || 0) + 1,
          lifecycle_history: [
            ...(ship.lifecycle_history || []),
            {
              action: "shipment.cancelled.local",
              actor_id: user.id,
              at: new Date().toISOString(),
            },
          ],
          sync_message:
            "cancelled locally: never submitted to the domain network (no create command identity was recorded)",
        },
      );
      if (!won) throw new ClaimPending("local_cancel_raced_with_submission");
      return Response.json({
        cancelled: true,
        mode: "local_only",
        reason: preflight.reason,
        evidence: preflight.evidence,
        shipment_id: shipmentId,
      });
    }

    const authority = await loadVerifiedAuthority(sr, user);
    if (!authority.ready || !authority.identity || !authority.local.ok) {
      await sr.entities.Shipment.update(shipmentId, {
        sync_message: provisioningSyncMessage({ message: authority.message }),
      });
      return Response.json(
        {
          cancelled: false,
          code: authority.code,
          message: authority.message,
          action: authority.action,
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
          cancelled: false,
          code: "identity_drift",
          message: `This shipment was created under a different domain identity (${drifted.join(", ")}).`,
          shipment_id: shipmentId,
        },
        { status: 409 },
      );
    }

    const credential = authority.local.credentials;

    // Settle an ambiguous submission BEFORE deciding anything. A lost POST
    // response leaves no canonical ids locally while the shipment may already
    // exist remotely, so the local row alone proves nothing. Reconcile with the
    // PERSISTED merchant/order and the identity this command was created under.
    let plan: CancelPlan = preflight;
    if (preflight.mode === "ambiguous") {
      const scopeMerchant = String(
        ship.domain_merchant_scope || authority.identity.domain_merchant_id,
      );
      const orderId = String(ship.order_id || "");
      const reconcile = await reconcileCanonicalShipment(callRender, {
        merchant_id: scopeMerchant,
        order_id: orderId,
        credential,
      });
      console.log(
        "cancelOrderOnDomain: reconciled ambiguous submission",
        JSON.stringify({
          shipment_id: shipmentId,
          order_id: orderId,
          markers: preflight.markers,
          reason: preflight.reason,
          ok: reconcile.ok,
          reconcile_reason: (reconcile as { reason?: string }).reason ?? null,
          matches: (reconcile as { matches?: number }).matches ?? null,
        }),
      );

      plan = resolveCancellationPlan(
        ship,
        reconcile as unknown as ReconcileOutcomeLike,
      );

      if (plan.mode === "blocked") {
        await sr.entities.Shipment.update(shipmentId, {
          sync_message: `cancel_blocked: ${plan.code} — ${plan.message}`.slice(
            0,
            280,
          ),
        });
        return Response.json(
          {
            cancelled: false,
            code: plan.code,
            message: plan.message,
            detail: plan.detail,
            reconciled: true,
            shipment_id: shipmentId,
          },
          { status: 409 },
        );
      }

      // A read that finds no match is not settled here: the create may still be
      // processing or commit later, and there is no command-status contract to
      // prove it failed, so the plan blocks and the row stays open.
      // The shipment does exist remotely: adopt the canonical identity the read
      // returned (never the row id) and continue with domain cancellation.
      const adopted = reconcile as unknown as {
        canonical?: { tracking_id?: string };
        matches?: number;
      };
      await sr.entities.Shipment.update(shipmentId, {
        canonical_shipment_id: plan.canonical_shipment_id,
        ...(adopted?.canonical?.tracking_id
          ? { tracking_id: adopted.canonical.tracking_id }
          : {}),
        version: plan.expected_version,
        sync_message: `reconciled: canonical identity adopted from the domain read (${adopted?.matches ?? 1} match)`,
      });
    }

    if (plan.mode !== "domain") {
      return Response.json(
        {
          cancelled: false,
          code: "cancel_preflight_unresolved",
          message: "The cancellation could not be planned for this shipment.",
          shipment_id: shipmentId,
        },
        { status: 409 },
      );
    }

    const canonicalId = plan.canonical_shipment_id;

    // Authoritative current canonical state: the version the cancellation is
    // planned against comes from the domain read, never from client input.
    const currentRes = await callRender<unknown>({
      method: "GET",
      path: `/api/v1/shipments/${encodeURIComponent(canonicalId)}`,
      timeoutMs: 10000,
      credential,
    });
    if (!currentRes.ok) {
      return Response.json(
        {
          cancelled: false,
          error: currentRes.message,
          code: currentRes.code,
          status: currentRes.status,
          request_id: currentRes.requestId,
          shipment_id: shipmentId,
        },
        { status: currentRes.status || 502 },
      );
    }
    const evidence = (currentRes.data as any)?.shipment;
    if (
      !evidence ||
      evidence.merchant_id !== authority.identity.domain_merchant_id ||
      evidence.order_id !== ship.order_id ||
      evidence.shipment_id !== canonicalId ||
      (ship.booking_command_claim?.payload?.sandbox_isolated === true &&
        evidence.sandbox_isolated !== true)
    )
      throw new ClaimPending("cancel_read_scope_or_isolation_missing");
    const current = readCanonicalState(currentRes.data);

    // A cancellation whose response was lost may already be applied remotely.
    // The canonical state decides first — a confirmed cancellation settles the
    // row, and only an unchanged (non-cancelled) canonical state lets a moved
    // version be treated as a conflict.
    const retry = resolveCancellationRetry({
      ship,
      canonical: { status: current.status, version: current.version },
    });
    if (retry.mode === "settle_cancelled") {
      const recorded = await lifecycleWrite(
        sr.entities.Shipment,
        shipmentId,
        user.id,
        "shipment.cancelled.canonical",
        {
          status: "cancelled",
          domain_status: "cancelled",
          version: retry.version ?? ship.version,
          sync_message: null,
        },
      );
      if (!recorded) throw new ClaimPending("cancel_audit_settlement_pending");
      return Response.json({
        cancelled: true,
        mode: "domain",
        reconciled: true,
        settled_from_canonical: true,
        canonical_version: retry.version,
        shipment_id: shipmentId,
      });
    }
    if (retry.mode === "version_conflict") {
      return Response.json(
        {
          cancelled: false,
          code: "version_conflict",
          message: retry.message,
          command_id: retry.command_id,
          expected_version: retry.expected_version,
          current_version: retry.current_version,
          shipment_id: shipmentId,
        },
        { status: 409 },
      );
    }
    if (current.version === null) {
      return Response.json(
        {
          cancelled: false,
          code: "canonical_version_missing",
          message:
            "The domain read did not report a canonical version, so expected_version cannot be checked.",
          shipment_id: shipmentId,
        },
        { status: 409 },
      );
    }

    // The cancel command carries the full handoff payload — command_id,
    // expected_version, correlation_id and reason — and every field is
    // preserved across retries. A retry that reused only some of them would be
    // a different command.
    const commandPlan = planCancelCommand({
      ship,
      current_version: current.version,
      requested_reason: body.reason,
      new_command_id: generateCommandId(),
      new_correlation_id: generateCorrelationId(),
    });
    if (!commandPlan.ok) {
      return Response.json(
        {
          cancelled: false,
          code: commandPlan.code,
          message: commandPlan.message,
          action:
            "Ask Statelines to review the pending cancellation before retrying it.",
          command_id: commandPlan.command_id,
          expected_version: commandPlan.expected_version,
          ...(commandPlan.code === "version_conflict"
            ? { current_version: commandPlan.current_version }
            : { missing: commandPlan.missing }),
          shipment_id: shipmentId,
        },
        { status: 409 },
      );
    }

    let command = commandPlan.command;
    let commandId = command.command_id;
    let expectedVersion = command.expected_version;

    if (
      !command.reason?.trim() ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        command.command_id,
      ) ||
      !Number.isInteger(command.expected_version) ||
      command.expected_version < 1 ||
      !command.correlation_id
    )
      throw new ClaimPending("cancel_payload_invalid");
    if (ship.cancel_command_id && !ship.cancel_command_claim)
      throw new ClaimPending("legacy_cancel_requires_reconciliation", {
        command_id: ship.cancel_command_id,
      });
    const proposed = {
      command_id: command.command_id,
      payload: command,
      canonical_id: canonicalId,
      merchant_id: authority.identity.domain_merchant_id,
      client_id: authority.identity.client_id,
      subject: authority.identity.signing_subject,
    };
    const claimed = ship.cancel_command_claim
      ? { owner: false, claim: ship.cancel_command_claim }
      : await acquireCommand(
          sr.entities.Shipment,
          shipmentId,
          "cancel_command",
          proposed,
        );
    const stored = claimed.claim;
    if (
      stored.canonical_id !== canonicalId ||
      stored.merchant_id !== authority.identity.domain_merchant_id ||
      stored.client_id !== authority.identity.client_id ||
      stored.subject !== authority.identity.signing_subject
    )
      throw new ClaimPending("cancel_claim_scope_conflict");
    if (stored.payload.expected_version !== current.version)
      throw new ClaimPending("cancel_version_conflict", {
        command_id: stored.command_id,
      });
    command = stored.payload;
    commandId = stored.command_id;
    expectedVersion = stored.payload.expected_version;
    const maySend =
      claimed.owner ||
      (await retryCommand(
        sr.entities.Shipment,
        shipmentId,
        "cancel_command",
        stored,
      ));
    if (!maySend)
      throw new ClaimPending("cancel_in_progress_reconcile_only", {
        command_id: stored.command_id,
      });
    await sr.entities.Shipment.update(shipmentId, {
      cancel_command_id: stored.command_id,
      cancel_expected_version: stored.payload.expected_version,
      cancel_correlation_id: stored.payload.correlation_id,
      cancel_reason: stored.payload.reason,
    });
    let result: any;
    try {
      result = await callRender<unknown>({
        method: "POST",
        path: `/api/v1/shipments/${encodeURIComponent(canonicalId)}/cancel`,
        body: stored.payload,
        timeoutMs: 15000,
        credential,
      });
    } catch {
      result = { ok: false, status: 0, code: "transport_unknown" };
    }
    await markCommand(
      sr.entities.Shipment,
      shipmentId,
      "cancel_command",
      stored,
      result.ok
        ? "accepted"
        : !result.status || result.status >= 500
          ? "retryable"
          : "rejected",
    );
    if (!result.ok && (!result.status || result.status >= 500))
      throw new ClaimPending("cancel_outcome_unknown", {
        command_id: stored.command_id,
      });
    if (!result.ok) {
      const conflict = result.status === 409 || result.status === 412;
      await sr.entities.Shipment.update(shipmentId, {
        sync_message:
          `cancel_${conflict ? "conflict" : "failed"}: ${result.code}: ${result.message}`.slice(
            0,
            280,
          ),
      });
      return Response.json(
        {
          cancelled: false,
          error: result.message,
          code: conflict ? "version_conflict" : result.code,
          http_status: result.status,
          request_id: result.requestId,
          command_id: commandId,
          expected_version: expectedVersion,
          correlation_id: command.correlation_id,
          shipment_id: shipmentId,
        },
        { status: result.status || 502 },
      );
    }

    // Confirm through the canonical read. A command acceptance is not a
    // cancelled shipment.
    const afterRes = await callRender<unknown>({
      method: "GET",
      path: `/api/v1/shipments/${encodeURIComponent(canonicalId)}`,
      timeoutMs: 10000,
      credential,
    });
    const afterEvidence = afterRes.ok ? (afterRes.data as any)?.shipment : null;
    const matches =
      afterEvidence?.merchant_id === authority.identity.domain_merchant_id &&
      afterEvidence?.order_id === ship.order_id &&
      afterEvidence?.shipment_id === canonicalId &&
      (ship.booking_command_claim?.payload?.sandbox_isolated !== true ||
        afterEvidence?.sandbox_isolated === true);
    const after = matches
      ? readCanonicalState(afterRes.data)
      : { status: null, version: null };

    if (after.status === "cancelled") {
      const recorded = await lifecycleWrite(
        sr.entities.Shipment,
        shipmentId,
        user.id,
        "shipment.cancelled.canonical",
        {
          status: "cancelled",
          domain_status: "cancelled",
          version: after.version ?? expectedVersion,
          sync_message: null,
        },
      );
      if (!recorded) throw new ClaimPending("cancel_audit_settlement_pending");
      return Response.json({
        cancelled: true,
        mode: "domain",
        reconciled: true,
        command_id: commandId,
        expected_version: expectedVersion,
        correlation_id: command.correlation_id,
        reason: command.reason ?? null,
        canonical_version: after.version,
        http_status: result.status,
        shipment_id: shipmentId,
      });
    }

    await sr.entities.Shipment.update(shipmentId, {
      sync_message:
        "cancel_pending_reconciliation: the command was accepted but the canonical read has not reported cancellation yet",
    });
    return Response.json(
      {
        cancelled: false,
        mode: "domain",
        pending: true,
        command_id: commandId,
        expected_version: expectedVersion,
        correlation_id: command.correlation_id,
        canonical_status: after.status,
        http_status: result.status,
        shipment_id: shipmentId,
      },
      { status: 202 },
    );
  } catch (error) {
    const pending = claimResponse(error);
    if (pending) return pending;
    console.error("cancelOrderOnDomain failed:", (error as Error).message);
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}
