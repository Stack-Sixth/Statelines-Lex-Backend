// Shared second-layer access gate for internal-only LEX functions.
//
// The functions that import this gate are not wired to any console screen or
// scheduled job today. They stay available for future server-side wiring (e.g.
// geo intake validation), but carry a second lock beyond the standard login
// gate: the caller must present LEX_INTERNAL_FUNCTION_SECRET. Only server-side
// callers (other backend functions, workflows) should ever hold the secret —
// never the browser, where it would be exposed.
//
// The secret may be supplied as either of:
//   - the `x-lex-internal-secret` request header
//   - the `internal_secret` field in the JSON body
// (Never as a URL parameter — URLs can leak into access logs and proxies.)
//
// Fail-closed: if the secret is not configured, every call is refused (503).
import { secrets } from "base44:runtime";

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function requireInternalSecret(req) {
  const expected = secrets.get("LEX_INTERNAL_FUNCTION_SECRET");
  if (!expected) {
    return Response.json(
      { error: "Internal function lock is not configured (LEX_INTERNAL_FUNCTION_SECRET missing)" },
      { status: 503 },
    );
  }

  let supplied = req.headers.get("x-lex-internal-secret") || "";
  if (!supplied) {
    try {
      const body = await req.clone().json();
      if (body && typeof body.internal_secret === "string") supplied = body.internal_secret;
    } catch {
      // not JSON or empty body — nothing to read
    }
  }
  if (!supplied) return Response.json({ error: "Forbidden" }, { status: 403 });

  // Compare digests so a wrong value gets the same refusal regardless of length.
  const [suppliedHash, expectedHash] = await Promise.all([sha256Hex(supplied), sha256Hex(expected)]);
  if (suppliedHash !== expectedHash) return Response.json({ error: "Forbidden" }, { status: 403 });

  return null; // allowed
}
