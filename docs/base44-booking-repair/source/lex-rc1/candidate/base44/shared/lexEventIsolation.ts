import type {Isolation} from "./lexTrustedIsolation.ts";
import {resolveTrustedIsolation,resolveLocalOperation} from './lexTrustedIsolation.ts';
import {localAuthority} from './lexOperationalAuthority.ts';
// EventLog is loaded by the delivery boundary, never reconstructed from a DLQ payload.
export async function eventIsolation(base44:any,event:any):Promise<Isolation> {
 try {
 const payload=event.payload||{};
 const hasRefs=['shipment_id','engine_shipment_id','canonical_shipment_id','tracking_id'].some(k=>Object.hasOwn(payload,k)) ||
  ['shipment','Shipment'].includes(event.aggregate_type)||['shipment','Shipment'].includes(event.aggregate?.type)||payload.entity_type==='Shipment';
 if(hasRefs) {
  const state=await resolveTrustedIsolation(base44,event);
  if(state.kind==='ordinary'&&state.local?.lex_effects_pending===true)return {kind:'unknown',reason:'transition_effects_pending'};
  return state;
 }
 // Do not guess shipment-less exemptions from the event name alone. This
 // explicit protected contract preserves reviewed non-shipment production events.
 const grant=await localAuthority(base44,'NonShipmentEvent',{id:event.event_name,tracking_id:null});
 if(!grant)return {kind:'unknown',reason:'non_shipment_contract_required'};
 const contract=grant.event_contract;
 if(!contract||payload.entity_type!==contract.entity_type||typeof payload.entity_id!=='string'||!Array.isArray(contract.allowed_fields)||Object.keys(payload).some(k=>!contract.allowed_fields.includes(k)))
  return {kind:'unknown',reason:'event_contract_mismatch'};
 for(const [field,value] of Object.entries(payload)) {
  const type=contract.field_types?.[field];
  if(type==='string[]'){if(!Array.isArray(value)||value.some(x=>typeof x!=='string'))return {kind:'unknown',reason:'event_field_type_mismatch'};}
  else if(!['string','number','boolean'].includes(type)||typeof value!==type||(type==='number'&&!Number.isFinite(value)))return {kind:'unknown',reason:'event_field_type_mismatch'};
 }
 if(!['CommunityCarrier','SmartNode'].includes(contract.entity_type))return {kind:'unknown',reason:'event_entity_contract_unsupported'};
 const entity=await base44.asServiceRole.entities[contract.entity_type].get(payload.entity_id);
 if(!entity)return {kind:'unknown',reason:'event_entity_unresolved'};
 return {kind:grant.classification==='ordinary'?'ordinary':'isolated',shipment:null};
 } catch {return {kind:'unknown',reason:'event_authority_unavailable'};}
}
export async function requireOrdinaryEvent(base44:any,event:any) {
 const state=await eventIsolation(base44,event);if(state.kind!=='ordinary')throw new Error(state.kind==='isolated'?'sandbox_isolated':'isolation_unknown');
 return state;
}
