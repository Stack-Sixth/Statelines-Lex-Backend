import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {stripTypeScriptTypes} from 'node:module';
const root=new URL('../candidate/base44/',import.meta.url);
function load(path:string,bindings:any,names=['handler']) {
 let s=readFileSync(new URL(path,root),'utf8').replace(/^import\s[\s\S]*?;\s*$/gm,'');s=s.replace('export default async function','const handler = async function');
 const js=stripTypeScriptTypes(s,{mode:'transform'}).replace(/^export /gm,'');
 return new Function(...Object.keys(bindings),js+`;return {${names.join(',')}};`)(...Object.values(bindings));
}
const clone=(v:any)=>structuredClone(v);const equal=(a:any,b:any)=>JSON.stringify(a)===JSON.stringify(b);
function matches(row:any,q:any):boolean {return Object.entries(q).every(([k,v]:any)=>{
 if(k==='$or')return v.some((x:any)=>matches(row,x));if(k==='$and')return v.every((x:any)=>matches(row,x));
 if(v&&typeof v==='object'&&!Array.isArray(v)){
  if('$exists'in v)return Object.hasOwn(row,k)===v.$exists;if('$in'in v)return v.$in.includes(row[k]);if('$lte'in v)return row[k]<=v.$lte;if('$gte'in v)return row[k]>=v.$gte;if('$gt'in v)return row[k]>v.$gt;
 }
 return equal(row[k],v);
});}
class Store {
 data=new Map<string,any>();creates=0;updates=0;before=async(_op:string,_arg:any)=>{};after=async(_op:string,_arg:any)=>{};
 constructor(public name:string,rows:any[]=[]){for(const r of rows)this.data.set(r.id,clone(r));}
 async get(id:string){await this.before('get',id);if(!this.data.has(id))throw new Error('missing');return clone(this.data.get(id));}
 async filter(q:any={},sort?:any,limit=1000){await this.before('filter',q);let result=[...this.data.values()].filter(r=>matches(r,q)).slice(0,typeof sort==='object'&&sort?sort.limit||limit:limit).map(clone);return typeof sort==='object'&&sort?{items:result}:result;}
 async list(_sort?:any,limit=1000){return [...this.data.values()].slice(0,limit).map(clone);}
 async create(data:any){await this.before('create',data);const row={...clone(data),id:this.name+'-'+(++this.creates)};this.data.set(row.id,row);await this.after('create',row);return clone(row);}
 async update(id:string,changes:any){await this.before('update',{id,changes});Object.assign(this.data.get(id),clone(changes));this.updates++;await this.after('update',{id,changes});return this.get(id);}
 async updateMany(q:any,change:any){assert.equal(typeof q.id,'string');await this.before('cas',{q,change});const row=this.data.get(q.id);if(!row||!matches(row,q))return {updated:0};Object.assign(row,clone(change.$set||{}));for(const [k,v]of Object.entries(change.$inc||{}))row[k]=(row[k]||0)+Number(v);this.updates++;await this.after('cas',{q,change});return {updated:1};}
}
const key='UNIT-ONLY-LEX-OPERATION-SIGNING-SECRET-000000';
const uuid='12345678-1234-4234-8234-123456789abc',other='22345678-1234-4234-8234-123456789abc';
const sid='aaaaaaaaaaaaaaaaaaaaaaaa',pid='bbbbbbbbbbbbbbbbbbbbbbbb',cid='cccccccccccccccccccccccc';
async function env(isolated=false) {
 const config:any={LEX_API_URL:'https://backend.unit',LEX_OPERATION_SIGNING_SECRET:key,LEX_OPERATION_POLICY_EPOCH:'epoch-v1',LEX_WEBHOOK_SECRET:'UNIT-ONLY-WEBHOOK'};
 const base:any={secrets:{get:(n:string)=>config[n]},backendTarget:(s:string)=>new URL(s).origin,renderBaseUrl:()=>config.LEX_API_URL,signedRenderHeaders:async()=>({'Authorization':'UNIT-ONLY'})};
 const proof=load('shared/lexEffectProof.ts',base,['stable','digest','seal','verified','absent','expect','rows','EffectsPending','cas']);Object.assign(base,proof);
 const store:any={};for(const name of ['Shipment','CrossAppPackage','CommunityCarrier','LexOperationalAuthority','EventLog','AuditLog','ShipmentLifecycleEvent','ChainOfCustodyEvent','OrchestrationTask','FraudAlert','Incident','SmartBundle','OperationalRule','PlatformDelivery','PlatformConnection','DeadLetterEvent','PlatformConfig','StaffAccess','Notification'])store[name]=new Store(name);
 store.PlatformConnection.data.set('conn',{id:'conn',status:'active',name:'Synthetic destination',webhook_url:'https://carrier.unit/webhook'});
 const user={id:'admin',role:'admin',full_name:'Synthetic operator'};
 const b:any={auth:{me:async()=>user},asServiceRole:{entities:store,integrations:{Core:{InvokeLLM:async()=>({alerts:[]})}}}};
 const remote:any={id:uuid,tracking_id:'ENGINE-TRACK',sandbox_isolated:isolated,status:'in_transit',version:1};let sends:any[]=[];
 const ship={id:sid,created_by_id:'owner',tracking_id:'SOURCE-TRACK',origin:'Alpha',destination:'Beta',weight_kg:1,package_size:'small',service_level:'standard',status:'in_transit',version:1,assigned_carrier_id:cid};
 const pkg={id:pid,tracking_id:ship.tracking_id,origin:'Alpha',destination:'Beta',weight_kg:1,package_size:'small',service_level:'standard',engine_shipment_id:uuid,engine_version:1};
 store.Shipment.data.set(sid,clone(ship));store.CrossAppPackage.data.set(pid,clone(pkg));store.CommunityCarrier.data.set(cid,{id:cid,owner_user_id:'driver',capacity_used_kg:1,capacity_total_kg:10,total_deliveries:0,status:'in_transit',route_origin:'Alpha',route_destination:'Beta',service_levels:['standard'],vehicle_type:'van'});
 const auth=load('shared/lexOperationalAuthority.ts',base,['localDigest','localAuthority','linkedEngineId']);Object.assign(base,auth);
 async function approve(type:string,row:any,extra:any={}) {
  const document={record_type:type,snapshot_digest:await auth.localDigest(row),policy_epoch:'epoch-v1',backend_target:'https://backend.unit',classification:isolated?'isolated':'ordinary',business_reference:'VERIFIED-PRODUCTION-BIZ',approved_engine_id:type==='NonShipmentEvent'?null:uuid,approved_assigned_carrier_id:row.assigned_carrier_id||null,approved_capacity_reserved_kg:1,allow_engine_create:type==='CrossAppPackage',...extra};
  const existing=[...store.LexOperationalAuthority.data.values()].find((r:any)=>r.record_type===type&&r.record_id===row.id);if(existing)store.LexOperationalAuthority.data.delete(existing.id);
  return store.LexOperationalAuthority.create({record_type:type,record_id:row.id,status:'active',proof:await proof.seal('local_operation',row.id,document)});
 }
 await approve('Shipment',ship);await approve('CrossAppPackage',pkg);
 base.fetch=async(u:any,o:any={})=>{
  const url=new URL(u);if(url.hostname!=='backend.unit'){sends.push({url:String(u),options:clone({...o,signal:undefined})});return new Response('',{status:200});}
  if((o.method||'GET')==='GET'){if(url.pathname==='/v1/shipments')return Response.json({items:[remote],next_cursor:null});return Response.json({shipment:{...remote,id:url.pathname.endsWith(other)?other:remote.id}});}
  sends.push({url:String(u),options:clone({...o,signal:undefined})});return Response.json({...remote,version:2},{status:201});
 };
 const iso=load('shared/lexTrustedIsolation.ts',base,['engineUuid','resolveTrustedIsolation','resolveLocalOperation','isolationDenied','ordinaryEventCopy','operationalLocal']);Object.assign(base,iso);
 const events=load('shared/lexEventIsolation.ts',base,['eventIsolation','requireOrdinaryEvent']);Object.assign(base,events);
 const utils=load('shared/lexUtils.ts',base,['nowIso','appendToOutbox','publishEvent','uuid','haversineKm','carrierEligibleForShipment','timingEligible','serviceLevelOk','carrierAvailableCapacityKg','corridorOverlap']);Object.assign(base,utils);
 const perms=load('shared/lexPermissions.ts',base,['resolveLevelAsync','requirePerm']);Object.assign(base,perms);
 const rec=load('shared/lexTransitionRecovery.ts',base,['applyCapacityPlan','projectTransitionArtifact','resumeTransition']);Object.assign(base,rec);
 const transitions=load('shared/lexTransitions.ts',base,['transitionShipment','authorizeTransition','CUSTODY_TO_STATUS','STAGE_TO_STATUS']);Object.assign(base,transitions);
 const bridge=load('shared/lexBridge.ts',base,['deliver','recordDelivery','isSubscribed','buildEnvelope']);Object.assign(base,bridge);
 const boundary=load('shared/lexEngineBoundary.ts',base,['requireEngineMutation','requirePackageMutation']);Object.assign(base,boundary);
 const engine=load('shared/lexEngineCreateRecovery.ts',base,['engineCreatePayload','confirmEngineCreate','settleEngineOutbox']);Object.assign(base,engine);
 const queueSubmission=load('shared/lexQueueSubmission.ts',base,['trustedBrowserTask','submitBrowserTask']);Object.assign(base,queueSubmission);
 const taskAuthority=load('shared/lexTaskAuthority.ts',base,['trustedEngineTask','trustedQueuePublication']);Object.assign(base,taskAuthority);
 const bundle=load('shared/lexBundleRecovery.ts',base,['recoverBundle']);Object.assign(base,bundle);
 base.createClientFromRequest=()=>b;
 return {b,base,store,remote,ship,pkg,user,approve,config,sends,transition:transitions.transitionShipment};
}
const request=(body:any)=>new Request('https://unit.invalid',{method:'POST',body:JSON.stringify(body)});
function opts(command='command-1',to='in_transit'){return {shipment_id:sid,tracking_id:'SOURCE-TRACK',command_id:command,to_status:to,actor:{id:'admin',role:'admin',full_name:'Synthetic operator'},custody:{event_type:'in_transit',location:'Synthetic'},note:'Synthetic test'};}

