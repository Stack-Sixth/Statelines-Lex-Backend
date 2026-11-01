import {rows,verified,seal,digest} from './lexEffectProof.ts';
import {localAuthority,linkedEngineId} from './lexOperationalAuthority.ts';
import {resolveLocalOperation,engineUuid} from './lexTrustedIsolation.ts';
import {backendTarget} from './lexAuthorityBinding.ts';
import {renderBaseUrl,signedRenderHeaders} from './lexRenderJwt.ts';
import {secrets} from 'base44:runtime';
// A transport key proves a connection, not a merchant. Bind to an independently
// reviewed existing package and canonical merchant; never mint from arbitrary tracking.
export async function authorizeIngress(b:any,evt:any,context:any){
 if(!context?.connection_id)throw new Error('sender_authority_required');
 const conn=await b.asServiceRole.entities.PlatformConnection.get(context.connection_id);
 if(conn.status!=='active'||!conn.ingress_app||evt.app!==conn.ingress_app)throw new Error('sender_app_mismatch');
 if(context.mode==='v2'&&!conn.ingress_v2_enabled)throw new Error('ingress_not_enabled');
 if(context.mode==='legacy-scoped'&&!conn.ingress_legacy_scoped)throw new Error('legacy_sender_not_enabled');
 if(!['v2','legacy-scoped','review'].includes(context.mode))throw new Error('sender_authority_required');
 const bindings=rows(await b.asServiceRole.entities.LexIngressBinding.filter({connection_id:conn.id,tracking_id:evt.tracking_id,status:'active'},'-created_date',2));
 if(bindings.length!==1)throw new Error('canonical_mapping_required');
 const a=bindings[0].proof;if(!await verified(a,'ingress_binding',bindings[0].id))throw new Error('ingress_binding_invalid');const doc=a.document;
 if(doc.connection_id!==conn.id||doc.app!==conn.ingress_app||doc.key_digest!==await digest(conn.auth_secret||'')||doc.source_target!==conn.base_url||doc.tracking_id!==evt.tracking_id||doc.policy_epoch!==secrets.get('LEX_OPERATION_POLICY_EPOCH')||doc.backend_target!==backendTarget(renderBaseUrl())||!/^MER_[0-9a-f]{32}$/.test(doc.merchant_id))throw new Error('ingress_binding_invalid');
 const pkg=await b.asServiceRole.entities.CrossAppPackage.get(doc.package_id),grant=await localAuthority(b,'CrossAppPackage',pkg),link=await linkedEngineId(b,'CrossAppPackage',pkg);
 if(pkg.tracking_id!==evt.tracking_id||!grant||!link||engineUuid(link.id)!==engineUuid(doc.engine_id)||grant.business_reference!==doc.business_reference)throw new Error('canonical_mapping_changed');
 const isolation=await resolveLocalOperation(b,'CrossAppPackage',pkg);if(isolation.kind!=='ordinary')throw new Error(isolation.kind==='isolated'?'sandbox_isolated':'isolation_unknown');
 // /v1 merchant_id filter expects its internal UUID. Prove membership using the
 // backend's scope/reference join, not merchant_name or the HMAC holder's assertion.
 const h=doc.merchant_id.slice(4),merchant=`${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;let after:string|null=null;const seen=new Set<string>();let matched=false;
 for(let page=0;page<20;page++){
  const q=new URLSearchParams({merchant_id:merchant,limit:'100'});if(after)q.set('after',after);
  const response=await fetch(new URL('/v1/shipments?'+q,backendTarget(renderBaseUrl())),{headers:await signedRenderHeaders('lex-ingress-read','admin'),redirect:'manual',signal:AbortSignal.timeout(15000)});if(!response.ok)throw new Error('canonical_scope_unavailable');
  const data=await response.json(),items=rows(data);if(items.some((s:any)=>s.id===engineUuid(doc.engine_id))){matched=true;break;}
  if(!data.next_cursor)break;if(typeof data.next_cursor!=='string'||seen.has(data.next_cursor)||items.length===0)throw new Error('canonical_scope_incomplete');seen.add(data.next_cursor);after=data.next_cursor;
 }
 if(!matched)throw new Error('canonical_merchant_mismatch');
 // Client may assert these identities, but never change them or routing data.
 for(const claims of [evt.pkg||{},evt.claims||{}]){
  if(claims.merchant_id!=null&&claims.merchant_id!==doc.merchant_id)throw new Error('payload_identity_mismatch');
  for(const field of ['engine_shipment_id','shipment_id'])if(claims[field]!=null&&engineUuid(claims[field])!==engineUuid(doc.engine_id))throw new Error('payload_identity_mismatch');
 }
 for(const field of ['origin','destination','merchant_name','package_size','service_level','declared_value'])if(evt.pkg?.[field]!=null&&String(evt.pkg[field])!==String(pkg[field]??''))throw new Error('payload_routing_change_requires_review');
 return {pkg,conn,document:doc};
}
export async function issueIngressBinding(b:any,input:any,actor:any){
 if(actor?.role!=='admin')throw new Error('Admin required');
 const conn=await b.asServiceRole.entities.PlatformConnection.get(input.connection_id),pkg=await b.asServiceRole.entities.CrossAppPackage.get(input.package_id),grant=await localAuthority(b,'CrossAppPackage',pkg),link=await linkedEngineId(b,'CrossAppPackage',pkg);
 if(!conn.auth_secret||conn.auth_secret.length<32||!conn.ingress_app||!grant||!link||!/^MER_[0-9a-f]{32}$/.test(input.merchant_id)||!String(input.evidence_ref||'').trim())throw new Error('reviewed_mapping_required');
 const E=b.asServiceRole.entities.LexIngressBinding;if(rows(await E.filter({connection_id:conn.id,tracking_id:pkg.tracking_id,status:'active'},'-created_date',2)).length)throw new Error('revoke_existing_binding_first');
 const row=await E.create({connection_id:conn.id,tracking_id:pkg.tracking_id,status:'revoked',proof:{}});
 const document={key_digest:await digest(conn.auth_secret||''),source_target:conn.base_url,connection_id:conn.id,app:conn.ingress_app,tracking_id:pkg.tracking_id,package_id:pkg.id,engine_id:link.id,merchant_id:input.merchant_id,business_reference:grant.business_reference,policy_epoch:secrets.get('LEX_OPERATION_POLICY_EPOCH'),backend_target:backendTarget(renderBaseUrl()),approved_by:actor.id,evidence_ref:input.evidence_ref};
 // Provisional signed binding is not active until an operator verifies scope;
 // confirmation is a separate handler action that calls authorizeIngress.
 await E.update(row.id,{proof:await seal('ingress_binding',row.id,document)});return row;
}
