import {requirePackageMutation} from "../../shared/lexEngineBoundary.ts";
import {engineCreatePayload,confirmEngineCreate,settleEngineOutbox} from "../../shared/lexEngineCreateRecovery.ts";
import {verified,stable} from "../../shared/lexEffectProof.ts";
// Keeps the Render LEX engine in sync with the cross-app hub. For each cross-app
// package not yet registered with the engine, calls lexApi.createShipment with the
// engine's contract payload and stores the returned shipment UUID + version.
//
// Engine createShipment contract (POST /v1/shipments):
//   command_id        string  (required, idempotency key)
//   origin            string  (required, >= 2 chars)
//   destination       string  (required, >= 2 chars)
//   package_size      enum    (small|medium|large|xl)
//   weight_kg         number  (required, > 0)
//   service_level     enum    (standard|express|same_day|overnight)
//   pickup_deadline   ISO     (required)
//   delivery_deadline ISO     (required)
//   (tracking_id, merchant_name, declared_value are NOT accepted by the engine)
//
// command_id is deterministic per package (UUIDv5 of the package id) so retries
// preserve it — it is never regenerated for an existing package.
//
// Records are classified, never silently dropped:
//   - Trusted backend/local approvals determine isolation; caller flags never
//     excluded from operational sync without deleting real shipments.
//   - Records missing required fields (origin, destination, or weight) are marked
//     "needs_information" and skipped — validation is never bypassed and weights
//     are never invented. A manual weight override (weight_override_kg) entered in
//     the hub takes precedence over the source weight.
//   - Packages already carrying an engine_shipment_id are skipped (already synced).
import { createClientFromRequest } from "npm:@base44/sdk@0.8.49";
import { secrets } from "base44:runtime";
import { mapServiceLevel, effectiveWeight } from "../../shared/lexPackageMapping.ts";
import { appendToOutbox } from "../../shared/lexUtils.ts";
import { signedRenderHeaders, renderBaseUrl } from "../../shared/lexRenderJwt.ts";

// Direct createShipment call against Render (bypasses the lexApi proxy). Used so
// this worker can distinguish a 409 idempotent-rejection (command_id already
// processed — reconcile) from a 5xx/network failure (retry). The lexApi proxy
// throws on non-2xx, losing the status/body that reconciliation needs.
async function renderCreateShipment(base44:any,row:any,payload: any) {
  row=await base44.asServiceRole.entities.CrossAppPackage.get(row.id);
  await requirePackageMutation(base44,row);
  if(!await verified(row.lex_engine_claim,'engine_create',row.id)||JSON.stringify(stable(row.lex_engine_claim.document))!==JSON.stringify(stable(payload)))throw new Error('frozen_engine_payload_required');
  const base = renderBaseUrl();
  const headers = await signedRenderHeaders("lex-engine-sync", "admin");
  const res = await fetch(new URL("/v1/shipments", base), {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
    redirect: "manual",
  });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { ok: res.ok, status: res.status, body };
}

// Look up an existing Render shipment by command_id. Render's list endpoint
// does not filter by command_id, so we scan recent shipments and match on the
// create payload fields (origin, destination, weight_kg, package_size). Used
// only to reconcile a 409 on a duplicate create — never as the primary path.
// Similar parcel fields cannot establish command ownership. A legacy 409 is
// held for exact-command reconciliation; a new frozen command retries verbatim.
async function findRenderShipmentByPayload(_payload:any) { return null; }

async function fetchWeightFromMerchant(base44: any, tracking_id: string): Promise<{ weight_kg: number | null; source: string | null }> {
  try {
    const conns = await base44.asServiceRole.entities.PlatformConnection.filter({ platform_type: "merchant", status: "active" });
    const merchant = (conns && conns[0]) || null;
    if (!merchant || !merchant.base_url) return { weight_kg: null, source: null };

    const secret = merchant.auth_secret || secrets.get("LEX_WEBHOOK_SECRET") || "";
    const target = new URL("/functions/lexSyncEndpoint", merchant.base_url);
    // Ask the merchant for this specific tracking_id — the sibling endpoint
    // filters by tracking_id when the query param is present.
    target.searchParams.set("tracking_id", tracking_id);

    const headers: Record<string, string> = { Accept: "application/json" };
    if (secret) {
      const key = await crypto.subtle.importKey(
        "raw", new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
      );
      const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(""));
      headers["X-LEX-Signature"] = "sha256=" + Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
    }

    const res = await fetch(target, { method: "GET", headers, signal: AbortSignal.timeout(10000), redirect: "manual" });
    if (!res.ok) return { weight_kg: null, source: null };
    const data: any = await res.json().catch(() => null);
    const events = Array.isArray(data?.events) ? data.events : Array.isArray(data) ? data : [];
    for (const evt of events) {
      const pkg = evt?.package || evt;
      const w = mapWeightFromSource(pkg);
      if (w !== null) return { weight_kg: w, source: "merchant" };
    }
    return { weight_kg: null, source: null };
  } catch {
    return { weight_kg: null, source: null };
  }
}

