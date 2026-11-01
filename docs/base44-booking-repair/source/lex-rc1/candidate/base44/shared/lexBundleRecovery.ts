import {verified,seal,cas,expect,rows,EffectsPending,stable} from './lexEffectProof.ts';
import {resolveLocalOperation} from './lexTrustedIsolation.ts';
// Bundle projection only after EVERY candidate has a completed signed member
// transition for this exact plan. Partial/unknown groups are explicit holds.
export async function recoverBundle(base44:any,servicePlan:any) {
 if(servicePlan?.kind!=='bundle')return null;
 const plan=servicePlan.document,S=base44.asServiceRole.entities.Shipment;
 if(!Array.isArray(plan.candidate_ids)||plan.candidate_ids.length<2)throw new EffectsPending('bundle_plan_invalid');
 const members=[];
 for(const id of plan.candidate_ids) {
  const ship=await S.get(id);if((await resolveLocalOperation(base44,'Shipment',ship)).kind!=='ordinary')throw new EffectsPending('bundle_isolation_hold');
  const receipts=[...(ship.lex_transition_history||[]),ship.lex_transition];let valid=false;
  for(const receipt of receipts)if(receipt?.phase==='complete'&&await verified(receipt.proof,'transition',ship.id)&&
    JSON.stringify(stable(receipt.proof.document.service_plan))===JSON.stringify(stable(servicePlan))&&receipt.proof.document.metadata_patch?.bundle_id===plan.bundle_id)valid=true;
  if(!valid||ship.bundle_id!==plan.bundle_id)throw new EffectsPending('bundle_group_partial_or_pending');members.push(ship);
 }
 const anchor=await S.get(plan.candidate_ids[0]);let state=anchor.lex_bundle_projection;
 const document={...plan.document,shipment_ids:members.map(x=>x.id)};
 if(!state) {
  const pending={phase:'pending',proof:await seal('bundle_projection',anchor.id,{bundle_id:plan.bundle_id,document})};
  await cas(S,anchor.id,{lex_bundle_projection:expect(anchor,'lex_bundle_projection')},{lex_bundle_projection:pending});state=(await S.get(anchor.id)).lex_bundle_projection;
 }
 if(!await verified(state?.proof,'bundle_projection',anchor.id)||state.proof.document.bundle_id!==plan.bundle_id)throw new EffectsPending('bundle_projection_conflict');
 if(state.phase==='done'){for(const member of members)await cas(S,member.id,{bundle_id:plan.bundle_id,lex_bundle_pending:true},{lex_bundle_pending:false});return state.row_id;}
 if(state.phase==='pending') {
  const creating={...state,phase:'creating'};
  if(await cas(S,anchor.id,{lex_bundle_projection:state},{lex_bundle_projection:creating})) {
   let row;try {row=await base44.asServiceRole.entities.SmartBundle.create({...document,lex_transition_ref:'bundle:'+plan.bundle_id});}catch{throw new EffectsPending('bundle_insert_unknown');}
   await cas(S,anchor.id,{lex_bundle_projection:creating},{lex_bundle_projection:{...creating,phase:'done',row_id:row.id}});
  }
  state=(await S.get(anchor.id)).lex_bundle_projection;
 }
 if(state.phase==='creating') {
  const found=rows(await base44.asServiceRole.entities.SmartBundle.filter({lex_transition_ref:'bundle:'+plan.bundle_id},'-created_date',2));
  if(found.length!==1||Object.entries(document).some(([k,v])=>JSON.stringify(stable(found[0][k]))!==JSON.stringify(stable(v))))throw new EffectsPending('bundle_projection_reconciliation_required');
  await cas(S,anchor.id,{lex_bundle_projection:state},{lex_bundle_projection:{...state,phase:'done',row_id:found[0].id}});
 }
 const done=(await S.get(anchor.id)).lex_bundle_projection;if(done.phase!=='done')throw new EffectsPending('bundle_projection_pending');
 for(const member of members)await cas(S,member.id,{bundle_id:plan.bundle_id,lex_bundle_pending:true},{lex_bundle_pending:false});
 return done.row_id;
}
