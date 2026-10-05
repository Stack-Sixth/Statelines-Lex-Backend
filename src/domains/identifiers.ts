import { z } from 'zod';
import { AppError } from '../domain.js';

export const prefixes = {
  user: 'USR',
  organization: 'ORG',
  merchant: 'MER',
  order: 'ORD',
  shipment: 'SHP',
  package: 'PKG',
  tracking: 'TRK',
  command: 'CMD',
  event: 'EVT',
  carrier: 'CAR',
  vehicle: 'VEH',
  assignment: 'ASN',
  trip: 'TRP',
  pudo: 'PUDO',
  incident: 'INC',
  payment: 'PAY',
} as const;
export type EntityType = keyof typeof prefixes;

/** A reversible encoding of the complete UUID; never truncates or replaces tracking IDs. */
export function publicId(type: EntityType, id: string): string {
  return prefixes[type] + '_' + z.string().uuid().parse(id).toLowerCase().replaceAll('-', '');
}
export function internalId(type: EntityType, value: string): string {
  if (z.string().uuid().safeParse(value).success) return value.toLowerCase();
  const prefix = prefixes[type] + '_';
  const hex = value.startsWith(prefix) ? value.slice(prefix.length) : '';
  if (/^[0-9a-f]{32}$/.test(hex)) {
    const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    if (z.string().uuid().safeParse(id).success) return id;
  }
  throw new AppError(400, 'invalid_identifier', `Expected a UUID or ${prefix} public identifier`);
}
