// Protected sender membership and immutable platform creator identify the
// booking account. Mutable contact_email is never an authorization join.
export async function resolveBookingMerchant(client:any,user:any) {
 const rows=(x:any)=>Array.isArray(x)?x:x?.items||[];
 const memberships=rows(await client.entities.PortalMembership.filter({user_id:user.id,portal_type:'sender'},'-created_date',10));
 if(memberships.some((m:any)=>m.status==='suspended'||m.status==='revoked'))return null;
 const owned=rows(await client.entities.Merchant.filter({created_by_id:user.id},'-created_date',3));
 return owned.length===1?owned[0]:null;
}
