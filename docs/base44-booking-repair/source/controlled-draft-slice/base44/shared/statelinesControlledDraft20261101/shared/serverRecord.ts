// Provenance only; row-level policies protect mutable state after cutover.
// Mint only on server CREATE, never on an existing browser-created row.
export function recordAuthority(secret: string | undefined) {
  if (!secret || secret.length < 32)
    throw new Error(
      "MERCHANT_CONTROLLED_RECORD_SIGNING_SECRET must be configured privately (32+ characters)",
    );
  const mac = async (kind: string, row: any) => {
    const data = JSON.stringify([
      "merchant-controlled-record-v1",
      kind,
      row.server_owner_user_id,
      row.merchant_id,
      row.server_nonce,
      row.server_record_created_at,
    ]);
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const bytes = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(data),
    );
    return [...new Uint8Array(bytes)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  };
  return {
    async mint(kind: string, user: string, merchant: string) {
      const row = {
        server_owner_user_id: user,
        merchant_id: merchant,
        server_nonce: crypto.randomUUID(),
        server_record_created_at: new Date().toISOString(),
      };
      return { ...row, server_record_proof: await mac(kind, row) };
    },
    async trusted(kind: string, row: any) {
      if (
        !row?.server_nonce ||
        !row.server_owner_user_id ||
        !row.merchant_id ||
        !row.server_record_created_at ||
        typeof row.server_record_proof !== "string"
      )
        return false;
      const expected = await mac(kind, row);
      if (expected.length !== row.server_record_proof.length) return false;
      let diff = 0;
      for (let i = 0; i < expected.length; i++)
        diff |= expected.charCodeAt(i) ^ row.server_record_proof.charCodeAt(i);
      return diff === 0;
    },
  };
}

// Atomic local lifecycle evidence; never physical deletion or frozen-field edits.
export async function lifecycleWrite(
  entity: any,
  id: string,
  actor: string,
  action: string,
  changes: any,
  guard: any = {},
) {
  const row = await entity.get(id),
    revision = Number(row.lifecycle_revision) || 0;
  if (
    action === "shipment.cancelled.canonical" &&
    row.status === "cancelled" &&
    row.domain_status === "cancelled"
  )
    return true;
  if (action === "shipment.archived" && row.archived_at) return true;
  const next = {
    ...changes,
    lifecycle_revision: revision + 1,
    lifecycle_history: [
      ...(row.lifecycle_history || []),
      {
        action,
        actor_id: actor,
        at: new Date().toISOString(),
        status: changes.status || row.status,
        canonical_shipment_id: row.canonical_shipment_id || null,
      },
    ],
  };
  const result = await entity.updateMany(
    {
      id,
      lifecycle_revision: Object.hasOwn(row, "lifecycle_revision")
        ? row.lifecycle_revision
        : { $exists: false },
      ...guard,
    },
    { $set: next },
  );
  return result?.updated === 1;
}
export async function recordOwner(
  kind: string,
  row: any,
  authority: ReturnType<typeof recordAuthority>,
) {
  return (await authority.trusted(kind, row))
    ? row.server_owner_user_id
    : row.created_by_id;
}
