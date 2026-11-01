// Explicit reviewed cleanup only. Geographic names never establish test status.
// The old no-argument scan is now a no-op; it must not cancel production parcels.
import {createClientFromRequest} from 'npm:@base44/sdk@0.8.49';
import {requireInternalSecret} from '../../shared/lexInternalGate.ts';
import {transitionShipment} from '../../shared/lexTransitions.ts';
import {resolveTrustedIsolation,operationalLocal} from '../../shared/lexTrustedIsolation.ts';
export default async function(req:Request):Promise<Response>{
 const denied=await requireInternalSecret(req);if(denied)return denied;
 const b=createClientFromRequest(req),user=await b.auth.me().catch(()=>null);
 if(!user)return Response.json({error:'Unauthorized'},{status:401});if(user.role!=='admin')return Response.json({error:'Forbidden'},{status:403});
 const body=await req.json().catch(()=>({}));
 if(!Array.isArray(body.operations)||body.operations.length===0)return Response.json({scanned_pages:0,test_shipments_found:0,cancelled:0,skipped:0,failed:0,results:[],held:true,reason:'Explicit reviewed operations required; geographic cleanup is disabled'});
 if(body.operations.length>20)return Response.json({error:'At most 20 reviewed operations'},{status:400});
 const results=[];let cancelled=0,skipped=0,failed=0;
 for(const op of body.operations){
  try{
   if(!op||typeof op!=='object'||!Number.isInteger(op.expected_version)||op.expected_version<0||typeof op.command_id!=='string'||!op.command_id||Object.keys(op).some(k=>!['shipment_id','command_id','expected_version'].includes(k)))throw Error('invalid_reviewed_operation');
   const resolved=await resolveTrustedIsolation(b,{shipment_id:op.shipment_id});if(resolved.kind!=='ordinary')throw Error('isolation_or_mapping_hold');
   const ship=await operationalLocal(b,resolved);if(!ship)throw Error('protected_local_mapping_required');
   if(body.execute!==true){skipped++;results.push({id:ship.id,dry_run:true});continue;}
   // Same signed intent/capacity/history/outbox recovery as every other
   // cancellation. Render mutation is queued, never bypassed here.
   const result=await transitionShipment(b,{shipment_id:ship.id,tracking_id:ship.tracking_id,command_id:op.command_id,expected_version:op.expected_version,to_status:'cancelled',actor:user,note:'Explicit reviewed cleanup',source:'lexEngineCleanup'});
   if(result.ok){cancelled++;results.push({id:ship.id,cancelled:true,engine_sync:result.engine_sync||null});}
   else{skipped++;results.push({id:ship.id,pending:true,code:result.code||409});}
  }catch{failed++;results.push({id:op?.shipment_id||null,held:true,reason:'reviewed_identity_or_transition_required'});}
 }
 return Response.json({scanned_pages:0,test_shipments_found:body.operations.length,cancelled,skipped,failed,results});
}
