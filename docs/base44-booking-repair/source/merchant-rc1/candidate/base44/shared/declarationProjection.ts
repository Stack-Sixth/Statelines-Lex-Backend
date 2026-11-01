import {ensureArtifact} from './artifactProjection.ts';
export async function settleBookingDeclaration(entities:any,shipment:any,secret:string) {
 const e=shipment.compliance_evidence;
 if(shipment.test_harness===true)return; // Synthetic fixture is not a real shipper declaration.
 if(e?.status!=='permitted'||!e.declaration||!e.accepted_by)throw new Error('Persisted compliance evidence required');
 return ensureArtifact(entities,shipment,'declaration_projection','ShipperDeclaration',{
  merchant_id:shipment.merchant_id,shipment_id:shipment.id,shipment_draft_id:shipment.booking_intent?.replace(/^draft:/,''),
  policy_version:e.policy_version,declaration_timestamp:e.checked_at,contents_description:e.declaration.contents_description,
  item_category:e.declaration.item_category,compliance_decision:e.status,compliance_review_id:e.decision?.approvedReviewId||'',created_by_id:e.accepted_by,
 },secret);
}
export async function settleBookingNotification(entities:any,shipment:any,secret:string) {
 if(shipment.test_harness===true)return;
 return ensureArtifact(entities,shipment,'created_notification_projection','Notification',{
  merchant_id:shipment.merchant_id,created_by_id:shipment.server_owner_user_id,
  title:'Shipment created',body:`${shipment.tracking_number} · ${shipment.origin_city} → ${shipment.destination_city}`,type:'shipment',
 },secret);
}
