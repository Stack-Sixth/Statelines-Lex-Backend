import {createClientFromRequest} from "npm:@base44/sdk@0.8.52";
import draftHandler from "../../shared/statelinesControlledDraft20261101/functions/merchantDraft/entry.ts";
import {resolveBookingMerchant} from "../../shared/statelinesControlledDraft20261101/shared/bookingMerchant.ts";
// Cohort-only adapter. Ordinary production writers and UI retain their current code.
const approved:Record<string,string>={"6ae36074e14192b2f7f51dc7":"6ae36089acdf77499fbf16d5","6ae36bfacc7ef5a364d5403f":"6ae36c0f51cbdef3e3e7b3c7"};
export default async function(req:Request):Promise<Response>{
 if(req.method!=="POST")return Response.json({error:"Method not allowed"},{status:405});
 try{
  const b=createClientFromRequest(req),user=await b.auth.me().catch(()=>null);
  if(!user)return Response.json({error:"Unauthorized"},{status:401});
  if(user.role!=="user"||!approved[user.id])return Response.json({error:"Approved controlled-test account required"},{status:403});
  const merchant=await resolveBookingMerchant(b.asServiceRole,user);
  if(!merchant||merchant.id!==approved[user.id])return Response.json({error:"Approved controlled-test business required"},{status:403});
  const body=await req.clone().json();
  if(body.draft_id){
   const row=await b.asServiceRole.entities.ControlledMerchantDraft.get(String(body.draft_id)).catch(()=>null);
   if(!row||row.merchant_id!==merchant.id)return Response.json({error:"Not found"},{status:404});
  }
  const response=await draftHandler(req);
  if(body.action==="list"&&response.ok){
   const result=await response.json();
   return Response.json({...result,items:(result.items||[]).filter((row:any)=>row.merchant_id===merchant.id)},{status:response.status});
  }
  return response;
 }catch{return Response.json({error:"Controlled draft authorization unavailable"},{status:503});}
}
