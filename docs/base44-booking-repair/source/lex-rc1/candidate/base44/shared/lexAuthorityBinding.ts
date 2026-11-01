// Server-only binding. Never return the binding digest or secret to a caller.
export const MER = /^MER_[0-9a-f]{32}$/;
export function backendTarget(value: string): string {
  const u = new URL(value);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    u.pathname !== "/"
  )
    throw new Error(
      "LEX_API_URL must be an HTTPS origin without credentials/path/query",
    );
  return u.origin;
}
export function canonicalMerchant(row: any): string | null {
  const id = row?.canonical_merchant_id || row?.merchant_id;
  return typeof id === "string" && MER.test(id) ? id : null;
}
export async function authorityBinding(
  row: any,
  subject: string,
  credential: { clientId: string; secret: string },
  target: string,
): Promise<string> {
  if (
    !canonicalMerchant(row) ||
    !subject ||
    !credential?.clientId ||
    !credential?.secret
  )
    throw new Error("Incomplete authority binding");
  const input = JSON.stringify([
    "lex-authority-v2",
    row.id,
    row.merchant_id,
    canonicalMerchant(row),
    credential.clientId,
    row.credential_ref,
    subject,
    [...(row.approved_subjects || [])].sort(),
    backendTarget(target),
  ]);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(credential.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(input),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
