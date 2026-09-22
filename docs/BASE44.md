# Connect the existing Base44 dashboard

Keep the present app intact until the new API is deployed and its staging workflow passes. The provided adapter is server-side; it is not a frontend replacement.

## Install the adapter

Create a Base44 backend function named `lexApi` using `integrations/base44-lex-api.entry.ts`. The adapter follows the SDK import/runtime conventions in your exported app. It must be tested in your actual Base44 workspace before publication.

Set these Base44 server secrets:

- `LEX_API_URL`: the HTTPS URL of the Render API.
- `LEX_API_CLIENT_ID`: `base44`.
- `LEX_API_CLIENT_SECRET`: the matching secret in Render's API_CLIENTS_JSON.
- `LEX_USER_ROLES_JSON`: optional JSON map of verified Base44 user IDs to `operator` or `carrier`. Ordinary users default to `merchant`; Base44 admins remain `admin`.

Example role map (replace IDs with verified users):

```json
{ "verified-carrier-user-id": "carrier", "verified-operator-user-id": "operator" }
```

The frontend must never provide the trusted role. Do not allow a user's editable profile fields to grant privileges.

## Create a shipment from the frontend

```js
const commandId = crypto.randomUUID(); // Keep this ID if retrying this operation.
const result = await base44.functions.invoke('lexApi', {
  action: 'createShipment',
  payload: {
    command_id: commandId,
    origin: 'Lagos',
    destination: 'Abuja',
    weight_kg: 2,
    package_size: 'small',
    service_level: 'standard',
    pickup_deadline: pickupDate.toISOString(),
    delivery_deadline: deliveryDate.toISOString(),
  },
});
const shipment = result.data;
```

Use dates supplied by your form. Preserve commandId while a request is unresolved; generating a new ID after a timeout defeats duplicate protection.

## Match or update an existing shipment

```js
await base44.functions.invoke('lexApi', {
  action: 'matchShipment',
  id: shipment.id,
  payload: {
    command_id: crypto.randomUUID(),
    expected_version: shipment.version,
  },
});
```

After a success, update the UI with the returned shipment and its new version. On a stale_version response, reload shipment data and ask the operator to review the changed state. Do not silently retry a new business action against an unseen version.

Other adapter actions: listShipments, getShipment, transitionShipment, approveWallet, createCarrier, listCarriers, scheduleCarrier, health, listDeliveries, replayDelivery. See API.md for payloads. Destination administration is intentionally handled through the secured API, not this user adapter.

## Changes needed in the existing interface

1. Replace shipment creation and mutations with lexApi calls.
2. Read migrated shipments and histories from lexApi.
3. Use real health/errors, loading and empty states separately.
4. Remove old direct Shipment updates and old wallet/delivery automation for migrated records.
5. Preserve the old intelligence features only where their reads and writes remain compatible.

The Node API is not a drop-in replacement for `lexAnalytics`, the Base44 entity SDK, or every legacy function. Update each caller deliberately. Do not activate both writers for the same shipment. No production dashboard has been changed by this package.
