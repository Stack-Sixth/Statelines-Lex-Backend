import {createClientFromRequest} from 'npm:@base44/sdk@0.8.52';
// A preflight read followed by User.delete is not a transaction with booking.
// Preserve the self-service request, but leave irreversible deletion to the
// supported operator process after producer freeze and retention review.
export default async function(req:Request):Promise<Response> {
 try {
  const b=createClientFromRequest(req),user=await b.auth.me().catch(()=>null);
  if(!user)return Response.json({error:'Unauthorized'},{status:401});
  const body=await req.json().catch(()=>({}));
  if(body.confirm!=='DELETE')return Response.json({error:'Confirmation required'},{status:400});
  await b.asServiceRole.entities.AuditLog.create({actor_id:user.id,action:'account_closure_requested',entity:'User',entity_id:user.id,
   detail:'Authenticated account closure request. Retention review and producer freeze required before irreversible deletion.'});
  return Response.json({deleted:false,requested:true,pending:true,code:'account_closure_review_required',
   message:'Your account closure request was recorded. Support must review retained shipping history and stop active writers before deletion. Your account and records have not been deleted.'},{status:202});
 } catch {return Response.json({error:'Closure request was not confirmed; no account or records were deleted'},{status:503});}
}
