// Trusted, server-side adapter to the Statelines Domain Platform on Render.
// Every call to Render's /api/v1/* domain API must go through here so that:
//   1. The short-lived service JWT is minted server-side (never sent to the
//      browser, never logged). The JWT is signed with LEX_SERVICE_CLIENT_SECRET,
//      the sensitive credential, which must never be returned to the browser,
//      displayed in diagnostic output, logged, included in API responses, or
//      hard-coded into client-side code.
//   2. Requests are fail-closed: if credentials are missing or Render rejects
//      the token, the caller sees a structured error and nothing is mutated
//      on Render's side.
//   3. Response handling + error normalization is shared across all commands.
//
// JWT contract (from the Render Domain Platform):
//   HS256, iss = LEX_SERVICE_CLIENT_ID, sub = LEX_SERVICE_CLIENT_ID,
//   aud = "statelines-lex", role = "merchant", iat = now, exp = now + 120s.
//
// LEX_SERVICE_CLIENT_ID is a client identifier (not a secret); its value is
// "statelines-merchant" and is safe to surface in diagnostic/reporting output.
// LEX_SERVICE_CLIENT_SECRET is the sensitive credential — server-side only.
//
// This module is server-side only. Never import it from src/.

import { secrets } from "base44:runtime";
import { evaluateMerchantContext, type MerchantContextOutcome } from "./authorityRules.ts";

// Re-exported so every importer keeps using one definition of the contract.
export type { MerchantContext, MerchantContextOutcome } from "./authorityRules.ts";

const AUDIENCE = "statelines-lex";
const TOKEN_TTL_SECONDS = 120; // 2 minutes, short-lived by contract

export interface RenderError {
  ok: false;
  status: number;
  code: string;
  message: string;
  requestId?: string;
}

export interface RenderOk<T = unknown> {
  ok: true;
  status: number;
  data: T;
  etag?: string;
}

export type RenderResult<T = unknown> = RenderOk<T> | RenderError;

// LEX_SERVICE_CLIENT_ID is a client identifier ("statelines-merchant"), not a
// secret — safe to surface in diagnostics. LEX_SERVICE_CLIENT_SECRET is the
// sensitive credential; this check merely confirms it is present without
// ever exposing its value.
/**
 * Reachability of the trusted domain API. A merchant booking needs LEX_API_URL
 * and that merchant's OWN dedicated pair — never the shared service client.
 */
export function isReachable(): boolean {
  return Boolean(secrets.get("LEX_API_URL"));
}

export function isConfigured(): boolean {
  return Boolean(
    secrets.get("LEX_API_URL") &&
      secrets.get("LEX_SERVICE_CLIENT_ID") &&
      secrets.get("LEX_SERVICE_CLIENT_SECRET"),
  );
}

