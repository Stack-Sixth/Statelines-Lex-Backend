import {createClientFromRequest} from 'npm:@base44/sdk@0.8.52';
import {secrets} from 'base44:runtime';
import {localDigest} from '../../shared/lexOperationalAuthority.ts';
import {seal,rows,cas,digest} from '../../shared/lexEffectProof.ts';
import {backendTarget} from '../../shared/lexAuthorityBinding.ts';
import {renderBaseUrl} from '../../shared/lexRenderJwt.ts';
// Explicit operator migration/approval, NOT a caller-controlled classification flag.
// Existing source ownership/link evidence must be reviewed before confirmation.
export default async function(req:Request):Promise<Response> {
 try {
  const b=createClientFromRequest(req),actor=await b.auth.me().catch(()=>null);if(actor?.role!=='admin')return Response.json({error:'Admin required'},{status:403});
  const input=await req.json(),sr=b.asServiceRole;
  if(input.action==='revoke') {
   const row=await sr.entities.LexOperationalAuthority.get(String(input.authority_id||''));
   return Response.json({revoked:await cas(sr.entities.LexOperationalAuthority,row.id,{status:'active'},{status:'revoked',revoked_by:actor.id,revoked_at:new Date().toISOString()})});
  }
  const type=input.record_type;if(!['Shipment','CrossAppPackage','NonShipmentEvent','EngineTask','QueueTask'].includes(type))return Response.json({error:'Unsupported authority type'},{status:400});
  const row=type==='NonShipmentEvent'?{id:String(input.event_name||''),tracking_id:null}:await sr.entities[['EngineTask','QueueTask'].includes(type)?'OrchestrationTask':type].get(String(input.record_id||''));
  const snapshot=await localDigest(row);
  if(input.action==='preview')return Response.json({record_type:type,record_id:row.id,snapshot_digest:snapshot,readonly:true});
  if(input.action!=='confirm'||input.snapshot_digest!==snapshot||!String(input.evidence_ref||'').trim())return Response.json({error:'Current snapshot and independently reviewed ownership/link evidence required'},{status:409});
  const epoch=secrets.get('LEX_OPERATION_POLICY_EPOCH');if(!epoch||input.policy_epoch!==epoch)return Response.json({error:'Verified policy epoch required'},{status:409});
  if(!String(input.business_reference||'').trim())return Response.json({error:'Independently verified business reference required'},{status:409});
  if(!['ordinary','isolated'].includes(input.classification))return Response.json({error:'Explicit classification required'},{status:400});
  if(['SBX-BIZ-ALPHA-001','SBX-BIZ-BETA-002'].includes(input.business_reference)) {
   if(input.classification!=='isolated')return Response.json({error:'Approved synthetic business cannot be ordinary'},{status:409});
  }
  if(type==='NonShipmentEvent'&&(!input.event_contract||typeof input.event_contract!=='object'))return Response.json({error:'Exact non-shipment entity/field contract required'},{status:409});
  const existing=rows(await sr.entities.LexOperationalAuthority.filter({record_type:type,record_id:row.id,status:'active'},'-created_date',3));if(existing.length)return Response.json({error:'Revoke/review current grant; no overwrite'},{status:409});
  const document={record_type:type,task_payload_digest:['EngineTask','QueueTask'].includes(type)?await digest({task_type:row.task_type,payload:row.payload||{}}):null,snapshot_digest:snapshot,policy_epoch:epoch,backend_target:backendTarget(renderBaseUrl()),
   classification:input.classification,business_reference:String(input.business_reference||''),approved_engine_id:input.approved_engine_id||null,
   approved_capacity_reserved_kg:typeof input.capacity_reserved_kg==='number'&&Number.isFinite(input.capacity_reserved_kg)&&input.capacity_reserved_kg>=0?input.capacity_reserved_kg:null,
   approved_assigned_carrier_id:type==='Shipment'?row.assigned_carrier_id||null:null,allow_engine_create:type==='CrossAppPackage'&&input.allow_engine_create===true,
   approved_create_payload:input.approved_create_payload||null,event_contract:type==='NonShipmentEvent'?input.event_contract:null,
   approved_by:actor.id,evidence_ref:String(input.evidence_ref),approved_at:new Date().toISOString()};
  const result=await sr.entities.LexOperationalAuthority.create({record_type:type,record_id:row.id,status:'active',proof:await seal('local_operation',row.id,document)});
  return Response.json({authority_id:result.id,record_id:row.id,classification:document.classification,booking_enabled:false});
 } catch {return Response.json({error:'Authority review unavailable; no gate changed'},{status:409});}
}
