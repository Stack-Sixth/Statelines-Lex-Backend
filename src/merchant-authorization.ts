import type { Sql } from './db.js';
import { AppError, type Actor } from './domain.js';

export function merchantScope(actor: Actor): string {
  if (!actor.merchantId)
    throw new AppError(
      403,
      'merchant_not_provisioned',
      'Merchant service client is not provisioned',
    );
  return actor.merchantId;
}

/** Issuer and subject have already been cryptographically verified. Never read scope from JWT claims. */
export async function resolveMerchantScope(sql: Sql, actor: Actor): Promise<Actor> {
  const binding = (
    await sql.query<{
      merchant_id: string;
      client_active: boolean;
      merchant_active: boolean;
      member: boolean;
    }>(
      `SELECT c.merchant_id,c.active AS client_active,m.active AS merchant_active,
      EXISTS(SELECT 1 FROM merchant.client_subjects s WHERE s.client_id=c.client_id AND s.subject_id=$2) AS member
     FROM merchant.service_clients c JOIN merchant.accounts m ON m.merchant_id=c.merchant_id
     WHERE c.client_id=$1`,
      [actor.clientId, actor.id],
    )
  ).rows[0];
  if (!binding)
    throw new AppError(
      403,
      'merchant_not_provisioned',
      'Merchant service client is not provisioned',
    );
  if (!binding.client_active)
    throw new AppError(403, 'merchant_client_revoked', 'Merchant service client is revoked');
  if (!binding.merchant_active)
    throw new AppError(403, 'merchant_inactive', 'Merchant account is inactive');
  if (!binding.member)
    throw new AppError(
      403,
      'merchant_subject_forbidden',
      'Subject is not authorized for this merchant service client',
    );
  return { ...actor, merchantId: binding.merchant_id };
}

export async function assertMerchantShipment(sql: Sql, actor: Actor, id: string) {
  const allowed = await sql.query(
    'SELECT shipment_id FROM merchant.shipment_scopes WHERE shipment_id=$1 AND merchant_id=$2',
    [id, merchantScope(actor)],
  );
  if (!allowed.rowCount) throw new AppError(404, 'not_found', 'Shipment not found');
}

/** Shared by both API generations. owner_user_id remains attribution, not tenant authority. */
export const shipmentAccess = `($1 IN ('admin','operator')
  OR ($1='merchant' AND EXISTS(SELECT 1 FROM merchant.shipment_scopes ms WHERE ms.shipment_id=s.id AND ms.merchant_id=$3))
  OR ($1='carrier' AND EXISTS(SELECT 1 FROM lex.carriers c WHERE c.id=s.assigned_carrier_id AND c.user_id=$2)))`;
