import { createClientFromRequest } from "npm:@base44/sdk@0.8.44";

// LEX Log Retention — enforces retention windows on high-volume log entities
// (EventLog, AuditLog, PlatformDelivery, DeadLetterEvent) to prevent unbounded
// growth. Admin-only. Supports dry_run (counts only) and purge modes, with
// configurable per-entity retention days and a per-run cap so a large backlog
// is chewed through gradually over successive runs instead of one huge delete.
// DeadLetterEvent only purges settled entries (replayed/archived); held ones remain.
export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (user.role !== "admin") return Response.json({ error: "Forbidden" }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const dryRun = body.dry_run === true;
    const defaultDays = Number(body.retention_days) || 90;
    const batchSize = Math.min(Number(body.batch_size) || 500, 500);
    const maxPerEntity = Math.min(Number(body.max_per_entity) || 5000, 10000);

    const config = [
      { entity: "EventLog", days: Number(body.event_log_days) || defaultDays, filter: {} },
      { entity: "AuditLog", days: Number(body.audit_log_days) || defaultDays, filter: {} },
      { entity: "PlatformDelivery", days: Number(body.platform_delivery_days) || defaultDays, filter: {} },
      {
        entity: "DeadLetterEvent",
        days: Number(body.dead_letter_days) || defaultDays,
        filter: { status: { $in: ["replayed", "archived"] } },
      },
    ];

    const results = [];
    for (const c of config) {
      const cutoff = new Date(Date.now() - c.days * 86400000).toISOString();
      let deleted = 0;
      const oldFilter = { ...c.filter, created_date: { $lt: cutoff } };
      while (deleted < maxPerEntity) {
        const batch = await base44.asServiceRole.entities[c.entity].filter(oldFilter, "created_date", batchSize);
        if (!batch.length) break;
        const take = Math.min(batch.length, maxPerEntity - deleted);
        if (dryRun) {
          deleted += take;
          if (batch.length < batchSize) break;
          continue;
        }
        const ids = batch.slice(0, take).map((r) => r.id);
        await base44.asServiceRole.entities[c.entity].deleteMany({ id: { $in: ids } });
        deleted += ids.length;
        if (batch.length < batchSize) break;
      }
      results.push({ entity: c.entity, retention_days: c.days, cutoff, purged: deleted, dry_run: dryRun });
    }

    await base44.asServiceRole.entities.AuditLog.create({
      actor_id: user.id,
      actor_name: user.full_name || "LEX",
      actor_role: user.role,
      action: "retention.run",
      entity_type: "EventLog",
      entity_id: "-",
      details: (dryRun ? "Dry-run scan: " : "Purged: ") + results.map((r) => r.entity + "=" + r.purged).join(", "),
      severity: "info",
    });

    return Response.json({ dry_run: dryRun, results });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}