import { createClientFromRequest } from "npm:@base44/sdk@0.8.52";
import { secrets } from "base44:runtime";
import { recordAuthority } from "../../shared/serverRecord.ts";
const rows = (x: any) => (Array.isArray(x) ? x : x?.items || []);
export default async function (req: Request): Promise<Response> {
  try {
    const b = createClientFromRequest(req),
      user = await b.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const body = await req.json(),
      E = b.asServiceRole.entities.Shipment,
      proof = recordAuthority(secrets.get("MERCHANT_RECORD_SIGNING_SECRET"));
    const own = async (r: any) =>
      (await proof.trusted("Shipment", r))
        ? r.server_owner_user_id === user.id
        : r.created_by_id === user.id;
    if(body.action==='admin_get') {
      if(user.role!=='admin')return Response.json({error:'Admin required'},{status:403});
      return Response.json({shipment:await E.get(String(body.shipment_id||''))});
    }
    if (body.action === "timeline") {
      const row=await E.get(String(body.shipment_id||''));
      if(!await own(row))return Response.json({error:'Not found'},{status:404});
      const sort=body.sort==='occurred_at'?'occurred_at':'-occurred_at';
      const limit=Number(body.limit||50);
      if(!Number.isInteger(limit)||limit<1||limit>200)return Response.json({error:'Invalid limit'},{status:400});
      return Response.json({items:rows(await b.asServiceRole.entities.ShipmentEvent.filter({shipment_id:row.id},sort,limit))});
    }
    if (body.action === "get") {
      const row = await E.get(String(body.shipment_id || ""));
      if (!(await own(row)))
        return Response.json({ error: "Not found" }, { status: 404 });
      return Response.json({ shipment: row });
    }
    if (body.action !== "list")
      return Response.json({ error: "Unknown action" }, { status: 400 });
    const limit = body.limit === undefined ? 100 : Number(body.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      return Response.json({ error: "Invalid limit" }, { status: 400 });
    const all = [
      ...rows(
        await E.filter(
          { server_owner_user_id: user.id },
          "-created_date",
          1000,
        ),
      ),
      ...rows(
        await E.filter({ created_by_id: user.id }, "-created_date", 1000),
      ),
    ];
    const items = [];
    for (const r of [...new Map(all.map((r) => [r.id, r])).values()])
      if (
        (await own(r)) &&
        !r.archived_at &&
        (!body.status || r.status === body.status)
      )
        items.push(r);
    items.sort(
      (a, b) =>
        String(b.created_date || "").localeCompare(
          String(a.created_date || ""),
        ) || String(b.id).localeCompare(String(a.id)),
    );
    return Response.json({ items: items.slice(0, limit), bounded_scan: true });
  } catch {
    return Response.json({ error: "Shipment read failed" }, { status: 400 });
  }
}
