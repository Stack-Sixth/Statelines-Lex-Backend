import {artifactPlan,projectArtifact} from './artifactProjection.ts';
import {cas,expected,ClaimPending} from './casBooking.ts';
import {recordAuthority} from './serverRecord.ts';
export async function settleCustody(entities:any,row:any,secret:string) {
 if(!row.custody_receipt)return row;
 for(const field of ['custody_projection','custody_audit_projection']) {
  if(!row[field])throw new ClaimPending('custody_evidence_missing');
  await projectArtifact(entities,row.id,field,secret);
 }
 return entities.Shipment.get(row.id);
}
export async function transitionCustody(entities:any,row:any,change:any,owner:any,secret:string) {
 // Freeze custody and audit evidence WITH the status transition, not after it.
 if(row.custody_receipt)row=await settleCustody(entities,row,secret);
 if(row.status===change.to&&row.custody_receipt?.to===change.to)return row;
 if(row.status!==change.from)throw new ClaimPending('custody_status_changed');
 const at=new Date().toISOString(),nonce=crypto.randomUUID();
 const event={shipment_id:row.id,event:change.to,location:change.facility,custodian:change.custodian,
  verification_method:'partner_scan',occurred_at:at,...await recordAuthority(secret).mint('ShipmentEvent',owner.owner_user_id,owner.merchant_id)};
 const receipt={id:nonce,from:change.from,to:change.to,actor_id:change.actor_id,location_ids:change.location_ids,at};
 const changes={status:change.to,current_location:change.facility,custody_receipt:receipt,
  custody_history:[...(row.custody_history||[]),receipt],
  custody_projection:{phase:'pending',plan:await artifactPlan(secret,row.id,'ShipmentEvent',event)},
  custody_audit_projection:{phase:'pending',plan:await artifactPlan(secret,row.id,'AuditLog',{
   actor_id:change.actor_id,merchant_id:owner.merchant_id,action:'custody_transition',entity:'Shipment',entity_id:row.id,
   detail:`Shipment status ${change.from} → ${change.to} at ${change.facility}`,})}};
 await cas(entities.Shipment,row.id,{status:row.status,custody_receipt:expected(row,'custody_receipt'),
  custody_projection:expected(row,'custody_projection'),custody_audit_projection:expected(row,'custody_audit_projection')},changes);
 const updated=await entities.Shipment.get(row.id);
 if(updated.custody_receipt?.id!==nonce) {
  if(updated.custody_receipt?.to!==change.to)throw new ClaimPending('custody_transition_conflict');
 }
 return settleCustody(entities,updated,secret);
}
