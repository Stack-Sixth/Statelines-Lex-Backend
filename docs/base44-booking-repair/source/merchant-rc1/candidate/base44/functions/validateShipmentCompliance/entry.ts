import {claimResponse} from "../../shared/casBooking.ts";
import {artifactPlan,verifiedPlan} from "../../shared/artifactProjection.ts";
import {resolveBookingMerchant} from "../../shared/bookingMerchant.ts";
import {secrets} from "base44:runtime";
import {recordAuthority,recordOwner} from "../../shared/serverRecord.ts";
import {settleBookingDeclaration} from "../../shared/declarationProjection.ts";
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';
import { validateCompliance, POLICY_VERSION } from '../../shared/shippingPolicy.ts';
import { overRateLimit } from '../../shared/rateLimit.ts';

// Server-side shipment compliance validation with AI content screening.
//
// Defense-in-depth for the Statelines Zero-Hazmat policy:
//   1. Rule-based policy check (keywords, category, battery) — validateCompliance.
//   2. AI semantic screening — catches disguised prohibited items and
//      category/description mismatches the keyword list misses.
//   3. Default-deny review loop — only explicitly permitted items pass;
//      anything suspicious or unclassified routes to a ComplianceReview
//      queue. An admin-approved review lets the item pass on re-validation.
//
// Actions:
//   - "validate" (default): returns the compliance decision (policy + AI).
//   - "request_review": creates a ComplianceReview record (restricted/unknown).
//   - "record_declaration": creates a ShipperDeclaration record.
//   - "approve"/"reject"/"request_info": admin reviews a pending ComplianceReview.
//
// Enforcement is server-side: the client cannot bypass this check. Blocked
// shipments (restricted, prohibited, unknown) must not proceed to creation.

const SCREEN_SCHEMA = {
  type: 'object',
  properties: {
    assessment: { type: 'string', enum: ['permitted', 'restricted', 'prohibited'] },
    mismatch: { type: 'boolean' },
    reason: { type: 'string' },
    detected_concerns: { type: 'array', items: { type: 'string' } },
  },
  required: ['assessment', 'mismatch', 'reason'],
};

function screenPrompt(itemCategory, contentsDescription) {
  return [
    'You are a parcel shipping compliance screener for Statelines, a US parcel logistics network.',
    'A shipper declared the following item category and free-text contents description.',
    'Determine:',
    '1. Whether the description plausibly matches the declared category. A mismatch suggests misdeclaration (shipping a restricted/prohibited item under a permitted category).',
    '2. Whether the contents contain or disguise a prohibited item: explosives, compressed gases, flammable liquids, toxic/corrosive materials, loose or damaged lithium batteries, illegal drugs, firearms/weapons, alcohol, tobacco, vaping products, cannabis/CBD, perishable foods, live animals, or cremated remains.',
    '3. Whether the contents are restricted and need manual review: large-format or industrial batteries, alcohol-based sanitizers or cosmetics, or anything ambiguous.',
    '',
    'Declared category: ' + itemCategory,
    'Contents description: ' + contentsDescription,
    '',
    'Respond with JSON: { "assessment": "permitted" | "restricted" | "prohibited", "mismatch": boolean, "reason": string, "detected_concerns": string[] }',
    '- "permitted": the description plausibly matches the category and raises no prohibited/restricted concerns.',
    '- "restricted": the contents are plausibly restricted, OR the description mismatches the declared category (needs manual review).',
    '- "prohibited": the contents are or disguise a prohibited item.',
    'Be conservative: when uncertain, prefer "restricted" over "permitted". Keep the reason to one sentence.',
  ].join('\n');
}

