import {createClientFromRequest} from 'npm:@base44/sdk@0.8.52';
import {secrets} from 'base44:runtime';
import {recordAuthority,recordOwner} from '../../shared/serverRecord.ts';
import {findExceptionByMerchant} from '../../shared/bookingException.ts';
// This export has NO authenticated shipment-capture receipt writer. A mutable
// Payment row or a different created_by_id cannot authorize withdrawable money.
// Retain the callable contract/ownership checks; never issue an unsafe credit.
export default async function(req:Request):Promise<Response> {
 try {
  const b=createClientFromRequest(req),user=await b.auth.me().catch(()=>null);
  if(!user)return Response.json({error:'Unauthorized'},{status:401});
  const body=await req.json(),id=String(body.shipment_id||'');
  if(!id)return Response.json({error:'Shipment ID is required'},{status:400});
  const row=await b.asServiceRole.entities.Shipment.get(id).catch(()=>null);
  if(!row||await recordOwner('Shipment',row,recordAuthority(secrets.get('MERCHANT_RECORD_SIGNING_SECRET')))!==user.id)
   return Response.json({error:'Shipment not found'},{status:404});
  const trusted=await recordAuthority(secrets.get('MERCHANT_RECORD_SIGNING_SECRET')).trusted('Shipment',row);
  const synthetic=trusted&&(row.test_harness===true||!!findExceptionByMerchant({local_merchant_id:row.merchant_id}));
  return Response.json({ok:true,skipped:synthetic?'synthetic_rewards_disabled':'trusted_payment_receipt_required',issued:false});
 } catch {return Response.json({error:'Reward evidence unavailable'},{status:409});}
}
