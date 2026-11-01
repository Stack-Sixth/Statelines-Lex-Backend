import * as exceptions from "../candidate/base44/shared/bookingException.ts";
import * as artifacts from "../candidate/base44/shared/artifactProjection.ts";
import * as custody from "../candidate/base44/shared/custodyRecovery.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import * as records from "../candidate/base44/shared/serverRecord.ts";
import * as containment from "../candidate/base44/shared/testContainment.ts";
import * as customer from "../candidate/base44/shared/customerShipment.ts";
import * as claims from "../candidate/base44/shared/casBooking.ts";
import * as rules from "../candidate/base44/shared/authorityRules.ts";
import * as reads from "../candidate/base44/shared/canonicalRead.ts";
const root = new URL("../candidate/base44/", import.meta.url);
function load(path: string, bindings: any, names: string[] = ["handler"]) {
  let source = readFileSync(new URL(path, root), "utf8").replace(
    /^import\s[\s\S]*?;\s*$/gm,
    "",
  );
  source = source.replace(
    "export default async function",
    "const handler = async function",
  );
  const js = stripTypeScriptTypes(source, { mode: "transform" }).replace(
    /^export /gm,
    "",
  );
  const loaded = new Function(
    ...Object.keys(bindings),
    js + `\nreturn {${names.join(",")}}`,
  )(...Object.values(bindings));
  if (loaded.handler && bindings.fixtureReady) {
    const fn = loaded.handler;
    loaded.handler = async (req: any) => {
      await bindings.fixtureReady();
      return fn(req);
    };
  }
  return loaded;
}
const ids = load(
  "shared/domainIds.ts",
  { secrets: { get: () => "" }, ...reads },
  [
    "generateCommandId",
    "generateCorrelationId",
    "normalizeWeight",
    "mapToRenderShipment",
    "extractCanonicalFromCreate",
    "reconcileCanonicalShipment",
  ],
);
const legacy = load("shared/legacyReview.ts", ids, ["legacyReview"]);
const testKey = "UNIT-ONLY-RECORD-PROVENANCE-SECRET-0000000000";
const proofs = records.recordAuthority(testKey);
class Store {
  rows = new Map<string, any>();
  creates = 0;
  transitions: any[] = [];
  before: (op: string, data: any) => Promise<void> = async () => {};
  after: (op: string, data: any) => Promise<void> = async () => {};
  constructor(rows: any[] = []) {
    for (const r of rows) this.rows.set(r.id, structuredClone(r));
  }
  async get(id: string) {
    await this.before("get", id);
    const r = this.rows.get(id);
    if (!r) throw Object.assign(new Error("missing"), { status: 404 });
    return structuredClone(r);
  }
  async update(id: string, changes: any) {
    Object.assign(this.rows.get(id), structuredClone(changes));
    return this.get(id);
  }
  async updateMany(query: any, change: any) {
    assert.equal(typeof query.id, "string");
    await this.before("cas", { query, change });
    const r = this.rows.get(query.id);
    const matches =
      r &&
      Object.entries(query).every(([k, v]: any) => {
        if (v && typeof v === "object") {
          if ("$exists" in v) return Object.hasOwn(r, k) === v.$exists;
          if ("$gt" in v) return r[k] > v.$gt;
        }
        return claims.equal(r[k], v);
      });
    if (!matches) return { updated: 0 };
    // No await between condition check and write: models verified one-id CAS.
    Object.assign(r, structuredClone(change.$set));
    this.transitions.push({ query, change });
    await this.after("cas", { query, change });
    return { updated: 1 };
  }
  async create(data: any) {
    await this.before("create", data);
    const r = { ...structuredClone(data), id: "local-" + ++this.creates };
    this.rows.set(r.id, r);
    await this.after("create", r);
    return structuredClone(r);
  }
  async filter(query: any, _sort: any, limit: number) {
    await this.before("filter", query);
    return [...this.rows.values()]
      .filter((r) => Object.entries(query).every(([k, v]) => r[k] === v))
      .slice(0, limit)
      .map((r) => structuredClone(r));
  }
}
const user = { id: "user-1" },
  merchant = { id: "merchant-1", company_name: "Test" };
