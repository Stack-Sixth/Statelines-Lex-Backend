import { createClientFromRequest } from "npm:@base44/sdk@0.8.40";

// LEX Analytics Service — aggregates platform-wide metrics for dashboards and reporting.
export default async function (req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    // Platform-wide audit logs, fraud alerts, and operational metrics are admin-only.
    if (user.role !== "admin") return Response.json({ error: "Forbidden" }, { status: 403 });

    const [shipments, carriers, nodes, bundles, alerts, forecasts, custody, notifications, audit] =
      await Promise.all([
        base44.asServiceRole.entities.Shipment.filter({}),
        base44.asServiceRole.entities.CommunityCarrier.filter({}),
        base44.asServiceRole.entities.SmartNode.filter({}),
        base44.asServiceRole.entities.SmartBundle.filter({}),
        base44.asServiceRole.entities.FraudAlert.filter({}),
        base44.asServiceRole.entities.DemandForecast.filter({}),
        base44.asServiceRole.entities.ChainOfCustodyEvent.filter({}),
        base44.asServiceRole.entities.Notification.filter({}),
        base44.asServiceRole.entities.AuditLog.filter({}),
      ]);

    const statusCounts = {};
    for (const s of shipments) statusCounts[s.status] = (statusCounts[s.status] || 0) + 1;

    const corridorVolume = {};
    for (const s of shipments) {
      const k = (s.origin || "?") + " → " + (s.destination || "?");
      corridorVolume[k] = (corridorVolume[k] || 0) + 1;
    }
    const topCorridors = Object.entries(corridorVolume)
      .map(([corridor, volume]) => ({ corridor, volume }))
      .sort((a, b) => b.volume - a.volume)
      .slice(0, 8);

    const totalCapacity = carriers.reduce((sum, c) => sum + (c.capacity_total_kg || 0), 0);
    const usedCapacity = carriers.reduce((sum, c) => sum + (c.capacity_used_kg || 0), 0);
    const avgRating =
      carriers.length > 0
        ? Math.round((carriers.reduce((sum, c) => sum + (c.rating || 0), 0) / carriers.length) * 100) / 100
        : 0;

    const totalSavings = bundles.reduce((sum, b) => sum + (b.estimated_savings_pct || 0), 0);
    const totalCarbon = bundles.reduce((sum, b) => sum + (b.carbon_savings_kg || 0), 0);

    const openAlerts = alerts.filter((a) => a.status === "open").length;

    // Explicit sort ordering — filter({}) guarantees no order.
    const recentAudit = await base44.asServiceRole.entities.AuditLog.list("-created_date", 10);
    const recentAlerts = await base44.asServiceRole.entities.FraudAlert.list("-created_date", 5);

    return Response.json({
      totals: {
        shipments: shipments.length,
        carriers: carriers.length,
        smart_nodes: nodes.length,
        smart_bundles: bundles.length,
        fraud_alerts: alerts.length,
        open_fraud_alerts: openAlerts,
        forecasts: forecasts.length,
        custody_events: custody.length,
        notifications: notifications.length,
        audit_entries: audit.length,
      },
      shipment_status: statusCounts,
      top_corridors: topCorridors,
      capacity: {
        total_kg: Math.round(totalCapacity),
        used_kg: Math.round(usedCapacity),
        utilization_pct: totalCapacity > 0 ? Math.round((usedCapacity / totalCapacity) * 1000) / 10 : 0,
      },
      carrier_quality: { avg_rating: avgRating, active_carriers: carriers.filter((c) => c.status !== "offline").length },
      bundle_efficiency: {
        total_savings_pct: Math.round(totalSavings * 10) / 10,
        carbon_savings_kg: Math.round(totalCarbon * 10) / 10,
      },
      recent_audit: recentAudit,
      recent_alerts: recentAlerts,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}