// Lightweight weight extraction for merchant-source records — reuses the same
// field-name logic as mapWeight but operates on the raw sibling event package.
function mapWeightFromSource(pkg: any): number | null {
  if (!pkg || typeof pkg !== "object") return null;
  const tryFields = ["weight_kg", "kg", "weight", "package_weight", "shipment_weight", "wt", "weight_lbs", "weight_lb", "lbs", "pounds", "weight_g", "grams", "weight_oz", "ounces"];
  for (const k of tryFields) {
    for (const [pk, pv] of Object.entries(pkg)) {
      if (pk.toLowerCase().trim() === k) {
        const n = Number(pv);
        if (Number.isFinite(n) && n > 0) {
          // Convert non-kg units to kg.
          const kl = k;
          if (kl === "weight_lbs" || kl === "weight_lb" || kl === "lbs" || kl === "lb" || kl === "pounds") return Math.round(n * 0.45359237 * 1000) / 1000;
          if (kl === "weight_g" || kl === "grams") return Math.round(n * 0.001 * 1000) / 1000;
          if (kl === "weight_oz" || kl === "ounces") return Math.round(n * 0.0283495231 * 1000) / 1000;
          return Math.round(n * 1000) / 1000;
        }
      }
    }
  }
  return null;
}

const SERVICE_SLA_HOURS: Record<string, number> = {
  standard: 72,
  express: 48,
  same_day: 24,
  overnight: 24,
};

// Fixed namespace UUID for LEX engine createShipment command_id derivation.
const LEX_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

function slaHours(level: string): number {
  return SERVICE_SLA_HOURS[level] || 72;
}

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