const identity = {
  domain_merchant_id: "MER_TEST",
  client_id: "client-1",
  signing_subject: "client-1",
};
const credential = {
  client_id: "client-1",
  client_secret: "TEST-ONLY-NOT-A-REAL-SECRET",
};
const authority = {
  ready: true,
  identity,
  merchant_id: merchant.id,
  local: { ok: true, credentials: credential },
  verification: { status: "verified" },
  booking_release: { open: true },
};
function request(body: any) {
  return new Request("https://unit.invalid", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
function env() {
  const Ship = new Store(),
    Draft = new Store([
      { id: "d1", status: "draft" },
      { id: "d2", status: "draft" },
    ]);
  const Quote = new Store([
    {
      id: "q1",
      user_id: user.id,
      merchant_id: merchant.id,
      status: "open",
      weight_lb: 1,
      declared_value: 0,
      service_level: "standard",
      insurance: false,
      expires_at: "2099-01-01T00:00:00Z",
      rate_version: "v1",
      amount: 10,
    },
  ]);
  const entities = {
    Shipment: Ship,
    ShipmentDraft: Draft,
    ShipmentQuote: Quote,
  };
  let cards = 0;
  const client = {
    auth: { me: async () => user },
    entities,
    asServiceRole: { entities },
  };
  const ready = Promise.all(
    [...Draft.rows.values()].map(async (r: any) =>
      Object.assign(
        r,
        await proofs.mint("ShipmentDraft", user.id, merchant.id),
        { data: booking().shipment, edit_revision: 0 },
      ),
    ),
  );
  const bindings = {
    ...records,
    ...customer,
    ...legacy,
    screenBooking:async()=>({status:'permitted',policy_version:'UNIT',accepted_by:user.id,declaration:{item_category:'clothing',contents_description:'Synthetic fixture'}}),
    settleBookingDeclaration:async()=>{},settleBookingNotification:async()=>{},
    fixtureReady: () => ready,
    ...claims,
    ...rules,
    ...ids,
    createClientFromRequest: () => client,
    secrets: {
      get: (n: string) =>
        n === "BOOKING_RELEASE_ENABLED"
          ? "true"
          : n === "MERCHANT_RECORD_SIGNING_SECRET"
            ? testKey
            : "UNIT-ONLY",
    },
    resolveCallerMerchant: async () => merchant,
    findExceptionByMerchant: () => null,
    resolveSavedCard: async () => {
      cards++;
      return {
        paymentMethod: {
          id: "pm_unit",
          card: { brand: "test", last4: "0000" },
        },
      };
    },
    RATE_VERSION: "v1",
    round2: (v: number) => Math.round(v * 100) / 100,
    settlePrice: () => ({
      total: 10,
      service_level: "standard",
      eta_days: 2,
      currency: "USD",
      rate_version: "v1",
      pricing_authority: "unit",
    }),
    loadVerifiedAuthority: async () => authority,
    provisioningSyncMessage: () => "",
    isReachable: () => true,
    evaluateForAuthority: () => ({ open: false }),
    exceptionContext: () => ({}),
    resolvePaymentConfiguration: () => ({ enabled: false }),
    callRender: async (_o: any) => ({ ok: false, status: 503 }),
  };
  return {
    Ship,
    Draft,
    Quote,
    entities,
    bindings,
    client,
    ready,
    get cards() {
      return cards;
    },
  };
}
const booking = (draft = "d1", quote = "q1") => ({
  draft_id: draft,
  shipment: {
    origin_address: "Synthetic O",
    destination_address: "Synthetic D",
    origin_city: "A",
    destination_city: "B",
    weight_lb: 1,
    declared_value: 0,
    service_level: "standard",
    insurance: false,
  },
  quote: { quote_id: quote, accepted_total: 10 },
});
const makeFinalize = (e: any) =>
  load("functions/finalizeShipment/entry.ts", e.bindings).handler;
function canonicalEnv() {
  const e = env();
  e.Ship.rows.set("s1", {
    id: "s1",
    compliance_evidence:{status:"permitted"},
    created_by_id: user.id,
    merchant_id: merchant.id,
    status: "created",
    order_id: "order-1",
    weight_lb: 1,
    origin_city: "A",
    destination_city: "B",
    service_level: "standard",
    package_size: "small",
    pickup_deadline: "2098-01-01T00:00:00Z",
    delivery_deadline: "2098-01-02T00:00:00Z",
  });
  const remote: any = {
    shipment_id: "SHP_TEST",
    tracking_id: "LEX-TEST",
    id: "internal-unit",
    merchant_id: "MER_TEST",
    order_id: "order-1",
    status: "created",
    version: 1,
  };
  let posts: any[] = [],
    exists = false;
  e.bindings.callRender = async (o: any) => {
    assert.deepEqual(o.credential, credential);
    if (o.method === "POST") {
      posts.push(structuredClone(o));
      exists = true;
      if (o.path.endsWith("/cancel")) {
        remote.status = "cancelled";
        remote.version++;
      }
      return {
        ok: true,
        status: 201,
        data: { shipment: structuredClone(remote) },
      };
    }
    if (o.path.includes("?"))
      return {
        ok: true,
        status: 200,
        data: {
          items: exists ? [structuredClone(remote)] : [],
          next_cursor: null,
        },
      };
    if (o.path === "/api/v1/merchant-context")
      return {
        ok: true,
        status: 200,
        data: {
          merchant_id: "MER_TEST",
          client_id: "client-1",
          subject: "client-1",
          sandbox_isolated: true,
        },
      };
    return {
      ok: true,
      status: 200,
      data: { shipment: structuredClone(remote) },
    };
  };
  const ready = e.ready.then(async () =>
    Object.assign(
      e.Ship.rows.get("s1"),
      await proofs.mint("Shipment", user.id, merchant.id),
    ),
  );
  e.bindings.fixtureReady = () => ready;
  return {
    ...e,
    ready,
    remote,
    posts,
    setExists: () => {
      exists = true;
    },
  };
}
test("50 concurrent actual finalizations insert once, reserve/consume once", async () => {
  const e = env(),
    fn = makeFinalize(e);
  const rs = await Promise.all(
    Array.from({ length: 50 }, () => fn(request(booking()))),
  );
  assert.ok(rs.some((r) => r.status === 200));
  assert.equal(e.Ship.creates, 1);
  assert.equal(
    e.Quote.transitions.filter((t) => t.change.$set.status === "reserved")
      .length,
    1,
  );
  assert.equal(
    e.Quote.transitions.filter((t) => t.change.$set.status === "consumed")
      .length,
    1,
  );
  assert.equal((await e.Draft.get("d1")).booking_state, "complete");
  assert.equal((await e.Ship.get("local-1")).booking_ready, true);
});
test("same quote across two existing drafts creates at most one row", async () => {
  const e = env(),
    fn = makeFinalize(e);
  await Promise.all([fn(request(booking("d1"))), fn(request(booking("d2")))]);
  assert.equal(e.Ship.creates, 1);
  assert.equal((await e.Quote.get("q1")).status, "consumed");
});
test("same draft with different quotes cannot become two intents", async () => {
  const e = env();
  e.Quote.rows.set("q2", { ...(await e.Quote.get("q1")), id: "q2" });
  const fn = makeFinalize(e);
  await Promise.all([
    fn(request(booking("d1", "q1"))),
    fn(request(booking("d1", "q2"))),
  ]);
  assert.equal(e.Ship.creates, 1);
});
test("lost insert acknowledgement recovers the original row and consumes once", async () => {
  const e = env();
  let once = true;
  e.Ship.after = async (op) => {
    if (op === "create" && once) {
      once = false;
      throw new Error("lost insert response");
    }
  };
  const fn = makeFinalize(e);
  assert.equal((await fn(request(booking()))).status, 202);
  assert.equal((await fn(request(booking()))).status, 200);
  assert.equal(e.Ship.creates, 1);
});
test("crash before insert leaves pending; retries never insert on absence", async () => {
  const e = env();
  e.Draft.after = async (_op, x) => {
    if (x.change.$set.booking_state === "creating") throw new Error("crash");
  };
  const fn = makeFinalize(e);
  await fn(request(booking()));
  e.Draft.after = async () => {};
  for (let i = 0; i < 3; i++)
    assert.equal((await fn(request(booking()))).status, 202);
  assert.equal(e.Ship.creates, 0);
});
test("crash after quote consumption completes without another insert/provider preflight", async () => {
  const e = env();
  let once = true;
  e.Quote.after = async (_op, x) => {
    if (x.change.$set.status === "consumed" && once) {
      once = false;
      throw new Error("crash");
    }
  };
  const fn = makeFinalize(e);
  await fn(request(booking()));
  const before = e.cards;
  assert.equal((await fn(request(booking()))).status, 200);
  assert.equal(e.Ship.creates, 1);
  assert.equal(e.cards, before);
});
test("synthetic saved-card finalize blocked before provider or store changes", async () => {
  const e = env();
  e.bindings.findExceptionByMerchant = () => ({
    local_merchant_id: merchant.id,
  });
  assert.equal((await makeFinalize(e)(request(booking()))).status, 403);
  assert.equal(e.cards, 0);
  assert.equal(e.Ship.creates, 0);
});
test("25 concurrent canonical-create handlers send exactly one claimed command", async () => {
  const e = canonicalEnv(),
    fn = load("functions/createOrderOnRender/entry.ts", e.bindings).handler;
  const rs = await Promise.all(
    Array.from({ length: 25 }, () => fn(request({ shipment_id: "s1" }))),
  );
  assert.equal(e.posts.length, 1);
  assert.ok(rs.some((r) => r.status === 200));
  const row = await e.Ship.get("s1");
  assert.equal(
    row.booking_command_claim.payload.command_id,
    e.posts[0].body.command_id,
  );
});
test("create timeout retries identical frozen payload with CAS and dedicated reads", async () => {
  const e = canonicalEnv(),
    original = e.bindings.callRender;
  let lost = true;
  e.bindings.callRender = async (o: any) => {
    if (o.method === "POST" && lost) {
      lost = false;
      e.posts.push(structuredClone(o));
      return { ok: false, status: 0, code: "timeout" };
    }
    return original(o);
  };
  const fn = load("functions/createOrderOnRender/entry.ts", e.bindings).handler;
  assert.equal((await fn(request({ shipment_id: "s1" }))).status, 202);
  await e.Ship.update("s1", { weight_lb: 10, pickup_deadline: "2097-01-01" });
  const rs = await Promise.all([
    fn(request({ shipment_id: "s1" })),
    fn(request({ shipment_id: "s1" })),
  ]);
  assert.ok(rs.some((r) => r.status === 200));
  assert.equal(e.posts.length, 2);
  assert.deepEqual(e.posts[0].body, e.posts[1].body);
});
test("CAS commit acknowledgement lost cannot send or steal sending claim", async () => {
  const e = canonicalEnv();
  let once = true;
  e.Ship.after = async (_op, x) => {
    if (x.change.$set.booking_command_claim && once) {
      once = false;
      throw new Error("lost CAS ack");
    }
  };
  const fn = load("functions/createOrderOnRender/entry.ts", e.bindings).handler;
  await fn(request({ shipment_id: "s1" }));
  assert.equal((await fn(request({ shipment_id: "s1" }))).status, 202);
  assert.equal(e.posts.length, 0);
});
test("30 concurrent cancellation handlers use one full command", async () => {
  const e = canonicalEnv();
  e.setExists();
  await e.Ship.update("s1", {
    canonical_shipment_id: "SHP_TEST",
    version: 1,
    domain_status: "created",
  });
  const fn = load("functions/cancelOrderOnDomain/entry.ts", e.bindings).handler;
  const rs = await Promise.all(
    Array.from({ length: 30 }, () =>
      fn(request({ shipment_id: "s1", reason: "synthetic cleanup" })),
    ),
  );
  assert.equal(e.posts.length, 1);
  assert.ok(rs.some((r) => r.status === 200));
  assert.equal(e.posts[0].body.reason, "synthetic cleanup");
});
test("lost cancel response settles cancelled state through read with no second POST", async () => {
  const e = canonicalEnv();
  e.setExists();
  await e.Ship.update("s1", {
    canonical_shipment_id: "SHP_TEST",
    version: 1,
    domain_status: "created",
  });
  const original = e.bindings.callRender;
  e.bindings.callRender = async (o: any) => {
    const r = await original(o);
    return o.method === "POST" ? { ok: false, status: 0, code: "timeout" } : r;
  };
  const fn = load("functions/cancelOrderOnDomain/entry.ts", e.bindings).handler;
  assert.equal(
    (await fn(request({ shipment_id: "s1", reason: "cleanup" }))).status,
    202,
  );
  assert.equal(
    (await fn(request({ shipment_id: "s1", reason: "changed reason ignored" })))
      .status,
    200,
  );
  assert.equal(e.posts.length, 1);
});
test("missing cancel reason is rejected before POST", async () => {
  const e = canonicalEnv();
  e.setExists();
  await e.Ship.update("s1", { canonical_shipment_id: "SHP_TEST", version: 1 });
  const fn = load("functions/cancelOrderOnDomain/entry.ts", e.bindings).handler;
  assert.equal((await fn(request({ shipment_id: "s1" }))).status, 202);
  assert.equal(e.posts.length, 0);
});
test("updated:true or missing updated is never proof of ownership", async () => {
  await assert.rejects(
    () =>
      claims.cas({ updateMany: async () => ({ updated: true }) }, "x", {}, {}),
    /cas_result_unknown/,
  );
  await assert.rejects(
    () =>
      claims.cas({ updateMany: async () => ({ success: true }) }, "x", {}, {}),
    /cas_result_unknown/,
  );
});
test("raw entity inserts can duplicate: only shared draft/quote protocol prevents it", async () => {
  const s = new Store();
  await Promise.all([
    s.create({ booking_intent: "same" }),
    s.create({ booking_intent: "same" }),
  ]);
  assert.equal(s.creates, 2);
});
test("two pre-existing local rows with same order rely on Render uniqueness, not per-row CAS", async () => {
  const e = canonicalEnv();
  await e.ready;
  e.Ship.rows.set("s2", { ...(await e.Ship.get("s1")), id: "s2" });
  const fn = load("functions/createOrderOnRender/entry.ts", e.bindings).handler;
  await Promise.all([
    fn(request({ shipment_id: "s1" })),
    fn(request({ shipment_id: "s2" })),
  ]);
  assert.equal(e.posts.length, 2);
  assert.notEqual(e.posts[0].body.command_id, e.posts[1].body.command_id);
  // This characterization is intentional: never promise local cross-row dedupe.
  assert.equal(e.posts[0].body.order_id, e.posts[1].body.order_id);
});
test("different draft plus different quote represents distinct intent; no invented insert uniqueness", async () => {
  const e = env();
  e.Quote.rows.set("q2", { ...(await e.Quote.get("q1")), id: "q2" });
  const fn = makeFinalize(e);
  await Promise.all([
    fn(request(booking("d1", "q1"))),
    fn(request(booking("d2", "q2"))),
  ]);
  assert.equal(e.Ship.creates, 2);
});
test("crash after draft claim resumes reservation; crash after reservation resumes same quote", async () => {
  for (const phase of ["claim", "reserve"]) {
    const e = env();
    const target = phase === "claim" ? e.Draft : e.Quote;
    let once = true;
    target.after = async (_op, x) => {
      if (
        once &&
        (x.change.$set.booking_claim || x.change.$set.status === "reserved")
      ) {
        once = false;
        throw new Error("crash");
      }
    };
    const fn = makeFinalize(e);
    await fn(request(booking()));
    assert.equal((await fn(request(booking()))).status, 200);
    assert.equal(e.Ship.creates, 1);
  }
});
test("duplicate rows discovered during uncertain-insert recovery fail closed", async () => {
  const e = env();
  e.Ship.after = async () => {
    throw new Error("lost ack");
  };
  const fn = makeFinalize(e);
  await fn(request(booking()));
  const row = await e.Ship.get("local-1");
  e.Ship.rows.set("duplicate", { ...row, id: "duplicate" });
  const r = await fn(request(booking()));
  assert.equal(r.status, 202);
  assert.equal((await r.json()).code, "duplicate_intent_rows");
  assert.equal((await e.Quote.get("q1")).status, "reserved");
});
test("lost cancellation CAS acknowledgement leaves only persisted identity and read-only recovery", async () => {
  const e = canonicalEnv();
  e.setExists();
  await e.Ship.update("s1", { canonical_shipment_id: "SHP_TEST", version: 1 });
  let once = true;
  e.Ship.after = async (_op, x) => {
    if (x.change.$set.cancel_command_claim && once) {
      once = false;
      throw new Error("crash");
    }
  };
  const fn = load("functions/cancelOrderOnDomain/entry.ts", e.bindings).handler;
  await fn(request({ shipment_id: "s1", reason: "cleanup" }));
  const before = (await e.Ship.get("s1")).cancel_command_claim;
  const r = await fn(request({ shipment_id: "s1", reason: "different" }));
  assert.equal(r.status, 202);
  assert.equal(e.posts.length, 0);
  assert.deepEqual((await e.Ship.get("s1")).cancel_command_claim, before);
});
test("local cancellation racing canonical create cannot be followed by a create POST", async () => {
  const e = canonicalEnv();
  const create = load(
    "functions/createOrderOnRender/entry.ts",
    e.bindings,
  ).handler;
  const cancel = load(
    "functions/cancelOrderOnDomain/entry.ts",
    e.bindings,
  ).handler;
  await Promise.all([
    cancel(request({ shipment_id: "s1", reason: "cleanup" })),
    create(request({ shipment_id: "s1" })),
  ]);
  const row = await e.Ship.get("s1");
  if (row.status === "cancelled")
    assert.equal(e.posts.filter((p) => !p.path.endsWith("/cancel")).length, 0);
  else assert.ok(row.booking_command_claim);
});
test("reconciliation refuses incomplete pages and sends credential on every page", async () => {
  let pages = 0;
  const r = await reads.collectShipmentPages(
    async (o: any) => {
      pages++;
      assert.deepEqual(o.credential, credential);
      return {
        ok: true,
        status: 200,
        data: { items: [{}], next_cursor: "stuck" },
      };
    },
    { merchant_id: "MER_TEST", order_id: "order-1", credential },
  );
  assert.equal(r.ok, false);
  assert.equal(pages, 2);
});
test("synthetic canonical create requires server context and persisted isolation on reconcile", async () => {
  const e = canonicalEnv();
  e.bindings.findExceptionByMerchant = () => ({
    local_merchant_id: merchant.id,
  });
  e.bindings.evaluateForAuthority = () => ({ open: true });
  const fn = load("functions/createOrderOnRender/entry.ts", e.bindings).handler;
  const first = await fn(request({ shipment_id: "s1" }));
  assert.equal(first.status, 202);
  assert.equal(e.posts[0].body.sandbox_isolated, true);
  e.remote.sandbox_isolated = true;
  assert.equal((await fn(request({ shipment_id: "s1" }))).status, 200);
  assert.equal(e.posts.length, 1);
});
test("crash between draft completion and shipment readiness resumes readiness", async () => {
  const e = env();
  let once = true;
  e.Ship.before = async (op, x) => {
    if (op === "cas" && x.change.$set.booking_ready === true && once) {
      once = false;
      throw new Error("crash");
    }
  };
  const fn = makeFinalize(e);
  assert.equal((await fn(request(booking()))).status, 202);
  assert.equal((await e.Draft.get("d1")).status, "booked");
  assert.equal((await e.Ship.get("local-1")).booking_ready, false);
  assert.equal((await fn(request(booking()))).status, 200);
  assert.equal((await e.Ship.get("local-1")).booking_ready, true);
  assert.equal(e.Ship.creates, 1);
});
test("cancel timeout before remote commit retries original reason/version/identity", async () => {
  const e = canonicalEnv();
  e.setExists();
  await e.Ship.update("s1", { canonical_shipment_id: "SHP_TEST", version: 1 });
  const orig = e.bindings.callRender;
  let once = true;
  e.bindings.callRender = async (o: any) => {
    if (o.method === "POST" && once) {
      once = false;
      e.posts.push(structuredClone(o));
      return { ok: false, status: 0, code: "timeout" };
    }
    return orig(o);
  };
  const fn = load("functions/cancelOrderOnDomain/entry.ts", e.bindings).handler;
  assert.equal(
    (await fn(request({ shipment_id: "s1", reason: "original reason" })))
      .status,
    202,
  );
  assert.equal(
    (
      await fn(
        request({
          shipment_id: "s1",
          reason: "new reason must not replace original",
        }),
      )
    ).status,
    200,
  );
  assert.deepEqual(e.posts[0].body, e.posts[1].body);
});
test("expired quote never reserves or inserts and posted authority fields never persist", async () => {
  const e = env();
  await e.Quote.update("q1", { expires_at: "2000-01-01" });
  const fn = makeFinalize(e);
  assert.equal((await fn(request(booking()))).status, 409);
  assert.equal(e.Ship.creates, 0);
  assert.equal(e.Quote.transitions.length, 0);
  await e.Quote.update("q1", { expires_at: "2099-01-01T00:00:00Z" });
  const b = booking();
  Object.assign(b.shipment, {
    booking_command_claim: { command_id: "evil" },
    test_harness: true,
    domain_merchant_scope: "evil",
    status: "delivered",
  });
  assert.equal((await fn(request(b))).status, 200);
  const row = await e.Ship.get("local-1");
  assert.equal(row.booking_command_claim, undefined);
  assert.equal(row.test_harness, false);
  assert.equal(row.domain_merchant_scope, undefined);
  assert.equal(row.status, "created");
});
test("failed canonical read cannot be accepted using a list row alone", async () => {
  const r = await ids.reconcileCanonicalShipment(
    async (o: any) =>
      o.path.includes("?")
        ? {
            ok: true,
            status: 200,
            data: {
              items: [
                {
                  shipment_id: "SHP_TEST",
                  tracking_id: "LEX-TEST",
                  merchant_id: "MER_TEST",
                  order_id: "order-1",
                  status: "created",
                  version: 1,
                },
              ],
              next_cursor: null,
            },
          }
        : { ok: false, status: 503, code: "unavailable", message: "unit" },
    { merchant_id: "MER_TEST", order_id: "order-1", credential },
  );
  assert.equal(r.ok, false);
});
test("paused insert remains in flight while retries see no row: never issues another insert", async () => {
  const e = env();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((r) => (entered = r)),
    hold = new Promise<void>((r) => (release = r));
  e.Ship.before = async (op) => {
    if (op === "create") {
      entered();
      await hold;
    }
  };
  const fn = makeFinalize(e),
    first = fn(request(booking()));
  await started;
  const retry = await fn(request(booking()));
  assert.equal(retry.status, 202);
  assert.equal(e.Ship.creates, 0);
  release();
  assert.equal((await first).status, 200);
  assert.equal(e.Ship.creates, 1);
});
test("cancellation cannot settle another merchant/order or missing isolation evidence", async () => {
  const e = canonicalEnv();
  e.setExists();
  await e.Ship.update("s1", { canonical_shipment_id: "SHP_TEST", version: 1 });
  e.remote.merchant_id = "MER_OTHER";
  const fn = load("functions/cancelOrderOnDomain/entry.ts", e.bindings).handler;
  assert.equal(
    (await fn(request({ shipment_id: "s1", reason: "cleanup" }))).status,
    202,
  );
  assert.equal(e.posts.length, 0);
});
test("retry body changes cannot replace first validated local snapshot", async () => {
  const e = env();
  let once = true;
  e.Quote.after = async (_op, x) => {
    if (once && x.change.$set.status === "reserved") {
      once = false;
      throw new Error("lost acknowledgement");
    }
  };
  const fn = makeFinalize(e);
  assert.equal((await fn(request(booking()))).status, 202);
  const altered = booking();
  altered.shipment.weight_lb = 99;
  altered.shipment.destination_address = "Different address";
  assert.equal((await fn(request(altered))).status, 200);
  const row = await e.Ship.get("local-1");
  assert.equal(row.weight_lb, 1);
  assert.equal(row.destination_address, "Synthetic D");
});

function ownerSDK(e: any, who: any = user) {
  const wrap = (store: any, entityName: string) => {
    const schema = JSON.parse(
      readFileSync(new URL(`entities/${entityName}.jsonc`, root), "utf8"),
    );
    const permit = (op: string, row: any = {}) => {
      const rule = schema.rls[op];
      const evalRule = (r: any): boolean =>
        r === true || (r === false && ["create", "update"].includes(op)) ||
        !!(
          r &&
          typeof r === "object" &&
          (r.$or
            ? r.$or.some(evalRule)
            : r.user_condition
              ? r.user_condition.role === who.role
              : Object.entries(r).every(
                  ([key, value]) =>
                    row[key.replace(/^data\./, "")] ===
                    String(value).replace("{{user.id}}", who.id),
                ))
        );
      if (!evalRule(rule))
        throw Object.assign(new Error("Forbidden by modeled configured RLS; hosted behavior unverified"), {
          status: 403,
        });
    };
    return {
      get: async (id: string) => {
        const r = await store.get(id);
        permit("read", r);
        return r;
      },
      create: async (v: any) => {
        permit("create", v);
        return store.create(v);
      },
      update: async (id: string, v: any) => {
        permit("update", await store.get(id));
        return store.update(id, v);
      },
      updateMany: async (q: any, v: any) => {
        permit("update", await store.get(q.id));
        return store.updateMany(q, v);
      },
      delete: async (id: string) => {
        permit("delete", await store.get(id));
        store.rows.delete(id);
      },
    };
  };
  return {
    Shipment: wrap(e.Ship, "Shipment"),
    ShipmentDraft: wrap(e.Draft, "ShipmentDraft"),
    ShipmentQuote: wrap(e.Quote, "ShipmentQuote"),
  };
}
test("configured policy model denies ordinary-owner SDK creation, tampering and deletion", async () => {
  const e = canonicalEnv();
  await e.ready;
  for (const who of [user]) {
    const sdk = ownerSDK(e, who);
    for (const [name, id] of [
      ["Shipment", "s1"],
      ["ShipmentDraft", "d1"],
      ["ShipmentQuote", "q1"],
    ]) {
      await assert.rejects(
        () => sdk[name].create({ command_id: crypto.randomUUID() }),
        { status: 403 },
      );
      await assert.rejects(
        () =>
          sdk[name].update(id, {
            command_id: null,
            booking_claim: null,
            status: "draft",
          }),
        { status: 403 },
      );
      await assert.rejects(
        () =>
          sdk[name].updateMany(
            { id },
            {
              $set: {
                booking_command_claim: null,
                cancel_command_id: "primed",
              },
            },
          ),
        { status: 403 },
      );
      await assert.rejects(() => sdk[name].delete(id), { status: 403 });
    }
  }
  assert.ok(await e.Ship.get("s1"));
  assert.ok(await e.Draft.get("d1"));
  assert.equal((await e.Quote.get("q1")).status, "open");
});
test("customer draft edits work through controlled handler despite SDK write denial", async () => {
  const e = env();
  await e.ready;
  e.client.entities = ownerSDK(e);
  const fn = load("functions/merchantDraft/entry.ts", e.bindings).handler;
  const r = await fn(
    request({
      action: "save",
      draft_id: "d1",
      expected_revision: 0,
      data: { ...booking().shipment, description: "Edited by customer" },
      step: 2,
      options: { promo_input: "TEST" },
    }),
  );
  assert.equal(r.status, 200);
  const d = (await r.json()).draft;
  assert.equal(d.data.description, "Edited by customer");
  assert.equal(d.edit_revision, 1);
  assert.equal(d.booking_claim, undefined);
  const bad = await fn(
    request({
      action: "save",
      draft_id: "d1",
      expected_revision: 1,
      data: booking().shipment,
      status: "draft",
      booking_claim: null,
    }),
  );
  assert.equal(bad.status, 400);
});
test("controlled draft creation mints ownership/provenance; customer-supplied metadata cannot enter", async () => {
  const e = env();
  e.client.entities = ownerSDK(e);
  const fn = load("functions/merchantDraft/entry.ts", e.bindings).handler;
  const r = await fn(
    request({
      action: "save",
      data: {
        ...booking().shipment,
        command_id: "primed",
        server_record_proof: "forged",
        test_harness: true,
      },
      step: 1,
    }),
  );
  assert.equal(r.status, 200);
  const d = (await r.json()).draft;
  assert.equal(await proofs.trusted("ShipmentDraft", d), true);
  assert.equal(d.server_owner_user_id, user.id);
  assert.equal(d.data.command_id, undefined);
  assert.equal(d.data.test_harness, undefined);
});
test("server-only read cannot trust a primed legacy server_owner_user_id", async () => {
  const e = canonicalEnv();
  await e.ready;
  e.Ship.rows.set("forged", {
    id: "forged",
    created_by_id: "another-user",
    server_owner_user_id: user.id,
    merchant_id: merchant.id,
  });
  const fn = load(
    "functions/merchantShipmentRead/entry.ts",
    e.bindings,
  ).handler;
  const r = await fn(request({ action: "get", shipment_id: "forged" }));
  assert.equal(r.status, 404);
});
test("primed browser-era create/cancel IDs are reconciled read-only, never replaced", async () => {
  const e = canonicalEnv();
  await e.ready;
  e.setExists();
  const row = e.Ship.rows.get("s1");
  delete row.server_record_proof;
  row.command_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  row.cancel_command_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  row.canonical_shipment_id = "SHP_TEST";
  row.status = "cancelled";
  let minted = 0;
  e.bindings.generateCommandId = () => {
    minted++;
    return crypto.randomUUID();
  };
  const before = structuredClone(row);
  for (const name of ["createOrderOnRender", "cancelOrderOnDomain"]) {
    const fn = load(`functions/${name}/entry.ts`, e.bindings).handler;
    const r = await fn(request({ shipment_id: "s1", reason: "cleanup" }));
    assert.equal(r.status, 202);
    assert.equal((await r.json()).code, "legacy_identity_review_required");
  }
  assert.equal(minted, 0);
  assert.equal(e.posts.length, 0);
  assert.deepEqual(e.Ship.rows.get("s1"), before);
});
test("legacy draft status or forged claim does not authorize finalization", async () => {
  const e = env();
  await e.ready;
  delete e.Draft.rows.get("d1").server_record_proof;
  Object.assign(e.Draft.rows.get("d1"), {
    status: "draft",
    shipment_id: "primed",
    created_by_id: user.id,
  });
  const r = await makeFinalize(e)(request(booking()));
  assert.equal(r.status, 202);
  assert.equal(e.Ship.creates, 0);
});
test("reopening presentation status cannot clear the authoritative booking claim", async () => {
  const e = env(),
    fn = makeFinalize(e);
  assert.equal((await fn(request(booking()))).status, 200);
  await e.Draft.update("d1", { status: "draft" }); // privileged corruption fixture, SDK attempt separately denied
  assert.equal((await fn(request(booking()))).status, 200);
  assert.equal(e.Ship.creates, 1);
  const save = load("functions/merchantDraft/entry.ts", e.bindings).handler;
  const resumed = await save(
    request({
      action: "save",
      draft_id: "d1",
      expected_revision: 0,
      data: booking().shipment,
    }),
  );
  assert.equal(resumed.status, 200);
  assert.equal((await resumed.json()).resume_only, true);
  assert.equal(e.Ship.creates, 1);
});
test("draft edits racing finalization cannot overwrite a frozen snapshot", async () => {
  const e = env();
  await e.ready;
  const finalize = makeFinalize(e),
    save = load("functions/merchantDraft/entry.ts", e.bindings).handler;
  const rs = await Promise.all([
    finalize(request(booking())),
    save(
      request({
        action: "save",
        draft_id: "d1",
        expected_revision: 0,
        data: { ...booking().shipment, description: "racing edit" },
      }),
    ),
  ]);
  const d = await e.Draft.get("d1");
  if (d.booking_claim) assert.equal(d.data.description, undefined);
  else assert.equal(e.Ship.creates, 0);
  assert.ok(rs.every((r) => [200, 202].includes(r.status)));
});
test("draft discard archives unclaimed data but never deletes or unlinks a booking", async () => {
  const e = env();
  await e.ready;
  const fn = load("functions/merchantDraft/entry.ts", e.bindings).handler;
  const r = await fn(request({ action: "discard", draft_id: "d2" }));
  assert.equal(r.status, 200);
  assert.ok((await e.Draft.get("d2")).archived_at);
  await makeFinalize(e)(request(booking()));
  const booked = await e.Draft.get("d1");
  assert.equal(
    (await fn(request({ action: "discard", draft_id: "d1" }))).status,
    202,
  );
  assert.equal((await e.Draft.get("d1")).shipment_id, booked.shipment_id);
});
test("finalizer ignores primed identity, frozen-payload, cancellation and test fields", async () => {
  const e = env();
  const b: any = booking();
  Object.assign(b.shipment, {
    command_id: crypto.randomUUID(),
    order_id: "primed-order",
    correlation_id: "primed-corr",
    idempotency_key: "primed",
    booking_command_claim: { payload: { evil: true } },
    server_owner_user_id: "other",
    domain_merchant_scope: "MER_EVIL",
    cancel_command_id: crypto.randomUUID(),
    cancel_reason: "evil",
    test_harness: true,
    tracking_number: "EVIL",
    drop_off_code: "EVIL",
  });
  const r = await makeFinalize(e)(request(b));
  assert.equal(r.status, 200);
  const s = (await r.json()).shipment;
  assert.equal(s.command_id, undefined);
  assert.equal(s.booking_command_claim, undefined);
  assert.equal(s.cancel_command_id, undefined);
  assert.equal(s.order_id, "draft:d1");
  assert.equal(s.test_harness, false);
  assert.notEqual(s.tracking_number, "EVIL");
  assert.notEqual(s.drop_off_code, "EVIL");
  assert.equal(s.server_owner_user_id, user.id);
  assert.equal(await proofs.trusted("Shipment", s), true);
});
test("archive cancels canonical shipment first and preserves all links and audit history", async () => {
  const e = canonicalEnv();
  await e.ready;
  e.setExists();
  await e.Ship.update("s1", { canonical_shipment_id: "SHP_TEST", version: 1 });
  e.bindings.cancelOrderOnDomain = load(
    "functions/cancelOrderOnDomain/entry.ts",
    e.bindings,
  ).handler;
  const fn = load(
    "functions/archiveMerchantShipment/entry.ts",
    e.bindings,
  ).handler;
  assert.equal((await fn(request({ shipment_id: "s1" }))).status, 200);
  const s = await e.Ship.get("s1");
  assert.equal(s.canonical_shipment_id, "SHP_TEST");
  assert.equal(s.status, "cancelled");
  assert.ok(s.archived_at);
  assert.equal(e.posts.length, 1);
  assert.ok(s.lifecycle_history.some((x) => x.action === "shipment.archived"));
  assert.ok(
    s.lifecycle_history.some(
      (x) => x.action === "shipment.cancelled.canonical",
    ),
  );
  assert.equal((await fn(request({ shipment_id: "s1" }))).status, 200);
  assert.equal(e.posts.length, 1);
});
test("ambiguous cancellation keeps row visible until retry settles archive", async () => {
  const e = canonicalEnv();
  await e.ready;
  e.setExists();
  await e.Ship.update("s1", { canonical_shipment_id: "SHP_TEST", version: 1 });
  const original = e.bindings.callRender;
  e.bindings.callRender = async (o: any) => {
    const r = await original(o);
    return o.method === "POST" ? { ok: false, status: 0, code: "timeout" } : r;
  };
  e.bindings.cancelOrderOnDomain = load(
    "functions/cancelOrderOnDomain/entry.ts",
    e.bindings,
  ).handler;
  const fn = load(
    "functions/archiveMerchantShipment/entry.ts",
    e.bindings,
  ).handler;
  assert.equal((await fn(request({ shipment_id: "s1" }))).status, 202);
  assert.equal((await e.Ship.get("s1")).archived_at, undefined);
  assert.equal((await fn(request({ shipment_id: "s1" }))).status, 200);
  assert.ok((await e.Ship.get("s1")).archived_at);
  assert.equal(e.posts.length, 1);
});
test("forged provenance is not an alternate route around legacy reconciliation", async () => {
  const e = canonicalEnv();
  await e.ready;
  const row = e.Ship.rows.get("s1");
  row.server_record_proof = "0".repeat(64);
  const fn = load("functions/createOrderOnRender/entry.ts", e.bindings).handler;
  assert.equal((await fn(request({ shipment_id: "s1" }))).status, 202);
  assert.equal(e.posts.length, 0);
});
function authorityBindings(e:any) {
 const secrets={get:(k:string)=>k==='MERCHANT_RECORD_SIGNING_SECRET'?testKey:k==='MERCHANT_AUTHORITY_POLICY_EPOCH'?'hosted-policy-v1':undefined};
 const a:any=load('shared/shipmentAuthority.ts',{recordAuthority:records.recordAuthority,secrets,findExceptionByMerchant:()=>null},['arrayRows','operationSnapshot','snapshotDigest','localOwnership','operationalAuthority','resolveOperationalShipment']);
 return {...containment,...records,secrets,...a};
}
test("containment refuses unsettled or unsigned rows, then allows trusted ordinary settled row", async () => {
  const e = canonicalEnv();
  await e.ready;
  e.entities.Merchant = new Store([]);
  e.entities.ShipmentQuote = new Store([]);
  e.entities.LegacyShipmentAuthority = new Store([]);
  const fn = load(
    "shared/containmentResolver.ts",
    authorityBindings(e),
    ["resolveShipmentSubject"],
  ).resolveShipmentSubject;
  await e.Ship.update("s1", {
    booking_intent: "draft:unit",
    booking_ready: false,
    test_harness: false,
  });
  assert.equal(
    (await fn(e.client.asServiceRole, { shipment_id: "s1" })).classification,
    "unknown",
  );
  await e.Ship.update("s1", { booking_ready: true });
  assert.equal(
    (await fn(e.client.asServiceRole, { shipment_id: "s1" })).classification,
    "production",
  );
  delete e.Ship.rows.get("s1").server_record_proof;
  e.Ship.rows.get("s1").test_harness = true;
  assert.equal(
    (await fn(e.client.asServiceRole, { shipment_id: "s1" })).classification,
    "unknown",
  );
});
test("missing local lookup cannot be rescued by another supplied tracking id", async () => {
  const e = canonicalEnv();
  await e.ready;
  e.entities.Merchant = new Store([]);
  e.entities.ShipmentQuote = new Store([]);
  e.entities.LegacyShipmentAuthority = new Store([]);
  await e.Ship.update("s1", { tracking_id: "TRACK-UNIT" });
  const fn = load(
    "shared/containmentResolver.ts",
    authorityBindings(e),
    ["resolveShipmentSubject"],
  ).resolveShipmentSubject;
  assert.equal(
    (
      await fn(e.client.asServiceRole, {
        shipment_id: "missing",
        tracking_id: "TRACK-UNIT",
      })
    ).classification,
    "unknown",
  );
});
test("ordinary SDK cannot reopen a consumed quote or clear frozen state", async () => {
  const e = env();
  await makeFinalize(e)(request(booking()));
  const before = await e.Quote.get("q1"),
    sdk = ownerSDK(e);
  await assert.rejects(
    () =>
      sdk.ShipmentQuote.update("q1", {
        status: "open",
        reservation_intent: null,
      }),
    { status: 403 },
  );
  assert.deepEqual(await e.Quote.get("q1"), before);
});
test("legacy draft edits preserve customer input but never seal/reopen it for booking", async () => {
  const e = env();
  await e.ready;
  const d = e.Draft.rows.get("d1");
  delete d.server_record_proof;
  d.created_by_id = user.id;
  d.status = "booked";
  const edit = load("functions/merchantDraft/entry.ts", e.bindings).handler;
  const r = await edit(
    request({
      action: "save",
      draft_id: "d1",
      expected_revision: 0,
      data: booking().shipment,
      step: 3,
    }),
  );
  assert.equal(r.status, 200);
  assert.equal((await e.Draft.get("d1")).status, "booked");
  assert.equal((await e.Draft.get("d1")).server_record_proof, undefined);
  assert.equal((await makeFinalize(e)(request(booking()))).status, 202);
  assert.equal(e.Ship.creates, 0);
});
test("legacy platform harness cannot write even if its former switch is configured", async () => {
  const e = env();
  e.client.auth.me = async () => ({ id: "admin", role: "admin" });
  const fn = load("functions/createTestShipment/entry.ts", e.bindings).handler;
  assert.equal(
    (await fn(request({ shipment_id: "any", confirmed: true }))).status,
    403,
  );
  assert.equal(e.Ship.creates, 0);
});
test("customer allowlist retains editable fields and excludes every authority/claim field", () => {
  const supplied: any = {
    origin_address: " Test ",
    weight_lb: "2",
    insurance: true,
    description: "Customer note",
    command_id: "forged",
    order_id: "forged",
    server_record_proof: "forged",
    merchant_id: "forged",
    domain_merchant_scope: "forged",
    pickup_deadline: "forged",
    tracking_number: "forged",
    cancel_command_claim: {},
    test_harness: true,
    booking_claim: {},
  };
  assert.deepEqual(customer.customerShipment(supplied), {
    origin_address: "Test",
    weight_lb: 2,
    insurance: true,
    description: "Customer note",
  });
});
test("closed gate permits only settlement of an already inserted intent, never a fresh insert", async () => {
  const e = env();
  let once = true;
  e.Quote.after = async (_op, x) => {
    if (once && x.change.$set.status === "consumed") {
      once = false;
      throw new Error("crash");
    }
  };
  const fn = makeFinalize(e);
  assert.equal((await fn(request(booking()))).status, 202);
  assert.equal(e.Ship.creates, 1);
  e.bindings.secrets.get = (n: string) =>
    n === "MERCHANT_RECORD_SIGNING_SECRET"
      ? testKey
      : n === "BOOKING_RELEASE_ENABLED"
        ? "false"
        : "UNIT-ONLY";
  const resume = makeFinalize(e);
  assert.equal((await resume(request(booking()))).status, 200);
  assert.equal(e.Ship.creates, 1);
  assert.equal((await resume(request(booking("d2")))).status, 409);
});
test("frozen resume does not consume a replacement quote supplied by the browser", async () => {
  const e = env();
  const fn = makeFinalize(e);
  assert.equal((await fn(request(booking()))).status, 200);
  e.Quote.rows.set("q2", {
    ...(await e.Quote.get("q1")),
    id: "q2",
    status: "open",
    reservation_intent: undefined,
  });
  const r = await fn(request(booking("d1", "q2")));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).quote_id, "q1");
  assert.equal((await e.Quote.get("q2")).status, "open");
});

