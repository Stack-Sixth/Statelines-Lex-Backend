import {seal,verified,stable,cas,expect,rows,EffectsPending} from './lexEffectProof.ts';
import {eventIsolation} from './lexEventIsolation.ts';
export async function trustedBrowserTask(b:any,task:any){
 if(!await verified(task.lex_queue_proof,'queue_submission',task.id))return false;const d=task.lex_queue_proof.document;
 if(d.task_type!==task.task_type||JSON.stringify(stable(d.payload))!==JSON.stringify(stable(task.payload)))return false;
 const event=await b.asServiceRole.entities.EventLog.get(d.payload.event_id).catch(()=>null);
 return !!event&&(await eventIsolation(b,event)).kind==='ordinary';
}
// Admin-only operator handler, never a generic service-role proxy. Browser may
// select persisted IDs, not publish arbitrary payloads or engine commands.
export async function submitBrowserTask(b:any,user:any,input:any){
 if(user?.role!=='admin')throw new Error('Admin required');
 if(!['webhook_redeliver','event_publish'].includes(input.task_type))throw new Error('task_type_not_allowed');
 if(!/^[0-9a-f-]{36}$/.test(input.request_id||''))throw new Error('stable_request_id_required');
 if(Object.keys(input).some(k=>!['op','request_id','task_type','event_id','connection_id','priority','scheduled_time'].includes(k)))throw new Error('caller_payload_not_allowed');
 const priority=input.priority??5,scheduled=input.scheduled_time||null;
 if(!Number.isInteger(priority)||priority<1||priority>10||(scheduled!==null&&(typeof scheduled!=='string'||!Number.isFinite(Date.parse(scheduled)))))throw new Error('invalid_schedule_or_priority');
 const settings={priority,scheduled_time:scheduled};
 const E=b.asServiceRole.entities.EventLog,T=b.asServiceRole.entities.OrchestrationTask,event=await E.get(String(input.event_id||''));
 if((await eventIsolation(b,event)).kind!=='ordinary')throw new Error('event_isolation_hold');
 if(input.task_type==='webhook_redeliver'){
  const conn=await b.asServiceRole.entities.PlatformConnection.get(String(input.connection_id||''));if(conn.status!=='active')throw new Error('destination_not_active');
 }
 const payload={event_id:event.id,...(input.task_type==='webhook_redeliver'?{connection_id:input.connection_id}:{})},key=user.id+':'+input.request_id;
 let requests=event.lex_queue_requests||{},state=requests[key];
 if(state&&(state.task_type!==input.task_type||JSON.stringify(stable(state.payload))!==JSON.stringify(stable(payload))||JSON.stringify(stable(state.settings))!==JSON.stringify(stable(settings))))throw new Error('request_conflict');
 if(!state){state={phase:'pending',task_type:input.task_type,payload,settings,ref:'queue:'+crypto.randomUUID()};const next={...requests,[key]:state};if(!await cas(E,event.id,{lex_queue_requests:expect(event,'lex_queue_requests')},{lex_queue_requests:next}))throw new EffectsPending('queue_contention');requests=next;}
 if(state.phase==='pending'){
  const creating={...state,phase:'creating'};const next={...requests,[key]:creating};
  if(await cas(E,event.id,{lex_queue_requests:requests},{lex_queue_requests:next})){
   let task;try{task=await T.create({task_type:input.task_type,payload,status:'preparing',...settings,retry_count:0,max_retries:3,lex_transition_ref:state.ref});}catch{throw new EffectsPending('queue_insert_unknown');}
   await T.update(task.id,{lex_queue_proof:await seal('queue_submission',task.id,{task_type:task.task_type,payload,requested_by:user.id})});
   // Preparing tasks cannot execute before their trusted payload proof exists.
   await cas(T,task.id,{status:'preparing'},{status:'queued'});
   await cas(E,event.id,{lex_queue_requests:next},{lex_queue_requests:{...next,[key]:{...creating,phase:'done',task_id:task.id}}});
  }
 }
 const fresh=await E.get(event.id);state=fresh.lex_queue_requests[key];
 if(state.phase==='creating'){
  const found=rows(await T.filter({lex_transition_ref:state.ref},'-created_date',2));if(found.length!==1)throw new EffectsPending('queue_insert_reconciliation_required');
  const task=found[0];if(task.task_type!==state.task_type||JSON.stringify(stable(task.payload))!==JSON.stringify(stable(payload)))throw new Error('queue_payload_conflict');
  // A preparing row with exact parent-owned reference can be safely completed.
  if(task.status==='preparing'){await T.update(task.id,{lex_queue_proof:await seal('queue_submission',task.id,{task_type:task.task_type,payload,requested_by:user.id})});await cas(T,task.id,{status:'preparing'},{status:'queued'});}
  else if(!await trustedBrowserTask(b,task))throw new Error('queue_proof_required');
  await cas(E,event.id,{lex_queue_requests:fresh.lex_queue_requests},{lex_queue_requests:{...fresh.lex_queue_requests,[key]:{...state,phase:'done',task_id:task.id}}});
 }
 const result=(await E.get(event.id)).lex_queue_requests[key];if(result.phase!=='done')throw new EffectsPending('queue_pending');return {task_id:result.task_id,queued:true};
}
