import {createClientFromRequest} from 'npm:@base44/sdk@0.8.52';
import {secrets} from 'base44:runtime';
import {localOwnership,snapshotDigest,operationSnapshot,arrayRows} from '../../shared/shipmentAuthority.ts';
export default async function(req:Request):Promise<Response> {
 const b=createClientFromRequest(req),actor=await b.auth.me().catch(()=>null);
 if(actor?.role!=='admin')return Response.json({error:'Admin review required'},{status:403});
 const input=await req.json(),sr=b.asServiceRole,row=await sr.entities.Shipment.get(String(input.shipment_id||''));
 if(input.action==='revoke') {
  const record=await sr.entities.LegacyShipmentAuthority.get(String(input.authority_id||''));
  if(record.shipment_id!==row.id)return Response.json({error:'Authority mismatch'},{status:409});
  const result=await sr.entities.LegacyShipmentAuthority.updateMany({id:record.id,status:'active'},{$set:{status:'revoked',revoked_by:actor.id,revoked_at:new Date().toISOString()}});
  return Response.json({revoked:result?.updated===1,shipment_id:row.id,booking_enabled:false},{status:result?.updated===1?200:409});
 }
 const ownership=await localOwnership(sr,row);
 if(!ownership.verified)return Response.json({error:'Independent ownership evidence required'},{status:409});
 const digest=await snapshotDigest(row);
 if(input.action==='preview')return Response.json({shipment_id:row.id,ownership,snapshot:operationSnapshot(row),digest,
   note:'Readonly review. A command ID is not verified by ownership approval.'});
 if(input.action!=='confirm'||input.digest!==digest||!String(input.evidence_ref||'').trim())return Response.json({error:'Current digest and protected evidence reference required'},{status:409});
 const epoch=secrets.get('MERCHANT_AUTHORITY_POLICY_EPOCH');
 if(!epoch||input.policy_epoch!==epoch)return Response.json({error:'Hosted-verified policy epoch required'},{status:409});
 const principals=Array.isArray(input.principals)?input.principals:[];
 if(!principals.length||principals.some((p:string)=>!['merchant','partner','lex','platform_sync','automation'].includes(p)))return Response.json({error:'Explicit principal grants required'},{status:400});
 const existing=arrayRows(await sr.entities.LegacyShipmentAuthority.filter({shipment_id:row.id,status:'active'},'-created_date',3));
 if(existing.length)return Response.json({error:'Existing approval requires explicit revision review; no overwrite'},{status:409});
 if(await snapshotDigest(await sr.entities.Shipment.get(row.id))!==digest)return Response.json({error:'Shipment changed during review'},{status:409});
 // Admin approval, not a claim of restored command provenance. No command fields change.
 const record=await sr.entities.LegacyShipmentAuthority.create({shipment_id:row.id,owner_user_id:ownership.owner_user_id,merchant_id:ownership.merchant_id,
   snapshot_digest:digest,principals,policy_epoch:epoch,status:'active',evidence_ref:String(input.evidence_ref),approved_by:actor.id,approved_at:new Date().toISOString()});
 return Response.json({approved:true,authority_id:record.id,shipment_id:row.id,command_provenance:'untrusted',booking_enabled:false});
}