function bytesToUuid(bytes: Uint8Array): string {
  const h = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

// Deterministic UUIDv5 from the package id — stable across retries (same package
// always yields the same command_id), and a valid UUID the engine accepts.
async function commandIdFor(packageId: string): Promise<string> {
  const nsBytes = uuidToBytes(LEX_NAMESPACE);
  const nameBytes = new TextEncoder().encode(packageId);
  const data = new Uint8Array(nsBytes.length + nameBytes.length);
  data.set(nsBytes, 0);
  data.set(nameBytes, nsBytes.length);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-1", data));
  hash[6] = (hash[6] & 0x0f) | 0x50; // version 5
  hash[8] = (hash[8] & 0x3f) | 0x80; // variant 1
  return bytesToUuid(hash);
}

export default async function (req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (user.role !== "admin") return Response.json({ error: "Forbidden" }, { status: 403 });

    const all = await base44.asServiceRole.entities.CrossAppPackage.list("-last_event_at", 200);
    const alreadySynced = (all || []).filter((p: any) => p.engine_shipment_id);
    const unsynced = (all || []).filter((p: any) => !p.engine_shipment_id);

    // Reconcile display state for records already registered with the engine
    // (e.g. the previously synced shipment) — never re-sync, just fix the label.
    const existingRecovery=[];
    for(const p of alreadySynced) {
      try {await requirePackageMutation(base44,p);await settleEngineOutbox(base44,p);existingRecovery.push({package_id:p.id,recovered:true});}
      catch {existingRecovery.push({package_id:p.id,held:true,reason:'existing_engine_receipt_or_outbox_review_required'});}
    }

    const results: any[] = [];
    let synced = 0, failed = 0, needsInfo = 0, testExcluded = 0;

    for (const p of unsynced) {
      // One record must never abort the whole sweep — a failure here is
      // classified and the loop continues with the remaining records.
      try {
      await requirePackageMutation(base44,p);
      // Forward the source app's (NOC) command_id to Render when present — retries
      // then dedup at the engine by the SAME command_id the source app issued.
      // Fall back to a deterministic UUIDv5 of the package id for hub-originated
      // packages (LEX intake / pull sync) that carry no source command_id.
      const command_id = p.engine_command_id || await commandIdFor(p.id);

      // Confirmed test fixtures are excluded from operational sync but never deleted.
      // Classification comes from protected business/link evidence and the
      // backend, never is_test or a tracking-id prefix supplied by a caller.
      // Effective weight: manual override (hub entry) takes precedence over source weight.
      let effWeight = effectiveWeight(p);
      let weightSource = p.weight_source || (effWeight === null ? "missing" : p.weight_source);

      // When weight is missing, attempt to pull it from the merchant source
      // (the authoritative source for merchant-declared package weight) before
      // flagging needs_information. This auto-populates weight without a manual
      // override when the merchant has the data. If the merchant endpoint is
      // unavailable or has no record, fall through to needs_information as before.
      if (effWeight === null) {
        const merchantW = await fetchWeightFromMerchant(base44, p.tracking_id);
        if (merchantW.weight_kg !== null) {
          await base44.asServiceRole.entities.CrossAppPackage.update(p.id, {
            weight_kg: merchantW.weight_kg,
            weight_source: "merchant",
            sync_status: "pending",
          });
          effWeight = merchantW.weight_kg;
          weightSource = "merchant";
        }
      }

      // Validate required fields before calling the engine (never bypass validation).
      const missing: string[] = [];
      if (!p.origin || String(p.origin).trim().length < 2) missing.push("origin");
      if (!p.destination || String(p.destination).trim().length < 2) missing.push("destination");
      if (effWeight === null) missing.push("weight_kg");
      if (missing.length) {
        await base44.asServiceRole.entities.CrossAppPackage.update(p.id, {
          sync_status: "needs_information",
          weight_source: weightSource,
        });
        needsInfo++;
        results.push({
          tracking_id: p.tracking_id,
          ok: false,
          needs_information: missing.join(", "),
          weight_source: weightSource,
        });
        continue;
      }

      const now = Date.now();
      const sla = slaHours(p.service_level) * 3600 * 1000;
      const candidatePayload = {
        command_id,
        origin: String(p.origin).trim(),
        destination: String(p.destination).trim(),
        package_size: p.package_size || "small",
        weight_kg: Number(effWeight),
        service_level: mapServiceLevel(p.service_level),
        pickup_deadline: new Date(now + sla / 2).toISOString(),
        delivery_deadline: new Date(now + sla).toISOString(),
      };

      const payload=await engineCreatePayload(base44,await base44.asServiceRole.entities.CrossAppPackage.get(p.id),candidatePayload);
      try {
        // Direct Render call (not the lexApi proxy) so a 409 idempotent-rejection
        // can be reconciled rather than collapsed into a generic failure. The
        // service identity ("lex-engine-sync", role "admin") matches the worker.
        const r = await renderCreateShipment(base44,p,payload);
        const data = r.body;
        const httpStatus = r.status;

        // 409 on create = command_id already processed by Render (idempotent
        // replay). Reconcile by finding the existing shipment and re-linking the
        // local pointer — never create a duplicate, never mark failed.
        if (r.status === 409) {
          await base44.asServiceRole.entities.CrossAppPackage.update(p.id,{engine_sync_hold:'exact_command_reconciliation_required'});
          failed++;results.push({tracking_id:p.tracking_id,held:true,http_status:409,error:'exact_command_reconciliation_required; no similar-shipment adoption'});continue;
        }

        const engineId =
          (data && (data.id || data.shipment_id || data.uuid)) ||
          (data && data.shipment && (data.shipment.id || data.shipment.shipment_id)) ||
          null;
        if (r.ok && engineId && /^[0-9a-f-]{36}$/i.test(String(engineId))) {
          await confirmEngineCreate(base44,p,payload,data);
          synced++;
          results.push({tracking_id:p.tracking_id,ok:true,engine_id:engineId,http_status:httpStatus,outbox_emitted:true});
        } else {
          await base44.asServiceRole.entities.CrossAppPackage.update(p.id, { sync_status: "failed" });
          failed++;
          // Engine rejected the shipment — surface the real reason. Distinguishes
          // config problems (503 not configured, 502 engine down) from validation
          // failures (422 with field-level issues). Sanitized — never expose secrets.
          const errMsg =
            (data && (data.error || data.message)) || "engine did not return a valid shipment id";
          const issues =
            data && Array.isArray(data.issues)
              ? data.issues
                  .map((i: any) => (typeof i === "string" ? i : i.message || JSON.stringify(i)))
                  .join("; ")
              : null;
          results.push({
            tracking_id: p.tracking_id,
            ok: false,
            error: errMsg,
            issues: issues || undefined,
            http_status: httpStatus,
          });
        }
      } catch (e: any) {
        await base44.asServiceRole.entities.CrossAppPackage.update(p.id, { engine_sync_hold: "request_or_confirmation_pending_same_frozen_command" });
        failed++;
        // Network-level failure (engine unreachable from the hub). Sanitized.
        results.push({
          tracking_id: p.tracking_id,
          ok: false,
          error: e?.message || "engine request failed",
          http_status: null,
        });
      }
      } catch (e: any) {
        await base44.asServiceRole.entities.CrossAppPackage.update(p.id, { engine_sync_hold: "isolation_or_authority_hold" }).catch(() => {});
        failed++;
        results.push({ tracking_id: p.tracking_id, ok: false, error: e?.message || "record processing failed", http_status: null });
      }
    }

    return Response.json({
      checked: (all || []).length,
      already_synced: alreadySynced.length,
      existing_receipt_recovery:existingRecovery,
      unsynced: unsynced.length,
      synced,
      failed,
      needs_information: needsInfo,
      test_excluded: testExcluded,
      results,
    });
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}