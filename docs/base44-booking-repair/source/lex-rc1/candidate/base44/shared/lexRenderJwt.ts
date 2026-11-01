// Shared Render LEX engine authentication. Builds the HMAC-signed JWT the Render
// engine expects, using server secrets only. Used by:
//  - lexApi (user-mode proxy): sub = the calling user's id, role = mapped role.
//  - lexEngineSync (service worker): sub = "lex-engine-sync", role = "admin".
// No caller ever sees the secret; the token is built server-side per request.
import { secrets } from "base44:runtime";

const enc = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

const jsonPart = (value: unknown) => enc(new TextEncoder().encode(JSON.stringify(value)));

export function renderBaseUrl(): string {
  return secrets.get("LEX_API_URL") || "";
}

export function renderCredentials(): { baseUrl: string; clientId: string; secret: string } {
  const baseUrl = secrets.get("LEX_API_URL");
  const clientId = secrets.get("LEX_API_CLIENT_ID");
  const secret = secrets.get("LEX_API_CLIENT_SECRET");
  if (!baseUrl || !clientId || !secret) throw new Error("LEX integration is not configured");
  if (!baseUrl.startsWith("https://")) throw new Error("LEX_API_URL must use HTTPS");
  return { baseUrl, clientId, secret };
}

// Builds the Authorization + Content-Type headers carrying a short-lived signed
// JWT for the given subject and role. Claim shape is unchanged by the merchant
// work: only `iss` can differ when a dedicated merchant credential is selected.
async function signHeaders(
  clientId: string,
  secret: string,
  sub: string,
  role: string,
): Promise<Record<string, string>> {
  const now = Math.floor(Date.now() / 1000);
  const signingInput =
    jsonPart({ alg: "HS256", typ: "JWT" }) +
    "." +
    jsonPart({ iss: clientId, aud: "statelines-lex", sub, role, iat: now, exp: now + 120 });
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput));
  return {
    Authorization: "Bearer " + signingInput + "." + enc(new Uint8Array(sig)),
    "Content-Type": "application/json",
  };
}

// Default path — the single configured service client. Unchanged, so every
// existing caller (proxy, engine sync, carrier sync, cleanup, diagnostics) keeps
// behaving exactly as before.
export async function signedRenderHeaders(sub: string, role: string): Promise<Record<string, string>> {
  const { clientId, secret } = renderCredentials();
  return signHeaders(clientId, secret, sub, role);
}

// Model A: sign with one merchant's dedicated credential. Claims are identical to
// the default path — only `iss` changes — so no new claim is emitted before the
// backend confirms the contract.
export async function signedRenderHeadersWith(
  credential: { clientId: string; secret: string },
  sub: string,
  role: string,
): Promise<Record<string, string>> {
  if (!credential?.clientId || !credential?.secret) throw new Error("Merchant credential is not configured");
  return signHeaders(credential.clientId, credential.secret, sub, role);
}

