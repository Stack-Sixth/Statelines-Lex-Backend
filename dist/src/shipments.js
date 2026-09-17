import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError, audit, command, emit, requireRole, transitions, statuses, corridor, packageSize, serviceLevel, commandFields, versionFields, uuid, } from './domain.js';
const weight = z.number().positive().max(1000000).multipleOf(0.001);
export const createShipmentSchema = z
    .object({
    ...commandFields,
    owner_user_id: z.string().min(1).max(200).optional(),
    origin: corridor,
    destination: corridor,
    weight_kg: weight,
    package_size: packageSize,
    service_level: serviceLevel,
    pickup_deadline: z.iso.datetime({ offset: true }),
    delivery_deadline: z.iso.datetime({ offset: true }),
})
    .strict()
    .refine((x) => x.origin !== x.destination, 'Origin and destination must differ')
    .refine((x) => Date.parse(x.delivery_deadline) > Date.parse(x.pickup_deadline), 'Delivery must follow pickup');
export const carrierSchema = z
    .object({
    ...commandFields,
    user_id: z.string().min(1).max(200),
    name: z.string().trim().min(1).max(120),
    origin: corridor,
    destination: corridor,
    service_levels: z.array(serviceLevel).min(1),
    package_sizes: z.array(packageSize).min(1),
    departure_at: z.iso.datetime({ offset: true }),
    arrival_at: z.iso.datetime({ offset: true }),
    capacity_kg: weight,
})
    .strict()
    .refine((x) => x.origin !== x.destination, 'Origin and destination must differ')
    .refine((x) => Date.parse(x.arrival_at) > Date.parse(x.departure_at), 'Arrival must follow departure');
export const matchSchema = z.object({ ...versionFields, carrier_id: uuid.optional() }).strict();
export const carrierScheduleSchema = z
    .object({
    ...commandFields,
    origin: corridor,
    destination: corridor,
    service_levels: z.array(serviceLevel).min(1),
    package_sizes: z.array(packageSize).min(1),
    departure_at: z.iso.datetime({ offset: true }),
    arrival_at: z.iso.datetime({ offset: true }),
    capacity_kg: weight,
    active: z.boolean(),
})
    .strict()
    .refine((x) => x.origin !== x.destination, 'Origin and destination must differ')
    .refine((x) => Date.parse(x.arrival_at) > Date.parse(x.departure_at), 'Arrival must follow departure');
export const transitionSchema = z
    .object({
    ...versionFields,
    status: z.enum(statuses),
    note: z.string().trim().min(1).max(2000).optional(),
})
    .strict();
export const walletSchema = z
    .object({
    ...versionFields,
    amount_minor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    currency: z.enum(['NGN', 'USD', 'GBP', 'EUR', 'CAD']),
})
    .strict();
