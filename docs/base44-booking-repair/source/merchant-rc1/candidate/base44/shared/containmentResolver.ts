import {resolveOperationalShipment} from './shipmentAuthority.ts';
import {unknownSubject,type ResolvedSubject} from './testContainment.ts';
export interface SubjectRef {shipment_id?:unknown;canonical_shipment_id?:unknown;tracking_id?:unknown;tracking_number?:unknown;business_id?:unknown;merchant_id?:unknown;}
export async function resolveShipmentSubject(client:any,ref:SubjectRef,principal="merchant"):Promise<ResolvedSubject> {
 try {
  const result:any=await resolveOperationalShipment(client,ref,principal);
  if(!result.ok && result.code!=='synthetic_isolated')return unknownSubject('unresolved_business',result.code);
  const row=result.shipment,owner=result.ownership;
  if((ref.business_id&&String(ref.business_id)!==owner.merchant_id)||(ref.merchant_id&&String(ref.merchant_id)!==owner.merchant_id))
   return unknownSubject('contradictory','asserted business does not match independently verified ownership');
  return {classification:result.code==='synthetic_isolated'?'synthetic':'production',resolution:'resolved',
   shipment_id:row.id,canonical_shipment_id:row.canonical_shipment_id||null,local_merchant_id:owner.merchant_id,
   canonical_merchant_id:row.domain_merchant_scope||null,test_harness:result.code==='synthetic_isolated',
   reasons:[result.code,owner.command_provenance==='untrusted'?'creation_command_untrusted':'server_record']};
 } catch {return unknownSubject('lookup_error','authority lookup failed');}
}
export function resolveEventSubject(client:any,row:any) {
 return resolveShipmentSubject(client,{shipment_id:row.shipment_id,tracking_number:row.tracking_number,merchant_id:row.merchant_id});
}