test('verified legacy operations do not bless creation command provenance',async()=>{
 const row={id:'legacy',created_by_id:'owner',merchant_id:'forged',tracking_number:'TRACK-LEGACY',test_harness:true};
 const sr={entities:{Shipment:new Store([row]),ShipmentQuote:new Store([]),Merchant:new Store([{id:'actual-merchant',created_by_id:'owner'}]),LegacyShipmentAuthority:new Store([])}};
 const a=authorityBindings({});
 const own=await a.localOwnership(sr,row);assert.equal(own.verified,true);assert.equal(own.merchant_id,'actual-merchant');assert.equal(own.command_provenance,'untrusted');
 assert.equal((await a.operationalAuthority(sr,row,'lex')).ok,false);
 await sr.entities.LegacyShipmentAuthority.create({shipment_id:'legacy',status:'active',owner_user_id:'owner',merchant_id:'actual-merchant',policy_epoch:'hosted-policy-v1',snapshot_digest:await a.snapshotDigest(row),principals:['lex']});
 const allowed=await a.operationalAuthority(sr,row,'lex');assert.equal(allowed.ok,true);assert.equal(allowed.shipment.test_harness,false);assert.equal(allowed.ownership.command_provenance,'untrusted');
 assert.equal((await a.operationalAuthority(sr,row,'partner')).ok,false);
 assert.equal((await a.operationalAuthority(sr,{...row,destination_address:'tampered'},'lex')).ok,false);
 await sr.entities.LegacyShipmentAuthority.update('local-1',{status:'revoked'});
 assert.equal((await a.operationalAuthority(sr,row,'lex')).ok,false);
});
test('multiple explicit identifiers must independently resolve the same shipment',async()=>{
 const a=authorityBindings({});const row={id:'s',created_by_id:'owner',...await proofs.mint('Shipment','owner','merchant'),booking_ready:true,tracking_number:'TRACK'};
 const sr={entities:{Shipment:new Store([row])}};
 assert.equal((await a.resolveOperationalShipment(sr,{shipment_id:'s',tracking_number:'TRACK'},'lex')).ok,true);
 assert.equal((await a.resolveOperationalShipment(sr,{shipment_id:'missing',tracking_number:'TRACK'},'lex')).ok,false);
 assert.equal((await a.resolveOperationalShipment(sr,{shipment_id:'s',tracking_number:'wrong'},'lex')).ok,false);
 assert.equal((await a.resolveOperationalShipment(sr,{tracking_number:'TRACK'},'lex')).ok,true);
});
test('actual platform sync handler contains synthetic shipments before status or event writes',async()=>{
 const a=authorityBindings({});const row={id:'synthetic',status:'created',test_harness:true,booking_ready:true,...await proofs.mint('Shipment','owner','merchant')};
 const Ship=new Store([row]);const event=new Store([]);const notifications=new Store([]);const sr={entities:{Shipment:Ship,ShipmentEvent:event,Notification:notifications}};
 const sync=load('shared/platformSync.ts',{...a,createTrustedShipmentEvent:()=>{throw new Error('must not emit');}},['applySyncEvent']).applySyncEvent;
 await assert.rejects(()=>sync({asServiceRole:sr},{event:'shipment_status_update',shipment_id:'synthetic',data:{status:'picked_up'}},'Carrier'),/synthetic_isolated/);
 assert.equal((await Ship.get('synthetic')).status,'created');assert.equal(event.creates,0);assert.equal(notifications.creates,0);
});
test('booking account resolution rejects mutable email joins, duplicates and revoked sender',async()=>{
 const resolve=load('shared/bookingMerchant.ts',{},['resolveBookingMerchant']).resolveBookingMerchant;
 const sr={entities:{Merchant:new Store([{id:'other',created_by_id:'other',contact_email:'caller@example.test'}]),PortalMembership:new Store([])}};
 assert.equal(await resolve(sr,{id:'caller',email:'caller@example.test'}),null);
 await sr.entities.Merchant.create({created_by_id:'caller'});assert.ok(await resolve(sr,{id:'caller'}));
 await sr.entities.PortalMembership.create({user_id:'caller',portal_type:'sender',status:'revoked'});assert.equal(await resolve(sr,{id:'caller'}),null);
});
test('draft-only allowlist retains card selection and declaration but drops authority fields',()=>{
 const d=customer.customerDraft({origin_address:'A',payment_method_id:'pm_unit',compliance:{item_category:'clothing',contents_description:'Synthetic',allowed:true},command_id:'primed',booking_claim:{command_id:'primed'},test_harness:true});
 assert.equal(d.payment_method_id,'pm_unit');assert.equal(d.compliance.allowed,undefined);assert.equal(d.command_id,undefined);assert.equal(d.booking_claim,undefined);assert.equal(d.test_harness,undefined);
});
function artifactEnv() {
 const entities={Shipment:new Store([{id:'parent',status:'awaiting_dropoff',merchant_id:'merchant',server_owner_user_id:'owner'}]),ShipmentEvent:new Store([]),AuditLog:new Store([]),ShipperDeclaration:new Store([]),Notification:new Store([])};
 return entities;
}
test('concurrent artifact projection has one insert owner on the stable parent',async()=>{
 const e=artifactEnv();const plan=await artifacts.artifactPlan(testKey,'parent','ShipperDeclaration',{shipment_id:'parent',contents_description:'Synthetic fixture'});
 await e.Shipment.update('parent',{declaration_projection:{phase:'pending',plan}});
 const results=await Promise.allSettled(Array.from({length:12},()=>artifacts.projectArtifact(e,'parent','declaration_projection',testKey)));
 assert.ok(results.some(r=>r.status==='fulfilled'));assert.equal(e.ShipperDeclaration.creates,1);assert.equal((await e.Shipment.get('parent')).declaration_projection.phase,'done');
});
test('artifact recovers a lost insert acknowledgment without another insert',async()=>{
 const e=artifactEnv();const plan=await artifacts.artifactPlan(testKey,'parent','ShipmentEvent',{shipment_id:'parent',event:'received_at_origin'});
 await e.Shipment.update('parent',{custody_projection:{phase:'pending',plan}});
 e.ShipmentEvent.after=async op=>{if(op==='create')throw new Error('lost ack');};
 await assert.rejects(()=>artifacts.projectArtifact(e,'parent','custody_projection',testKey),/artifact_insert_unknown/);
 const id=await artifacts.projectArtifact(e,'parent','custody_projection',testKey);assert.ok(id);assert.equal(e.ShipmentEvent.creates,1);
});
test('crash before artifact insert stays pending and never steals an expired lease',async()=>{
 const e=artifactEnv();const plan=await artifacts.artifactPlan(testKey,'parent','AuditLog',{action:'custody'});
 await e.Shipment.update('parent',{custody_audit_projection:{phase:'creating',plan}});
 for(let i=0;i<3;i++)await assert.rejects(()=>artifacts.projectArtifact(e,'parent','custody_audit_projection',testKey),/artifact_insert_unknown/);
 assert.equal(e.AuditLog.creates,0);
});
test('artifact plan content tampering or another parent never causes an insert',async()=>{
 const e=artifactEnv();const plan=await artifacts.artifactPlan(testKey,'parent','AuditLog',{action:'custody'});
 await e.Shipment.update('parent',{custody_audit_projection:{phase:'pending',plan:{...plan,document:{action:'tampered'}}}});
 await assert.rejects(()=>artifacts.projectArtifact(e,'parent','custody_audit_projection',testKey),/artifact_authority_unverified/);assert.equal(e.AuditLog.creates,0);
});
test('custody status CAS atomically retains receipt and recovers its missing event/audit',async()=>{
 const e=artifactEnv();e.ShipmentEvent.after=async op=>{if(op==='create')throw new Error('lost event ack');};
 const change={from:'awaiting_dropoff',to:'received_at_origin',actor_id:'partner',facility:'Synthetic facility',custodian:'Test partner',location_ids:['loc']};
 const before=await e.Shipment.get('parent');
 await assert.rejects(()=>custody.transitionCustody(e,before,change,{owner_user_id:'owner',merchant_id:'merchant'},testKey),/artifact_insert_unknown/);
 const stored=await e.Shipment.get('parent');assert.equal(stored.status,'received_at_origin');assert.equal(stored.custody_receipt.actor_id,'partner');assert.equal(stored.custody_history.length,1);assert.equal(stored.custody_projection.phase,'creating');
 const recovered=await custody.settleCustody(e,stored,testKey);assert.equal(recovered.custody_projection.phase,'done');assert.equal(recovered.custody_audit_projection.phase,'done');assert.equal(e.ShipmentEvent.creates,1);assert.equal(e.AuditLog.creates,1);
 const again=await custody.transitionCustody(e,recovered,change,{owner_user_id:'owner',merchant_id:'merchant'},testKey);assert.equal(again.status,'received_at_origin');assert.equal(e.ShipmentEvent.creates,1);
});
function controlledEnv() {
 const e=env();e.bindings.resolveBookingMerchant=async()=>merchant;
 e.bindings.findExceptionByMerchant=()=>({approved_user_id:user.id,local_merchant_id:merchant.id});
 e.bindings.loadVerifiedAuthority=async()=>({...authority,isolation:{evidenced:true,sandbox_isolated:true}});
 e.bindings.evaluateForAuthority=()=>({open:true,code:'verified_test'});
 return e;
}
test('controlled handler creates one quarantined fixture under concurrent requests with no card or effects',async()=>{
 const e=controlledEnv();await e.ready;
 const fn=load('functions/createControlledTestShipment/entry.ts',e.bindings).handler;
 const responses=await Promise.all(Array.from({length:12},()=>fn(request({draft_id:'d1',quote_id:'q1'}))));
 assert.ok(responses.some(r=>r.status===200));assert.equal(e.Ship.creates,1);assert.equal(e.cards,0);
 const row=[...e.Ship.rows.values()][0];assert.equal(row.test_harness,true);assert.equal(row.sandbox_isolated,true);assert.equal(row.payment_capture_status,'synthetic_disabled');assert.equal(row.origin_address,'Synthetic origin — DO NOT DISPATCH');
 const again=await fn(request({draft_id:'d1',quote_id:'q1'}));assert.equal(again.status,200);assert.equal((await again.json()).shipment.id,row.id);assert.equal(e.Ship.creates,1);
});
test('controlled handler denies closed exception, absent backend evidence, wrong account and caller flags before insert',async()=>{
 for(const variant of ['closed','no_isolation','wrong_user','caller_flag']) {
  const e=controlledEnv();await e.ready;
  if(variant==='closed')e.bindings.evaluateForAuthority=()=>({open:false,code:'flag_off'});
  if(variant==='no_isolation')e.bindings.loadVerifiedAuthority=async()=>({...authority,isolation:{evidenced:false,sandbox_isolated:true}});
  if(variant==='wrong_user')e.bindings.findExceptionByMerchant=()=>({approved_user_id:'other'});
  const fn=load('functions/createControlledTestShipment/entry.ts',e.bindings).handler;
  const body:any={draft_id:'d1',quote_id:'q1'};if(variant==='caller_flag')body.sandbox_isolated=true;
  assert.ok((await fn(request(body))).status>=400);assert.equal(e.Ship.creates,0);assert.equal(e.cards,0);
 }
});
test('controlled handler recovers lost local create response without a replacement intent',async()=>{
 const e=controlledEnv();await e.ready;e.Ship.after=async op=>{if(op==='create')throw new Error('lost ack');};
 const fn=load('functions/createControlledTestShipment/entry.ts',e.bindings).handler;
 assert.equal((await fn(request({draft_id:'d1',quote_id:'q1'}))).status,202);
 assert.equal((await fn(request({draft_id:'d1',quote_id:'q1'}))).status,200);assert.equal(e.Ship.creates,1);assert.equal(e.cards,0);
});
test('server screening uses the stored declaration and retained auth, refusing restricted decisions',async()=>{
 let posted:any;
 const check=load('shared/complianceBooking.ts',{POLICY_VERSION:'UNIT',validateShipmentCompliance:async(req:Request)=>{posted=await req.json();assert.equal(req.headers.get('authorization'),'Bearer unit');return Response.json({status:'restricted'});}},['screenBooking']).screenBooking;
 const draft={id:'d',server_owner_user_id:'u',declaration_checked:true,data:{compliance:{item_category:'general-dry-goods',contents_description:'Synthetic declared contents',quantity:1}}};
 await assert.rejects(()=>check(new Request('https://unit.invalid',{method:'POST',headers:{authorization:'Bearer unit'}}),draft,{id:'m'}),/Compliance approval required/);assert.equal(posted.action,'validate');assert.equal(posted.merchant_id,'m');assert.equal(posted.contents_description,draft.data.compliance.contents_description);
});
test('normal finalizer rejects failed server compliance before card or shipment creation',async()=>{
 const e=env();e.bindings.screenBooking=async()=>{throw new Error('Compliance approval required');};
 assert.equal((await makeFinalize(e)(request(booking()))).status,500);assert.equal(e.cards,0);assert.equal(e.Ship.creates,0);
});
test('account closure racing booking records a request and never deletes user or shipment history',async()=>{
 const e=env();let deletes=0;const audit=new Store([]);
 (e.entities as any).AuditLog=audit;(e.entities as any).User={delete:async()=>{deletes++;}};
 const close=load('functions/deleteMyAccount/entry.ts',e.bindings).handler;
 const [result]=await Promise.all([close(request({confirm:'DELETE'})),makeFinalize(e)(request(booking()))]);
 assert.equal(result.status,202);assert.equal((await result.json()).deleted,false);assert.equal(deletes,0);assert.equal(audit.creates,1);assert.equal(e.Ship.creates,1);
});
test('reward handler does not turn mutable payment data into withdrawable money',async()=>{
 const e=canonicalEnv();await e.ready;let credits=0;
 (e.entities as any).WalletTransaction={create:async()=>{credits++;}};
 (e.entities as any).Payment=new Store([{id:'fake',status:'succeeded',amount:999999,reference:'s1',created_by_id:'different-user',merchant_id:merchant.id}]);
 const fn=load('functions/awardShipmentRewards/entry.ts',e.bindings).handler;
 const results=await Promise.all(Array.from({length:8},()=>fn(request({shipment_id:'s1'}))));
 assert.ok(results.every(r=>r.status===200));assert.equal(credits,0);assert.equal((await results[0].json()).skipped,'trusted_payment_receipt_required');
});
test('synthetic saved-card and wallet endpoints deny before any provider access',async()=>{
 for(const name of ['listPaymentMethods','createCardSetupSession','walletDeposit','walletWithdraw']) {
  const e=env();e.bindings.syntheticPaymentDenied=()=>true;e.bindings.syntheticWalletDenied=async()=>true;
  e.bindings.getPaymentProfile=()=>{throw new Error('must not query provider profile');};e.bindings.callStripe=()=>{throw new Error('must not call Stripe');};
  const fn=load(`functions/${name}/entry.ts`,e.bindings).handler;
  assert.equal((await fn(request({merchant_id:merchant.id,amount:10}))).status,403);assert.equal(e.Ship.creates,0);
 }
});
test('default workflow handlers reject unauthenticated invocation before privileged work',async()=>{
 for(const name of ['dispatchPlatformEvent','lexPushToHub','notifyShipmentStatus']) {
  const e=env();e.client.auth.me=async()=>null;
  const fn=load(`functions/${name}/entry.ts`,e.bindings).handler;
  assert.ok([401,403].includes((await fn(request({shipment_id:'s1',status:'delivered',event:'custody_event'}))).status));
  assert.equal(e.Ship.creates,0);
 }
});
test('custody handler recovery retains facility authorization across a lost event response',async()=>{
 const e=env();await e.ready;
 const r={id:'p',status:'awaiting_dropoff',origin_location_id:'approved-location',...await proofs.mint('Shipment',user.id,merchant.id)};
 e.Ship.rows.set('p',r);
 (e.entities as any).ShipmentEvent=new Store([]);(e.entities as any).AuditLog=new Store([]);
 e.bindings.resolvePortalAccess=async()=>({portals:{pudo:{status:'approved'}},merchant,memberships:[{portal_type:'pudo',status:'approved',location_id:'approved-location'}]});
 e.bindings.operationalAuthority=authorityBindings(e).operationalAuthority;
 e.bindings.transitionCustody=custody.transitionCustody;e.bindings.settleCustody=custody.settleCustody;
 e.bindings.arrayRows=(x:any)=>Array.isArray(x)?x:x.items||[];
 e.bindings.allowedPartnerTransitions=(s:string)=>s==='awaiting_dropoff'?['received_at_origin']:[];e.bindings.sanitizeShipment=(s:any)=>s;
 (e.entities as any).ShipmentEvent.after=async(op:string)=>{if(op==='create')throw new Error('lost reply');};
 const fn=load('functions/partnerCustody/entry.ts',e.bindings).handler;
 const first=await fn(request({action:'transition',shipment_id:'p',to:'received_at_origin'}));assert.equal(first.status,202);
 e.bindings.resolvePortalAccess=async()=>({portals:{pudo:{status:'approved'}},merchant,memberships:[{portal_type:'pudo',status:'approved',location_id:'another-location'}]});
 const outsider=load('functions/partnerCustody/entry.ts',e.bindings).handler;
 assert.equal((await outsider(request({action:'transition',shipment_id:'p',to:'received_at_origin'}))).status,404);
 const retry=await fn(request({action:'transition',shipment_id:'p',to:'received_at_origin'}));assert.equal(retry.status,200);
 assert.equal((e.entities as any).ShipmentEvent.creates,1);assert.equal((e.entities as any).AuditLog.creates,1);
});
test('compliance fast-path does not accept an owner-created approved review or altered signed scope',async()=>{
 const review={id:'review',merchant_id:'m',item_category:'general-dry-goods',contents_description:'Synthetic fixture',quantity:1,has_battery:false,battery_details:'',compliance_status:'approved'};
 const b={asServiceRole:{entities:{ComplianceReview:{filter:async()=>({items:[review]})}}}};
 const fn=load('functions/validateShipmentCompliance/entry.ts',{secrets:{get:()=>testKey},POLICY_VERSION:'UNIT',verifiedPlan:artifacts.verifiedPlan},['findApprovedReview']).findApprovedReview;
 const args=[b,'m','general-dry-goods','Synthetic fixture',{quantity:1,hasBattery:false,batteryDetails:''}];
 assert.equal(await fn(...args),null);
 (review as any).approval_proof=await artifacts.artifactPlan(testKey,'review','ComplianceReviewApproval',{...review,decision:'approved',policy_version:'UNIT'});
 assert.equal((await fn(...args)).id,'review');
 assert.equal(await fn(b,'m','general-dry-goods','Synthetic fixture',{quantity:2,hasBattery:false,batteryDetails:''}),null);
 (review as any).approval_proof.document.merchant_id='other';assert.equal(await fn(...args),null);
});
test('LEX-local mapping ID never substitutes for an explicit Merchant DomainMerchantLink',()=>{
 const base=exceptions.EXCEPTION_BUSINESSES[0];assert.equal(base.mapping_id,null);assert.ok(base.lex_mapping_record_id);
 const entry={...base,canonical_merchant_id:'MER_'+'a'.repeat(32)};
 const subject:any={account:{id:base.approved_user_id},merchant:{id:base.local_merchant_id,created_by_id:base.approved_user_id},
  link:{id:base.lex_mapping_record_id,merchant_id:base.local_merchant_id,user_id:base.approved_user_id,domain_merchant_id:entry.canonical_merchant_id,domain_client_id:base.client_id,signing_subject:base.client_id,credential_key:base.credential_key,status:'authorized',scope_verified_at:'UNIT'},
  identity:{domain_merchant_id:entry.canonical_merchant_id,client_id:base.client_id,signing_subject:base.client_id},probe:{ok:true,sandbox_isolated:true},stamp_verified:true};
 const ctx={readSecret:()=> 'UNIT-PRESENCE-ONLY',exceptionFlagEnabled:true,isolationConfirmed:true};
 assert.equal(exceptions.evaluateControlledEntry(entry,subject,ctx).open,false);
 const explicit={...entry,mapping_id:'actual-merchant-link'};assert.equal(exceptions.evaluateControlledEntry(explicit,subject,ctx).open,false);
 subject.link.id='actual-merchant-link';assert.equal(exceptions.evaluateControlledEntry(explicit,subject,ctx).open,true);
});
test('signed payment webhook cannot credit a synthetic test wallet',async()=>{
 const e=env();let credits=0;
 (e.entities as any).WalletTransaction={filter:async()=>({items:[]}),create:async()=>{credits++;}};
 (e.entities as any).AuditLog=new Store([]);e.bindings.syntheticWalletDenied=async()=>true;e.bindings.secrets={get:()=>testKey};
 const fn=load('functions/stripeWebhook/entry.ts',e.bindings).handler;
 const raw=JSON.stringify({id:'evt_unit',type:'checkout.session.completed',data:{object:{id:'cs_unit',payment_status:'paid',amount_total:100,metadata:{type:'wallet_deposit',user_id:user.id}}}});
 const timestamp=Math.floor(Date.now()/1000);const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(testKey),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const mac=[...new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(`${timestamp}.${raw}`)))].map(x=>x.toString(16).padStart(2,'0')).join('');
 const response=await fn(new Request('https://unit.invalid',{method:'POST',headers:{'stripe-signature':`t=${timestamp},v1=${mac}`},body:raw}));
 assert.equal(response.status,200);assert.equal((await response.json()).held,true);assert.equal(credits,0);assert.equal((e.entities as any).AuditLog.creates,1);
});
test('untrusted rewards cannot discount a new quote or a pre-existing open quote',async()=>{
 const e=env();const quote=load('functions/requestLiveRate/entry.ts',e.bindings).handler;
 assert.equal((await quote(request({weight_lb:1,rewards_points:9999}))).status,409);
 await e.Quote.update('q1',{rewards_points:9999});assert.equal((await makeFinalize(e)(request(booking()))).status,409);assert.equal(e.Ship.creates,0);
});
test('admin compliance decision still requires independent review/business ownership',async()=>{
 const e=env();e.client.auth.me=async()=>({id:'admin',role:'admin'});
 const reviews=new Store([{id:'r',created_by_id:'requester',merchant_id:'m',compliance_status:'pending_review',item_category:'general-dry-goods',contents_description:'Synthetic fixture',quantity:1,has_battery:false,battery_details:''}]);
 (e.entities as any).ComplianceReview=reviews;(e.entities as any).Merchant=new Store([{id:'m',created_by_id:'different-owner'}]);
 const bindings={...e.bindings,...artifacts,POLICY_VERSION:'UNIT'};const fn=load('functions/validateShipmentCompliance/entry.ts',bindings).handler;
 assert.equal((await fn(request({action:'approve',review_id:'r'}))).status,409);assert.equal((await reviews.get('r')).compliance_status,'pending_review');
 await (e.entities as any).Merchant.update('m',{created_by_id:'requester'});
 assert.equal((await fn(request({action:'approve',review_id:'r'}))).status,200);
 const row=await reviews.get('r');assert.equal(await artifacts.verifiedPlan(row.approval_proof,'r','ComplianceReviewApproval',testKey),true);
});
test('declaration handler ignores caller decision, checks ownership and recovers lost insert ack',async()=>{
 const e=canonicalEnv();await e.ready;const declaration=new Store([]);(e.entities as any).ShipperDeclaration=declaration;
 await e.Ship.update('s1',{booking_intent:'draft:d1',compliance_evidence:{status:'permitted',policy_version:'UNIT',accepted_by:user.id,checked_at:'UNIT-TIME',declaration:{item_category:'general-dry-goods',contents_description:'Stored synthetic contents'},decision:{}}});
 const projection=load('shared/declarationProjection.ts',{ensureArtifact:artifacts.ensureArtifact},['settleBookingDeclaration']).settleBookingDeclaration;
 const fn=load('functions/validateShipmentCompliance/entry.ts',{...e.bindings,settleBookingDeclaration:projection}).handler;
 declaration.after=async(op:string)=>{if(op==='create')throw new Error('lost ack');};
 const payload={action:'record_declaration',shipment_id:'s1',compliance_decision:'prohibited',contents_description:'Caller replacement'};
 assert.equal((await fn(request(payload))).status,202);
 assert.equal((await fn(request(payload))).status,200);assert.equal(declaration.creates,1);
 const actual=[...declaration.rows.values()][0];assert.equal(actual.contents_description,'Stored synthetic contents');assert.equal(actual.compliance_decision,'permitted');
 e.client.auth.me=async()=>({id:'unrelated'});assert.equal((await fn(request(payload))).status,404);assert.equal(declaration.creates,1);
});
test('protected entity rules deny ordinary roles but retain explicit admin trust; hosted enforcement unverified',()=>{
 for(const entity of ['Shipment','ShipmentDraft','ShipmentQuote','ShipmentEvent','ShipperDeclaration','ComplianceReview','LegacyShipmentAuthority']) {
  const schema=JSON.parse(readFileSync(new URL(`entities/${entity}.jsonc`,root),'utf8'));
  for(const action of ['create','update','delete']){assert.deepEqual(schema.rls[action],{user_condition:{role:'admin'}},`${entity}.${action}`);const matches=(role:string)=>schema.rls[action].user_condition.role===role;assert.equal(matches('user'),false);assert.equal(matches('admin'),true);}
 }
});
test('controlled fixture fields and payment status fit the actual Shipment schema',async()=>{
 const e=controlledEnv();await e.ready;const fn=load('functions/createControlledTestShipment/entry.ts',e.bindings).handler;
 const response=await fn(request({draft_id:'d1',quote_id:'q1'}));assert.equal(response.status,200);const row=(await response.json()).shipment;
 const schema=JSON.parse(readFileSync(new URL('entities/Shipment.jsonc',root),'utf8'));
 for(const name of Object.keys(row))assert.ok(name==='id'||schema.properties[name],`Undeclared shipment field: ${name}`);
 assert.ok(schema.properties.payment_capture_status.enum.includes(row.payment_capture_status));
});
test('synthetic payment classification uses exact registered context, never a caller marker',async()=>{
 const guard=load('shared/syntheticPaymentGuard.ts',{findExceptionByMerchant:exceptions.findExceptionByMerchant,EXCEPTION_BUSINESSES:exceptions.EXCEPTION_BUSINESSES},['syntheticPaymentDenied','syntheticWalletDenied']);
 const alpha=exceptions.EXCEPTION_BUSINESSES[0];assert.equal(guard.syntheticPaymentDenied({id:alpha.local_merchant_id}),true);
 assert.equal(guard.syntheticPaymentDenied({id:'ordinary',sandbox_isolated:true,test_harness:true}),false);
 const sr={entities:{Merchant:{get:async()=>({id:alpha.local_merchant_id,created_by_id:alpha.approved_user_id})}}};
 assert.equal(await guard.syntheticWalletDenied(sr,alpha.approved_user_id),true);assert.equal(await guard.syntheticWalletDenied(sr,'unrelated-user'),false);
});

