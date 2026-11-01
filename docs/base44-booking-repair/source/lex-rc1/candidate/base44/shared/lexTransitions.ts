// One stable Shipment is the transition/command/effect ownership boundary.
// Status always CASes the observed version, even when the legacy caller omits
// expected_version. No claim that a sweep reconstructs a never-created event.
import {nowIso} from './lexUtils.ts';
import {resolveLevelAsync} from './lexPermissions.ts';
import {digest,seal,verified,rows,cas,expect,EffectsPending} from './lexEffectProof.ts';
import {localAuthority,linkedEngineId} from './lexOperationalAuthority.ts';
import {resolveLocalOperation} from './lexTrustedIsolation.ts';
import {resumeTransition} from './lexTransitionRecovery.ts';
export const STAGE_TO_STATUS = {
  created: "pending", accepted: "pending", merchant_dropoff: "pending",
  exchange_partner_intake: "at_node", bundle_assigned: "matched", carrier_assigned: "matched",
  in_transit: "in_transit", arrival: "at_node", last_mile_assigned: "out_for_delivery",
  delivered: "delivered", returned: "returned", cancelled: "cancelled", exception: "flagged",
};
export const STATUS_TO_STAGE = {
  pending: "created", matched: "carrier_assigned", picked_up: "in_transit",
  in_transit: "in_transit", at_node: "arrival", out_for_delivery: "last_mile_assigned",
  delivered: "delivered", returned: "returned", cancelled: "cancelled", flagged: "exception",
};
export const ALLOWED_TRANSITIONS = {
  pending: ["matched", "cancelled", "flagged"],
  matched: ["picked_up", "cancelled", "flagged"],
  picked_up: ["in_transit", "at_node", "flagged", "cancelled"],
  in_transit: ["at_node", "in_transit", "out_for_delivery", "flagged", "cancelled"],
  at_node: ["in_transit", "out_for_delivery", "flagged"],
  out_for_delivery: ["delivered", "flagged"],
  delivered: ["returned"],
  returned: [],
  cancelled: [],
  flagged: ["picked_up", "in_transit", "at_node", "out_for_delivery", "delivered", "cancelled"],
};
export const CUSTODY_TO_STATUS = {
  matched: "matched", picked_up: "picked_up", deposited_at_node: "at_node",
  bundled: "in_transit", in_transit: "in_transit", transfer: "in_transit",
  out_for_delivery: "out_for_delivery", delivered: "delivered", exception: "flagged",
};
export const STATUS_TO_EVENT = {
  matched: "ShipmentMatched", picked_up: "ShipmentPickedUp", in_transit: "ShipmentInTransit",
  at_node: "ShipmentAtNode", out_for_delivery: "ShipmentOutForDelivery",
  delivered: "ShipmentDelivered", returned: "ShipmentReturned",
  cancelled: "ShipmentCancelled", flagged: "ShipmentException",
};

export function isValidTransition(from, to) {
  return (ALLOWED_TRANSITIONS[from] || []).includes(to);
}

export async function authorizeTransition(base44, user, ship, carrier, toStatus, custodyEventType) {
  const level = await resolveLevelAsync(base44, user);
  if (level === "admin" || level === "dispatcher") return { ok: true };
  const isOwner = ship.created_by_id === user.id;
  const isAssignedCarrier = !!(carrier && carrier.owner_user_id && carrier.owner_user_id === user.id);
  if (isOwner) {
    if (toStatus === "cancelled") return { ok: true };
    if (["deposited_at_node", "merchant_dropoff"].includes(custodyEventType)) return { ok: true };
  }
  if (isAssignedCarrier) {
    const carrierCustody = ["picked_up", "in_transit", "transfer", "out_for_delivery", "delivered", "deposited_at_node", "bundled"];
    if (carrierCustody.includes(custodyEventType)) return { ok: true };
  }
  return { ok: false, reason: "not authorized for this transition" };
}


