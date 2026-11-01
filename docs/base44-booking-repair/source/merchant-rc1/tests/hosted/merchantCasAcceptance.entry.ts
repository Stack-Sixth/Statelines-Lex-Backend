import {transitionCustody,settleCustody} from "../../shared/custodyRecovery.ts";
// DEVELOPMENT-ONLY function. Do NOT put this in the production apply/ tree.
// Install at base44/functions/merchantCasAcceptance/entry.ts in a disposable copy.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.52";
import { secrets } from "base44:runtime";
import { finalizeShipmentWithDependencies } from "../finalizeShipment/entry.ts";
import { customerShipment } from "../../shared/customerShipment.ts";
import { recordAuthority } from "../../shared/serverRecord.ts";
import * as cas from "../../shared/casBooking.ts";
import { resolveCallerMerchant } from "../../shared/portalMemberships.ts";
import { settlePrice, RATE_VERSION, round2 } from "../../shared/rateQuote.ts";
const list = (r: any) => (Array.isArray(r) ? r : r?.items || []);
const check = (ok: boolean, code: string) => {
  if (!ok) throw { acceptanceCode: code };
};
export default async function (req: Request): Promise<Response> {
  const fixtures: any[] = [];
  let phase = "guard";
  try {
    const b = createClientFromRequest(req),
      admin = await b.auth.me();
    if (admin?.role !== "admin")
      return Response.json({ error: "Admin only" }, { status: 403 });
    const body = await req.json();
    const appId = (b as any).getConfig?.().appId;
    check(
      !!appId && appId !== "6a7a16095324cf70f0965bef" &&
        appId === secrets.get("MERCHANT_ACCEPTANCE_APP_ID") &&
        appId === body.disposable_app_id,
      "disposable_app_id_mismatch",
    );
    check(
      secrets.get("MERCHANT_ACCEPTANCE_DISPOSABLE") === "true",
      "disposable_confirmation_missing",
    );
    for (const flag of [
      "BOOKING_RELEASE_ENABLED",
      "BOOKING_EXCEPTION_ENABLED",
      "EXCEPTION_ISOLATION_CONFIRMED",
      "DOMAIN_TEST_HARNESS_ENABLED",
      "TEST_PAYMENT_ENABLED",
    ])
      check(
        String(secrets.get(flag) || "").toLowerCase() !== "true",
        "real_gates_must_stay_closed",
      );
    for (const name of [
      "STRIPE_SECRET_KEY",
      "STRIPE_SANDBOX_SECRET_KEY",
      "LEX_API_URL",
      "LEX_SERVICE_CLIENT_SECRET",
      "LEX_WEBHOOK_SECRET",
      "LEX_HUB_URL",
      "PLATFORM_SYNC_SECRET",
    ])
      check(!secrets.get(name), "provider_or_outbound_configuration_present");
    const sr = b.asServiceRole,
      owner = await sr.entities.User.get(String(body.test_user_id || ""));
    check(
      !!owner?.id && owner.role !== "admin",
      "non_admin_test_user_required",
    );
    const merchant = await resolveCallerMerchant(sr, owner);
    check(!!merchant?.id, "test_merchant_required");
    const allowed = JSON.parse(
      secrets.get("MERCHANT_ACCEPTANCE_MERCHANT_IDS_JSON") || "[]",
    );
    check(
      Array.isArray(allowed) &&
        allowed.includes(merchant.id) &&
        allowed.length <= 2,
      "approved_test_business_required",
    );
    const proof = recordAuthority(
      secrets.get("MERCHANT_RECORD_SIGNING_SECRET"),
    );
    const details = {
      origin_address: "SYNTHETIC TEST ORIGIN",
      destination_address: "SYNTHETIC TEST DESTINATION",
      origin_city: "Test A",
      destination_city: "Test B",
      weight_lb: 1,
      declared_value: 0,
      service_level: "standard",
      insurance: false,
    };
    const price = settlePrice({
      ...details,
      promo_code: "",
      rewards_points: 0,
    });
    const make = async () => {
      const draft = await sr.entities.ShipmentDraft.create({
        ...(await proof.mint("ShipmentDraft", owner.id, merchant.id)),
        user_id: owner.id,
        data: details,
        status: "draft",
        edit_revision: 0,
      });
      const quote = await sr.entities.ShipmentQuote.create({
        user_id: owner.id,
        merchant_id: merchant.id,
        status: "open",
        weight_lb: 1,
        declared_value: 0,
        service_level: price.service_level,
        insurance: false,
        amount: price.total,
        currency: price.currency,
        rate_version: RATE_VERSION,
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      });
      fixtures.push({ draft_id: draft.id, quote_id: quote.id });
      return { draft, quote };
    };
    const run = (f: any, entities: any = sr.entities, extra: any = {}) =>
      finalizeShipmentWithDependencies(
        new Request("https://isolated-test.invalid/finalize", {
          method: "POST",
          body: JSON.stringify({
            draft_id: f.draft.id,
            shipment: { ...details, ...extra },
            quote: { quote_id: f.quote.id, accepted_total: price.total },
          }),
        }),
        {
          ...cas,
          customerShipment,
          recordAuthority,
          createClientFromRequest: () => ({
            auth: { me: async () => owner },
            asServiceRole: { entities },
          }),
          // Only this private test invocation uses a stubbed open gate/card. Real secrets
          // stay closed/unset and production default handler dependencies are unchanged.
          secrets: {
            get: (name: string) =>
              name === "BOOKING_RELEASE_ENABLED"
                ? "true"
                : name === "MERCHANT_RECORD_SIGNING_SECRET"
                  ? secrets.get(name)
                  : name === "STRIPE_SECRET_KEY"
                    ? "UNIT-NO-PROVIDER-KEY"
                    : undefined,
          },
          findExceptionByMerchant: () => null,
          resolveCallerMerchant: async () => merchant,
          // Provider/compliance seams are deliberately stubbed in this STORAGE test.
          // Default hosted auth/compliance/payment acceptance is a separate procedure.
          screenBooking:async()=>({status:'permitted',policy_version:'DISPOSABLE-TEST',accepted_by:owner.id,declaration:{item_category:'clothing',contents_description:'Synthetic storage fixture'}}),
          settleBookingDeclaration:async()=>{},settleBookingNotification:async()=>{},
          resolveSavedCard: async () => ({
            paymentMethod: {
              id: "pm_UNIT_NO_NETWORK",
              card: { brand: "test", last4: "0000" },
            },
          }),
          settlePrice,
          RATE_VERSION,
          round2,
        } as any,
      );
    const count = async (f: any) =>
      list(
        await sr.entities.Shipment.filter({
          booking_intent: "draft:" + f.draft.id,
        }),
      );
    const results = [];
    phase = "concurrent_handlers";
    const f = await make();
    await Promise.all(Array.from({ length: 8 }, () => run(f)));
    await run(f);
    let rows = await count(f);
    check(rows.length === 1, "concurrent_duplicate_local_rows");
    check(
      (await sr.entities.ShipmentQuote.get(f.quote.id))
        .consumed_by_shipment_id === rows[0].id,
      "quote_consumption_mismatch",
    );
    results.push({
      case: "eight_concurrent_handlers",
      passed: true,
      local_rows: 1,
    });
    phase = "lost_insert_ack";
    const lost = await make();
    let once = true;
    const shipmentProxy = new Proxy(sr.entities.Shipment, {
      get(t: any, k: any) {
        if (k === "create")
          return async (v: any) => {
            const r = await t.create(v);
            if (once) {
              once = false;
              throw new Error("injected_lost_ack");
            }
            return r;
          };
        const v = t[k];
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const lostEntities = new Proxy(sr.entities, {
      get(t: any, k: any) {
        return k === "Shipment" ? shipmentProxy : t[k];
      },
    });
    check(
      (await run(lost, lostEntities)).status === 202,
      "lost_insert_not_pending",
    );
    await run(lost);
    check((await count(lost)).length === 1, "lost_insert_duplicated");
    results.push({ case: "lost_insert_ack_recovery", passed: true });
    phase = "crash_before_insert";
    const stopped = await make();
    once = true;
    const draftProxy = new Proxy(sr.entities.ShipmentDraft, {
      get(t: any, k: any) {
        if (k === "updateMany")
          return async (q: any, v: any) => {
            const r = await t.updateMany(q, v);
            if (
              once &&
              r.updated === 1 &&
              v.$set.booking_state === "creating"
            ) {
              once = false;
              throw new Error("injected_crash");
            }
            return r;
          };
        const v = t[k];
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const stoppedEntities = new Proxy(sr.entities, {
      get(t: any, k: any) {
        return k === "ShipmentDraft" ? draftProxy : t[k];
      },
    });
    await run(stopped, stoppedEntities);
    check((await run(stopped)).status === 202, "pre_insert_crash_not_pending");
    check((await count(stopped)).length === 0, "uncertain_insert_retried");
    results.push({ case: "crash_before_insert_no_retry", passed: true });
    phase = "primed_payload";
    const primed = await make();
    await run(primed, sr.entities, {
      command_id: crypto.randomUUID(),
      cancel_command_id: crypto.randomUUID(),
      order_id: "BROWSER-PRIMED",
      domain_merchant_scope: "MER_PRIMED",
      test_harness: true,
    });
    const primedRows = await count(primed);
    check(primedRows.length === 1, "primed_case_missing_row");
    check(
      !primedRows[0].command_id &&
        !primedRows[0].cancel_command_id &&
        !primedRows[0].domain_merchant_scope &&
        primedRows[0].test_harness === false &&
        primedRows[0].order_id !== "BROWSER-PRIMED",
      "primed_fields_persisted",
    );
    results.push({ case: "browser_priming_ignored", passed: true });
    phase = 'custody_artifact_lost_ack';
    const custodyRow=primedRows[0];let lostEventOnce=true;
    const eventProxy=new Proxy(sr.entities.ShipmentEvent,{
      get(t:any,k:any) {
        if(k==='create')return async(data:any)=>{const result=await t.create(data);if(lostEventOnce){lostEventOnce=false;throw new Error('injected_lost_event_ack');}return result;};
        const value=t[k];return typeof value==='function'?value.bind(t):value;
      },
    });
    const custodyEntities=new Proxy(sr.entities,{get(t:any,k:any){return k==='ShipmentEvent'?eventProxy:t[k];}});
    let custodyPending=false;
    try {await transitionCustody(custodyEntities,custodyRow,{from:custodyRow.status,to:'picked_up',actor_id:owner.id,facility:'DISPOSABLE SYNTHETIC FACILITY',custodian:'Synthetic test',location_ids:[]},
      {owner_user_id:owner.id,merchant_id:merchant.id},secrets.get('MERCHANT_RECORD_SIGNING_SECRET')!);}
    catch(e){custodyPending=e?.code==='artifact_insert_unknown';}
    check(custodyPending,'custody_lost_ack_not_pending');
    const recorded=await sr.entities.Shipment.get(custodyRow.id);
    check(recorded.status==='picked_up'&&!!recorded.custody_receipt,'custody_receipt_not_atomic');
    const restored=await settleCustody(sr.entities,recorded,secrets.get('MERCHANT_RECORD_SIGNING_SECRET')!);
    check(restored.custody_projection.phase==='done'&&restored.custody_audit_projection.phase==='done','custody_projection_unsettled');
    const eventRows=list(await sr.entities.ShipmentEvent.filter({server_artifact_ref:recorded.custody_projection.plan.nonce},'-created_date',3));
    check(eventRows.length===1,'custody_event_duplicated');
    results.push({case:'real_storage_custody_lost_ack_recovery',passed:true});
    return Response.json({
      passed: true,
      results,
      fixtures,
      shipment_id: rows[0].id,
      quote_id: f.quote.id,
      draft_id: f.draft.id,
      note: "Real Base44 CAS storage and exact finalizer core; provider seams mocked. No payment/domain/notification acceptance. No fixture deletion.",
    });
  } catch (e) {
    return Response.json(
      {
        passed: false,
        phase,
        fixtures,
        code: e?.acceptanceCode || "storage_or_handler_failure",
        error: "Inspect private function logs and retained disposable fixtures",
      },
      { status: 409 },
    );
  }
}
