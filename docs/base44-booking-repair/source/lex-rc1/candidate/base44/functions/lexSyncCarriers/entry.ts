// LEX Carrier → Engine sync. Registers every hub CommunityCarrier on the Render
// LEX engine so the engine can match, route and track shipments to them. LEX is
// the engine of the entire operation; carriers must be known to it to participate.
//
// Idempotent: lists existing Render carriers and skips any already registered
// (keyed by user_id = hub carrier id). New carriers get a forward schedule so they
// are /match-eligible (departure in the future, arrival within a typical window).
// Admin-only — invoked from the LEX console "Sync to engine" button.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.52";
import { renderCredentials, signedRenderHeaders } from "../../shared/lexRenderJwt.ts";

export default async function (req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (user.role !== "admin") return Response.json({ error: "admin only" }, { status: 403 });

    const { baseUrl } = renderCredentials();

    const page = await base44.asServiceRole.entities.CommunityCarrier.filter({}, { limit: 200 });
    const carriers = Array.isArray(page) ? page : (page.items || []);

    const listHeaders = await signedRenderHeaders("lex-sync-carriers", "admin");
    const listRes = await fetch(new URL("/v1/carriers?limit=100", baseUrl), {
      method: "GET",
      headers: listHeaders,
      signal: AbortSignal.timeout(15000),
      redirect: "manual",
    });
    const listBody = await listRes.json().catch(() => ({ items: [] }));
    const existing = new Set((listBody.items || []).map((c: any) => c.user_id));

    const now = Date.now();
    const departureAt = new Date(now + 2 * 3600 * 1000).toISOString();
    const arrivalAt = new Date(now + 6 * 3600 * 1000).toISOString();

    const results = [];
    let synced = 0;
    let skipped = 0;
    let failed = 0;

    for (const c of carriers) {
      if (existing.has(c.id)) {
        skipped++;
        results.push({ carrier: c.name, skipped: true });
        continue;
      }
      const payload = {
        command_id: crypto.randomUUID(),
        user_id: c.id,
        name: c.name,
        origin: c.route_origin,
        destination: c.route_destination,
        package_sizes: ["small", "medium", "large", "xl"],
        service_levels:
          c.service_levels && c.service_levels.length
            ? c.service_levels
            : ["standard", "express", "same_day", "overnight"],
        departure_at: departureAt,
        arrival_at: arrivalAt,
        capacity_kg: c.capacity_total_kg || 100,
      };
      try {
        const h = await signedRenderHeaders("lex-sync-carriers", "admin");
        const r = await fetch(new URL("/v1/carriers", baseUrl), {
          method: "POST",
          headers: h,
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(15000),
          redirect: "manual",
        });
        const body = await r.json().catch(() => ({}));
        if (r.status === 201 && body.id) {
          synced++;
          results.push({ carrier: c.name, synced: true, engine_id: body.id });
        } else if (r.status === 409) {
          // Already registered on the engine (list may have been capped or filtered).
          skipped++;
          results.push({ carrier: c.name, skipped: true, conflict: true });
        } else {
          failed++;
          results.push({
            carrier: c.name,
            failed: true,
            status: r.status,
            error: body.error || body.detail || null,
          });
        }
      } catch (e) {
        failed++;
        results.push({ carrier: c.name, failed: true, error: e instanceof Error ? e.message : String(e) });
      }
    }

    return Response.json({ synced, skipped, failed, total: carriers.length, results });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}