async function findShipment(base44:any,opts:any) {
 let local=null;
 if(opts.shipment_id)local=await base44.asServiceRole.entities.Shipment.get(opts.shipment_id).catch(()=>null);
 else if(opts.tracking_id){const found=rows(await base44.asServiceRole.entities.Shipment.filter({tracking_id:opts.tracking_id}));if(found.length===1)local=found[0];}
 if(!local || (opts.tracking_id&&local.tracking_id!==opts.tracking_id))return null;
 return local;
}
export async function transitionShipment(base44:any,opts:any) {
 try {
  const actor=opts.actor;if(!actor)return {ok:false,code:401,error:'actor required'};
  if(!opts.to_status)return {ok:false,code:400,error:'to_status required'};
  const ship=await findShipment(base44,opts);if(!ship)return {ok:false,code:404,error:'Shipment not found'};
  const isolation=await resolveLocalOperation(base44,'Shipment',ship);
  if(isolation.kind!=='ordinary')return {ok:false,code:isolation.kind==='isolated'?403:409,error:isolation.kind==='isolated'?'sandbox_isolated':'isolation_unknown'};
  const grant=await localAuthority(base44,'Shipment',ship);if(!grant)return {ok:false,code:409,error:'local_operation_authority_required'};
  const assigned=opts.assign_carrier_id||ship.assigned_carrier_id;
  const carrier=assigned?await base44.asServiceRole.entities.CommunityCarrier.get(assigned).catch(()=>null):null;
  const auth=await authorizeTransition(base44,actor,ship,carrier,opts.to_status,opts.custody?.event_type);
  if(!auth.ok)return {ok:false,code:403,error:auth.reason};
  const level=await resolveLevelAsync(base44,actor);
  if((opts.metadata_patch||opts.service_plan||opts.additional_artifacts)&&!['admin','dispatcher'].includes(level))return {ok:false,code:403,error:'service metadata requires authorized staff'};
  if(opts.force&&!['admin','dispatcher'].includes(level))return {ok:false,code:403,error:'force requires authorized staff'};
  const hash=await digest({metadata_patch:opts.metadata_patch||null,service_plan:opts.service_plan||null,additional_artifacts:opts.additional_artifacts||null,shipment_id:ship.id,to_status:opts.to_status,custody:opts.custody||null,assign_carrier_id:opts.assign_carrier_id||null,
    event_name:opts.event_name||null,event_payload:opts.event_payload||null,note:opts.note||null,actor_id:actor.id});
  const history=[...(ship.lex_transition_history||[]),...(ship.lex_transition?[ship.lex_transition]:[])];
  if(opts.command_id)for(const prior of history) {
   if(!await verified(prior?.proof,'transition',ship.id))continue;
   if(prior.proof.document.command_id!==opts.command_id)continue;
   if(prior.proof.document.command_hash!==hash)return {ok:false,code:409,error:'command_id reused with a different payload'};
   if(['complete','rejected'].includes(prior.phase))return {...prior.result,idempotent:true};
   return await resumeTransition(base44,ship);
  }
  // An old lifecycle row can describe an incomplete pre-upgrade command. Never
  // treat its mere existence as proof capacity/history/outbox all completed.
  if(opts.command_id) {
   const prior=rows(await base44.asServiceRole.entities.ShipmentLifecycleEvent.filter({command_id:opts.command_id}));
   if(prior.length)return {ok:false,code:409,error:'legacy_command_effects_review_required'};
  }
  if(ship.lex_transition&&!['complete','rejected'].includes(ship.lex_transition.phase))return {ok:false,code:409,error:'previous_transition_effects_pending'};
  if(Object.hasOwn(ship,'version')&&(!Number.isInteger(ship.version)||ship.version<1))return {ok:false,code:409,error:'legacy_version_review_required'};
  if(opts.expected_version!=null&&(!Number.isInteger(Number(opts.expected_version))||Number(opts.expected_version)!==Number(ship.version||1)))return {ok:false,code:409,error:'version_conflict',current_version:ship.version||1,current_status:ship.status};
  if(!opts.force&&!isValidTransition(ship.status,opts.to_status))return {ok:false,code:409,error:`Invalid transition: ${ship.status} → ${opts.to_status}`};
  if(opts.assign_carrier_id&&(opts.to_status!=='matched'||!carrier))return {ok:false,code:409,error:'valid carrier assignment requires matched transition'};
  const weight=Number(ship.weight_kg);
  let binding:any=null;
  if(await verified(ship.lex_capacity_binding,'capacity_binding',ship.id))binding=ship.lex_capacity_binding.document;
  else if(carrier&&Number.isFinite(grant.approved_capacity_reserved_kg))binding={carrier_id:carrier.id,weight_kg:grant.approved_capacity_reserved_kg,reserved:grant.approved_capacity_reserved_kg>0};
  if(carrier&&['picked_up','in_transit','at_node','out_for_delivery'].includes(opts.to_status)&&!binding?.reserved)return {ok:false,code:409,error:'legacy_capacity_reservation_review_required'};
  let capacity:any={kind:'none',delta:0};let nextBinding=binding;
  if(carrier) {
   if(!Number.isFinite(weight)||weight<=0) return {ok:false,code:409,error:'verified positive weight required for capacity'};
   if(binding&&binding.carrier_id!==carrier.id)return {ok:false,code:409,error:'carrier reservation mismatch'};
   if(opts.to_status==='matched'&&!binding?.reserved){capacity={kind:'reserve',delta:weight,carrier_id:carrier.id};nextBinding={carrier_id:carrier.id,weight_kg:weight,reserved:true};}
   else if(['delivered','cancelled','returned'].includes(opts.to_status)) {
    if(!binding)return {ok:false,code:409,error:'legacy_capacity_reservation_review_required'};
    if(binding.reserved){capacity={kind:opts.to_status==='delivered'?'deliver':opts.to_status==='cancelled'?'release_cancel':'release_return',delta:-binding.weight_kg,carrier_id:carrier.id};nextBinding={...binding,reserved:false};}
   } else if(['picked_up','in_transit'].includes(opts.to_status))capacity={kind:'in_transit',delta:0,carrier_id:carrier.id};
  }
  const at=nowIso(),id=crypto.randomUUID(),command=opts.command_id||crypto.randomUUID(),version=Number(ship.version||1)+1;
  const artifacts:any[]=[];const add=(slot:string,entity:string,document:any)=>artifacts.push({slot,entity,document});
  add('audit','AuditLog',{actor_id:actor.id,actor_name:actor.full_name||'LEX',actor_role:actor.role,action:'shipment.transition',entity_type:'Shipment',entity_id:ship.id,
   details:`${ship.tracking_id||ship.id}: ${ship.status} → ${opts.to_status} (v${version})`,severity:opts.to_status==='flagged'?'warning':'info'});
  add('lifecycle','ShipmentLifecycleEvent',{shipment_id:ship.id,tracking_id:ship.tracking_id,stage:STATUS_TO_STAGE[opts.to_status]||opts.to_status,
   previous_stage:STATUS_TO_STAGE[ship.status]||ship.status,from_status:ship.status,to_status:opts.to_status,trigger_source:opts.trigger_source||'operator',
   responsible_entity:actor.full_name||actor.email||'LEX',note:opts.note||null,command_id:command,command_hash:hash,result:null,timestamp:at});
  if(opts.custody?.event_type)add('custody','ChainOfCustodyEvent',{shipment_id:ship.id,tracking_id:ship.tracking_id,event_type:opts.custody.event_type,
   location:opts.custody.location||ship.origin||null,lat:opts.custody.lat,lng:opts.custody.lng,actor_id:actor.id,actor_name:actor.full_name||actor.email||'LEX',
   signature:opts.custody.signature||null,notes:opts.custody.notes||null,timestamp:at});
  for(const extra of opts.additional_artifacts||[]) {if(!['FraudAlert','Incident','EventLog'].includes(extra.entity))return {ok:false,code:409,error:'service artifact not supported'};add(extra.slot,extra.entity,extra.document);}
  const event=opts.event_name||STATUS_TO_EVENT[opts.to_status];
  if(event)add('outbox','EventLog',{event_name:event,payload:{...(opts.event_payload||{}),shipment_id:ship.id,tracking_id:ship.tracking_id||null,from_status:ship.status,to_status:opts.to_status,version},
   correlation_id:opts.command_id||opts.correlation_id||null,causation_id:command,published_at:at,schema_version:1,source:'statelines-lex',occurred_at:at,aggregate_type:'shipment',aggregate_id:ship.id,aggregate_version:version});
  let engineId=null;
  if(ship.tracking_id) {
   const packages=rows(await base44.asServiceRole.entities.CrossAppPackage.filter({tracking_id:ship.tracking_id}));
   if(packages.length>1)return {ok:false,code:409,error:'ambiguous_engine_mapping'};
   if(packages.length===1&&packages[0].engine_shipment_id){const link=await linkedEngineId(base44,'CrossAppPackage',packages[0]);if(!link)return {ok:false,code:409,error:'engine_mapping_unverified'};engineId=link.id;}
  }
  if(engineId)add('engine','OrchestrationTask',{task_type:'engine_sync',status:'queued',priority:5,max_retries:8,payload:{engine_shipment_id:engineId,tracking_id:ship.tracking_id,shipment_id:ship.id,
   command_id:/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(command)?command:crypto.randomUUID(),hub_command_id:command,
   to_status:opts.to_status,from_status:ship.status,hub_version:version,trigger_source:opts.trigger_source||'operator',event_type:opts.custody?.event_type||null,enqueued_at:at}});
  const intent={id,metadata_patch:opts.metadata_patch||null,service_plan:opts.service_plan||null,caller_command_supplied:!!opts.command_id,command_id:command,command_hash:hash,from_status:ship.status,from_assigned_carrier_id:ship.assigned_carrier_id||null,
   to_assigned_carrier_id:assigned||null,to_status:opts.to_status,version,capacity,capacity_hash:await digest(capacity),capacity_binding:nextBinding,artifacts,engine_id:engineId,actor_id:actor.id,at};
  const receipt={proof:await seal('transition',ship.id,intent),phase:'pending',progress:Object.fromEntries(artifacts.map((_,i)=>[String(i),{phase:'pending'}]))};
  const set:any={status:opts.to_status,version,last_transition_at:at,lex_transition:receipt,lex_transition_history:history,lex_effects_pending:true};
  if(opts.metadata_patch)for(const [key,value] of Object.entries(opts.metadata_patch)) {if(!['bundle_id','risk_score'].includes(key))return {ok:false,code:409,error:'metadata field not allowed'};set[key]=value;}
  if(opts.service_plan?.kind==='bundle')set.lex_bundle_pending=true;
  if(opts.assign_carrier_id)set.assigned_carrier_id=opts.assign_carrier_id;
  if(!await cas(base44.asServiceRole.entities.Shipment,ship.id,{status:ship.status,version:expect(ship,'version'),lex_transition:expect(ship,'lex_transition')},set))
   return {ok:false,code:409,error:'concurrent transition: state/version changed'};
  return await resumeTransition(base44,await base44.asServiceRole.entities.Shipment.get(ship.id));
 } catch(e) {return {ok:false,code:409,pending:true,error:e instanceof EffectsPending?e.code:'transition_effects_pending'};}
}
