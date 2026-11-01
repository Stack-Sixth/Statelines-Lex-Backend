import {cas,expect,rows,verified,seal,EffectsPending,stable} from './lexEffectProof.ts';
import {resolveLocalOperation} from './lexTrustedIsolation.ts';
const active=['matched','picked_up','in_transit','at_node','out_for_delivery'];
// Capacity arithmetic and its idempotency marker commit on ONE existing carrier.
// Retrying an unknown CAS is safe: the same effect token is present or its old
// revision predicate no longer matches. No second entity insert is involved.
export async function applyCapacityPlan(base44:any,receipt:any) {
 const plan=receipt.proof.document.capacity;if(!plan||plan.kind==='none')return {applied:false,reason:'no capacity effect'};
 const C=base44.asServiceRole.entities.CommunityCarrier;
 for(let attempt=0;attempt<8;attempt++) {
  const carrier=await C.get(plan.carrier_id),journal=carrier.lex_capacity_journal||[];
  const previous=journal.find((r:any)=>r.effect_id===receipt.proof.document.id);
  if(previous) {
   if(previous.plan_hash!==receipt.proof.document.capacity_hash)throw new EffectsPending('capacity_receipt_conflict');
   return previous.result;
  }
  const used=Number(carrier.capacity_used_kg||0),total=Number(carrier.capacity_total_kg);
  if(!Number.isFinite(used)||used<0||!Number.isFinite(total)||total<0)throw new EffectsPending('capacity_data_invalid');
  const next=used+plan.delta;
  if(plan.delta>0&&(next>total||carrier.status==='offline'))return {applied:false,rejected:true,reason:'capacity no longer available'};
  if(next<0)throw new EffectsPending('capacity_underflow_review_required');
  const result={applied:true,effect:plan.kind,updated:1};
  const item={effect_id:receipt.proof.document.id,plan_hash:receipt.proof.document.capacity_hash,result};
  const fields:any={capacity_used_kg:next,lex_capacity_revision:Number(carrier.lex_capacity_revision||0)+1,lex_capacity_journal:[...journal,item]};
  if(plan.kind==='reserve')fields.status='assigned';
  if(plan.kind==='in_transit'&&carrier.status!=='offline')fields.status='in_transit';
  if(plan.kind==='deliver')fields.total_deliveries=Number(carrier.total_deliveries||0)+1;
  if(['deliver','release_cancel','release_return'].includes(plan.kind)&&next===0&&carrier.status!=='offline') {
   const related=rows(await base44.asServiceRole.entities.Shipment.filter({assigned_carrier_id:carrier.id}));
   if(!related.some((s:any)=>active.includes(s.status)))fields.status='available';
  }
  let won;
  try {won=await cas(C,carrier.id,{capacity_total_kg:expect(carrier,'capacity_total_kg'),status:expect(carrier,'status'),capacity_used_kg:expect(carrier,'capacity_used_kg'),lex_capacity_revision:expect(carrier,'lex_capacity_revision'),lex_capacity_journal:expect(carrier,'lex_capacity_journal'),total_deliveries:expect(carrier,'total_deliveries')},fields);}
  catch(e) {
   const fresh=await C.get(carrier.id);const proof=(fresh.lex_capacity_journal||[]).find((r:any)=>r.effect_id===item.effect_id&&r.plan_hash===item.plan_hash);
   if(proof)return proof.result;throw e;
  }
  if(won)return result;
 }
 throw new EffectsPending('capacity_contention');
}
export async function projectTransitionArtifact(base44:any,shipId:string,index:number) {
 const entities=base44.asServiceRole.entities,S=entities.Shipment;
 let ship=await S.get(shipId),receipt=ship.lex_transition;
 if(!await verified(receipt?.proof,'transition',shipId))throw new EffectsPending('transition_proof_invalid');
 const original=receipt.proof.document.artifacts[index],key=String(index);
 const plan=original&&{...original,document:{...original.document}};
 const idFor=(slot:string)=>{const i=receipt.proof.document.artifacts.findIndex((x:any)=>x.slot===slot);return i>=0?receipt.progress[String(i)]?.id:null;};
 if(plan?.slot==='lifecycle')plan.document.audit_ref=idFor('audit');
 if(plan?.slot==='outbox') {
  if(idFor('fraud_alert'))plan.document.payload={...plan.document.payload,fraud_alert_id:idFor('fraud_alert')};
  plan.document.payload={...plan.document.payload,custody_event_id:idFor('custody')||null};
  if(!receipt.proof.document.caller_command_supplied)plan.document.causation_id=idFor('audit');
 }
 if(!plan||!['AuditLog','ShipmentLifecycleEvent','ChainOfCustodyEvent','EventLog','OrchestrationTask','FraudAlert','Incident'].includes(plan.entity))throw new EffectsPending('artifact_entity_denied');
 let progress=receipt.progress[key];if(progress?.phase==='done')return progress.id;
 if(progress?.phase==='pending') {
  const next={...receipt,progress:{...receipt.progress,[key]:{phase:'creating'}}};
  const won=await cas(S,shipId,{lex_transition:receipt},{lex_transition:next});
  if(won) {
   let result;
   try {result=await entities[plan.entity].create({...plan.document,lex_transition_ref:receipt.proof.document.id+':'+key});}
   catch {throw new EffectsPending('artifact_insert_unknown:'+key);}
   const done={...next,progress:{...next.progress,[key]:{phase:'done',id:result.id}}};
   await cas(S,shipId,{lex_transition:next},{lex_transition:done});
  }
  ship=await S.get(shipId);receipt=ship.lex_transition;progress=receipt.progress[key];
 }
 if(progress?.phase==='creating') {
  const found=rows(await entities[plan.entity].filter({lex_transition_ref:receipt.proof.document.id+':'+key},'-created_date',2));
  if(found.length!==1)throw new EffectsPending(found.length?'artifact_duplicate_conflict:'+key:'artifact_insert_unknown:'+key);
  if(Object.entries(plan.document).some(([k,v])=>JSON.stringify(stable(found[0][k]))!==JSON.stringify(stable(v))))throw new EffectsPending('artifact_payload_conflict:'+key);
  const done={...receipt,progress:{...receipt.progress,[key]:{phase:'done',id:found[0].id}}};
  await cas(S,shipId,{lex_transition:receipt},{lex_transition:done});
 }
 const final=(await S.get(shipId)).lex_transition.progress[key];if(final?.phase!=='done')throw new EffectsPending('artifact_projection_pending');return final.id;
}
export async function resumeTransition(base44:any,ship:any) {
 const S=base44.asServiceRole.entities.Shipment,receipt=ship.lex_transition;
 if(!await verified(receipt?.proof,'transition',ship.id))throw new EffectsPending('transition_proof_invalid');
 const intent=receipt.proof.document;
 const isolation=await resolveLocalOperation(base44,'Shipment',ship);
 if(isolation.kind!=='ordinary')throw new EffectsPending(isolation.kind==='isolated'?'sandbox_isolated':'isolation_unknown');
 if(receipt.phase==='complete'||receipt.phase==='rejected')return receipt.result;
 const capacity=await applyCapacityPlan(base44,receipt);
 if(capacity.rejected) {
  // Only our exact winner may revert its match. Version stays monotonic and
  // prior assignment is restored, never $unset blindly over another winner.
  const result={ok:false,code:409,error:capacity.reason,shipment_id:ship.id,status:intent.from_status,version:intent.version+1};
  const fresh=await S.get(ship.id),next={...fresh.lex_transition,phase:'rejected',result};
  const won=await cas(S,ship.id,{status:intent.to_status,version:intent.version,lex_transition:fresh.lex_transition},{status:intent.from_status,assigned_carrier_id:intent.from_assigned_carrier_id,version:intent.version+1,lex_transition:next,lex_effects_pending:false});
  if(!won)throw new EffectsPending('capacity_rejection_state_conflict');return result;
 }
 for(let i=0;i<intent.artifacts.length;i++)await projectTransitionArtifact(base44,ship.id,i);
 const fresh=await S.get(ship.id),state=fresh.lex_transition;
 const ids:any={};intent.artifacts.forEach((p:any,i:number)=>{ids[p.slot]=state.progress[String(i)].id;});
 const result={ok:true,idempotent:false,shipment_id:ship.id,status:intent.to_status,version:intent.version,
  command_id:intent.command_id,artifacts:ids,lifecycle_event_id:ids.lifecycle||null,custody_event_id:ids.custody||null,outbox_event_id:ids.outbox||null,
  capacity,engine_sync:ids.engine?{queued:true,task_id:ids.engine,engine_shipment_id:intent.engine_id,target:intent.to_status}:null};
 if(ids.lifecycle)await base44.asServiceRole.entities.ShipmentLifecycleEvent.update(ids.lifecycle,{audit_ref:ids.audit,result});
 const changes:any={lex_transition:{...state,phase:'complete',result},lex_effects_pending:false};
 if(intent.capacity_binding)changes.lex_capacity_binding=await seal('capacity_binding',ship.id,intent.capacity_binding);
 if(!await cas(S,ship.id,{version:intent.version,lex_transition:state},changes))throw new EffectsPending('transition_completion_conflict');
 return result;
}
