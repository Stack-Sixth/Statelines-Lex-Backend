import {canonicalMerchant, MER} from "../../shared/lexAuthorityBinding.ts";
// Install as a Base44 backend function named lexSandboxBooking.
// Admin-only control plane for the merchant booking exception.
//
// It can only ever touch the two businesses in the registry. Nothing here mints a
// canonical merchant id, and activation additionally requires recorded event-isolation
// evidence, dedicated synthetic-merchant credentials, an approved non-admin test subject
// and a verified read-back — so no data edit alone can open booking. Testing runs on the
// live backend; there is no sandbox engine and no sandbox URL is read. Each business's
// credential pair is read only through its credential_ref, never a shared credential.
//
// Returns redacted evidence: business ids, credential-key names and authenticated
// user ids only. Client ids are reported as fingerprints; secret values never.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.40";
import { secrets } from "base44:runtime";
import {
  SANDBOX_BUSINESSES,
  SANDBOX_INTRODUCED_SECRETS,
  sandboxBusinessForMerchantId,
  liveEngine,
  sandboxSwitchOpen,
  sandboxViolation,
  redactedBusinessLine,
} from "../../shared/lexSandbox.ts";
import {
  resolveDedicatedCredential,
  validateMerchantAgainstBackend,
  recordMerchantValidation,
  clientFingerprint,
  evaluateMerchantRow,
} from "../../shared/lexMerchantContext.ts";

function asArray(r: any): any[] {
  return Array.isArray(r) ? r : r?.items || [];
}

const GUARD_PROBES = [
  { label: "sandbox_tracking_id", payload: { tracking_id: "LEX-SBX-ALPHA-0001" } },
  { label: "sandbox_business_id", payload: { merchant: "SBX-BIZ-ALPHA-001" } },
  { label: "sandbox_flag", payload: { shipment_id: "abc", sandbox: true } },
  { label: "nested_sandbox_ref", payload: { event_name: "shipment.created", payload: { note: "LEX-SBX-BETA-0002" } } },
  { label: "clean_payload", payload: { event_name: "shipment.created", payload: { note: "routine event" } } },
];

