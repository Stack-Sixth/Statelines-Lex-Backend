// Durable per-user rate limiting, shared by backend functions that spend
// billable credits or external API calls on each request.
//
// Usage inside a function, after the auth check:
//   if (await overRateLimit(base44, user.id, "my_action_name")) {
//     return Response.json({ error: "Too many requests. Please wait a minute." }, { status: 429 });
//   }
//
// Layered, best-effort:
// 1. In-memory window on the current worker instance (free fast path).
// 2. Durable window: counts this user's recorded events in the entity store,
//    so the limit holds across instances and restarts.
// Blocked calls are NOT recorded, so storage grows only at the allowed rate.
// Old records can be purged by an admin at any time.

const MEM_BUCKETS = new Map<string, number[]>();
const LIMITS = [
  { prefix: "min", windowMs: 60000, max: 10 },
  { prefix: "hr", windowMs: 3600000, max: 40 },
];

export async function overRateLimit(base44, userId, action): Promise<boolean> {
  const now = Date.now();
  // The service role stamps its own internal identity as the record creator,
  // so created_by_id cannot carry the caller's id. Key the per-user counter
  // into the action field instead: "<action>:<userId>".
  const key = `${action}:${userId}`;

  // 1. In-memory fast path (same worker instance).
  let blocked = false;
  for (const { prefix, windowMs, max } of LIMITS) {
    const key = `${prefix}:${action}:${userId}`;
    const hits = (MEM_BUCKETS.get(key) || []).filter((t) => now - t < windowMs);
    if (hits.length >= max) {
      blocked = true;
      break;
    }
    hits.push(now);
    MEM_BUCKETS.set(key, hits);
  }
  // Opportunistic cleanup so the in-memory map cannot grow unbounded.
  if (MEM_BUCKETS.size > 10000) {
    for (const [key, hits] of MEM_BUCKETS) {
      if (!hits.length || now - hits[hits.length - 1] > 3600000) MEM_BUCKETS.delete(key);
    }
  }
  if (blocked) return true;

  // 2. Durable window: count this user's recorded allowed calls per window.
  for (const { windowMs, max } of LIMITS) {
    const since = new Date(now - windowMs).toISOString();
    const count = await base44.asServiceRole.entities.RateLimitEvent.count({
      action: key,
      created_date: { $gte: since },
    });
    if (count >= max) return true;
  }

  // 3. Allowed: record it so subsequent calls see it.
  await base44.asServiceRole.entities.RateLimitEvent.create({
    action: key,
  }).catch(() => {});
  return false;
}