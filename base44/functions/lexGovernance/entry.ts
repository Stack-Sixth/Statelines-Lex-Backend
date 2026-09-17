import { createClientFromRequest } from "npm:@base44/sdk@0.8.40";
import { nowIso, publishEvent } from "../../shared/lexUtils.ts";

// LEX Phase 3 — Governance: rule conflict detection + version restore.
// Ops: "conflicts" (duplicate rules, priority clashes, overlapping effective
// dates, policy conflicts — warnings only, never blocks an administrator),
// "restore_rule" / "restore_policy" (bring back a previous version, audited).
export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (user.role !== "admin") return Response.json({ error: "Forbidden" }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const op = body.op || "conflicts";

    if (op === "restore_rule" || op === "restore_policy") {
      const isRule = op === "restore_rule";
      const id = body.id;
      const version = Number(body.version);
      if (!id || !version)
        return Response.json({ error: "id and version required" }, { status: 400 });
      const entity = isRule
        ? base44.asServiceRole.entities.OperationalRule
        : base44.asServiceRole.entities.Policy;
      const record = await entity.get(id).catch(() => null);
      if (!record) return Response.json({ error: "Record not found" }, { status: 404 });
      const snapshot = (record.history || []).find((h) => Number(h.version) === version);
      if (!snapshot)
        return Response.json({ error: "Version " + version + " not found in history" }, { status: 404 });

      const restored = {};
      for (const field of ["name", "rule_type", "policy_type", "parameters", "standard", "priority", "enabled", "status", "effective_date", "expiration_date", "description"]) {
        if (snapshot[field] !== undefined) restored[field] = snapshot[field];
      }
      restored.version = (record.version || 1) + 1;
      restored.history = [
        ...(record.history || []).filter((h) => Number(h.version) !== version),
        {
          version: record.version || 1,
          name: record.name,
          parameters: record.parameters,
          standard: record.standard,
          priority: record.priority,
          enabled: record.enabled,
          status: record.status,
          effective_date: record.effective_date,
          expiration_date: record.expiration_date,
          changed_at: nowIso(),
          changed_by: user.full_name || user.email || "console",
        },
      ];
      restored.updated_by = user.full_name || user.email || "console";
      await entity.update(id, restored);

      await base44.asServiceRole.entities.AuditLog.create({
        actor_id: user.id,
        actor_name: user.full_name || "LEX",
        actor_role: user.role,
        action: isRule ? "governance.restore_rule" : "governance.restore_policy",
        entity_type: isRule ? "OperationalRule" : "Policy",
        entity_id: id,
        details: (record.name || id) + " restored to v" + version + " (now v" + restored.version + ")",
        severity: "info",
      });

      await publishEvent(base44, isRule ? "lex.rule_restored" : "lex.policy_restored", {
        id, restored_version: version,
      });

      return Response.json({ restored: true, version: restored.version });
    }

    // conflicts
    const [rules, policies] = [
      await base44.asServiceRole.entities.OperationalRule.filter({}),
      await base44.asServiceRole.entities.Policy.filter({}),
    ];
    const warnings = [];
    const now = Date.now();
    const active = (r) =>
      r.enabled !== false &&
      (!r.effective_date || new Date(r.effective_date).getTime() <= now) &&
      (!r.expiration_date || new Date(r.expiration_date).getTime() >= now);

    // duplicate rules — same type and identical parameters
    const seen = {};
    for (const r of rules) {
      const key = r.rule_type + "|" + JSON.stringify(r.parameters || {});
      if (seen[key]) {
        warnings.push({
          kind: "duplicate_rule",
          entity_type: "OperationalRule",
          ids: [seen[key].id, r.id],
          names: [seen[key].name, r.name],
          message: "Rules \"" + seen[key].name + "\" and \"" + r.name + "\" have identical type and parameters",
        });
      } else {
        seen[key] = r;
      }
    }

    // conflicting priorities + overlapping effective dates per rule type
    for (const t of [...new Set(rules.map((r) => r.rule_type))]) {
      const group = rules.filter((r) => r.rule_type === t && r.enabled !== false);
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const a = group[i];
          const b = group[j];
          if ((a.priority ?? 100) === (b.priority ?? 100)) {
            warnings.push({
              kind: "conflicting_priority",
              entity_type: "OperationalRule",
              ids: [a.id, b.id],
              names: [a.name, b.name],
              message: "Rules \"" + a.name + "\" and \"" + b.name + "\" share priority " + (a.priority ?? 100) + " — evaluation order is ambiguous",
            });
          }
          const aStart = a.effective_date ? new Date(a.effective_date).getTime() : null;
          const aEnd = a.expiration_date ? new Date(a.expiration_date).getTime() : null;
          const bStart = b.effective_date ? new Date(b.effective_date).getTime() : null;
          const bEnd = b.expiration_date ? new Date(b.expiration_date).getTime() : null;
          if (aStart && bStart) {
            const overlap =
              (aEnd == null || bStart <= aEnd) && (bEnd == null || aStart <= bEnd);
            if (overlap) {
              warnings.push({
                kind: "overlapping_dates",
                entity_type: "OperationalRule",
                ids: [a.id, b.id],
                names: [a.name, b.name],
                message: "Rules \"" + a.name + "\" and \"" + b.name + "\" have overlapping effective dates",
              });
            }
          }
        }
      }
    }

    // policy conflicts — two active policies of the same type
    for (const t of [...new Set(policies.map((p) => p.policy_type))]) {
      const activePolicies = policies.filter((p) => p.policy_type === t && p.status === "active");
      for (let i = 0; i < activePolicies.length; i++) {
        for (let j = i + 1; j < activePolicies.length; j++) {
          warnings.push({
            kind: "policy_conflict",
            entity_type: "Policy",
            ids: [activePolicies[i].id, activePolicies[j].id],
            names: [activePolicies[i].name, activePolicies[j].name],
            message: "Policies \"" + activePolicies[i].name + "\" and \"" + activePolicies[j].name + "\" are both active for " + t.replace(/_/g, " "),
          });
        }
      }
    }

    return Response.json({
      scanned_rules: rules.length,
      scanned_policies: policies.length,
      warnings,
      note: "warnings never block activation — administrators may override",
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}