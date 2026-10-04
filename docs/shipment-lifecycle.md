# Shipment lifecycle

Existing values remain authoritative. The proposed vocabulary is not a license to rename production states.

| Current state        | Allowed next states                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------- |
| created              | matched via matching command; cancelled via transition                                       |
| matched              | picked_up, cancelled, exception                                                              |
| picked_up            | in_transit, at_node, exception, return_in_transit                                            |
| in_transit           | at_node, out_for_delivery, exception, return_in_transit                                      |
| at_node              | in_transit, out_for_delivery, exception, return_in_transit                                   |
| out_for_delivery     | delivered, exception, return_in_transit                                                      |
| delivered            | return_in_transit                                                                            |
| exception            | Previous pre-exception state, return_in_transit, or cancelled, constrained by service checks |
| return_in_transit    | returned, exception                                                                          |
| cancelled / returned | Terminal                                                                                     |

All mutations use a stable command_id; shipment changes require expected_version and increment version. Duplicate successful commands return the original result even after later changes. A different command with stale expected_version fails with 409. Invalid state transitions fail; statuses are never freely writable.

Merchant can cancel their own created/matched shipment. Assigned carriers perform permitted operational transitions; operator/admin control recovery and post-delivery returns. Exception/recovery/return actions require reasons. Matching reserves capacity under locks; delivered/cancelled/returned release once. Post-delivery returns must reserve capacity again.

Concept mapping: assigned = current matched (responsibility reserved, not accepted); arrived_at_pudo may correspond to at_node but location/custody proof is absent; delivery_failed may be an exception but cannot be inferred. confirmed, ready_for_pickup, carrier_accepted and carrier_arrived have no current equivalents. Introduce separate models and contracts before emitting those states.
