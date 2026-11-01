import {createClientFromRequest} from 'npm:@base44/sdk@0.8.52';
import {localOwnership} from '../../shared/shipmentAuthority.ts';
export default async function(req:Request):Promise<Response> {
 const b=createClientFromRequest(req),user=await b.auth.me().catch(()=>null);
 if(user?.role!=='admin')return Response.json({error:'Admin only'},{status:403});
 const body=await req.json(),row=await b.asServiceRole.entities.Shipment.get(String(body.shipment_id||''));
 const ownership=await localOwnership(b.asServiceRole,row);
 return Response.json({ready:false,review_ready:!!row.booking_command_claim&&ownership.command_provenance==='server',shipment_id:row.id,
  payload:ownership.command_provenance==='server'?row.booking_command_claim?.payload||null:null,
  code:ownership.command_provenance==='server'?'readonly_preview':'legacy_identity_review_required',
  message:'Readonly preview; no command generated, persisted, replaced or submitted.'});
}
