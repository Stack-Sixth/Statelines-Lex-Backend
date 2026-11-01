import { base44 } from "@/api/base44Client";
export async function readShipments(limit = 200) {
  const r = await base44.functions.invoke("merchantShipmentRead", { action: "list", limit });
  if (!Array.isArray(r.data?.items)) throw new Error("Invalid shipment list response");
  return r.data.items;
}
export async function readShipment(shipment_id) {
  const r = await base44.functions.invoke("merchantShipmentRead", { action: "get", shipment_id });
  if (!r.data?.shipment) throw new Error("Invalid shipment read response");
  return r.data.shipment;
}

export async function readShipmentTimeline(shipment_id,sort="-occurred_at",limit=50) {
 const r=await base44.functions.invoke("merchantShipmentRead",{action:"timeline",shipment_id,sort,limit});
 if(!Array.isArray(r.data?.items))throw new Error("Invalid timeline response");
 return r.data.items;
}
