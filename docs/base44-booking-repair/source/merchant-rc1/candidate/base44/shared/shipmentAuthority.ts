// Separate ownership, operation authorization and command provenance.
// Service-role access is storage capability, never caller authorization.
import { secrets } from 'base44:runtime';
import { recordAuthority } from './serverRecord.ts';
import { findExceptionByMerchant } from './bookingException.ts';
export const arrayRows=(r:any):any[]=>Array.isArray(r)?r:Array.isArray(r?.items)?r.items:[];
export const SNAPSHOT_FIELDS=['tracking_number','tracking_id','canonical_shipment_id','order_id','origin_address','destination_address','origin_city','destination_city','origin_location_id','destination_location_id','weight_lb','weight_kg','service_level','package_size'];
export function operationSnapshot(row:any) {return Object.fromEntries(SNAPSHOT_FIELDS.map(k=>[k,row[k]??null]));}
export async function snapshotDigest(row:any) {
 const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(operationSnapshot(row))));
 return [...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,'0')).join('');
}
export async function localOwnership(sr:any,row:any) {
 const secret=secrets.get('MERCHANT_RECORD_SIGNING_SECRET');
 if(secret && await recordAuthority(secret).trusted('Shipment',row))return {verified:true,owner_user_id:row.server_owner_user_id,merchant_id:row.merchant_id,command_provenance:'server'};
 // A protected quote's consumption pointer is independent of the editable
 // Shipment.quote_id. Do not trust caller email or merchant_id for this join.
 const quotes=arrayRows(await sr.entities.ShipmentQuote.filter({consumed_by_shipment_id:row.id,status:'consumed'},'-created_date',3));
 if(quotes.length===1&&quotes[0].user_id&&quotes[0].merchant_id&&(!row.created_by_id||quotes[0].user_id===row.created_by_id))
  return {verified:true,owner_user_id:quotes[0].user_id,merchant_id:quotes[0].merchant_id,command_provenance:'untrusted'};
 if(quotes.length>1)return {verified:false,owner_user_id:null,merchant_id:null,command_provenance:'untrusted'};
 const owner=row.created_by_id;
 if(!owner)return {verified:false,owner_user_id:null,merchant_id:null,command_provenance:'untrusted'};
 const merchants=arrayRows(await sr.entities.Merchant.filter({created_by_id:owner},'-created_date',3));
 return {verified:merchants.length===1,owner_user_id:owner,merchant_id:merchants.length===1?merchants[0].id:null,command_provenance:'untrusted'};
}
export async function operationalAuthority(sr:any,row:any,principal='merchant') {
 const ownership=await localOwnership(sr,row);
 if(!ownership.verified)return {ok:false,code:'ownership_unverified',ownership};
 const server=ownership.command_provenance==='server';let binding:any=null;
 if(!server) {
  const rows=arrayRows(await sr.entities.LegacyShipmentAuthority.filter({shipment_id:row.id,status:'active'},'-created_date',3));
  if(rows.length!==1)return {ok:false,code:rows.length?'ambiguous_legacy_authority':'legacy_operation_unverified',ownership};
  binding=rows[0];const epoch=secrets.get('MERCHANT_AUTHORITY_POLICY_EPOCH');
  if(!epoch||binding.policy_epoch!==epoch||binding.owner_user_id!==ownership.owner_user_id||binding.merchant_id!==ownership.merchant_id||
    binding.snapshot_digest!==await snapshotDigest(row)||!Array.isArray(binding.principals)||!binding.principals.includes(principal))
   return {ok:false,code:'legacy_authority_stale_or_principal_denied',ownership};
 }
 if(server&&row.booking_intent&&row.booking_ready!==true)return {ok:false,code:'finalization_pending',ownership};
 const synthetic=!!findExceptionByMerchant({local_merchant_id:ownership.merchant_id,canonical_merchant_id:binding?.canonical_merchant_id||row.domain_merchant_scope});
 // Legacy caller flags are ignored; only server-owned registry/approval facts count.
 const isolated=synthetic||(server&&row.test_harness===true);
 return {ok:!isolated,code:isolated?'synthetic_isolated':'verified_production',ownership,binding,
   shipment:{...row,merchant_id:ownership.merchant_id,server_owner_user_id:ownership.owner_user_id,test_harness:isolated}};
}
export async function resolveOperationalShipment(sr:any,ref:any,principal:string) {
 const found:any[]=[];
 for(const key of ['shipment_id','tracking_number','tracking_id','canonical_shipment_id']) {
  if(ref[key]===undefined||ref[key]===null||ref[key]==='')continue;
  const value=String(ref[key]);let rows:any[];
  if(key==='shipment_id') {try {rows=[await sr.entities.Shipment.get(value)];}catch{return {ok:false,code:'explicit_reference_unresolved'};}}
  else rows=arrayRows(await sr.entities.Shipment.filter({[key]:value},'-created_date',3));
  if(rows.length!==1)return {ok:false,code:rows.length?'ambiguous_reference':'explicit_reference_unresolved'};
  found.push(rows[0]);
 }
 if(!found.length||found.some(x=>x.id!==found[0].id))return {ok:false,code:'missing_or_conflicting_references'};
 return operationalAuthority(sr,found[0],principal);
}