// Run the AI semantic screen. Fail-safe: any error returns ok:false so the
// caller routes the shipment to manual review instead of auto-approving.
async function screenContents(base44, itemCategory, contentsDescription) {
  try {
    const llmRes = await base44.asServiceRole.integrations.Core.InvokeLLM({
      prompt: screenPrompt(itemCategory, contentsDescription),
      response_json_schema: SCREEN_SCHEMA,
    });
    const screen = typeof llmRes === 'string' ? JSON.parse(llmRes) : llmRes;
    if (!screen || !screen.assessment) return { ok: false, error: 'No assessment returned.' };
    return {
      ok: true,
      assessment: screen.assessment,
      mismatch: !!screen.mismatch,
      reason: String(screen.reason || ''),
      concerns: Array.isArray(screen.detected_concerns) ? screen.detected_concerns : [],
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function normalizeDesc(s) {
  return String(s || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

// Default-deny review loop: if a ComplianceReview for this merchant + category +
// contents was already approved by an admin, the item is cleared to ship.
async function findApprovedReview(base44, merchantId, itemCategory, contentsDescription, details) {
  if (!merchantId || !itemCategory) return null;
  try {
    const target = normalizeDesc(contentsDescription);
    const { items } = await base44.asServiceRole.entities.ComplianceReview.filter(
      { merchant_id: merchantId, item_category: itemCategory, compliance_status: 'approved' },
      { sort: '-created_date', limit: 20 }
    );
    for(const r of items||[]) {
      const plan=r.approval_proof;
      if(normalizeDesc(r.contents_description)!==target || !await verifiedPlan(plan,r.id,'ComplianceReviewApproval',secrets.get('MERCHANT_RECORD_SIGNING_SECRET')))continue;
      const a=plan.document;
      if(a.decision!=='approved'||a.policy_version!==POLICY_VERSION||a.merchant_id!==merchantId||a.item_category!==itemCategory||normalizeDesc(a.contents_description)!==target)continue;
      if(a.quantity!==details.quantity||a.has_battery!==details.hasBattery||a.battery_details!==details.batteryDetails)continue;
      return r;
    }
    return null;
  } catch {
    return null;
  }
}

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const itemCategory = String(body.item_category || '').trim().slice(0, 80);
    const contentsDescription = String(body.contents_description || '').trim().slice(0, 500);
    const quantity = Math.max(1, Math.min(Number(body.quantity) || 1, 1000));
    const hasBattery = !!body.has_battery;
    const batteryDetails = String(body.battery_details || '').trim().slice(0, 300);
    const action = String(body.action || 'validate');
    let merchantId = String(body.merchant_id || '').slice(0, 100);
    const shipmentId = String(body.shipment_id || '').slice(0, 100);
    const shipmentDraftId = String(body.shipment_draft_id || '').slice(0, 100);

    if(action==='list_reviews') {
      const sr=base44.asServiceRole;
      const all=await sr.entities.ComplianceReview.filter(user.role==='admin'?{}:{$or:[{server_owner_user_id:user.id},{created_by_id:user.id}]},{sort:'-created_date',limit:50});
      const rows=Array.isArray(all)?all:all.items||[],proof=recordAuthority(secrets.get('MERCHANT_RECORD_SIGNING_SECRET'));
      const items=[];
      for(const row of rows)if(user.role==='admin'||await recordOwner('ComplianceReview',row,proof)===user.id)items.push(row);
      return Response.json({items,bounded_scan:true});
    }
    if (action === 'record_declaration') {
      const sr=base44.asServiceRole;
      const row=shipmentId?await sr.entities.Shipment.get(shipmentId).catch(()=>null):null;
      const proof=recordAuthority(secrets.get('MERCHANT_RECORD_SIGNING_SECRET'));
      if(!row||await recordOwner('Shipment',row,proof)!==user.id)return Response.json({error:'Shipment not found'},{status:404});
      if(!await proof.trusted('Shipment',row))return Response.json({pending:true,code:'legacy_declaration_review_required'},{status:202});
      const id=await settleBookingDeclaration(sr.entities,row,secrets.get('MERCHANT_RECORD_SIGNING_SECRET')!);
      return Response.json({status:row.compliance_evidence?.status,declaration_id:id,duplicate:true});
    }

    // Rate limit: each validation can run a billable AI screening pass, so
    // scripted floods are throttled. Admin review actions are exempt (low
    // volume, admin-gated).
    if (action !== 'approve' && action !== 'reject' && action !== 'request_info') {
      if (await overRateLimit(base44, user.id, 'validate_shipment_compliance')) {
        return Response.json(
          { error: 'Too many compliance checks. Please wait a minute before trying again.' },
          { status: 429 }
        );
      }
    }

    // The approved-review fast-path keys on merchant_id; a spoofed id could
    // otherwise let one shipment borrow another merchant's compliance
    // approval. Only the merchant's owner (or an admin) may pass it through.
    if (merchantId && user.role !== 'admin') {
      const merchant = await base44.entities.Merchant.get(merchantId).catch(() => null);
      if (!merchant || merchant.created_by_id !== user.id) merchantId = '';
    }

    // --- Admin review actions (admin-only, stamps reviewer_id server-side) ---
    // These don't need contents_description — they operate on a review_id.
    if (action === 'approve' || action === 'reject' || action === 'request_info') {
      if (user.role !== 'admin') return Response.json({ error: 'Forbidden — admin only.' }, { status: 403 });
      const reviewId = String(body.review_id || '');
      if (!reviewId) return Response.json({ error: 'review_id is required.' }, { status: 400 });
      const newStatus = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'additional_info_required';
      const sr=base44.asServiceRole,row=await sr.entities.ComplianceReview.get(reviewId);
      const actualOwner=await recordOwner('ComplianceReview',row,recordAuthority(secrets.get('MERCHANT_RECORD_SIGNING_SECRET')));
      const business=await sr.entities.Merchant.get(String(row.merchant_id||'')).catch(()=>null);
      if(!actualOwner||!business||business.created_by_id!==actualOwner)return Response.json({error:'Independent review/business ownership evidence required'},{status:409});
      const approvalProof=newStatus==='approved'?await artifactPlan(secrets.get('MERCHANT_RECORD_SIGNING_SECRET'),row.id,'ComplianceReviewApproval',{
        merchant_id:row.merchant_id,item_category:row.item_category,contents_description:row.contents_description,
        quantity:row.quantity,has_battery:row.has_battery,battery_details:row.battery_details,
        reviewer_id:user.id,decision:'approved',policy_version:POLICY_VERSION,
      }):{};
      const changed=await sr.entities.ComplianceReview.updateMany({id:row.id,compliance_status:row.compliance_status},{$set:{
        compliance_status:newStatus,reviewer_note:String(body.reviewer_note||'').trim().slice(0,500),reviewer_id:user.id,
        reviewed_at:new Date().toISOString(),approval_proof:approvalProof,
      }});
      if(changed?.updated!==1)return Response.json({error:'Review changed; reload before deciding'},{status:409});
      return Response.json({ ok: true, review_id: reviewId, compliance_status: newStatus });
    }

    if (!contentsDescription) {
      return Response.json({ error: 'Contents description is required.' }, { status: 400 });
    }

    // 1. Authoritative server-side policy validation.
    let result = validateCompliance({ itemCategory, contentsDescription, quantity, hasBattery, batteryDetails });
    let approvedViaReview = false;

    // Default-deny review loop: a previously admin-approved review clears the item.
    if (result.status !== 'permitted') {
      const approved = await findApprovedReview(base44, merchantId, itemCategory, contentsDescription,{quantity,hasBattery,batteryDetails});
      if (approved) {
        result = {
          ...result,
          status: 'permitted',
          reason: 'Item approved via compliance review (' + approved.id + '). Cleared to ship under the approved conditions.',
          packagingConditions: 'Ship under the conditions noted in the approved compliance review.',
          reviewRequired: false,
          approvedReviewId: approved.id,
        };
        approvedViaReview = true;
      }
    }

    // 2. AI semantic screening — only for items that passed the policy check and
    //    were not already cleared by an approved review. Runs on both validate
    //    and request_review so the review record captures the AI flag. Fail-safe
    //    to restricted (manual review) if the screen cannot complete.
    if ((action === 'validate' || action === 'request_review') && result.status === 'permitted' && !approvedViaReview) {
      const screen = await screenContents(base44, itemCategory, contentsDescription);
      if (!screen.ok) {
        result = {
          ...result,
          status: 'restricted',
          reason: 'Automated compliance screening could not be completed. Manual review is required before this shipment can proceed.',
          packagingConditions: 'Pending compliance review.',
          reviewRequired: true,
          screening: { ok: false, error: screen.error },
        };
      } else if (screen.assessment === 'prohibited') {
        result = {
          ...result,
          status: 'prohibited',
          reason: 'AI screening flagged this item as prohibited: ' + screen.reason,
          packagingConditions: 'Not shippable via Statelines.',
          reviewRequired: false,
          screening: { ok: true, assessment: screen.assessment, mismatch: screen.mismatch, reason: screen.reason, concerns: screen.concerns },
        };
      } else if (screen.assessment === 'restricted' || screen.mismatch) {
        result = {
          ...result,
          status: 'restricted',
          reason: 'AI screening flagged this item for manual review: ' + screen.reason + (screen.mismatch ? ' (declared category does not match the described contents).' : ''),
          packagingConditions: 'Pending compliance review — submit product specifications and packaging details.',
          reviewRequired: true,
          screening: { ok: true, assessment: screen.assessment, mismatch: screen.mismatch, reason: screen.reason, concerns: screen.concerns },
        };
      } else {
        result = {
          ...result,
          screening: { ok: true, assessment: 'permitted', mismatch: false, reason: screen.reason, concerns: screen.concerns },
        };
      }
    }

    // 3. Create a compliance review request for restricted or unknown items.
    if (action === 'request_review' && (result.status === 'restricted' || result.status === 'unknown')) {
      const owned=await resolveBookingMerchant(base44.asServiceRole,user);
      if(!owned||merchantId!==owned.id)return Response.json({error:'Authorized merchant required'},{status:403});
      const proof=recordAuthority(secrets.get('MERCHANT_RECORD_SIGNING_SECRET'));
      const review = await base44.asServiceRole.entities.ComplianceReview.create({
        ...await proof.mint('ComplianceReview',user.id,owned.id),
        merchant_id: merchantId,
        shipment_id: shipmentId,
        shipment_draft_id: shipmentDraftId,
        item_category: itemCategory,
        contents_description: contentsDescription,
        quantity,
        has_battery: hasBattery,
        battery_details: batteryDetails,
        compliance_status: 'pending_review',
        validation_status: result.status,
        validation_reason: result.reason,
        policy_version: POLICY_VERSION,
      });
      return Response.json({ ...result, review_id: review.id });
    }

    return Response.json(result);
  } catch (error) {
    const pending=claimResponse(error);if(pending)return pending;
    console.error('validateShipmentCompliance error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}