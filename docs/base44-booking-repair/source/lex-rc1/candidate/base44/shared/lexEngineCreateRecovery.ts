import {seal,verified,cas,expect,rows,EffectsPending,stable} from './lexEffectProof.ts';
import {requirePackageMutation} from './lexEngineBoundary.ts';
import {engineUuid} from './lexTrustedIsolation.ts';
export async function engineCreatePayload(base44:any,row:any,candidate:any) {
 const grant=await requirePackageMutation(base44,row),P=base44.asServiceRole.entities.CrossAppPackage;
 if(!row.lex_engine_claim) {
  let payload=candidate;
  if(row.engine_command_id) {
   // A source command may already have been submitted before this upgrade.
   // Never reconstruct its old deadlines/body or adopt a merely similar shipment.
   payload=grant.approved_create_payload;
   if(!payload||payload.command_id!==row.engine_command_id)throw new EffectsPending('legacy_create_payload_review_required');
  }
  if(engineUuid(payload.command_id)!==String(payload.command_id).toLowerCase()||payload.origin!==String(row.origin).trim()||payload.destination!==String(row.destination).trim()||!Number.isFinite(payload.weight_kg)||payload.weight_kg<=0)
   throw new EffectsPending('create_snapshot_invalid');
  const proof=await seal('engine_create',row.id,payload);
  await cas(P,row.id,{lex_engine_claim:expect(row,'lex_engine_claim'),engine_shipment_id:expect(row,'engine_shipment_id')},{lex_engine_claim:proof});
  row=await P.get(row.id);
 }
 if(!await verified(row.lex_engine_claim,'engine_create',row.id))throw new EffectsPending('engine_create_claim_unverified');
 return row.lex_engine_claim.document;
}
export async function confirmEngineCreate(base44:any,row:any,payload:any,data:any) {
 const P=base44.asServiceRole.entities.CrossAppPackage,current=await P.get(row.id);
 if(!await verified(current.lex_engine_claim,'engine_create',row.id)||JSON.stringify(stable(current.lex_engine_claim.document))!==JSON.stringify(stable(payload)))throw new EffectsPending('engine_create_identity_changed');
 const value=data?.shipment||data,id=engineUuid(value?.id),version=value?.version,tracking=value?.tracking_id;
 if(!id||!Number.isInteger(version)||version<1||typeof tracking!=='string'||!tracking)throw new EffectsPending('engine_create_evidence_incomplete');
 if(current.engine_shipment_id&&engineUuid(current.engine_shipment_id)!==id)throw new EffectsPending('engine_pointer_conflict');
 if(current.lex_engine_receipt) {
  if(!await verified(current.lex_engine_receipt,'engine_create_receipt',row.id)||current.lex_engine_receipt.document.engine_id!==id)throw new EffectsPending('engine_receipt_conflict');
  return settleEngineOutbox(base44,current);
 }
 const receipt=await seal('engine_create_receipt',row.id,{engine_id:id,version,engine_tracking_id:tracking,source_tracking_id:row.tracking_id,command_id:payload.command_id});
 const at=new Date().toISOString();
 const document={event_name:'shipment.created',payload:{tracking_id:row.tracking_id,engine_shipment_id:id,engine_version:version,command_id:payload.command_id,sync_status:'synced'},
  correlation_id:payload.command_id,causation_id:payload.command_id,published_at:at,occurred_at:at,source:'statelines-lex',schema_version:1,aggregate_type:'shipment',aggregate_id:id,aggregate_version:version};
 const outbox={phase:'pending',proof:await seal('engine_outbox',row.id,document)};
 await cas(P,row.id,{lex_engine_receipt:expect(current,'lex_engine_receipt'),lex_engine_claim:current.lex_engine_claim,engine_shipment_id:expect(current,'engine_shipment_id')},
  {engine_shipment_id:id,engine_version:version,synced_to_engine_at:at,sync_status:'synced',lex_engine_receipt:receipt,lex_engine_outbox:outbox});
 return settleEngineOutbox(base44,await P.get(row.id));
}
export async function settleEngineOutbox(base44:any,row:any) {
 await requirePackageMutation(base44,row);
 const P=base44.asServiceRole.entities.CrossAppPackage,E=base44.asServiceRole.entities.EventLog;
 const state=row.lex_engine_outbox;
 if(!await verified(row.lex_engine_receipt,'engine_create_receipt',row.id)||!await verified(state?.proof,'engine_outbox',row.id))throw new EffectsPending('engine_confirmation_plan_missing');
 if(state.phase==='done'){await P.update(row.id,{sync_status:'synced',engine_sync_hold:''});return state.event_id;}
 const doc=state.proof.document,ref='engine:'+row.id+':'+row.lex_engine_receipt.document.command_id;
 if(state.phase==='pending') {
  const creating={...state,phase:'creating'};
  if(await cas(P,row.id,{lex_engine_outbox:state},{lex_engine_outbox:creating})) {
   let ev;try {ev=await E.create({...doc,lex_transition_ref:ref});}catch {throw new EffectsPending('engine_outbox_insert_unknown');}
   await cas(P,row.id,{lex_engine_outbox:creating},{lex_engine_outbox:{...creating,phase:'done',event_id:ev.id}});
  }
  row=await P.get(row.id);
 }
 if(row.lex_engine_outbox.phase==='creating') {
  const found=rows(await E.filter({lex_transition_ref:ref},'-created_date',2));
  if(found.length!==1||Object.entries(doc).some(([k,v])=>JSON.stringify(stable(found[0][k]))!==JSON.stringify(stable(v))))throw new EffectsPending('engine_outbox_reconciliation_required');
  await cas(P,row.id,{lex_engine_outbox:row.lex_engine_outbox},{lex_engine_outbox:{...row.lex_engine_outbox,phase:'done',event_id:found[0].id}});
 }
 const done=(await P.get(row.id)).lex_engine_outbox;if(done.phase!=='done')throw new EffectsPending('engine_outbox_pending');await P.update(row.id,{sync_status:'synced',engine_sync_hold:''});return done.event_id;
}
