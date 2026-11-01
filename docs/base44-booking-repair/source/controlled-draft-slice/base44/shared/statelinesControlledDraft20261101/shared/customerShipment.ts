// Customer intent only. Never copy lifecycle, claims, identity or test metadata.
export const CUSTOMER_FIELDS = [
  "origin_address",
  "destination_address",
  "origin_city",
  "destination_city",
  "origin_location_id",
  "origin_location_name",
  "destination_location_id",
  "destination_location_name",
  "intake_method",
  "delivery_method",
  "weight_lb",
  "package_size",
  "length_in",
  "width_in",
  "height_in",
  "declared_value",
  "insurance",
  "service_level",
  "description",
] as const;
export function customerShipment(input: any): Record<string, any> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid shipment details");
  const result: Record<string, any> = {};
  for (const key of CUSTOMER_FIELDS) {
    const value = input[key];
    if (value === undefined) continue;
    if (
      [
        "weight_lb",
        "length_in",
        "width_in",
        "height_in",
        "declared_value",
      ].includes(key)
    ) {
      const n =
        typeof value === "string" && value.trim() !== ""
          ? Number(value)
          : value;
      if (n === "") continue;
      if (typeof n !== "number" || !Number.isFinite(n) || n < 0)
        throw new Error(`Invalid ${key}`);
      result[key] = n;
    } else if (key === "insurance") {
      if (typeof value !== "boolean") throw new Error("Invalid insurance");
      result[key] = value;
    } else {
      if (typeof value !== "string" || value.length > 2000)
        throw new Error(`Invalid ${key}`);
      result[key] = value.trim();
    }
  }
  return result;
}

// Draft-only selections; neither a saved card nor compliance output authorizes
// an effect. Finalization revalidates these selections server-side.
export function customerDraft(input:any):Record<string,any> {
 const result=customerShipment(input);
 for(const k of ['payment_method_id','payment_method_label']) {
   if(input[k]!==undefined) {
     if(typeof input[k]!=='string'||input[k].length>200)throw new Error(`Invalid ${k}`);
     result[k]=input[k];
   }
 }
 if(input.compliance!==undefined) {
   const c=input.compliance;if(!c||typeof c!=='object'||Array.isArray(c))throw new Error('Invalid declaration');
   result.compliance={};
   for(const k of ['item_category','contents_description','battery_details'])if(c[k]!==undefined) {
     if(typeof c[k]!=='string'||c[k].length>2000)throw new Error('Invalid declaration');result.compliance[k]=c[k];
   }
   if(c.has_battery!==undefined)result.compliance.has_battery=c.has_battery===true;
   if(c.quantity!==undefined) {const n=Number(c.quantity);if(!Number.isInteger(n)||n<1||n>10000)throw new Error('Invalid quantity');result.compliance.quantity=n;}
 }
 return result;
}
