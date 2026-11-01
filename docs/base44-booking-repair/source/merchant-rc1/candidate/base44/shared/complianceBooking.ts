import validateShipmentCompliance from '../functions/validateShipmentCompliance/entry.ts';
import {POLICY_VERSION} from './shippingPolicy.ts';
// Invoke the existing screening contract with the original authenticated caller.
// No browser decision/result is accepted as evidence.
export async function screenBooking(req:Request,draft:any,merchant:any) {
 if(draft.declaration_checked!==true)throw Object.assign(new Error('Shipper declaration acceptance required'),{code:'declaration_required',status:400});
 const raw=draft.data?.compliance;
 const c=raw&&{item_category:String(raw.item_category||'').trim().slice(0,80),contents_description:String(raw.contents_description||'').trim().slice(0,500),quantity:Math.max(1,Math.min(Number(raw.quantity)||1,1000)),has_battery:raw.has_battery===true,battery_details:String(raw.battery_details||'').trim().slice(0,300)};
 if(!c||!String(c.contents_description||'').trim())throw Object.assign(new Error('Contents declaration required'),{code:'declaration_required',status:400});
 const headers=new Headers(req.headers);headers.delete('content-length');headers.set('content-type','application/json');
 const result=await validateShipmentCompliance(new Request(req.url,{method:'POST',headers,body:JSON.stringify({
  action:'validate',merchant_id:merchant.id,shipment_draft_id:draft.id,
  item_category:c.item_category,contents_description:c.contents_description,quantity:c.quantity,
  has_battery:c.has_battery,battery_details:c.battery_details,
 })}));
 const decision=await result.json();
 if(!result.ok||decision.status!=='permitted')throw Object.assign(new Error('Compliance approval required'),{code:'compliance_approval_required',status:403});
 return {status:'permitted',policy_version:POLICY_VERSION,checked_at:new Date().toISOString(),accepted_by:draft.server_owner_user_id,
  declaration:{...c},decision};
}
