import {resolveTrustedIsolation,resolveLocalOperation,engineUuid} from './lexTrustedIsolation.ts';
import {localAuthority} from './lexOperationalAuthority.ts';
import {EffectsPending} from './lexEffectProof.ts';
export async function requireEngineMutation(base44:any,engineId:any,context?:any) {
 const id=engineUuid(engineId);if(!id)throw new EffectsPending('engine_identifier_invalid');
 const result=await resolveTrustedIsolation(base44,{...(context||{}),engine_shipment_id:id});
 if(result.kind!=='ordinary'||result.local?.lex_effects_pending===true)throw new EffectsPending(result.kind==='isolated'?'sandbox_isolated':'isolation_unknown');
 return id;
}
export async function requirePackageMutation(base44:any,row:any) {
 const grant=await localAuthority(base44,'CrossAppPackage',row);
 if(!grant||grant.classification!=='ordinary'||grant.allow_engine_create!==true)throw new EffectsPending('engine_create_authority_required');
 const result=await resolveLocalOperation(base44,'CrossAppPackage',row);
 if(result.kind!=='ordinary')throw new EffectsPending(result.kind==='isolated'?'sandbox_isolated':'isolation_unknown');
 return grant;
}
