// Operator-run only in a disposable Base44 development project, never production.
// Pass its service-role CASProbe entity. No application flags or shipments touched.
export async function verifyBase44Storage(
  entity: any,
  target: "disposable-development",
) {
  if (target !== "disposable-development")
    throw new Error("disposable target required");
  const made: string[] = [];
  const check = (ok: boolean, label: string) => {
    if (!ok) throw new Error(label);
  };
  try {
    const row = await entity.create({
      label: crypto.randomUUID(),
      state: "open",
    });
    made.push(row.id);
    const stale = await entity.updateMany(
      { id: row.id, state: "wrong" },
      { $set: { state: "bad" } },
    );
    check(stale.updated === 0, "wrong expected state must return updated:0");
    const observed = await entity.get(row.id);
    const ownerExpected = Object.hasOwn(observed, "owner") ? observed.owner : { $exists: false };
    const race = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        entity.updateMany(
          { id: row.id, state: "open", owner: ownerExpected },
          { $set: { state: "owned", owner: String(i) } },
        ),
      ),
    );
    check(
      race.filter((r: any) => r.updated === 1).length === 1,
      "exactly one CAS winner",
    );
    check(
      race.filter((r: any) => r.updated === 0).length === 39,
      "all other CAS attempts updated:0",
    );
    const persisted = await entity.get(row.id);
    check(
      persisted.state === "owned" && typeof persisted.owner === "string",
      "winning identity persisted",
    );
    const second = await entity.updateMany(
      { id: row.id, state: "open" },
      { $set: { state: "bad" } },
    );
    check(second.updated === 0, "stale CAS cannot change ownership");
    const firstInsert = await entity.create({
      label: "same-intent",
      state: "open",
    });
    made.push(firstInsert.id);
    const secondInsert = await entity.create({
      label: "same-intent",
      state: "open",
    });
    made.push(secondInsert.id);
    check(
      firstInsert.id !== secondInsert.id,
      "inserts are not unique: protocol must claim existing shared row",
    );
    return {
      passed: true,
      cas_winners: 1,
      cas_losers: 39,
      duplicate_insert_possible: true,
    };
  } finally {
    // Only disposable CASProbe fixtures, never canonical/domain/application rows.
    for (const id of made) await entity.delete(id);
  }
}
