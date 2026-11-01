import {createClientFromRequest} from 'npm:@base44/sdk@0.8.40';
import {submitBrowserTask,trustedBrowserTask} from '../../shared/lexQueueSubmission.ts';
import {cas,expect} from '../../shared/lexEffectProof.ts';
export default async function(req:Request){
 const b=createClientFromRequest(req),user=await b.auth.me().catch(()=>null);if(user?.role!=='admin')return Response.json({error:'Admin required'},{status:403});
 try{const input=await req.json();if(input.op==='enqueue')return Response.json(await submitBrowserTask(b,user,input));
 if(!['retry','cancel','archive'].includes(input.op))return Response.json({error:'Unsupported operation'},{status:400});
 const T=b.asServiceRole.entities.OrchestrationTask,t=await T.get(String(input.task_id||''));if(!await trustedBrowserTask(b,t))throw new Error('handler_owned_task_required');
 if(t.status==='running'||t.lease_owner)throw new Error('running_task_requires_worker_reconciliation');
 if(input.op==='retry'&&!['failed','retrying','cancelled'].includes(t.status))throw new Error('task_not_retryable');
 const changes=input.op==='retry'?{status:'queued',failure_reason:null}:{status:'cancelled',completed_time:new Date().toISOString(),result:{archived:input.op==='archive'}};
 const won=await cas(T,t.id,{status:t.status,lease_owner:expect(t,'lease_owner'),lex_queue_proof:t.lex_queue_proof},changes);return Response.json({updated:won?1:0},{status:won?200:409});
 }catch{return Response.json({error:'Task request held; reconcile persisted identity',pending:true},{status:409});}
}
