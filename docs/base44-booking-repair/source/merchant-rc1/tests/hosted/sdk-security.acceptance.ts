// Run from the actual non-admin test-user SDK in the disposable project.
// Fixture IDs come from the admin-only hosted handler acceptance function.
export async function verifyOwnerSdk(
  owner: any,
  fixture: any,
  other?: any,
  admin?: any,
) {
  const check = (ok: boolean, label: string) => {
    if (!ok) throw new Error(label);
  };
  const r = await owner.functions.invoke("merchantShipmentRead", {
    action: "get",
    shipment_id: fixture.shipment_id,
  });
  const before = r.data.shipment;
  check(!!before, "owner_read_handler_failed");
  const attemptsFor = (actor: any) => [
    () =>
      actor.entities.Shipment.update(fixture.shipment_id, {
        command_id: "browser-primed",
        booking_command_claim: null,
        server_record_proof: "forged",
        test_harness: true,
      }),
    () =>
      actor.entities.Shipment.updateMany(
        { id: fixture.shipment_id },
        { $set: { cancel_command_id: "primed", booking_command_claim: {} } },
      ),
    () => actor.entities.Shipment.delete(fixture.shipment_id),
    () =>
      actor.entities.ShipmentDraft.update(fixture.draft_id, {
        status: "draft",
        shipment_id: null,
        booking_claim: null,
      }),
    () => actor.entities.ShipmentDraft.delete(fixture.draft_id),
    () =>
      actor.entities.ShipmentQuote.update(fixture.quote_id, {
        status: "open",
        reservation_intent: null,
      }),
    () => actor.entities.ShipmentQuote.delete(fixture.quote_id),
  ];
  for (const actor of [owner, admin].filter(Boolean)) {
    for (const [entity, data] of [
      [
        "Shipment",
        {
          origin_address: "SYNTHETIC SDK PROBE",
          destination_address: "SYNTHETIC SDK PROBE",
        },
      ],
      [
        "ShipmentDraft",
        { user_id: before.server_owner_user_id, status: "draft" },
      ],
      [
        "ShipmentQuote",
        {
          user_id: before.server_owner_user_id,
          amount: 0,
          rate_version: "security-probe",
          expires_at: new Date(Date.now() + 60000).toISOString(),
        },
      ],
    ] as any[]) {
      let created: any = null;
      try {
        created = await actor.entities[entity].create(data);
      } catch {}
      check(
        !created?.id && !created?.data?.id,
        "direct_sdk_create_allowed_" + entity,
      );
    }
    for (const attempt of attemptsFor(actor)) {
      try {
        await attempt();
      } catch {
        /* invariants below are decisive */
      }
    }
  }
  const after = (
    await owner.functions.invoke("merchantShipmentRead", {
      action: "get",
      shipment_id: fixture.shipment_id,
    })
  ).data.shipment;
  for (const k of [
    "command_id",
    "booking_command_claim",
    "cancel_command_id",
    "server_record_proof",
    "test_harness",
    "order_id",
  ])
    check(
      JSON.stringify(after[k]) === JSON.stringify(before[k]),
      "sdk_tampering_changed_" + k,
    );
  check(after.id === before.id, "sdk_delete_removed_shipment");
  const draft = (
    await owner.functions.invoke("merchantDraft", {
      action: "load",
      draft_id: fixture.draft_id,
    })
  ).data.draft;
  check(
    draft.booking_state === "complete" &&
      draft.shipment_id === fixture.shipment_id,
    "sdk_reopened_or_deleted_draft",
  );
  const quote = await owner.entities.ShipmentQuote.get(fixture.quote_id);
  check(
    quote.status === "consumed" &&
      quote.consumed_by_shipment_id === fixture.shipment_id,
    "sdk_reopened_or_deleted_quote",
  );
  if (other) {
    try {
      const x = await other.functions.invoke("merchantShipmentRead", {
        action: "get",
        shipment_id: fixture.shipment_id,
      });
      check(!x.data?.shipment, "cross_account_read_allowed");
    } catch (e) {
      if (e?.message === "cross_account_read_allowed") throw e;
    }
  }
  return {
    passed: true,
    sdk_attempts: (admin ? 2 : 1) * 10,
    records_preserved: true,
  };
}
