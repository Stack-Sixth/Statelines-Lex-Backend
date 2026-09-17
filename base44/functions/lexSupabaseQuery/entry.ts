// LEX → Supabase database bridge. Admin-only gateway over the authorized
// Supabase connector. Exposes three operations:
//   - tables : list tables in the public schema
//   - query  : run an arbitrary SQL statement (database:write scope)
//   - rows   : read rows from one table via PostgREST (service_role key)
// The Supabase project ref is resolved automatically via the shared module.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.40";
import { resolveSupabase, mgmt, projectInfo, healthCheck, nowIso } from "../../shared/lexSupabase.ts";

export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (user.role !== "admin") return Response.json({ error: "Forbidden" }, { status: 403 });

    let payload = {};
    try { payload = await req.json(); } catch { /* no body is fine */ }
    const operation = payload.operation || "tables";

    const ctx = await resolveSupabase(base44);
    const project = ctx.project;

    if (operation === "health") {
      const h = await healthCheck(ctx);
      return Response.json({ generated_at: nowIso(), project: projectInfo(project), health: h });
    }

    if (operation === "tables") {
      const sql = "select table_schema, table_name from information_schema.tables where table_schema in ('public') order by table_schema, table_name;";
      const result = await mgmt(`/projects/${project.id}/database/query/read-only`, ctx.accessToken, {
        method: "POST",
        body: JSON.stringify({ query: sql }),
      });
      return Response.json({
        generated_at: nowIso(),
        project: projectInfo(project),
        tables: (result || []).map((r) => r.table_name).filter(Boolean),
      });
    }

    if (operation === "query") {
      const sql = (payload.sql || "").trim();
      if (!sql) return Response.json({ error: "Missing 'sql'" }, { status: 400 });
      const readOnly = payload.read_only === true;
      const endpoint = readOnly ? "/database/query/read-only" : "/database/query";
      const result = await mgmt(`/projects/${project.id}${endpoint}`, ctx.accessToken, {
        method: "POST",
        body: JSON.stringify({ query: sql }),
      });
      return Response.json({
        generated_at: nowIso(),
        project: { id: project.id, name: project.name },
        read_only: readOnly,
        rows: result || [],
      });
    }

    if (operation === "rows") {
      const table = (payload.table || "").trim();
      if (!table) return Response.json({ error: "Missing 'table'" }, { status: 400 });
      const limit = Math.min(Math.max(Number(payload.limit) || 50, 1), 1000);
      const select = payload.select || "*";
      const order = payload.order || null;
      const filter = payload.filter || null; // e.g. "id=eq.123"

      const qs = new URLSearchParams();
      qs.set("select", select);
      if (order) qs.set("order", order);
      qs.set("limit", String(limit));
      const filterPart = filter ? `&${filter}` : "";
      const url = `https://${project.id}.supabase.co/rest/v1/${table}?${qs.toString()}${filterPart}`;
      const res = await fetch(url, {
        headers: { apikey: ctx.serviceKey, Authorization: `Bearer ${ctx.serviceKey}` },
      });
      const text = await res.text();
      let rows = null;
      try { rows = JSON.parse(text); } catch { rows = text; }
      if (!res.ok) {
        return Response.json({ error: (rows && (rows.message || rows.error)) || `HTTP ${res.status}`, raw: text }, { status: res.status });
      }
      const count = res.headers.get("Content-Range");
      return Response.json({
        generated_at: nowIso(),
        project: { id: project.id, name: project.name },
        table,
        count: Array.isArray(rows) ? rows.length : null,
        total_range: count,
        rows,
      });
    }

    return Response.json({ error: `Unknown operation: ${operation}` }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}