import {verified,digest,stable} from './lexEffectProof.ts';
import {localAuthority} from './lexOperationalAuthority.ts';
import {engineUuid} from './lexTrustedIsolation.ts';
// An admin worker does not turn a caller-created queue row into authorization.
export async function trustedEngineTask(base44:any,task:any) {
 const payload=task.payload||{};
 if(!engineUuid(payload.command_id)||engineUuid(payload.command_id)!==String(payload.command_id).toLowerCase())return false;
 if(payload.shipment_id&&task.lex_transition_ref) {
  const ship=await base44.asServiceRole.entities.Shipment.get(payload.shipment_id).catch(()=>null);
  if(!ship||ship.lex_effects_pending)return false;
  for(const receipt of [...(ship.lex_transition_history||[]),ship.lex_transition]) {
   if(receipt?.phase!=='complete'||!await verified(receipt.proof,'transition',ship.id))continue;
   const artifacts=receipt.proof.document.artifacts||[];
   for(let i=0;i<artifacts.length;i++)if(artifacts[i].entity==='OrchestrationTask'&&
    task.lex_transition_ref===receipt.proof.document.id+':'+i&&receipt.progress?.[String(i)]?.id===task.id&&
    JSON.stringify(stable(artifacts[i].document.payload))===JSON.stringify(stable(payload)))return true;
  }
 }
 const grant=await localAuthority(base44,'EngineTask',task);
 return !!grant&&grant.classification==='ordinary'&&grant.approved_engine_id===engineUuid(payload.engine_shipment_id)&&grant.task_payload_digest===await digest({task_type:task.task_type,payload});
}
export async function trustedQueuePublication(base44:any,task:any) {
 const grant=await localAuthority(base44,'QueueTask',task);
 return !!grant&&grant.classification==='ordinary'&&grant.task_payload_digest===await digest({task_type:task.task_type,payload:task.payload||{}});
}