test('policy model exposes platform-admin mutation trust instead of claiming server-only storage',async()=>{
 const e=canonicalEnv();await e.ready;const sdk=ownerSDK(e,{id:'admin-test',role:'admin'});
 const created=await sdk.ShipmentDraft.create({status:'draft'});assert.ok(created.id);await sdk.ShipmentDraft.update(created.id,{booking_command_claim:'privileged-change'});assert.equal((await sdk.ShipmentDraft.get(created.id)).booking_command_claim,'privileged-change');await sdk.ShipmentDraft.delete(created.id);
});
test('coordinated Merchant pull receiver verifies v2 request and response, rejects replay and retains legacy peer path',async()=>{
 const secretsMap:any={PLATFORM_SYNC_SECRET:'UNIT-ONLY-LEGACY-PULL-TOKEN',LEX_PULL_LEX_SECRET:'UNIT-ONLY-DEDICATED-PULL-SECRET-1234567890'};
 const P=new Store([{id:'peer',connection_id:'lex-connection',status:'active',secret_env:'LEX_PULL_LEX_SECRET',target:'https://merchant.unit/functions/lexSyncEndpoint',merchant_ids:['allowed']}]);
 const S=new Store([{id:'local-record',merchant_id:'allowed',tracking_number:'REAL-TRACK',status:'pending',weight_lb:1,created_date:'2026-10-30T00:00:00Z'},{id:'other',merchant_id:'other-business',tracking_number:'OTHER-TRACK',status:'pending',weight_lb:1}]);
 (S as any).list=async()=>[...S.rows.values()].map(x=>structuredClone(x));
 const bindings:any={cas:claims.cas,expect:claims.expected,secrets:{get:(k:string)=>secretsMap[k]},operationalAuthority:async(_b:any,row:any)=>({ok:true,shipment:row}),arrayRows:(v:any)=>Array.isArray(v)?v:v.items};
 const protocol=load('shared/lexPullProtocol.ts',bindings,['signPull','verifyPullResponse','pullReceiver','claimPullNonce']);Object.assign(bindings,protocol);
 bindings.createClientFromRequest=()=>({auth:{me:async()=>null},asServiceRole:{entities:{LexPullPeer:P,Shipment:S}}});
 const fn=load('functions/lexSyncEndpoint/entry.ts',bindings).handler,challenge=await protocol.signPull('https://merchant.unit/functions/lexSyncEndpoint','lex-connection',secretsMap.LEX_PULL_LEX_SECRET);
 const request=()=>new Request(challenge.target,{headers:challenge.headers});const response=await fn(request());assert.equal(response.status,200);const data=await protocol.verifyPullResponse(challenge,await response.text(),response.headers.get('X-LEX-Response-Signature'),secretsMap.LEX_PULL_LEX_SECRET);assert.equal(data.events.length,1);assert.equal(data.events[0].tracking_id,'REAL-TRACK');assert.notEqual(data.events[0].tracking_id,'local-record');assert.equal((await fn(request())).status,401);
 const legacy=await fn(new Request('https://merchant.unit/functions/lexSyncEndpoint?token='+secretsMap.PLATFORM_SYNC_SECRET));assert.equal(legacy.status,200);assert.equal((await legacy.json()).events.length,2);
});