test('shared delivery reloads event and blocks missing-marker synthetic without signing/sending',async()=>{
 const e=await env(true);e.store.EventLog.data.set('event',{id:'event',event_name:'ShipmentInTransit',payload:{engine_shipment_id:uuid}});
 const result=await e.base.deliver({id:'conn',webhook_url:'https://carrier.unit/webhook'}, {id:'event',payload:{sandbox_isolated:false}},'UNIT-KEY',e.b);
 assert.equal(result.held,true);assert.equal(e.sends.length,0);
});
test('ordinary delivery retains complete Carrier envelope, headers and HMAC protocol',async()=>{
 const e=await env();const event={id:'event',event_name:'ShipmentInTransit',payload:{engine_shipment_id:uuid,version:1},schema_version:1,source:'statelines-lex',occurred_at:'UNIT-TIME',aggregate_type:'shipment',aggregate_id:uuid,aggregate_version:1};e.store.EventLog.data.set(event.id,event);
 const result=await e.base.deliver({id:'conn',webhook_url:'https://carrier.unit/webhook'}, {id:'event',payload:{tampered:true}},'UNIT-SIGNING',e.b);assert.equal(result.ok,true);assert.equal(e.sends.length,1);
 const sent=e.sends[0].options;assert.deepEqual(JSON.parse(sent.body),e.base.buildEnvelope(event));assert.match(sent.headers['X-LEX-Signature'],/^sha256=[0-9a-f]{64}$/);assert.equal(sent.headers['X-LEX-Event-Id'],'event');assert.equal(sent.headers['X-LEX-Event'],'ShipmentInTransit');
});
test('deleted event cannot be reconstructed from queue or DLQ payload',async()=>{
 const e=await env();const result=await e.base.deliver({id:'conn',webhook_url:'https://carrier.unit'}, {id:'absent',payload:{engine_shipment_id:uuid}},'UNIT',e.b);assert.equal(result.held,true);assert.equal(e.sends.length,0);
});
test('backend lookup error or absent persisted marker fails closed',async()=>{
 for(const mode of ['missing','error']){const e=await env();if(mode==='missing')delete e.remote.sandbox_isolated;else e.base.fetch=async()=>{throw new Error('offline');};
  // Recreate resolver using the changed fetch closure.
  const iso=load('shared/lexTrustedIsolation.ts',e.base,['resolveTrustedIsolation']);const result=await iso.resolveTrustedIsolation(e.b,{engine_shipment_id:uuid});assert.equal(result.kind,'unknown');assert.equal(e.sends.length,0);
 }
});
test('source tracking, local id, canonical SHP and UUID agree through protected mapping',async()=>{
 const e=await env();const result=await e.base.resolveTrustedIsolation(e.b,{shipment_id:sid,tracking_id:'SOURCE-TRACK',engine_shipment_id:'SHP_'+uuid.replaceAll('-','')});assert.equal(result.kind,'ordinary');assert.equal(result.shipment.tracking_id,'ENGINE-TRACK');
 assert.equal((await e.base.resolveTrustedIsolation(e.b,{shipment_id:sid,engine_shipment_id:other})).kind,'unknown');
});
test('caller primed local linkage cannot authorize an ordinary operational mutation',async()=>{
 const e=await env();e.store.LexOperationalAuthority.data.clear();const result=await e.transition(e.b,opts());assert.equal(result.ok,false);assert.equal(e.store.Shipment.updates,0);assert.equal(e.sends.length,0);
});
test('same-status concurrent transitions without expected_version have one observed-version winner',async()=>{
 const e=await env();const results=await Promise.all([e.transition(e.b,opts('one')),e.transition(e.b,opts('two'))]);assert.equal(results.filter(r=>r.ok).length,1);assert.equal((await e.store.Shipment.get(sid)).version,2);assert.equal(e.store.ShipmentLifecycleEvent.creates,1);assert.equal(e.store.EventLog.creates,1);
});
test('same-command concurrent retries and replay do not repeat capacity or history',async()=>{
 const e=await env();e.store.Shipment.data.get(sid).status='out_for_delivery';const results=await Promise.all(Array.from({length:8},()=>e.transition(e.b,opts('same','delivered'))));assert.ok(results.some(r=>r.ok),JSON.stringify(results.map(r=>({ok:r.ok,error:r.error}))));
 const again=await e.transition(e.b,opts('same','delivered'));assert.equal(again.ok,true);assert.equal(again.idempotent,true);assert.equal(e.store.EventLog.creates,1);assert.equal((await e.store.CommunityCarrier.get(cid)).total_deliveries,1);assert.equal((await e.store.CommunityCarrier.get(cid)).capacity_used_kg,0);
});
test('a reused command with changed custody payload conflicts without a second write',async()=>{
 const e=await env();assert.equal((await e.transition(e.b,opts())).ok,true);const o=opts();o.custody.location='Changed';assert.equal((await e.transition(e.b,o)).code,409);assert.equal(e.store.EventLog.creates,1);
});
test('capacity CAS lost acknowledgment is recovered from the carrier token without double increment',async()=>{
 const e=await env();e.store.Shipment.data.get(sid).status='out_for_delivery';let once=true;e.store.CommunityCarrier.after=async(op:string)=>{if(op==='cas'&&once){once=false;throw new Error('lost ack');}};
 const transitionResult=await e.transition(e.b,opts('deliver','delivered'));assert.equal(transitionResult.ok,true,JSON.stringify(transitionResult));assert.equal((await e.store.CommunityCarrier.get(cid)).total_deliveries,1);assert.equal((await e.store.CommunityCarrier.get(cid)).capacity_used_kg,0);
});
test('history/outbox lost acknowledgments reconcile the existing row, not a second insert',async()=>{
 for(const name of ['AuditLog','ShipmentLifecycleEvent','ChainOfCustodyEvent','EventLog','OrchestrationTask']) {
  const e=await env();let once=true;e.store[name].after=async(op:string)=>{if(op==='create'&&once){once=false;throw new Error('lost ack');}};
  const first=await e.transition(e.b,opts());assert.equal(first.ok,false,name);const stored=await e.store.Shipment.get(sid);assert.equal(stored.version,2);assert.equal(stored.lex_effects_pending,true);assert.ok(stored.lex_transition.proof.document.artifacts.length>=4);
  const retry=await e.transition(e.b,opts());assert.equal(retry.ok,true,name);assert.equal(e.store[name].creates,1,name);assert.equal((await e.store.Shipment.get(sid)).lex_effects_pending,false);
 }
});
test('never-created history/outbox remains a durable explicit hold, never assumed reconstructed',async()=>{
 for(const name of ['ShipmentLifecycleEvent','EventLog']){const e=await env();e.store[name].before=async(op:string)=>{if(op==='create')throw new Error('before insert');};
  assert.equal((await e.transition(e.b,opts())).ok,false);e.store[name].before=async()=>{};
  for(let i=0;i<3;i++)assert.equal((await e.transition(e.b,opts())).ok,false);assert.equal(e.store[name].creates,0);assert.equal((await e.store.Shipment.get(sid)).lex_effects_pending,true);
 }
});
test('synthetic transitions have no status, capacity, audit or outbox effects',async()=>{
 const e=await env(true);const result=await e.transition(e.b,opts());assert.equal(result.code,403);assert.equal(e.store.Shipment.updates,0);assert.equal(e.store.CommunityCarrier.updates,0);assert.equal(e.store.EventLog.creates,0);assert.equal(e.store.AuditLog.creates,0);
});
test('force cannot be borrowed by an ordinary owner and no new Carrier command fields are required',async()=>{
 const e=await env();const o={...opts('cancel','cancelled'),actor:{id:'owner',role:'user'},force:true};assert.equal((await e.transition(e.b,o)).code,403);assert.equal(e.store.Shipment.updates,0);
 const accepted=await e.transition(e.b,{...o,force:false});assert.equal(accepted.ok,true);assert.equal(accepted.version,2);
});
test('initial, queue, retry, replay and DLQ paths all deny a synthetic persisted event',async()=>{
 for(const path of ['initial','queue','retry','replay','dlq_replay']) {
  const e=await env(true);e.store.EventLog.data.set('event',{id:'event',event_name:'ShipmentInTransit',payload:{engine_shipment_id:uuid},published_at:'2026-01-01',created_date:'2026-01-01'});
  e.store.PlatformDelivery.data.set('delivery',{id:'delivery',connection_id:'conn',event_id:'event',event_name:'ShipmentInTransit',status:'failed',terminal:false,attempts:0,max_attempts:8});
  e.store.DeadLetterEvent.data.set('dead',{id:'dead',target_connection_id:'conn',event_id:'event',event_name:'ShipmentInTransit',status:'held',payload:{sandbox_isolated:false},original_delivery_id:'delivery'});
  if(path==='initial') {
   const fn=load('functions/lexPublishToPlatforms/entry.ts',e.base).handler;assert.equal((await fn(request({mode:'sync'}))).status,200);
  } else if(path==='queue') {
   e.store.OrchestrationTask.data.set('task',{id:'task',task_type:'webhook_redeliver',status:'queued',payload:{event_id:'event',connection_id:'conn'}});
   const fn=load('functions/lexQueue/entry.ts',e.base).handler;assert.equal((await fn(request({op:'run'}))).status,200);assert.equal((await e.store.OrchestrationTask.get('task')).result,undefined);
  } else {
   const fn=load('functions/lexEventReliability/entry.ts',e.base).handler;const r=await fn(request({op:path,event_id:'event',id:'dead'}));assert.ok([200,403,409].includes(r.status),path+':'+r.status);
  }
  assert.equal(e.sends.length,0,path);assert.notEqual((await e.store.PlatformDelivery.get('delivery')).status,'delivered',path);
 }
});
test('queue cannot redeliver a DLQ fallback body after the EventLog row was deleted',async()=>{
 const e=await env();e.store.OrchestrationTask.data.set('task',{id:'task',task_type:'webhook_redeliver',status:'queued',payload:{event_id:'absent',connection_id:'conn',event_name:'ShipmentInTransit',payload:{engine_shipment_id:uuid}}});
 const fn=load('functions/lexQueue/entry.ts',e.base).handler;await fn(request({op:'run'}));assert.equal(e.sends.length,0);
});
test('delivery independently rechecks destination revocation',async()=>{
 const e=await env();e.store.EventLog.data.set('event',{id:'event',event_name:'ShipmentInTransit',payload:{engine_shipment_id:uuid}});e.store.PlatformConnection.data.get('conn').status='disabled';
 const r=await e.base.deliver({id:'conn',status:'active',webhook_url:'https://old.unit'}, {id:'event'},'UNIT',e.b);assert.equal(r.held,true);assert.equal(e.sends.length,0);
});
test('engine low-level transition, match and raw probe never POST an isolated or unknown shipment',async()=>{
 for(const mode of ['isolated','unknown']) {
  const e=await env(mode==='isolated');if(mode==='unknown')delete e.remote.sandbox_isolated;
  const helpers=load('functions/lexEngineSync/entry.ts',e.base,['renderTransition','renderMatch','renderRaw']);
  await assert.rejects(()=>helpers.renderTransition(e.b,uuid,{status:'picked_up',command_id:other,expected_version:1}));
  await assert.rejects(()=>helpers.renderMatch(e.b,uuid,{command_id:other}));
  await assert.rejects(()=>helpers.renderRaw(e.b,'POST','/v1/shipments/'+uuid+'/transitions',{status:'picked_up'}));
  assert.equal(e.sends.length,0);
 }
});
test('typed ordinary engine mutations preserve UUID paths and supplied command identity',async()=>{
 const e=await env();const helpers=load('functions/lexEngineSync/entry.ts',e.base,['renderTransition','renderRaw']);
 await helpers.renderTransition(e.b,'SHP_'+uuid.replaceAll('-',''),{status:'picked_up',command_id:other,expected_version:1});assert.equal(e.sends.length,1);assert.equal(new URL(e.sends[0].url).pathname,'/v1/shipments/'+uuid+'/transitions');assert.equal(JSON.parse(e.sends[0].options.body).command_id,other);
 const count=e.sends.length;assert.equal((await helpers.renderRaw(e.b,'POST','https://evil.unit/',{})).status,409);assert.equal((await helpers.renderRaw(e.b,'POST','/v1/destinations',{})).status,409);assert.equal(e.sends.length,count);
});
test('engine worker holds an isolated queued transition without completed bookkeeping',async()=>{
 const e=await env(true);e.store.OrchestrationTask.data.set('task',{id:'task',task_type:'engine_sync',status:'queued',payload:{engine_shipment_id:uuid,tracking_id:'SOURCE-TRACK',shipment_id:sid,to_status:'delivered',command_id:other}});
 const fn=load('functions/lexEngineSync/entry.ts',e.base).handler;const response=await fn(request({}));assert.equal(response.status,200);assert.equal(e.sends.length,0);assert.equal((await e.store.OrchestrationTask.get('task')).status,'retrying');
});
async function unregistered(e:any,extra:any={}) {
 const p=e.store.CrossAppPackage.data.get(pid);delete p.engine_shipment_id;delete p.engine_version;
 await e.approve('CrossAppPackage',p,{approved_engine_id:null,allow_engine_create:true,...extra});return clone(p);
}
function createPayload(){return {command_id:other,origin:'Alpha',destination:'Beta',weight_kg:1,package_size:'small',service_level:'standard',pickup_deadline:'2099-01-01T00:00:00Z',delivery_deadline:'2099-01-02T00:00:00Z'};}
test('new engine create freezes the original deadlines/payload under concurrent calls',async()=>{
 const e=await env();const p=await unregistered(e);
 const payloads=await Promise.all(Array.from({length:8},(_,i)=>e.base.engineCreatePayload(e.b,p,{...createPayload(),pickup_deadline:`2099-01-0${i+1}T00:00:00Z`})));assert.ok(payloads.every(x=>equal(x,payloads[0])));
 const later=await e.base.engineCreatePayload(e.b,await e.store.CrossAppPackage.get(pid),{...createPayload(),command_id:uuid,pickup_deadline:'2100-01-01T00:00:00Z'});assert.deepEqual(later,payloads[0]);
});
test('pre-existing source command without exact frozen provenance is held, never reconstructed',async()=>{
 const e=await env();const p=await unregistered(e);e.store.CrossAppPackage.data.get(pid).engine_command_id=other;
 await assert.rejects(()=>e.base.engineCreatePayload(e.b,e.store.CrossAppPackage.data.get(pid),createPayload()),/legacy_create_payload_review_required/);assert.equal(e.sends.length,0);
});
test('engine acceptance and outbox plan persist together; lost outbox ack recovers once',async()=>{
 const e=await env();const p=await unregistered(e);const payload=await e.base.engineCreatePayload(e.b,p,createPayload());
 let once=true;e.store.EventLog.after=async(op:string)=>{if(op==='create'&&once){once=false;throw new Error('lost ack');}};
 await assert.rejects(()=>e.base.confirmEngineCreate(e.b,p,payload,{id:uuid,tracking_id:'ENGINE-TRACK',version:1}),/engine_outbox_insert_unknown/);
 const confirmed=await e.store.CrossAppPackage.get(pid);assert.equal(confirmed.engine_shipment_id,uuid);assert.ok(confirmed.lex_engine_receipt);assert.ok(confirmed.lex_engine_outbox.proof);
 const id=await e.base.settleEngineOutbox(e.b,confirmed);assert.ok(id);assert.equal(e.store.EventLog.creates,1);
 const mapped=await e.base.resolveTrustedIsolation(e.b,{tracking_id:'SOURCE-TRACK',engine_shipment_id:uuid});assert.equal(mapped.kind,'ordinary');
});
test('engine create refuses fabricated version/tracking evidence and never adopts similar parcels',async()=>{
 const e=await env();const p=await unregistered(e);const payload=await e.base.engineCreatePayload(e.b,p,createPayload());
 await assert.rejects(()=>e.base.confirmEngineCreate(e.b,p,payload,{id:uuid}),/engine_create_evidence_incomplete/);assert.equal((await e.store.CrossAppPackage.get(pid)).engine_shipment_id,undefined);
 const helpers=load('functions/lexSyncEngine/entry.ts',e.base,['findRenderShipmentByPayload']);assert.equal(await helpers.findRenderShipmentByPayload(payload),null);
});
test('direct create refuses a synthetic package before Render or merchant weight calls',async()=>{
 const e=await env(true);const p=await unregistered(e);const helper=load('functions/lexSyncEngine/entry.ts',e.base,['renderCreateShipment']);
 await assert.rejects(()=>helper.renderCreateShipment(e.b,p,createPayload()));assert.equal(e.sends.length,0);assert.equal(e.store.EventLog.creates,0);
});
test('an old backend without isolation evidence cannot become ordinary through a local approval',async()=>{
 const e=await env();delete e.remote.sandbox_isolated;const r=await e.base.resolveLocalOperation(e.b,'Shipment',e.ship);assert.equal(r.kind,'unknown');assert.equal((await e.transition(e.b,opts())).ok,false);
});
test('a reviewed unregistered ordinary cohort can operate without inventing a backend record',async()=>{
 const e=await env();const p=await unregistered(e);
 await e.approve('Shipment',e.ship,{approved_engine_id:null});
 const r=await e.base.resolveLocalOperation(e.b,'Shipment',e.ship);assert.equal(r.kind,'ordinary');assert.match(r.shipment.id,/^local-tracking:/);
 const result=await e.transition(e.b,opts());assert.equal(result.ok,true);assert.equal(result.engine_sync,null);assert.equal(e.sends.length,0);
});
test('revoke, policy epoch change and routing/assignment tampering invalidate local authority',async()=>{
 for(const mode of ['revoke','epoch','routing','assignment']) {
  const e=await env();if(mode==='revoke')for(const grant of e.store.LexOperationalAuthority.data.values())grant.status='revoked';
  if(mode==='epoch')e.config.LEX_OPERATION_POLICY_EPOCH='changed';if(mode==='routing')e.store.Shipment.data.get(sid).destination='Tampered';if(mode==='assignment')e.store.Shipment.data.get(sid).assigned_carrier_id='other';
  assert.equal((await e.transition(e.b,opts())).ok,false,mode);assert.equal(e.store.EventLog.creates,0);assert.equal(e.sends.length,0);
 }
});
test('scoped bundle/fraud operations exclude synthetic records before any operational or LLM effect',async()=>{
 for(const name of ['lexOptimizeBundles','lexDetectFraud']) {
  const e=await env(true);e.store.Shipment.data.get(sid).status='matched';e.store.Shipment.data.get(sid).declared_value=6000;
  let llm=0;e.b.asServiceRole.integrations.Core.InvokeLLM=async()=>{llm++;return {alerts:[]};};
  const fn=load(`functions/${name}/entry.ts`,e.base).handler;
  const response=await fn(request({shipment_ids:[sid]}));assert.equal(response.status,200,name);assert.equal(llm,0);assert.equal(e.store.Shipment.updates,0);assert.equal(e.store.CommunityCarrier.updates,0);assert.equal(e.store.SmartBundle.creates,0);assert.equal(e.store.FraudAlert.creates,0);assert.equal(e.store.Incident.creates,0);assert.equal(e.sends.length,0);
  assert.equal((await fn(request({shipment_ids:null}))).status,400);
 }
});
test('ordinary fraud flag and risk score share the transition CAS and durable alert plans',async()=>{
 const e=await env();e.store.Shipment.data.get(sid).declared_value=6000;
 e.b.asServiceRole.integrations.Core.InvokeLLM=async()=>({alerts:[{entity_type:'Shipment',entity_id:sid,risk_score:80,reasons:['Synthetic heuristic']}]});
 const fn=load('functions/lexDetectFraud/entry.ts',e.base).handler;const response=await fn(request({shipment_ids:[sid]}));assert.equal(response.status,200,await response.clone().text());
 assert.equal((await e.store.Shipment.get(sid)).status,'flagged');assert.equal((await e.store.Shipment.get(sid)).risk_score,80);assert.equal(e.store.FraudAlert.creates,1);assert.equal(e.store.Incident.creates,1);assert.equal(e.store.EventLog.creates,2);
});
test('ordinary bundling does not reserve matched parcel weight twice, including a full carrier',async()=>{
 const e=await env();const second='dddddddddddddddddddddddd',pkg2='eeeeeeeeeeeeeeeeeeeeeeee';
 e.store.Shipment.data.get(sid).status='matched';e.store.CommunityCarrier.data.get(cid).capacity_used_kg=2;e.store.CommunityCarrier.data.get(cid).capacity_total_kg=2;
 const s2={...e.ship,id:second,status:'matched',tracking_id:'SOURCE-2'};e.store.Shipment.data.set(second,s2);await e.approve('Shipment',s2,{approved_engine_id:other});
 const p2={...e.pkg,id:pkg2,tracking_id:'SOURCE-2',engine_shipment_id:other};e.store.CrossAppPackage.data.set(pkg2,p2);await e.approve('CrossAppPackage',p2,{approved_engine_id:other});
 const fn=load('functions/lexOptimizeBundles/entry.ts',e.base).handler;const response=await fn(request({shipment_ids:[sid,second]}));assert.equal(response.status,200,await response.clone().text());const body=await response.json();assert.equal(body.bundles_created,1,JSON.stringify(body.rejected));assert.equal(e.store.SmartBundle.creates,1);assert.equal((await e.store.CommunityCarrier.get(cid)).capacity_used_kg,2);
 const s1=await e.store.Shipment.get(sid);assert.equal(s1.status,'in_transit');assert.equal(s1.bundle_id,(await e.store.Shipment.get(second)).bundle_id);
});
test('a full carrier rejection only rolls back its exact match, retaining a monotonic version',async()=>{
 const e=await env();const ship=e.store.Shipment.data.get(sid);ship.status='pending';ship.assigned_carrier_id=null;await e.approve('Shipment',ship,{approved_assigned_carrier_id:null,approved_capacity_reserved_kg:0});
 e.store.CommunityCarrier.data.get(cid).capacity_used_kg=10;
 const result=await e.transition(e.b,{...opts('match','matched'),assign_carrier_id:cid,custody:null});assert.equal(result.code,409);const after=await e.store.Shipment.get(sid);assert.equal(after.status,'pending');assert.equal(after.assigned_carrier_id,null);assert.equal(after.version,3);assert.equal(e.store.EventLog.creates,0);assert.equal((await e.store.CommunityCarrier.get(cid)).capacity_used_kg,10);
});
test('malformed CAS success counts never grant transition ownership',async()=>{
 const e=await env();e.store.Shipment.updateMany=async()=>({updated:'1'});const result=await e.transition(e.b,opts());assert.equal(result.ok,false);assert.equal(e.store.EventLog.creates,0);assert.equal(e.store.CommunityCarrier.updates,0);
});
test('wrong actor remains denied after trusted isolation classification',async()=>{
 const e=await env();const result=await e.transition(e.b,{...opts(),actor:{id:'unrelated',role:'user'}});assert.equal(result.code,403);assert.equal(e.store.Shipment.updates,0);
});
test('an explicit shipment-less production event contract works without a blanket bypass',async()=>{
 const e=await env();const event={id:'carrier-event',event_name:'IncidentCreated',payload:{entity_type:'CommunityCarrier',entity_id:cid,risk_score:80}};
 await e.approve('NonShipmentEvent',{id:'IncidentCreated',tracking_id:null},{event_contract:{entity_type:'CommunityCarrier',allowed_fields:['entity_type','entity_id','risk_score'],field_types:{entity_type:'string',entity_id:'string',risk_score:'number'}}});
 e.store.EventLog.data.set(event.id,event);assert.equal((await e.base.deliver({id:'conn'},event,'UNIT',e.b)).ok,true);
 e.store.EventLog.data.get(event.id).payload.risk_score={shipment_id:uuid};assert.equal((await e.base.deliver({id:'conn'},event,'UNIT',e.b)).held,true);assert.equal(e.sends.length,1);
});
test('new engine tasks are bound to the signed parent receipt, not worker admin privilege',async()=>{
 const e=await env();assert.equal((await e.transition(e.b,opts())).ok,true);const task=[...e.store.OrchestrationTask.data.values()][0];assert.equal(await e.base.trustedEngineTask(e.b,task),true);
 assert.equal(await e.base.trustedEngineTask(e.b,{...task,id:'copied-task'}),false);assert.equal(await e.base.trustedEngineTask(e.b,{...task,payload:{...task.payload,to_status:'delivered'}}),false);
 const fabricated={id:'user-task',task_type:'engine_sync',payload:{engine_shipment_id:uuid,command_id:other,to_status:'delivered'}};assert.equal(await e.base.trustedEngineTask(e.b,fabricated),false);
});
test('an untrusted queued publication cannot become a privileged signed event',async()=>{
 const e=await env();e.store.OrchestrationTask.data.set('task',{id:'task',task_type:'event_publish',status:'queued',payload:{event_name:'ShipmentDelivered',payload:{engine_shipment_id:uuid}}});
 const fn=load('functions/lexQueue/entry.ts',e.base).handler;assert.equal((await fn(request({op:'run'}))).status,200);assert.equal(e.store.EventLog.creates,0);assert.equal(e.sends.length,0);
});
test('submitted Carrier key, action, evidence and optional expected_version contract still succeeds',async()=>{
 const e=await env();e.store.Shipment.data.get(sid).status='matched';const token='UNIT-CARRIER-BOUNDARY';
 e.store.CommunityCarrier.data.get(cid).api_key_hash=await e.base.digest(token);
 // Carrier auth hashes raw UTF-8, not the JSON-valued digest helper.
 const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token)))].map(x=>x.toString(16).padStart(2,'0')).join('');e.store.CommunityCarrier.data.get(cid).api_key_hash=hash;
 const fn=load('functions/lexCarrierGateway/entry.ts',e.base).handler;
 const r=await fn(new Request('https://unit.invalid',{method:'POST',headers:{Authorization:'Bearer '+token},body:JSON.stringify({action:'acceptAssignment',shipment_id:sid,command_id:other,location:'Synthetic facility',signature:'Synthetic evidence'})}));
 assert.equal(r.status,200,await r.clone().text());const body=await r.json();assert.equal(body.shipment_id,sid);assert.equal(body.status,'picked_up');assert.equal(body.version,2);assert.equal(body.engine_shipment_id,uuid);assert.ok(body.lifecycle_event_id);assert.ok(body.custody_event_id);
});
test('recovery endpoint uses stored plans, not status-derived fabricated events',async()=>{
 const e=await env();let once=true;e.store.EventLog.after=async(op:string)=>{if(op==='create'&&once){once=false;throw new Error('lost ack');}};
 assert.equal((await e.transition(e.b,opts())).ok,false);const fn=load('functions/lexRecoverTransitions/entry.ts',e.base).handler;
 const r=await fn(request({shipment_id:sid}));assert.equal(r.status,200);assert.equal((await r.json()).results[0].ok,true);assert.equal(e.store.EventLog.creates,1);
});
test('ordinary queue/replay delivery cannot be suppressed by caller-supplied test assertions',async()=>{
 const e=await env();e.store.EventLog.data.set('event',{id:'event',event_name:'ShipmentInTransit',payload:{engine_shipment_id:uuid,sandbox_isolated:true,synthetic:true,note:'Preserve ordinary data'}});
 assert.equal((await e.base.deliver({id:'conn'},{id:'event'},'UNIT',e.b)).ok,true);const payload=JSON.parse(e.sends[0].options.body).payload;assert.equal(payload.sandbox_isolated,false);assert.equal(payload.synthetic,undefined);assert.equal(payload.note,'Preserve ordinary data');
 assert.equal((await e.store.EventLog.get('event')).payload.sandbox_isolated,true); // no data deletion/rewrite
});
test('capacity failure after status CAS retains a plan and completes exactly once on recovery',async()=>{
 const e=await env();let fail=true;e.store.CommunityCarrier.before=async(op:string)=>{if(op==='cas'&&fail)throw new Error('storage outage');};
 const first=await e.transition(e.b,opts());assert.equal(first.ok,false);assert.equal((await e.store.Shipment.get(sid)).version,2);assert.equal((await e.store.Shipment.get(sid)).lex_effects_pending,true);assert.equal(e.store.EventLog.creates,0);
 fail=false;const retry=await e.transition(e.b,opts());assert.equal(retry.ok,true);assert.equal(e.store.EventLog.creates,1);assert.equal((await e.store.CommunityCarrier.get(cid)).lex_capacity_journal.length,1);
});
test('bundle insert lost acknowledgement recovers the one saved projection without re-reserving capacity',async()=>{
 const e=await env();const second='dddddddddddddddddddddddd',pkg2='eeeeeeeeeeeeeeeeeeeeeeee';
 e.store.Shipment.data.get(sid).status='matched';e.store.CommunityCarrier.data.get(cid).capacity_used_kg=2;
 const s2={...e.ship,id:second,status:'matched',tracking_id:'SOURCE-2'};e.store.Shipment.data.set(second,s2);await e.approve('Shipment',s2,{approved_engine_id:other});
 const p2={...e.pkg,id:pkg2,tracking_id:'SOURCE-2',engine_shipment_id:other};e.store.CrossAppPackage.data.set(pkg2,p2);await e.approve('CrossAppPackage',p2,{approved_engine_id:other});
 let once=true;e.store.SmartBundle.after=async(op:string)=>{if(op==='create'&&once){once=false;throw new Error('lost acknowledgement');}};
 const optimize=load('functions/lexOptimizeBundles/entry.ts',e.base).handler;await optimize(request({shipment_ids:[sid,second]}));assert.equal(e.store.SmartBundle.creates,1);
 const recover=load('functions/lexRecoverTransitions/entry.ts',e.base).handler;const response=await recover(request({shipment_id:sid}));assert.equal((await response.json()).results[0].ok,true);assert.equal(e.store.SmartBundle.creates,1);assert.equal((await e.store.Shipment.get(sid)).lex_bundle_pending,false);assert.equal((await e.store.CommunityCarrier.get(cid)).capacity_used_kg,2);
});
test('capacity recovery never brings an offline carrier online',async()=>{
 const e=await env();e.store.CommunityCarrier.data.get(cid).status='offline';e.store.Shipment.data.get(sid).status='out_for_delivery';
 const result=await e.transition(e.b,opts('offline-delivery','delivered'));assert.equal(result.ok,true);assert.equal((await e.store.CommunityCarrier.get(cid)).status,'offline');assert.equal((await e.store.CommunityCarrier.get(cid)).capacity_used_kg,0);
});
test('concurrent bundle runs and a cancellation share fenced capacity without an absolute carrier update',async()=>{
 const e=await env();const second='dddddddddddddddddddddddd',pkg2='eeeeeeeeeeeeeeeeeeeeeeee';
 e.store.Shipment.data.get(sid).status='matched';e.store.CommunityCarrier.data.get(cid).capacity_used_kg=2;
 const s2={...e.ship,id:second,status:'matched',tracking_id:'SOURCE-2'};e.store.Shipment.data.set(second,s2);await e.approve('Shipment',s2,{approved_engine_id:other});
 const p2={...e.pkg,id:pkg2,tracking_id:'SOURCE-2',engine_shipment_id:other};e.store.CrossAppPackage.data.set(pkg2,p2);await e.approve('CrossAppPackage',p2,{approved_engine_id:other});
 e.store.CommunityCarrier.before=async(op:string)=>{if(op==='update')throw Error('unfenced carrier write forbidden');};
 const fn=load('functions/lexOptimizeBundles/entry.ts',e.base).handler;
 await Promise.allSettled([fn(request({shipment_ids:[sid,second]})),fn(request({shipment_ids:[sid,second]})),e.transition(e.b,{...opts('cancel-concurrent','cancelled'),custody:null})]);
 // If cancellation lost the version race, retry the SAME command after the
 // winning bundle effect is complete, never replace its identity.
 let cancelled=await e.transition(e.b,{...opts('cancel-concurrent','cancelled'),custody:null});
 assert.equal(cancelled.ok,true,JSON.stringify(cancelled));const carrier=await e.store.CommunityCarrier.get(cid);assert.equal(carrier.capacity_used_kg,1);assert.equal(new Set(carrier.lex_capacity_journal.map((x:any)=>x.effect_id)).size,carrier.lex_capacity_journal.length);assert.ok(e.store.SmartBundle.creates<=1);
});
test('unapproved owner-created tracking shadow cannot suppress a verified operational mapping',async()=>{
 const e=await env();const shadow='ffffffffffffffffffffffff';e.store.Shipment.data.set(shadow,{...e.ship,id:shadow,created_by_id:'attacker',lex_effects_pending:true});
 const ordinary=await e.base.resolveTrustedIsolation(e.b,{engine_shipment_id:uuid});assert.equal(ordinary.kind,'ordinary');assert.equal((await e.base.operationalLocal(e.b,ordinary)).id,sid);
 assert.equal((await e.base.resolveTrustedIsolation(e.b,{shipment_id:shadow})).kind,'unknown');
});
test('cleanup never scans geographic labels or directly mutates Render, and explicit cancellation reuses transition intent',async()=>{
 const e=await env();const fn=load('functions/lexEngineCleanup/entry.ts',{...e.base,requireInternalSecret:async()=>null}).handler;
 const none=await fn(request({}));assert.equal(none.status,200);assert.equal((await none.json()).cancelled,0);assert.equal(e.sends.length,0);assert.equal(e.store.Shipment.updates,0);
 const body={execute:true,operations:[{shipment_id:sid,command_id:'reviewed-cleanup',expected_version:1}]};const result=await fn(request(body));assert.equal((await result.json()).cancelled,1);assert.equal(e.sends.length,0);assert.equal((await e.store.Shipment.get(sid)).status,'cancelled');const eventCount=e.store.EventLog.creates;
 const retry=await fn(request(body));assert.equal((await retry.json()).cancelled,1);assert.equal(e.store.EventLog.creates,eventCount);
});
test('cleanup isolation and internal/admin authorization still apply to explicit selected records',async()=>{
 const e=await env(true);const body={execute:true,operations:[{shipment_id:sid,command_id:'synthetic-cleanup',expected_version:1}]};
 const fn=load('functions/lexEngineCleanup/entry.ts',{...e.base,requireInternalSecret:async()=>null}).handler;const r=await fn(request(body));assert.equal((await r.json()).failed,1);assert.equal(e.store.Shipment.updates,0);assert.equal(e.sends.length,0);
 const denied=load('functions/lexEngineCleanup/entry.ts',{...e.base,requireInternalSecret:async()=>Response.json({error:'internal required'},{status:401})}).handler;assert.equal((await denied(request(body))).status,401);
});
