// Coordinated v2 pull contract. No empty-body legacy fallback.
// Request is bound to method, origin/path/query, caller, timestamp and random challenge.
// Response is bound to that exact challenge AND its raw body. Receiver needs no
// unsafe best-effort nonce insert; a captured response cannot satisfy a fresh pull.
import {cas,expected as expect} from './casBooking.ts';
async function digest(v:any){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(v))))].map(x=>x.toString(16).padStart(2,'0')).join('');}
async function hmac(secret:string,message:string){if(!secret)throw new Error('partner_key_required');const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);return [...new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(message)))].map(x=>x.toString(16).padStart(2,'0')).join('');}
function same(a:string,b:string){if(a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);return d===0;}
export async function signPull(url:string,connection_id:string,secret:string,now=Date.now()){
 const timestamp=String(Math.floor(now/1000)),nonce=crypto.randomUUID(),target=new URL(url).href;
 const message=['LEX-PULL-2','GET',target,connection_id,timestamp,nonce].join('\n');
 return {target,connection_id,timestamp,nonce,headers:{'X-LEX-Pull-Version':'2','X-LEX-Connection-Id':connection_id,'X-LEX-Timestamp':timestamp,'X-LEX-Nonce':nonce,'X-LEX-Signature':'sha256='+await hmac(secret,message)}};
}
export async function verifyPullRequest(req:Request,secret:string,expectedConnection:string,expectedTarget:string,now=Date.now()){
 const h=req.headers,t=h.get('X-LEX-Timestamp')||'',nonce=h.get('X-LEX-Nonce')||'',connection_id=h.get('X-LEX-Connection-Id')||'';
 if(req.method!=='GET'||h.get('X-LEX-Pull-Version')!=='2'||connection_id!==expectedConnection||req.url!==new URL(expectedTarget).href||!/^\d+$/.test(t)||Math.abs(now/1000-Number(t))>60||!/^[0-9a-f-]{36}$/.test(nonce))throw new Error('pull_request_invalid');
 const signature='sha256='+await hmac(secret,['LEX-PULL-2','GET',req.url,connection_id,t,nonce].join('\n'));
 if(!same(signature,h.get('X-LEX-Signature')||''))throw new Error('pull_request_invalid');
 return {target:req.url,connection_id,timestamp:t,nonce};
}
export async function signPullResponse(challenge:any,body:string,secret:string){return 'sha256='+await hmac(secret,['LEX-PULL-RESPONSE-2',challenge.target,challenge.connection_id,challenge.timestamp,challenge.nonce,await digest(body)].join('\n'));}
export async function verifyPullResponse(challenge:any,body:string,signature:string,secret:string,now=Date.now()){
 if(Math.abs(now/1000-Number(challenge.timestamp))>60||!same(await signPullResponse(challenge,body,secret),signature))throw new Error('pull_response_invalid');
 return JSON.parse(body);
}
// Remote adapter: wrap the EXISTING read-only sync handler after partner config
// lookup. Do not use any caller-supplied connection id to choose a signing key.
// Receiver MUST claim the nonce atomically on an existing protected record.
// There is no permissive fallback when nonce storage is unavailable.
export async function pullReceiver(req:Request,config:{secret:string;connection_id:string;target:string},claimNonce:(challenge:any)=>Promise<boolean>,readEvents:(req:Request)=>Promise<Response>){
 let challenge:any;
 try{challenge=await verifyPullRequest(req,config.secret,config.connection_id,config.target);if(await claimNonce(challenge)!==true)throw new Error('pull_replay');}
 catch{return Response.json({error:'Invalid pull authentication'},{status:401});}
 try{const response=await readEvents(req);if(!response.ok)return response;const body=await response.text();return new Response(body,{status:response.status,headers:{'Content-Type':'application/json','X-LEX-Pull-Version':'2','X-LEX-Response-Signature':await signPullResponse(challenge,body,config.secret),'Cache-Control':'no-store'}});}
 catch{return Response.json({error:'Pull read unavailable'},{status:503});}
}

// Receiver-side nonce claim on ONE pre-existing protected connection record. No
// check-then-insert race. Keep entries for the full acceptance window.
export async function claimPullNonce(entity:any,recordId:string,challenge:any,now=Date.now()){
 for(let i=0;i<8;i++){const row=await entity.get(recordId),state=row.lex_pull_nonce_state||[];if(state.some((x:any)=>x.nonce===challenge.nonce))return false;
 const active=state.filter((x:any)=>Number(x.timestamp)>=now/1000-120);
 if(active.length>=1000)throw new Error('pull_nonce_capacity');
 if(await cas(entity,recordId,{lex_pull_nonce_state:expect(row,'lex_pull_nonce_state')},{lex_pull_nonce_state:[...active,{nonce:challenge.nonce,timestamp:challenge.timestamp}]}))return true;}throw new Error('pull_nonce_contention');
}
export async function signPush(url:string,connection_id:string,body:string,secret:string,now=Date.now()){
 const timestamp=String(Math.floor(now/1000)),nonce=crypto.randomUUID();return {'X-LEX-Push-Version':'2','X-LEX-Connection-Id':connection_id,'X-LEX-Timestamp':timestamp,'X-LEX-Nonce':nonce,'X-LEX-Signature':'sha256='+await hmac(secret,['LEX-PUSH-2','POST',new URL(url).href,connection_id,timestamp,nonce,await digest(body)].join('\n'))};
}
export async function verifyPush(req:Request,body:string,secret:string,connectionId:string,now=Date.now()){
 const h=req.headers,t=h.get('X-LEX-Timestamp')||'',nonce=h.get('X-LEX-Nonce')||'';
 if(req.method!=='POST'||h.get('X-LEX-Push-Version')!=='2'||h.get('X-LEX-Connection-Id')!==connectionId||!/^\d+$/.test(t)||Math.abs(now/1000-Number(t))>60||!/^[0-9a-f-]{36}$/.test(nonce))throw new Error('push_invalid');
 const expected='sha256='+await hmac(secret,['LEX-PUSH-2','POST',req.url,connectionId,t,nonce,await digest(body)].join('\n'));if(!same(expected,h.get('X-LEX-Signature')||''))throw new Error('push_invalid');return {nonce,timestamp:t};
}
export async function verifyLegacyScoped(body:string,signature:string,secret:string){return same('sha256='+await hmac(secret,body),signature);}