async function lockedShipment(sql, id, expected) {
    const s = (await sql.query('SELECT * FROM lex.shipments WHERE id=$1 FOR UPDATE', [id]))
        .rows[0];
    if (!s)
        throw new AppError(404, 'not_found', 'Shipment not found');
    if (s.version !== expected)
        throw new AppError(409, 'stale_version', 'Shipment changed; refresh before issuing a new command');
    return s;
}
async function history(sql, s, from, actor, commandId, note, details = {}) {
    await sql.query('INSERT INTO lex.shipment_history(id,shipment_id,version,from_status,to_status,actor_id,actor_role,command_id,note,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [
        randomUUID(),
        s.id,
        s.version,
        from,
        s.status,
        actor.id,
        actor.role,
        commandId,
        note || null,
        JSON.stringify(details),
    ]);
    await audit(sql, actor, 'shipment.' + s.status, s.id, commandId, details);
}
export function shipmentService(db) {
    return {
        async create(actor, input) {
            requireRole(actor, 'admin', 'operator', 'merchant');
            const owner = input.owner_user_id || actor.id;
            if (actor.role === 'merchant' && owner !== actor.id)
                throw new AppError(403, 'forbidden', 'Cannot create a shipment for another user');
            return command(db, actor, input.command_id, 'shipment.create', input, async (sql) => {
                if (Date.parse(input.pickup_deadline) <= Date.now())
                    throw new AppError(422, 'invalid_deadline', 'Pickup deadline must be in the future');
                const id = randomUUID();
                const s = (await sql.query('INSERT INTO lex.shipments(id,tracking_id,owner_user_id,origin,destination,weight_kg,package_size,service_level,pickup_deadline,delivery_deadline) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *', [
                    id,
                    'LEX-' + id.toUpperCase(),
                    owner,
                    input.origin,
                    input.destination,
                    input.weight_kg,
                    input.package_size,
                    input.service_level,
                    input.pickup_deadline,
                    input.delivery_deadline,
                ])).rows[0];
                await history(sql, s, null, actor, input.command_id);
                await emit(sql, 'ShipmentCreated', s, input.command_id, {
                    shipment_id: s.id,
                    tracking_id: s.tracking_id,
                    status: s.status,
                    version: s.version,
                });
                return s;
            });
        },
        async createCarrier(actor, input) {
            requireRole(actor, 'admin', 'operator');
            return command(db, actor, input.command_id, 'carrier.create', input, async (sql) => {
                const result = (await sql.query('INSERT INTO lex.carriers(id,user_id,name,origin,destination,service_levels,package_sizes,departure_at,arrival_at,capacity_kg) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *', [
                    randomUUID(),
                    input.user_id,
                    input.name,
                    input.origin,
                    input.destination,
                    input.service_levels,
                    input.package_sizes,
                    input.departure_at,
                    input.arrival_at,
                    input.capacity_kg,
                ])).rows[0];
                await audit(sql, actor, 'carrier.created', String(result.id), input.command_id);
                return result;
            });
        },
        async scheduleCarrier(actor, id, input) {
            requireRole(actor, 'admin', 'operator');
            return command(db, actor, input.command_id, 'carrier.schedule', { id, ...input }, async (sql) => {
                const c = (await sql.query('SELECT reserved_kg FROM lex.carriers WHERE id=$1 FOR UPDATE', [id])).rows[0];
                if (!c)
                    throw new AppError(404, 'not_found', 'Carrier not found');
                if (Number(c.reserved_kg) > 0)
                    throw new AppError(409, 'active_reservations', 'Complete or cancel reserved shipments before replacing the carrier schedule');
                const result = (await sql.query('UPDATE lex.carriers SET origin=$2,destination=$3,service_levels=$4,package_sizes=$5,departure_at=$6,arrival_at=$7,capacity_kg=$8,active=$9 WHERE id=$1 RETURNING *', [
                    id,
                    input.origin,
                    input.destination,
                    input.service_levels,
                    input.package_sizes,
                    input.departure_at,
                    input.arrival_at,
                    input.capacity_kg,
                    input.active,
                ])).rows[0];
                await audit(sql, actor, 'carrier.schedule', id, input.command_id);
                return result;
            });
        },
        async match(actor, id, input) {
            requireRole(actor, 'admin', 'operator');
            return command(db, actor, input.command_id, 'shipment.match', { id, ...input }, async (sql) => {
                const s = await lockedShipment(sql, id, input.expected_version);
                if (s.status !== 'created')
                    throw new AppError(409, 'invalid_transition', 'Only created shipments can be matched');
                const carrier = (await sql.query('SELECT id FROM lex.carriers WHERE active AND origin=$1 AND destination=$2 AND $3=ANY(service_levels) AND $4=ANY(package_sizes) AND capacity_kg-reserved_kg >= $5 AND departure_at >= now() AND departure_at <= $6 AND arrival_at <= $7 AND ($8::uuid IS NULL OR id=$8) ORDER BY capacity_kg-reserved_kg,id LIMIT 1 FOR UPDATE SKIP LOCKED', [
                    s.origin,
                    s.destination,
                    s.service_level,
                    s.package_size,
                    s.weight_kg,
                    s.pickup_deadline,
                    s.delivery_deadline,
                    input.carrier_id || null,
                ])).rows[0];
                if (!carrier)
                    throw new AppError(409, 'no_eligible_carrier', 'No available carrier meets route, package, service, timing and capacity requirements');
                await sql.query('UPDATE lex.carriers SET reserved_kg=reserved_kg+$2 WHERE id=$1', [
                    carrier.id,
                    s.weight_kg,
                ]);
                const next = (await sql.query("UPDATE lex.shipments SET status='matched',assigned_carrier_id=$2,capacity_reserved=true,version=version+1,updated_at=now() WHERE id=$1 RETURNING *", [id, carrier.id])).rows[0];
                const reason = {
                    rule_version: 'exact-corridor-v1',
                    carrier_id: carrier.id,
                    origin: s.origin,
                    destination: s.destination,
                    weight_kg: s.weight_kg,
                    package_size: s.package_size,
                    service_level: s.service_level,
                    pickup_deadline: s.pickup_deadline,
                    delivery_deadline: s.delivery_deadline,
                };
                await history(sql, next, s.status, actor, input.command_id, undefined, reason);
                await emit(sql, 'ShipmentMatched', next, input.command_id, {
                    shipment_id: id,
                    carrier_id: carrier.id,
                    status: next.status,
                    version: next.version,
                });
                return next;
            });
        },
        async transition(actor, id, input) {
            return command(db, actor, input.command_id, 'shipment.transition', { id, ...input }, async (sql) => {
                const s = await lockedShipment(sql, id, input.expected_version);
                const nextStatus = input.status;
                if (actor.role === 'merchant') {
                    if (s.owner_user_id !== actor.id ||
                        nextStatus !== 'cancelled' ||
                        !['created', 'matched'].includes(s.status))
                        throw new AppError(403, 'forbidden', 'Merchants may cancel only their own uncollected shipments');
                }
                else if (actor.role === 'carrier') {
                    const own = (await sql.query('SELECT id FROM lex.carriers WHERE id=$1 AND user_id=$2', [
                        s.assigned_carrier_id,
                        actor.id,
                    ])).rows[0];
                    if (!own ||
                        ![
                            'picked_up',
                            'in_transit',
                            'at_node',
                            'out_for_delivery',
                            'delivered',
                            'exception',
                            'returned',
                        ].includes(nextStatus) ||
                        ['delivered', 'exception'].includes(s.status))
                        throw new AppError(403, 'forbidden', 'Carrier cannot perform this transition');
                }
                else
                    requireRole(actor, 'admin', 'operator');
                if (!transitions[s.status].includes(nextStatus))
                    throw new AppError(409, 'invalid_transition', `Cannot transition ${s.status} to ${nextStatus}`);
                if (s.status === 'exception') {
                    const prior = (await sql.query("SELECT from_status FROM lex.shipment_history WHERE shipment_id=$1 AND to_status='exception' ORDER BY version DESC LIMIT 1", [id])).rows[0];
                    if (!prior ||
                        ![prior.from_status, 'return_in_transit', 'cancelled'].includes(nextStatus))
                        throw new AppError(409, 'invalid_recovery', 'Recover to the pre-exception state, start a return, or cancel with an audited reason');
                }
                if (['exception', 'return_in_transit'].includes(nextStatus) || s.status === 'exception') {
                    if (!input.note)
                        throw new AppError(422, 'note_required', 'Exception, recovery and return actions require a reason');
                }
                // A delivered return is an explicit operator action reserving the original carrier again.
                let reserved = s.capacity_reserved;
                if (s.status === 'delivered' && nextStatus === 'return_in_transit') {
                    requireRole(actor, 'admin', 'operator');
                    const c = await sql.query('UPDATE lex.carriers SET reserved_kg=reserved_kg+$2 WHERE id=$1 AND active AND capacity_kg-reserved_kg >= $2 RETURNING id', [s.assigned_carrier_id, s.weight_kg]);
                    if (!c.rowCount)
                        throw new AppError(409, 'return_capacity_unavailable', 'Original carrier has insufficient return capacity');
                    reserved = true;
                }
                if (['delivered', 'cancelled', 'returned'].includes(nextStatus) && reserved) {
                    await sql.query('UPDATE lex.carriers SET reserved_kg=reserved_kg-$2,total_deliveries=total_deliveries+$3 WHERE id=$1', [s.assigned_carrier_id, s.weight_kg, nextStatus === 'delivered' ? 1 : 0]);
                    reserved = false;
                }
                const next = (await sql.query('UPDATE lex.shipments SET status=$2,capacity_reserved=$3,version=version+1,updated_at=now() WHERE id=$1 RETURNING *', [id, nextStatus, reserved])).rows[0];
                await history(sql, next, s.status, actor, input.command_id, input.note);
                await emit(sql, nextStatus === 'delivered' ? 'ShipmentDelivered' : 'ShipmentStatusChanged', next, input.command_id, {
                    shipment_id: id,
                    tracking_id: s.tracking_id,
                    carrier_id: s.assigned_carrier_id,
                    previous_status: s.status,
                    status: nextStatus,
                    version: next.version,
                });
                return next;
            });
        },
        async approveWallet(actor, id, input) {
            requireRole(actor, 'admin');
            return command(db, actor, input.command_id, 'wallet.approve', { id, ...input }, async (sql) => {
                const s = await lockedShipment(sql, id, input.expected_version);
                if (s.status !== 'delivered' || !s.assigned_carrier_id)
                    throw new AppError(409, 'delivery_required', 'Wallet approval requires a delivered shipment and assigned carrier');
                const existing = (await sql.query('SELECT * FROM lex.wallet_approvals WHERE shipment_id=$1', [id])).rows[0];
                if (existing) {
                    if (Number(existing.amount_minor) !== input.amount_minor ||
                        existing.currency !== input.currency)
                        throw new AppError(409, 'approval_conflict', 'Shipment already approved with different amount or currency');
                    return existing;
                }
                const approvalId = randomUUID();
                const approval = (await sql.query('INSERT INTO lex.wallet_approvals(id,shipment_id,carrier_id,amount_minor,currency,command_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING *', [
                    approvalId,
                    id,
                    s.assigned_carrier_id,
                    input.amount_minor,
                    input.currency,
                    input.command_id,
                ])).rows[0];
                await emit(sql, 'WalletApprovalCreated', s, input.command_id, {
                    wallet_event_id: approvalId,
                    shipment_id: id,
                    carrier_id: s.assigned_carrier_id,
                    amount_minor: input.amount_minor,
                    currency: input.currency,
                    operation_key: 'delivery-approval:' + id,
                });
                await audit(sql, actor, 'wallet.approved', approvalId, input.command_id, {
                    shipment_id: id,
                });
                return approval;
            });
        },
        async get(actor, id) {
            const s = (await db.query(`SELECT s.* FROM lex.shipments s WHERE id=$1 AND ($2 IN ('admin','operator') OR ($2='merchant' AND owner_user_id=$3) OR ($2='carrier' AND EXISTS(SELECT 1 FROM lex.carriers c WHERE c.id=s.assigned_carrier_id AND c.user_id=$3)))`, [id, actor.role, actor.id])).rows[0];
            if (!s)
                throw new AppError(404, 'not_found', 'Shipment not found');
            const events = await db.query('SELECT version,from_status,to_status,note,created_at FROM lex.shipment_history WHERE shipment_id=$1 ORDER BY version', [id]);
            return { shipment: s, history: events.rows };
        },
        async list(actor, after, limit) {
            return (await db.query(`SELECT s.* FROM lex.shipments s WHERE ($1 IN ('admin','operator') OR ($1='merchant' AND owner_user_id=$2) OR ($1='carrier' AND EXISTS(SELECT 1 FROM lex.carriers c WHERE c.id=s.assigned_carrier_id AND c.user_id=$2))) AND ($3::uuid IS NULL OR s.id>$3) ORDER BY s.id LIMIT $4`, [actor.role, actor.id, after || null, limit])).rows;
        },
    };
}
//# sourceMappingURL=shipments.js.map