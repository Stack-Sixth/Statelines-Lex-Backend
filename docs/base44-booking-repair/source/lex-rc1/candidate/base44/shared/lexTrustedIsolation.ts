import {localAuthority,linkedEngineId} from "./lexOperationalAuthority.ts";
// Isolation authority is the backend's persisted boolean, never payload flags,
// SBX labels, local user-writable metadata, or an inferred default false.
import { renderBaseUrl, signedRenderHeaders } from "./lexRenderJwt.ts";
import { backendTarget } from "./lexAuthorityBinding.ts";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function engineUuid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (UUID.test(value)) return value.toLowerCase();
  if (!/^SHP_[0-9a-f]{32}$/.test(value)) return null;
  const h = value.slice(4),
    id = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  return UUID.test(id) ? id : null;
}
export type Isolation =
  | { kind: "ordinary" | "isolated"; shipment: any; local?: any }
  | { kind: "unknown"; reason: string };
async function backendRead(path: string): Promise<any> {
  const base = backendTarget(renderBaseUrl());
  const r = await fetch(new URL(path, base), {
    method: "GET",
    headers: await signedRenderHeaders("lex-isolation-read", "admin"),
    redirect: "manual",
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error("backend_lookup_failed");
  return await r.json();
}
function list(value: any): any[] {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.items)) return value.items;
  throw new Error("lookup_contract_unknown");
}
function refs(input: any): { type: "id" | "tracking"; value: string }[] {
  const out: { type: "id" | "tracking"; value: string }[] = [];
  const visit = (v: any, depth: number) => {
    if (!v || typeof v !== "object" || depth > 3) return;
    for (const key of [
      "shipment_id",
      "canonical_shipment_id",
      "engine_shipment_id",
    ]) {
      if (Object.hasOwn(v, key)) {
        if (typeof v[key] !== "string" || !v[key])
          throw new Error("invalid_shipment_reference");
        out.push({ type: "id", value: v[key] });
      }
    }
    if (Object.hasOwn(v, "tracking_id")) {
      if (typeof v.tracking_id !== "string" || !v.tracking_id)
        throw new Error("invalid_tracking_reference");
      out.push({ type: "tracking", value: v.tracking_id });
    }
    if(v.aggregate_type && ['shipment','Shipment'].includes(v.aggregate_type)) {
      if(typeof v.aggregate_id!=='string'||!v.aggregate_id)throw new Error('invalid_aggregate');
      out.push({type:'id',value:v.aggregate_id});
    }
    if(v.entity_type==='Shipment') {
      if(typeof v.entity_id!=='string'||!v.entity_id)throw new Error('invalid_entity_reference');
      out.push({type:'id',value:v.entity_id});
    }
    if (v.aggregate && ["shipment", "Shipment"].includes(v.aggregate.type)) {
      if (typeof v.aggregate.id !== "string" || !v.aggregate.id)
        throw new Error("invalid_aggregate");
      out.push({ type: "id", value: v.aggregate.id });
    }
    for (const key of ["payload", "shipment", "event_payload"])
      visit(v[key], depth + 1);
  };
  visit(input, 0);
  return out;
}
async function byTracking(tracking: string,base44?:any): Promise<any> {
  // Source-app tracking IDs and Render tracking IDs are different namespaces.
  // Follow only an operator-approved/signed source-to-engine mapping.
  const entity=base44?.asServiceRole?.entities?.CrossAppPackage;
  if(entity) {
    const packages=list(await entity.filter({tracking_id:tracking}));
    if(packages.length>1)throw new Error('ambiguous_source_tracking');
    if(packages.length===1) {
      const link=await linkedEngineId(base44,'CrossAppPackage',packages[0]);
      if(link) {
        const uuid=engineUuid(link.id);if(!uuid)throw new Error('invalid_engine_link');
        const row=(await backendRead('/v1/shipments/'+uuid)).shipment;
        if(!row||row.id!==uuid)throw new Error('engine_identity_mismatch');
        return {...row,__source_tracking:tracking};
      }
    }
  }
  // Backend has no tracking-id filter. Walk the existing legacy list contract;
  // a cap or repeated cursor is UNKNOWN, never proof that a record is ordinary.
  let after: string | null = null;
  const matches: any[] = [];
  const seen = new Set<string>();
  for (let page = 0; page < 20; page++) {
    const q = new URLSearchParams({ limit: "100" });
    if (after) q.set("after", after);
    const res = await backendRead("/v1/shipments?" + q);
    const rows = list(res);
    for (const row of rows) if (row.tracking_id === tracking) matches.push(row);
    const next = res.next_cursor;
    if (!next) {
      if(matches.length===0&&base44) {
        const candidates=[];
        for(const type of ['CrossAppPackage','Shipment']) {
          const entity=base44.asServiceRole.entities[type];if(!entity)continue;
          const localRows=list(await entity.filter({tracking_id:tracking}));
          const approved=[];for(const local of localRows){const grant=await localAuthority(base44,type,local);if(grant)approved.push({local,grant});}
          if(approved.length>1)throw new Error('ambiguous_trusted_local_tracking');
          if(approved.length===1){const {local,grant}=approved[0];if(!local.engine_shipment_id&&!grant.approved_engine_id)candidates.push({local,grant});}
        }
        if(candidates.length) {
          if(candidates.some(x=>x.grant.business_reference!==candidates[0].grant.business_reference||x.grant.classification!==candidates[0].grant.classification))throw new Error('conflicting_local_authorities');
          return {id:'local-tracking:'+tracking,tracking_id:tracking,sandbox_isolated:candidates[0].grant.classification==='isolated',__local_authority:true};
        }
      }
      if (matches.length !== 1)
        throw new Error(
          matches.length ? "ambiguous_tracking" : "tracking_not_found",
        );
      return matches[0];
    }
    if (typeof next !== "string" || seen.has(next) || rows.length === 0)
      throw new Error("incomplete_tracking_lookup");
    seen.add(next);
    after = next;
  }
  throw new Error("tracking_lookup_cap");
}
export async function resolveTrustedIsolation(
  base44: any,
  input: any,
): Promise<Isolation> {
  try {
    const references = refs(input);
    if (!references.length)
      return { kind: "unknown", reason: "shipment_reference_required" };
    let chosen: any = null,
      local: any;
    for (const ref of references) {
      let row: any;
      if (ref.type === "tracking") row = await byTracking(ref.value,base44);
      else {
        const uuid = engineUuid(ref.value);
        if (uuid) {
          row = (await backendRead("/v1/shipments/" + encodeURIComponent(uuid)))
            .shipment;
          if (!row || row.id !== uuid)
            throw new Error("engine_identity_mismatch");
        } else if (/^[a-f0-9]{16,}$/i.test(ref.value)) {
          // The id is local Base44 identity, not an engine UUID. A failed explicit
          // lookup cannot be rescued by a different supplied tracking reference.
          const s = await base44.asServiceRole.entities.Shipment.get(ref.value);
          if (!s || s.id !== ref.value || !s.tracking_id)
            throw new Error("local_identity_unresolved");
          row = await byTracking(s.tracking_id,base44);
          if(row.sandbox_isolated===false && !await localAuthority(base44,'Shipment',s))throw new Error('local_link_authority_required');
          local = s;
          // Local metadata is not isolation authority. The engine read above is.
        } else throw new Error("unsupported_shipment_identifier");
      }
      if (
        !row ||
        (!engineUuid(row.id) && row.__local_authority!==true) ||
        typeof row.sandbox_isolated !== "boolean"
      )
        throw new Error("persisted_isolation_missing");
      if (ref.type === "tracking" && row.tracking_id !== ref.value && row.__source_tracking!==ref.value)
        throw new Error("tracking_mismatch");
      if (
        chosen &&
        (chosen.id !== row.id ||
          chosen.tracking_id !== row.tracking_id ||
          chosen.sandbox_isolated !== row.sandbox_isolated)
      )
        throw new Error("conflicting_shipment_references");
      chosen = row;
    }
    return {
      kind: chosen.sandbox_isolated ? "isolated" : "ordinary",
      shipment: chosen,
      ...(local ? { local } : {}),
    };
  } catch {
    // Do not disclose request URLs, secret-bearing SDK errors or customer rows.
    return {
      kind: "unknown",
      reason: "shipment_identity_or_backend_classification_unverified",
    };
  }
}
export function isolationDenied(result: Isolation): Response | null {
  if (result.kind === "ordinary") return null;
  return Response.json(
    {
      error: "Operational processing withheld",
      code:
        result.kind === "isolated" ? "sandbox_isolated" : "isolation_unknown",
    },
    { status: result.kind === "isolated" ? 403 : 409 },
  );
}
export async function operationalLocal(
  base44: any,
  result: Isolation,
): Promise<any | null> {
  if (result.kind !== "ordinary") return null;
  if (result.local) return await localAuthority(base44,'Shipment',result.local)?result.local:null;
  const rows = list(
    await base44.asServiceRole.entities.Shipment.filter({
      tracking_id: result.shipment.tracking_id,
    }),
  );
  // An unapproved owner-created shadow row must not suppress a verified
  // production mapping. Ambiguity between trusted mappings still holds.
  const approved=[];for(const row of rows)if(await localAuthority(base44,'Shipment',row))approved.push(row);
  if(approved.length===1)return approved[0];if(approved.length>1)return null;
  const packages=list(await base44.asServiceRole.entities.CrossAppPackage.filter({engine_shipment_id:result.shipment.id}));
  if(packages.length!==1)return null;
  const linked=await linkedEngineId(base44,'CrossAppPackage',packages[0]);if(!linked||engineUuid(linked.id)!==result.shipment.id)return null;
  const locals=list(await base44.asServiceRole.entities.Shipment.filter({tracking_id:packages[0].tracking_id}));
  const trusted=[];for(const row of locals)if(await localAuthority(base44,'Shipment',row))trusted.push(row);
  return trusted.length===1?trusted[0]:null;
}
// A caller cannot set downstream operational classification either. Remove
// classification assertions and stamp the verified ordinary result on the copy.
export function ordinaryEventCopy(input: any, result: Isolation): any {
  if (result.kind !== "ordinary")
    throw new Error("ordinary_backend_evidence_required");
  const flags = new Set([
    "sandbox_isolated",
    "sandbox",
    "synthetic",
    "is_sandbox",
    "sandbox_record",
    "test_harness",
  ]);
  const scrub = (v: any, depth = 0): any => {
    if (depth > 32) throw new Error("event_depth_unsupported");
    if (Array.isArray(v)) return v.map((x) => scrub(x, depth + 1));
    if (!v || typeof v !== "object") return v;
    return Object.fromEntries(
      Object.entries(v)
        .filter(([k]) => !flags.has(k))
        .map(([k, x]) => [k, scrub(x, depth + 1)]),
    );
  };
  const clean = scrub(input);
  clean.sandbox_isolated = false;
  if (clean.payload && typeof clean.payload === "object")
    clean.payload.sandbox_isolated = false;
  return clean;
}

// Local/pre-engine records need independently reviewed protected authority.
// A missing backend record does not itself prove an ordinary production parcel.
export async function resolveLocalOperation(base44:any,type:string,row:any):Promise<Isolation> {
 try {
  const grant=await localAuthority(base44,type,row);
  if(!grant)return {kind:'unknown',reason:'local_operation_grant_required'};
  if(grant.classification==='isolated')return {kind:'isolated',shipment:row,local:row};
  const linked=await linkedEngineId(base44,type,row);
  if(linked) {
    const uuid=engineUuid(linked.id);if(!uuid)return {kind:'unknown',reason:'engine_link_invalid'};
    const result=await resolveTrustedIsolation(base44,{engine_shipment_id:uuid});
    return result.kind==='unknown'?result:{...result,local:row};
  }
  if(row.engine_shipment_id||grant.approved_engine_id)return {kind:'unknown',reason:'engine_mapping_unverified'};
  if(!row.tracking_id)return {kind:'unknown',reason:'tracking_required'};
  const result=await resolveTrustedIsolation(base44,{tracking_id:row.tracking_id});
  return result.kind==='unknown'?result:{...result,local:row};
 } catch {return {kind:'unknown',reason:'local_authority_unavailable'};}
}
