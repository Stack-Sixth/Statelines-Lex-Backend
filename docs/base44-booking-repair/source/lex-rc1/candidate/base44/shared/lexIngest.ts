import {nowIso} from './lexUtils.ts';
import {mapWeight} from './lexPackageMapping.ts';
import {authorizeIngress} from './lexIngressAuthority.ts';
import {cas,expect,rows,digest,seal,verified,stable,EffectsPending} from './lexEffectProof.ts';
const APPS=['lex','noc','merchant','carrier'],STAGES=['created','at_noc','at_merchant','with_carrier','in_transit','delivered','exception'];
export function normalizeEvent(raw:any){
 if(!raw||typeof raw!=='object')return null;const tracking_id=String(raw.tracking_id||raw.trackingId||'').trim(),app=String(raw.app||'').toLowerCase(),stage=String(raw.stage||raw.status||'created').toLowerCase();
 if(!tracking_id||!APPS.includes(app)||!STAGES.includes(stage))return null;
 const occurred_at=String(raw.occurred_at||raw.occurredAt||'');if(!Number.isFinite(Date.parse(occurred_at)))return null;
 return {claims:Object.fromEntries(['merchant_id','engine_shipment_id','shipment_id'].filter(k=>raw[k]!=null).map(k=>[k,raw[k]])),tracking_id,app,stage,event_type:String(raw.event_type||raw.eventType||`package.${stage}`),note:String(raw.note||''),actor:String(raw.actor||''),location:String(raw.location||''),occurred_at,command_id:String(raw.command_id||raw.commandId||''),pkg:raw.package&&typeof raw.package==='object'?raw.package:null};
}
// Transport authentication is necessary but insufficient. Only existing reviewed
// package/sender/canonical scopes may be updated here. New shipment onboarding is
// an explicit mapping step, never an arbitrary tracking-id upsert.
export async function ingestEvent(b:any,evt:any,context?:any){
 const {pkg}=await authorizeIngress(b,evt,context),P=b.asServiceRole.entities.CrossAppPackage;
 const weight=evt.pkg?mapWeight(evt.pkg):null;if(weight!=null&&Number(weight)!==Number(pkg.weight_override_kg||pkg.weight_kg))throw new Error('weight_change_requires_review');
 const command=await digest({connection_id:context.connection_id,key:evt.command_id||[evt.tracking_id,evt.occurred_at,evt.event_type].join('|')}),hash=await digest(evt);
 let state=pkg.lex_ingress;const history=pkg.lex_ingress_history||[];
 const prior=[...history,state].find((x:any)=>x?.proof?.document?.command===command);
 if(prior){if(!await verified(prior.proof,'ingress',pkg.id)||prior.proof.document.hash!==hash)throw new Error('ingress_command_conflict');if(prior.phase==='complete')return {...prior.result,duplicate:true};if(prior!==state)throw new EffectsPending('ingress_history_pending');}
 else{
  if(state&&state.phase!=='complete')throw new EffectsPending('ingress_previous_pending');
  if(Number.isFinite(Date.parse(pkg.last_event_at||''))&&Date.parse(evt.occurred_at)<Date.parse(pkg.last_event_at))throw new Error('stale_ingress_event');
  const key='ingress:'+command,activity={tracking_id:evt.tracking_id,app:evt.app,app_label:evt.app,event_type:evt.event_type,stage:evt.stage,note:evt.note,actor:evt.actor,location:evt.location,occurred_at:evt.occurred_at,idempotency_key:key};
  state={phase:'pending',proof:await seal('ingress',pkg.id,{command,hash,activity})};
  const step={app:evt.app,stage:evt.stage,location:evt.location,note:evt.note,actor:evt.actor,occurred_at:evt.occurred_at};
  const changes:any={lex_ingress:state,lex_ingress_history:[...history,...(pkg.lex_ingress?[pkg.lex_ingress]:[])],current_stage:evt.stage,current_app:evt.app,current_location:evt.location||pkg.current_location,last_event_at:evt.occurred_at,journey:[...(pkg.journey||[]),step]};
  if(['delivered','exception'].includes(evt.stage))changes.status=evt.stage;
  // Do not alter source ownership, routing, is_test, sync disposition or engine
  // command identity based on sender data. Classification is independently read.
  if(!await cas(P,pkg.id,{lex_ingress:expect(pkg,'lex_ingress'),last_event_at:expect(pkg,'last_event_at')},changes))throw new EffectsPending('ingress_contention');
 }
 if(state.phase==='pending'){
  const creating={...state,phase:'creating'};
  if(await cas(P,pkg.id,{lex_ingress:state},{lex_ingress:creating})){
   let row;try{row=await b.asServiceRole.entities.CrossAppActivity.create(creating.proof.document.activity);}catch{throw new EffectsPending('ingress_activity_insert_unknown');}
   await cas(P,pkg.id,{lex_ingress:creating},{lex_ingress:{...creating,phase:'inserted',activity_id:row.id}});
  }
  state=(await P.get(pkg.id)).lex_ingress;
 }
 if(state.phase==='creating'){
  const found=rows(await b.asServiceRole.entities.CrossAppActivity.filter({idempotency_key:state.proof.document.activity.idempotency_key},'-created_date',2));
  if(found.length!==1||Object.entries(state.proof.document.activity).some(([k,v])=>JSON.stringify(stable(found[0][k]))!==JSON.stringify(stable(v))))throw new EffectsPending('ingress_activity_reconciliation_required');
  const next={...state,phase:'inserted',activity_id:found[0].id};await cas(P,pkg.id,{lex_ingress:state},{lex_ingress:next});state=(await P.get(pkg.id)).lex_ingress;
 }
 if(state.phase!=='inserted'&&state.phase!=='complete')throw new EffectsPending('ingress_pending');
 const final=await P.get(pkg.id),result={package_id:pkg.id,activity_id:state.activity_id,duplicate:false,tracking_id:evt.tracking_id,engine_state:final.sync_status,engine_shipment_id:final.engine_shipment_id||null,engine_version:final.engine_version??null,command_id:evt.command_id||null};
 if(state.phase!=='complete'&&!await cas(P,pkg.id,{lex_ingress:state},{lex_ingress:{...state,phase:'complete',result}}))throw new EffectsPending('ingress_completion_pending');
 return result;
}