export default async function (req: Request): Promise<Response> {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== "admin") return Response.json({ error: "Admin access required" }, { status: 403 });

  const body = await req.json().catch(() => ({} as any));
  const action = body.action || "status";
  const rows: any[] = asArray(await base44.asServiceRole.entities.MerchantAuthorization.list("-created_date", 200));
  const sandboxRows = rows.filter((r) => sandboxBusinessForMerchantId(r.merchant_id));

  const env = () => {
    const engine = liveEngine();
    return {
      live_engine: { configured: engine.usable, reason: engine.reason },
      sandbox_engine: { status: "not used — controlled testing runs on the live backend; no sandbox URL is read or substituted" },
      payment: { posture: "no_charge", sandbox_key_required: false, live_key_reachable_from_this_path: false },
      activation_switch_open: sandboxSwitchOpen(),
      env_var_inventory: SANDBOX_INTRODUCED_SECRETS,
    };
  };

  const perRowBlockers = async (row: any) => {
    const blockers: { code: string; detail: string }[] = [];
    const business = sandboxBusinessForMerchantId(row?.merchant_id);
    if (row && sandboxRows.filter(r=>r.merchant_id===row.merchant_id).length !== 1)
      blockers.push({code:"ambiguous_mapping",detail:"Duplicate mapping rows require operator reconciliation."});
    const approved: string[] = Array.isArray(row?.approved_subjects) ? row.approved_subjects : [];
    if (!row) {
      blockers.push({ code: "sandbox_row_missing", detail: "No mapping row for a registered business." });
      return blockers;
    }
    if (!business) blockers.push({ code: "sandbox_business_not_registered", detail: `${row.merchant_id} is not in the registry.` });
    if (!row.synthetic || !row.sandbox)
      blockers.push({ code: "sandbox_flags_not_set", detail: "synthetic and sandbox must both be true." });
    if (!["prepared", "paused"].includes(String(row.activation_state || "")))
      blockers.push({ code: "sandbox_activation_state_invalid", detail: `activation_state is "${row.activation_state}".` });
    if (!approved.length) blockers.push({ code: "sandbox_subject_missing", detail: "approved_subjects is empty." });
    for (const id of approved) {
      const u = asArray(await base44.asServiceRole.entities.User.filter({ id }))[0];
      if (!u) blockers.push({ code: "sandbox_subject_not_real_user", detail: `${id} is not an existing app user.` });
      else if (u.role === "admin")
        blockers.push({ code: "sandbox_subject_is_admin", detail: `${id} is a platform admin and cannot serve as the merchant subject.` });
    }
    if (business && row.credential_ref !== business.credential_ref)
      blockers.push({ code: "sandbox_credential_ref_mismatch", detail: `credential_ref must be ${business.credential_ref}.` });
    if (!resolveDedicatedCredential(row.credential_ref))
      blockers.push({ code: "sandbox_credential_missing", detail: `${row.credential_ref}_CLIENT_ID / _CLIENT_SECRET are not present.` });
    if (String(row.status) !== "provisioned")
      blockers.push({ code: "sandbox_not_provisioned", detail: `status is "${row.status}"; a matching read-back must set it to provisioned.` });
    const credential = resolveDedicatedCredential(row.credential_ref);
    const ctx = await evaluateMerchantRow(row, business?.lex_subject || null);
    if (!canonicalMerchant(row)) blockers.push({code:"canonical_merchant_missing",detail:"Bind the provisioned MER identity explicitly."});
    if (!business || approved.length !== 1 || approved[0] !== business.lex_subject || credential?.clientId !== business.client_id)
      blockers.push({code:"sandbox_identity_mismatch",detail:"Client and approved LEX subject must equal the exact registry identity."});
    if (!ctx.validation_matches_caller) blockers.push({code:"sandbox_validation_stale",detail:"Reverify current canonical identity, credential pair, subject and target."});
    if (credential && business && canonicalMerchant(row)) {
      const live = await validateMerchantAgainstBackend(row,business.lex_subject,credential);
      if (!live.matched) blockers.push({code:"backend_isolation_unverified",detail:"Fresh backend merchant-context/isolation did not match."});
    }
    return blockers;
  };

  const evaluate = async (evidence: string | null) => {
    const e = env();
    const blockers: { scope: string; code: string; detail: string }[] = [];
    if (!e.live_engine.configured)
      blockers.push({ scope: "env", code: "live_engine_not_configured", detail: e.live_engine.reason || "LEX_API_URL missing" });
    if (!evidence) blockers.push({ scope: "env", code: "isolation_evidence_required", detail: "Backend isolation must be confirmed and referenced before activation." });
    for (const business of SANDBOX_BUSINESSES) {
      const row = sandboxRows.find((r) => r.merchant_id === business.business_id);
      for (const b of await perRowBlockers(row))
        blockers.push({ scope: business.business_id, code: b.code, detail: b.detail });
    }
    return { env: e, blockers };
  };

  if (action === "status") {
    const { env: e, blockers } = await evaluate(null);
    const businesses = [];
    for (const business of SANDBOX_BUSINESSES) {
      const row = sandboxRows.find((r) => r.merchant_id === business.business_id);
      const credential = resolveDedicatedCredential(row?.credential_ref);
      businesses.push({
        ...redactedBusinessLine(row),
        registered_name: business.business_name,
        row_present: !!row,
        client_fingerprint: credential ? await clientFingerprint(credential.clientId) : null,
        ...(await (async () => ({ activation_blockers: await perRowBlockers(row) }))()),
      });
    }
    return Response.json(
      {
        businesses,
        business_count: businesses.length,
        env: e,
        general_merchant_booking: { gate: "closed (LEX_MERCHANT_BOOKING_ENABLED untouched)", evidence: "createShipment returns 409 merchant_booking_disabled for every non-exception caller" },
        lex_booking: { state: "closed", evidence: "no action creates a shipment outside the controlled test exception; admin path is also refused" },
        isolation_guards: {
          primary: "Backend-persisted isolation and matching quarantine-capable workers; dedicated identities are authorization, not delivery containment",
          defence_in_depth: "Operational boundaries require a persisted backend classification; payload markers are diagnostic only",
          diagnostic_marker_examples: GUARD_PROBES.map((p) => ({ label: p.label, hint_only: !!sandboxViolation(p.payload), field: sandboxViolation(p.payload) })),
        },
        activation_blockers: blockers,
        secret_values_returned: false,
      },
      { status: 200 },
    );
  }

  if (action === "prepare") {
    const ids: string[] = Array.isArray(body.subject_user_ids) ? body.subject_user_ids.filter((v: unknown) => typeof v === "string") : [];
    if (ids.length !== 2 || new Set(ids).size !== 2)
      return Response.json({ error: "subject_user_ids must contain exactly two distinct authenticated LEX user ids" }, { status: 400 });
    if (ids.some((id,i)=>id !== SANDBOX_BUSINESSES[i].lex_subject))
      return Response.json({error:"Subjects must match the explicit Alpha/Beta registry order"},{status:400});
    for (const id of ids) {
      const u = asArray(await base44.asServiceRole.entities.User.filter({ id }))[0];
      if (!u) return Response.json({ error: `${id} is not an existing app user` }, { status: 400 });
      if (u.role === "admin") return Response.json({ error: `${id} is a platform admin; the merchant subject must be a non-admin user` }, { status: 400 });
    }

    const written = [];
    for (let i = 0; i < SANDBOX_BUSINESSES.length; i++) {
      const business = SANDBOX_BUSINESSES[i];
      const matching = sandboxRows.filter(r=>r.merchant_id===business.business_id);
      if (matching.length > 1) return Response.json({error:"Ambiguous business mapping"},{status:409});
      const existing = matching[0];
      const payload = {
        merchant_id: business.business_id,
        ...(existing?.canonical_merchant_id ? {canonical_merchant_id:existing.canonical_merchant_id} : {}),
        validation_status: "unverified",
        validation_binding: null,
        merchant_name: business.business_name,
        status: "pending",
        credential_ref: business.credential_ref,
        approved_subjects: [ids[i]],
        booking_enabled: false,
        synthetic: true,
        sandbox: true,
        activation_state: "prepared",
        isolation_confirmed_at: null,
        isolation_evidence: null,
        contract_version: "live-controlled-test-1",
        backend_commit: null,
        notes: `Synthetic business. Merchant signs sub=client_id; LEX signs sub=authenticated_user_id. General merchant booking and LEX booking remain closed.`,
      };
      const row = existing
        ? await base44.asServiceRole.entities.MerchantAuthorization.update(existing.id, payload)
        : await base44.asServiceRole.entities.MerchantAuthorization.create(payload);
      written.push(redactedBusinessLine({ ...payload, ...row }));
    }
    return Response.json({ prepared: written.length, businesses: written, note: "Prepared only. Not active; booking stays closed until verification, isolation evidence and the activation switch." }, { status: 200 });
  }

  if (action === "bindCanonical") {
    const business = sandboxBusinessForMerchantId(body.business_id);
    const matches = sandboxRows.filter(r=>r.merchant_id===body.business_id);
    if (!business || matches.length !== 1 || !MER.test(String(body.canonical_merchant_id || "")))
      return Response.json({error:"One existing registered business and a provisioned MER identity are required"},{status:400});
    const row = matches[0];
    if (row.activation_state === "active") return Response.json({error:"Deactivate before changing canonical mapping"},{status:409});
    if (sandboxRows.some(r=>r.id!==row.id && r.canonical_merchant_id===body.canonical_merchant_id))
      return Response.json({error:"Alpha and Beta must have distinct canonical merchants"},{status:409});
    await base44.asServiceRole.entities.MerchantAuthorization.update(row.id,{
      canonical_merchant_id: body.canonical_merchant_id, status:"pending", booking_enabled:false,
      validation_status:"unverified",validation_binding:null,isolation_confirmed_at:null,isolation_evidence:null,
    });
    return Response.json({business_id:row.merchant_id,canonical_merchant_id:body.canonical_merchant_id,booking_enabled:false});
  }

  if (action === "verify") {
    const engine = liveEngine();
    if (!engine.usable)
      return Response.json({ error: "Live backend is not configured", code: "live_engine_not_configured", reason: engine.reason }, { status: 503 });

    const results = [];
    for (const row of sandboxRows) {
      const approved: string[] = Array.isArray(row.approved_subjects) ? row.approved_subjects : [];
      const subject = approved[0] || null;
      const credential = resolveDedicatedCredential(row.credential_ref);
      if (!subject || !credential) {
        results.push({ business_id: row.merchant_id, verified: false, status: "failed", reason: !subject ? "sandbox_subject_missing" : "sandbox_credential_missing" });
        continue;
      }
      const validation = await validateMerchantAgainstBackend(row, subject, credential, engine.base_url);
      await recordMerchantValidation(base44, row.id, { status: validation.status, subject, credential_ref: row.credential_ref, validation });
      if (validation.matched)
        await base44.asServiceRole.entities.MerchantAuthorization.update(row.id, { status: "provisioned", backend_commit: body.backend_commit || null });
      results.push({
        business_id: row.merchant_id,
        verified: validation.matched,
        status: validation.status,
        http_status: validation.http_status,
        subject,
        expected_client_fingerprint: validation.expected.client_fingerprint,
        returned_client_fingerprint: validation.returned.client_fingerprint,
        mismatches: validation.mismatches,
        error: validation.error,
      });
    }
    return Response.json({ results, note: "A matching read-back sets status=provisioned; only then can activation consider the row." }, { status: 200 });
  }

  if (action === "activate") {
    const evidence = typeof body.isolation_evidence === "string" ? body.isolation_evidence.trim() : "";
    const { blockers } = await evaluate(evidence);
    if (blockers.length)
      return Response.json(
        { activated: false, code: "sandbox_activation_refused", blockers, note: "The exception stays inactive. General merchant booking and LEX booking are unaffected and remain closed." },
        { status: 409 },
      );
    const now = new Date().toISOString();
    const updated = [];
    for (const business of SANDBOX_BUSINESSES) {
      const row = sandboxRows.find((r) => r.merchant_id === business.business_id);
      const res = await base44.asServiceRole.entities.MerchantAuthorization.update(row.id, {
        activation_state: "active",
        booking_enabled: true,
        isolation_confirmed_at: now,
        isolation_evidence: evidence,
      });
      updated.push(redactedBusinessLine({ ...row, ...res }));
    }
    return Response.json(
      { activated: true, at: now, businesses: updated, scope: "Controlled live test for the two synthetic businesses only. General merchant booking and all LEX booking remain closed." },
      { status: 200 },
    );
  }

  if (action === "deactivate") {
    const updated = [];
    for (const row of sandboxRows) {
      const res = await base44.asServiceRole.entities.MerchantAuthorization.update(row.id, {
        activation_state: "paused",
        booking_enabled: false,
      });
      updated.push(redactedBusinessLine({ ...row, ...res }));
    }
    return Response.json({ deactivated: true, businesses: updated, note: "isolation_confirmed_at is cleared from live evaluation because activation_state is no longer active." }, { status: 200 });
  }

  return Response.json({ error: "Unknown action", actions: ["status", "prepare", "bindCanonical", "verify", "activate", "deactivate"] }, { status: 400 });
}

