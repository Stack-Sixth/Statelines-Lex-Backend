import {createClientFromRequest} from 'npm:@base44/sdk@0.8.52';
import {secrets} from 'base44:runtime';
import {recordAuthority} from '../../shared/serverRecord.ts';
import {resolveBookingMerchant} from '../../shared/bookingMerchant.ts';
import {loadVerifiedAuthority} from '../../shared/domainMerchant.ts';
import {evaluateForAuthority,exceptionContext} from '../../shared/bookingExceptionRuntime.ts';
import {findExceptionByMerchant} from '../../shared/bookingException.ts';
import {finalizeIntent,ClaimPending,claimResponse} from '../../shared/casBooking.ts';
// Separate test-only intake. Normal Merchant finalizeShipment still rejects
// synthetic payment calls. This handler NEVER imports Stripe or dispatch code.
export default async function(req:Request):Promise<Response> {
 try {
  if(req.method!=='POST')return Response.json({error:'Method not allowed'},{status:405});
  const b=createClientFromRequest(req),user=await b.auth.me().catch(()=>null);
  if(!user)return Response.json({error:'Unauthorized'},{status:401});
  const body=await req.json();
  if(Object.keys(body).some(k=>!['draft_id','quote_id'].includes(k)))return Response.json({error:'Only existing draft/quote identifiers accepted'},{status:400});
  const sr=b.asServiceRole,merchant=await resolveBookingMerchant(sr,user);
  const registered=merchant&&findExceptionByMerchant({local_merchant_id:merchant.id});
  if(!registered||registered.approved_user_id!==user.id)return Response.json({error:'Approved synthetic business/account required'},{status:403});
  const authority=await loadVerifiedAuthority(sr,user);
  const release=evaluateForAuthority(authority,{id:user.id},merchant,exceptionContext());
  if(!authority.ready||!release.open||authority.isolation?.evidenced!==true||authority.isolation?.sandbox_isolated!==true)
   return Response.json({error:'controlled_test_closed',code:release.code},{status:409});
  const D=sr.entities.ShipmentDraft,Q=sr.entities.ShipmentQuote;
  const draft=await D.get(String(body.draft_id||'')),quote=await Q.get(String(body.quote_id||''));
  const proof=recordAuthority(secrets.get('MERCHANT_RECORD_SIGNING_SECRET'));
  if(!await proof.trusted('ShipmentDraft',draft)||draft.server_owner_user_id!==user.id||draft.merchant_id!==merchant.id||
     quote.user_id!==user.id||quote.merchant_id!==merchant.id)return Response.json({error:'Not found'},{status:404});
  // Fixture values are server-defined, not caller parcels/contact/payment data.
  if(Number(quote.rewards_points||0)!==0)return Response.json({error:'Synthetic rewards are disabled'},{status:409});
  if(Number(quote.weight_lb)!==1||String(quote.service_level)!=='standard'||Number(quote.declared_value)!==0||quote.insurance===true)
   return Response.json({error:'Test quote must be standard, 1 lb, declared value 0, no insurance'},{status:409});
  if(draft.booking_claim&&draft.booking_claim.snapshot?.test_harness!==true)throw new ClaimPending('different_intent_requires_review');
  if(!Number.isFinite(Number(quote.amount))||Number(quote.amount)<0)return Response.json({error:'Invalid server quote'},{status:409});
  const now=Date.now();
  const shipment=await finalizeIntent(sr.entities,draft.id,quote.id,{user_id:user.id,merchant_id:merchant.id,edit_revision:draft.edit_revision},{
   test_harness:true,sandbox_isolated:true,merchant_id:merchant.id,merchant_name:'Synthetic controlled test',
   origin_address:'Synthetic origin — DO NOT DISPATCH',destination_address:'Synthetic destination — DO NOT DISPATCH',
   origin_city:'Synthetic Alpha/Beta',destination_city:'Synthetic Alpha/Beta',weight_lb:1,weight_kg:0.45359237,
   service_level:'standard',package_size:'small',description:'Synthetic clothing fixture; no physical parcel',
   status:'created',domain_status:'pending',sync_status:'pending',version:1,
   cost:Number(quote.amount),quoted_amount:Number(quote.amount),currency:quote.currency||'USD',quote_id:quote.id,quote_ref:quote.quote_ref||'',
   payment_capture_status:'synthetic_disabled',pricing_authority:'synthetic_test_quote_only',
   tracking_number:'STL-TEST-'+crypto.randomUUID().replaceAll('-','').toUpperCase(),
   pickup_deadline:new Date(now+86400000).toISOString(),delivery_deadline:new Date(now+3*86400000).toISOString(),
   isolation_evidence:{merchant_id:authority.identity!.domain_merchant_id,client_id:authority.identity!.client_id,
    signing_subject:authority.identity!.signing_subject,checked_at:new Date(now).toISOString(),backend_reported_isolated:true},
  },proof,true);
  return Response.json({shipment,synthetic:true,payment_calls:0,operational_dispatch:false,
   next:'createOrderOnRender uses a fresh identity/isolation probe and the same persisted canonical command'});
 } catch(e) {return claimResponse(e)||Response.json({error:'Controlled test creation failed; retain draft and reconcile'},{status:409});}
}
