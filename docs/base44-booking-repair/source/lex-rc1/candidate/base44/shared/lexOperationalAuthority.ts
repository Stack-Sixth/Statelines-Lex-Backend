import {secrets} from 'base44:runtime';
import {backendTarget} from './lexAuthorityBinding.ts';
import {renderBaseUrl} from './lexRenderJwt.ts';
import {digest,verified,rows} from './lexEffectProof.ts';
const FIELDS=['id','created_by_id','tracking_id','origin','destination','weight_kg','weight_override_kg','package_size','service_level','merchant_id','business_id','source_app','source_record_id'];
export async function localDigest(row:any) {return digest(Object.fromEntries(FIELDS.map(k=>[k,row[k]??null])));}
export async function localAuthority(base44:any,type:string,row:any) {
 const found=rows(await base44.asServiceRole.entities.LexOperationalAuthority.filter({record_type:type,record_id:row.id,status:'active'},'-created_date',3));
 if(found.length!==1)return null;const record=found[0],proof=record.proof;
 if(!await verified(proof,'local_operation',row.id))return null;const a=proof.document;
 if(a.record_type!==type||a.snapshot_digest!==await localDigest(row)||a.policy_epoch!==secrets.get('LEX_OPERATION_POLICY_EPOCH')||!a.policy_epoch||a.backend_target!==backendTarget(renderBaseUrl()))return null;
 if(type==='Shipment'&&String(row.assigned_carrier_id||'')!==String(a.approved_assigned_carrier_id||'')) {
  const state=row.lex_transition;
  if(!await verified(state?.proof,'transition',row.id)||state.proof.document.to_assigned_carrier_id!==row.assigned_carrier_id)return null;
 }
 return a;
}
export async function linkedEngineId(base44:any,type:string,row:any) {
 const grant=await localAuthority(base44,type,row);if(!grant)return null;
 const pointer=row.engine_shipment_id||grant.approved_engine_id;
 if(!pointer)return null;
 if(pointer===grant.approved_engine_id)return {id:pointer,grant};
 if(type==='CrossAppPackage'&&await verified(row.lex_engine_receipt,'engine_create_receipt',row.id)&&row.lex_engine_receipt.document.engine_id===pointer)
  return {id:pointer,grant};
 return null;
}