function b64url(input: string): string {
  // Base64-url-encode an already-UTF8 string. Safe for JSON (ASCII) headers.
  const b64 = btoa(input);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlBytes(bytes: Uint8Array): string {
  // Base64-url-encode raw bytes (standard JWS signature encoding).
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmacSha256(keyStr: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(keyStr),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  // JWS requires base64url-encoded signatures, not hex.
  return b64urlBytes(new Uint8Array(sig));
}

// A credential pair identifies WHICH merchant scope the token speaks for. The
// platform service client (LEX_SERVICE_CLIENT_*) is never passed here for a
// merchant booking: each merchant is addressed with its own provisioned pair.
export interface ServiceCredential {
  client_id: string;
  client_secret: string;
}

export async function mintServiceToken(credential?: ServiceCredential): Promise<string> {
  // A merchant-scoped caller MUST pass a COMPLETE dedicated pair. Falling back
  // field-by-field to the platform service client would let a partially
  // configured merchant mint a token under the wrong tenant, so a supplied
  // credential is used exactly as given and never completed from secrets.
  const clientId = credential ? credential.client_id : secrets.get("LEX_SERVICE_CLIENT_ID");
  const secret = credential ? credential.client_secret : secrets.get("LEX_SERVICE_CLIENT_SECRET");
  if (credential && (!credential.client_id || !credential.client_secret)) {
    throw new Error("Dedicated merchant credential is incomplete; a shared client is never substituted.");
  }
  if (!clientId || !secret) {
    throw new Error("Render credentials not configured (LEX_SERVICE_CLIENT_ID / LEX_SERVICE_CLIENT_SECRET).");
  }
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(
    JSON.stringify({
      iss: clientId,
      sub: clientId,
      aud: AUDIENCE,
      role: "merchant",
      iat: now,
      exp: now + TOKEN_TTL_SECONDS,
    }),
  );
  const signature = await hmacSha256(secret, `${header}.${payload}`);
  return `${header}.${payload}.${signature}`;
}

// The signing subject of a merchant-scoped token is that dedicated client's own
// client_id: the JWT carries iss = sub = client_id. The backend accepts the
// subject only when it was approved for that client during provisioning, so the
// subject is derived in exactly one place and verified against the mapping.
// Booking and reconciliation both mint from the same dedicated credential, so
// both speak for the same subject.
export function signingSubject(credential: ServiceCredential): string {
  return String(credential?.client_id || "");
}

function normalizeError(status: number, body: unknown): RenderError {
  let code = "render_error";
  let message = `Render responded ${status}`;
  let requestId: string | undefined;
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    // Render answers with either { error: "code", message } or
    // { error: { code, message } }; both shapes must reach the caller so a
    // refusal is diagnosable instead of a bare "Render responded 403".
    const nested = b.error && typeof b.error === "object" ? (b.error as Record<string, unknown>) : null;
    if (typeof b.error === "string") code = b.error;
    else if (nested && typeof nested.code === "string") code = nested.code;
    if (typeof b.message === "string") message = b.message;
    else if (nested && typeof nested.message === "string") message = nested.message;
    else if (typeof b.detail === "string") message = b.detail;
    if (typeof b.request_id === "string") requestId = b.request_id;
    else if (typeof b.correlation_id === "string") requestId = b.correlation_id;
  }
  return { ok: false, status, code, message, requestId };
}

export interface CallOptions {
  method: string;
  path: string; // e.g. "/api/v1/orders"
  body?: unknown;
  etag?: string; // for If-Match optimistic concurrency
  expectEtag?: boolean;
  timeoutMs?: number;
  // Merchant-scoped credential. Omit only for platform-level reads where the
  // platform's own scope is the intended subject.
  credential?: ServiceCredential;
  // Optional base-URL override, used only by the controlled staging
  // verification path (LEX_STAGING_API_URL). Production calls omit it.
  baseUrl?: string;
}

export async function callRender<T = unknown>(opts: CallOptions): Promise<RenderResult<T>> {
  const configured = (secrets.get("LEX_API_URL") || "").replace(/\/$/, "");
  const baseUrl = (opts.baseUrl ? String(opts.baseUrl) : configured).replace(/\/$/, "");
  if (!baseUrl) {
    return { ok: false, status: 0, code: "not_configured", message: "LEX_API_URL not configured" };
  }
  let token: string;
  try {
    token = await mintServiceToken(opts.credential);
  } catch (e) {
    return { ok: false, status: 0, code: "auth_mint_failed", message: (e as Error).message };
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (opts.etag) headers["If-Match"] = opts.etag;
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${opts.path}`, {
      method: opts.method,
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15000),
    });
  } catch (e) {
    return { ok: false, status: 0, code: "network_error", message: (e as Error).message };
  }
  const rawText = await res.text();
  let parsed: unknown = undefined;
  if (rawText) {
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = rawText;
    }
  }
  if (!res.ok) return normalizeError(res.status, parsed);
  const etag = res.headers.get("etag") || undefined;
  return { ok: true, status: res.status, data: parsed as T, etag };
}

// ---------------------------------------------------------------------------
// Verified backend authorization: GET /api/v1/merchant-context
// ---------------------------------------------------------------------------
//
// This is the ONLY call that proves a dedicated credential is accepted by the
// deployed backend AND speaks for the merchant we mapped. A local "credentials
// present" check cannot establish either. Every branch fails closed:
//   • 401/403            → credential refused            (unauthorized)
//   • 404 / 5xx / no net  → backend not deployed/healthy  (backend_unavailable)
//   • missing fields      → unexpected response           (malformed)
//   • any field mismatch  → wrong tenant/identity         (mismatch)

export async function verifyMerchantContext(input: {
  credential: ServiceCredential;
  expected: { merchant_id: string; client_id: string; subject: string };
  baseUrl?: string;
}): Promise<MerchantContextOutcome> {
  const res = await callRender<unknown>({
    method: "GET",
    path: "/api/v1/merchant-context",
    timeoutMs: 10000,
    credential: input.credential,
    baseUrl: input.baseUrl,
  });

  // Every branch is decided by the pure evaluator, so the same rules are the
  // ones exercised by the unit tests.
  return evaluateMerchantContext({
    ok: res.ok,
    status: res.status,
    body: res.ok ? res.data : undefined,
    code: res.ok ? undefined : res.code,
    message: res.ok ? undefined : res.message,
    expected: input.expected,
  });
}