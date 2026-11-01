import {recoverBundle} from "../../shared/lexBundleRecovery.ts";
import {createClientFromRequest} from 'npm:@base44/sdk@0.8.52';
import {resumeTransition} from '../../shared/lexTransitionRecovery.ts';
import {rows,verified} from '../../shared/lexEffectProof.ts';
// Recovery reads the durable parent intent; it does NOT infer missing events
// from current status or fabricate a command. Admin/operator only, no new schedule.
export default async function(req:Request):Promise<Response> {
 const b=createClientFromRequest(req),user=await b.auth.me().catch(()=>null);
 if(user?.role!=='admin')return Response.json({error:'Admin required'},{status:403});
 const body=await req.json().catch(()=>({})),S=b.asServiceRole.entities.Shipment;
 const items=body.shipment_id?[await S.get(String(body.shipment_id))]:rows(await S.filter({$or:[{lex_effects_pending:true},{lex_bundle_pending:true}]},'-last_transition_at',100));
 const results=[];
 for(const row of items) {
  try {
   if(!await verified(row.lex_transition?.proof,'transition',row.id))throw new Error('signed_transition_intent_required');
   const result=await resumeTransition(b,row);let bundle:any=null;
   if(row.lex_bundle_pending) {
    for(const receipt of [...(row.lex_transition_history||[]),row.lex_transition])if(await verified(receipt?.proof,'transition',row.id)&&receipt.proof.document.service_plan?.document?.bundle_id===row.bundle_id)bundle=receipt.proof.document.service_plan;
    if(!bundle)throw new Error('bundle_plan_required');await recoverBundle(b,bundle);
   }
   results.push({shipment_id:row.id,ok:result.ok,code:result.code||null});
  } catch {results.push({shipment_id:row.id,ok:false,pending:true,reason:'reconciliation_required_no_blind_insert_retry'});}
 }
 return Response.json({results,booking_enabled:false});
}
