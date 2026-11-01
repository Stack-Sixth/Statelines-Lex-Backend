// A protected parent row is the uniqueness boundary. One CAS winner may issue
// one insert. There is deliberately no timed lease takeover of an uncertain insert.
import {cas,expected,ClaimPending} from './casBooking.ts';
function stable(x:any):any {return Array.isArray(x)?x.map(stable):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,stable(x[k])])):x;}
async function signature(secret:string,plan:any) {
 if(!secret||secret.length<32)throw new Error('Private record signing key required');
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const {signature:ignored,...payload}=plan;
 return [...new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(JSON.stringify(stable(payload)))))].map(x=>x.toString(16).padStart(2,'0')).join('');
}
export async function artifactPlan(secret:string,parent_id:string,entity:string,document:any) {
 const plan:any={parent_id,entity,nonce:crypto.randomUUID(),document};
 return {...plan,signature:await signature(secret,plan)};
}
export async function projectArtifact(entities:any,parent_id:string,field:string,secret:string) {
 const Parent=entities.Shipment;let parent=await Parent.get(parent_id);let slot=parent[field];
 if(!slot?.plan||slot.plan.parent_id!==parent_id||slot.plan.signature!==await signature(secret,slot.plan))throw new ClaimPending('artifact_authority_unverified');
 const plan=slot.plan,Entity=entities[plan.entity];
 if(!['ShipmentEvent','ShipperDeclaration','Notification','AuditLog'].includes(plan.entity))throw new ClaimPending('artifact_entity_denied');
 if(slot.phase==='done')return slot.row_id;
 if(slot.phase==='pending') {
  const creating={...slot,phase:'creating'};
  const won=await cas(Parent,parent_id,{[field]:slot},{[field]:creating});
  if(won) {
   let result;
   try {result=await Entity.create({...plan.document,server_artifact_ref:plan.nonce});}
   catch {throw new ClaimPending('artifact_insert_unknown',{artifact_ref:plan.nonce});}
   await cas(Parent,parent_id,{[field]:creating},{[field]:{...creating,phase:'done',row_id:result.id}});
  }
  parent=await Parent.get(parent_id);slot=parent[field];
 }
 if(slot.phase==='creating') {
  const result=await Entity.filter({server_artifact_ref:plan.nonce},'-created_date',2);
  const rows=Array.isArray(result)?result:result?.items||[];
  if(rows.length!==1)throw new ClaimPending(rows.length?'artifact_duplicate_conflict':'artifact_insert_unknown',{artifact_ref:plan.nonce});
  // A matching nonce is not sufficient when the destination supports user writes.
  if(Object.entries(plan.document).some(([k,v])=>JSON.stringify(stable(rows[0][k]))!==JSON.stringify(stable(v))))throw new ClaimPending('artifact_payload_conflict');
  await cas(Parent,parent_id,{[field]:slot},{[field]:{...slot,phase:'done',row_id:rows[0].id}});
 }
 const done=(await Parent.get(parent_id))[field];
 if(done.phase!=='done')throw new ClaimPending('artifact_settlement_pending');
 return done.row_id;
}
export async function ensureArtifact(entities:any,parent:any,field:string,entity:string,document:any,secret:string) {
 if(!parent[field]) {
  const slot={phase:'pending',plan:await artifactPlan(secret,parent.id,entity,document)};
  await cas(entities.Shipment,parent.id,{[field]:expected(parent,field)},{[field]:slot});
 }
 return projectArtifact(entities,parent.id,field,secret);
}
export async function verifiedPlan(plan:any,parent_id:string,entity:string,secret:string) {
 return !!plan&&plan.parent_id===parent_id&&plan.entity===entity&&plan.signature===await signature(secret,plan);
}
