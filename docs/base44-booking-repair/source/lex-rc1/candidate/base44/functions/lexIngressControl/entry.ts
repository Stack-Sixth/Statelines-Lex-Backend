import {createClientFromRequest} from 'npm:@base44/sdk@0.8.49';
import {issueIngressBinding,authorizeIngress} from '../../shared/lexIngressAuthority.ts';
import {cas,verified} from '../../shared/lexEffectProof.ts';
export default async function(req:Request){
 const b=createClientFromRequest(req),actor=await b.auth.me().catch(()=>null);if(actor?.role!=='admin')return Response.json({error:'Admin required'},{status:403});
 try{const input=await req.json(),E=b.asServiceRole.entities.LexIngressBinding;
 if(input.op==='prepare'){const row=await issueIngressBinding(b,input,actor);return Response.json({binding_id:row.id,status:'revoked',booking_enabled:false});}
 const row=await E.get(String(input.binding_id||''));if(!await verified(row.proof,'ingress_binding',row.id))throw new Error('invalid_binding');
 if(input.op==='revoke')return Response.json({revoked:await cas(E,row.id,{status:'active'},{status:'revoked'})});
 if(input.op!=='confirm')throw new Error('unsupported_operation');
 // Each ingestion still independently checks canonical ownership. Config switches
 // are NOT enabled here. Invalid/ambiguous mappings never pass that check.
 if(!await cas(E,row.id,{status:'revoked',proof:row.proof},{status:'active'}))throw new Error('binding_conflict');
 try{const doc=row.proof.document;await authorizeIngress(b,{app:doc.app,tracking_id:doc.tracking_id,pkg:null},{connection_id:doc.connection_id,mode:'review'});}
 catch(e){await cas(E,row.id,{status:'active',proof:row.proof},{status:'revoked'});throw e;}
 return Response.json({binding_id:row.id,status:'active',booking_enabled:false});
 }catch{return Response.json({error:'Ingress mapping review incomplete; no gate changed'},{status:409});}
}
