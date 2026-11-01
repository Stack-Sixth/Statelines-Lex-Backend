import {secrets} from 'base44:runtime';
import {recordAuthority} from './serverRecord.ts';
import {operationalAuthority} from './shipmentAuthority.ts';
export async function createTrustedShipmentEvent(sr:any,shipment:any,principal:string,data:any) {
 const authority=await operationalAuthority(sr,shipment,principal);
 if(!authority.ok)throw new Error(`Event held: ${authority.code}`);
 return sr.entities.ShipmentEvent.create({...data,shipment_id:shipment.id,
  ...await recordAuthority(secrets.get('MERCHANT_RECORD_SIGNING_SECRET')).mint('ShipmentEvent',authority.ownership.owner_user_id,authority.ownership.merchant_id)});
}
export async function requireTrustedEvent(sr:any,body:any) {
 if(!body.source_event_id)return null;
 const row=await sr.entities.ShipmentEvent.get(String(body.source_event_id));
 if(!await recordAuthority(secrets.get('MERCHANT_RECORD_SIGNING_SECRET')).trusted('ShipmentEvent',row))throw new Error('Unverified source event');
 if(row.shipment_id!==body.shipment_id)throw new Error('Source event shipment mismatch');
 // Resolve the actual stored event; caller-supplied event text is not signed.
 return {...body,event:'custody_event',data:{event:row.event,location:row.location,custodian:row.custodian,verification_method:row.verification_method,occurred_at:row.occurred_at}};
}
