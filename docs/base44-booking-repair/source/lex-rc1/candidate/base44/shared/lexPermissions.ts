// LEX Staff Access — 4 tiers (admin, dispatcher, analyst, viewer).
//
// AUTHORITATIVE SOURCE: The StaffAccess entity (admin-write-only RLS) is the
// authoritative store for non-admin staff levels. The User.staff_level field is
// a self-editable custom field (base44.auth.updateMe lets users change it), so
// it MUST NOT be trusted for authorization — a user could self-set it to
// "dispatcher" or "analyst" to escalate privileges (OWASP A01 / CWE-269).
//
// resolveLevelSync (kept for the frontend) falls back to user.staff_level for
// UX display only; it is never the enforcement path. The backend enforcement
// path is resolveLevelAsync → StaffAccess lookup → viewer if no row.
export const STAFF_LEVELS = ["admin", "dispatcher", "analyst", "viewer"];

export const LEVEL_LABELS = {
  admin: "Super Admin",
  dispatcher: "Dispatcher",
  analyst: "Analyst",
  viewer: "Viewer",
};

// Permission -> levels allowed. Admin level always wins via resolveLevel.
export const PERMISSIONS = {
  view_console: ["admin", "dispatcher", "analyst"],
  match_shipments: ["admin", "dispatcher"],
  record_custody: ["admin", "dispatcher"],
  transition_shipment: ["admin", "dispatcher"],
  price_shipment: ["admin", "dispatcher"],
  estimate_eta: ["admin", "dispatcher", "analyst"],
  optimize_bundles: ["admin", "dispatcher"],
  optimize_routes: ["admin", "dispatcher"],
  recommend_node: ["admin", "dispatcher"],
  forecast_demand: ["admin", "analyst"],
  detect_fraud: ["admin", "analyst"],
  record_decision: ["admin", "dispatcher", "analyst"],
  publish_reward: ["admin"],
  publish_wallet: ["admin"],
  platform_sync: ["admin"],
  manage_staff: ["admin"],
  manage_platform_connections: ["admin"],
  manage_supabase: ["admin"],
  manage_rules: ["admin"],
  manage_policies: ["admin"],
  manage_carriers: ["admin"],
  manage_nodes: ["admin"],
  governance: ["admin"],
  reliability: ["admin"],
  queue: ["admin"],
  simulate: ["admin"],
  log_retention: ["admin"],
  geo_verify: ["admin", "dispatcher", "analyst"],
  geo_route: ["admin", "dispatcher", "analyst"],
  geo_intake_check: ["admin", "dispatcher"],
  manage_operating_areas: ["admin"],
};

// Sync resolver — uses the (untrusted) user.staff_level for display/UX only.
// The backend MUST use resolveLevelAsync for authorization.
export function resolveLevelSync(user) {
  if (!user) return "viewer";
  // Admin tier is granted ONLY by the platform role, never by a self-set field.
  if (user.role === "admin") return "admin";
  const lvl = STAFF_LEVELS.includes(user.staff_level) ? user.staff_level : "viewer";
  return lvl === "admin" ? "viewer" : lvl;
}

// Keep the old name as an alias so the frontend mirror and lexTransitions'
// sync callers compile during the transition, but the backend enforcement
// path now uses resolveLevelAsync.
export const resolveLevel = resolveLevelSync;

// Authoritative async resolver — looks up the admin-controlled StaffAccess row
// for the user. Admin-role users are always full-access regardless of any
// StaffAccess row. If no StaffAccess row exists, the user is a viewer (least
// privilege). This is the ONLY resolver backend functions should use for
// authorization decisions.
export async function resolveLevelAsync(base44, user) {
  if (!user) return "viewer";
  if (user.role === "admin") return "admin";
  try {
    const rows = await base44.asServiceRole.entities.StaffAccess.filter({ user_id: user.id });
    const items = Array.isArray(rows) ? rows : (rows?.items || []);
    const row = items[0];
    if (!row) return "viewer";
    const lvl = STAFF_LEVELS.includes(row.staff_level) ? row.staff_level : "viewer";
    // StaffAccess.staff_level="admin" does NOT grant platform admin — only the
    // platform role does. A non-platform-admin with staff_level="admin" is
    // treated as viewer to prevent privilege escalation.
    return lvl === "admin" ? "viewer" : lvl;
  } catch {
    // On any lookup failure, fail closed (least privilege).
    return "viewer";
  }
}

export async function canAsync(base44, user, perm) {
  const level = await resolveLevelAsync(base44, user);
  const allowed = PERMISSIONS[perm];
  if (!allowed) return false;
  return allowed.includes(level);
}

export function levelLabel(level) {
  return LEVEL_LABELS[level] || "Viewer";
}

export function deniedReason(user, perm) {
  const allowed = PERMISSIONS[perm] || [];
  const need = allowed.filter((l) => l !== "admin");
  if (need.length === 0) return "Super Admin access required";
  if (need.length === 1) return levelLabel(need[0]) + " access required";
  return need.map(levelLabel).join(" or ") + " access required";
}

// Backend helper — returns a 403 Response when denied, or null when allowed.
// Async: looks up the authoritative staff level from StaffAccess (admin-only
// writes), NOT the self-editable user.staff_level field.
export async function requirePerm(base44, user, perm) {
  if (await canAsync(base44, user, perm)) return null;
  return Response.json({ error: deniedReason(user, perm) }, { status: 403 });
}
