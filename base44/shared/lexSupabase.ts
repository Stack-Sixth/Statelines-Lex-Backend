// Shared Supabase connection resolution for LEX bridge functions.
// Resolves the project ref + management token + service_role key, and exposes
// a Management API helper. Used by lexSupabaseQuery and lexSupabaseSync so the
// connector wiring lives in one place.
import { nowIso } from "./lexUtils.ts";

const MGMT = "https://api.supabase.com/v1";

// Retry transient Supabase failures (network errors, 429, 5xx) with exponential
// backoff so maintenance windows and brief blips don't surface as hard failures.
export async function fetchWithRetry(url, init = {}, { retries = 3, baseMs = 400 } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, baseMs * 2 ** attempt));
          continue;
        }
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, baseMs * 2 ** attempt));
        continue;
      }
    }
  }
  throw lastErr || new Error("Request failed after retries");
}

export async function mgmt(path, token, init = {}) {
  const res = await fetchWithRetry(MGMT + path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    const message = (body && (body.message || body.error)) || `HTTP ${res.status}`;
    throw new Error(message);
  }
  return body;
}

// Returns { project, accessToken, serviceKey, restUrl } for the first project
// in the connected Supabase account. Throws if not connected or no project.
export async function resolveSupabase(base44) {
  const { accessToken } = await base44.asServiceRole.connectors.getConnection("supabase");
  if (!accessToken) throw new Error("Supabase not connected");
  const projects = await mgmt("/projects", accessToken);
  if (!projects || !projects.length) throw new Error("No Supabase projects found in this account");
  const project = projects[0];
  const keys = await mgmt(`/projects/${project.id}/api-keys`, accessToken);
  const serviceKey = (keys || []).find((k) => k.name === "service_role");
  if (!serviceKey) throw new Error("service_role key not found");
  return {
    project,
    accessToken,
    serviceKey: serviceKey.api_key,
    restUrl: `https://${project.id}.supabase.co/rest/v1`,
  };
}

// Upsert an array of row objects into a Supabase table via PostgREST,
// merging on the primary key (id). Chunks to 500 rows per request.
export async function upsertRows(ctx, table, rows) {
  const { serviceKey, restUrl } = ctx;
  const chunkSize = 500;
  let written = 0;
  let lastError = null;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const batch = rows.slice(i, i + chunkSize);
    let res;
    try {
      res = await fetchWithRetry(`${restUrl}/${table}`, {
        method: "POST",
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates,return=representation",
        },
        body: JSON.stringify(batch),
      });
    } catch (e) {
      lastError = String(e.message || e);
      continue;
    }
    if (!res.ok) {
      const text = await res.text();
      lastError = `HTTP ${res.status}: ${text.slice(0, 200)}`;
    } else {
      written += batch.length;
    }
  }
  return { written, error: lastError };
}

export function projectInfo(project) {
  return { id: project.id, name: project.name, region: project.region };
}

// Lightweight reachability probe for the connected Supabase project.
// Returns { ok, status, latency_ms, error }. ok = reachable and not in 5xx.
export async function healthCheck(ctx) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetchWithRetry(`${ctx.restUrl}/`, {
      headers: { apikey: ctx.serviceKey, Authorization: `Bearer ${ctx.serviceKey}` },
      signal: ctrl.signal,
    }, { retries: 1, baseMs: 300 });
    clearTimeout(t);
    const ok = res.status < 500;
    return { ok, status: res.status, latency_ms: Date.now() - t0, error: ok ? null : `HTTP ${res.status}` };
  } catch (e) {
    clearTimeout(t);
    return { ok: false, status: 0, latency_ms: Date.now() - t0, error: String(e.message || e) };
  }
}

export { nowIso };