// Runs the real trigger and backfill handlers with a stubbed fetch and a fake Realtime Database, so a
// dependency upgrade that breaks them (e.g. a removed API) fails here instead of on the first real call.
const assert = require("node:assert/strict");
const test = require("node:test");

// defineString defaults are applied by the Firebase CLI at deploy time, so provide the values directly.
Object.assign(process.env, {
  TIME_LEFT_INGESTION_TOKEN: "test-token",
  TIME_LEFT_CALENDAR_ID: "cal-1",
  TIME_LEFT_CONNECTION_ID: "conn-1",
  TIME_LEFT_SINGLE_INGEST_ENDPOINT: "https://time-left.test/ingestOne",
  TIME_LEFT_BATCH_INGEST_ENDPOINT: "https://time-left.test/ingestBatch",
  TIME_LEFT_LIFE_EVENT_ENDPOINT: "https://time-left.test/lifeEvents",
  MYDOUBLE_OWNER_UID: "owner-uid",
  MYDOUBLE_APP_BASE_URL: "https://app.test",
  MYDOUBLE_TIMEZONE: "America/Toronto",
});

const fetchCalls = [];
// A response may carry `_status` to simulate an HTTP error from Time Left.
let timeLeftResponse = () => ({ created: 1 });
global.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  fetchCalls.push({ url, headers: init.headers, body, bytes: Buffer.byteLength(init.body) });
  const response = timeLeftResponse(body, url);
  const status = response._status || 200;
  return { ok: status < 400, status, text: async () => JSON.stringify(response) };
};
const cardCalls = () => fetchCalls.filter((call) => call.url.endsWith("/ingestOne"));
const lifeEventCalls = () => fetchCalls.filter((call) => call.url.endsWith("/lifeEvents"));

const dbReads = [];
let storedSessions = {};
const fakeDatabase = {
  ref: (path) => ({
    limitToLast: (limit) => ({
      once: async (eventType) => {
        dbReads.push({ path, limit, eventType });
        return { val: () => storedSessions };
      },
    }),
  }),
};
// Replace the Admin SDK's database module before the handlers load it.
const databaseModule = require.resolve("firebase-admin/database");
require.cache[databaseModule] = {
  id: databaseModule, filename: databaseModule, loaded: true, exports: { getDatabase: () => fakeDatabase },
};

const triggers = require("../timeLeftMyDouble/triggers");

const snapshot = (value) => ({ exists: () => value != null, val: () => value });
const change = (before, after) => ({ before: snapshot(before), after: snapshot(after) });
const eveningSession = {
  startedAtMs: Date.UTC(2028, 6, 26, 0, 30, 0), // 20:30 the previous evening in Toronto
  endedAtMs: Date.UTC(2028, 6, 26, 0, 50, 0),
  activeMs: 1200000,
  perDouble: {
    D1: { attempts: 1, completed: true, hitDart: 1 },
    DBULL: { attempts: 3, completed: true, hitDart: 3 },
  },
};

test.beforeEach(() => {
  timeLeftResponse = () => ({ created: 1 });
  fetchCalls.length = 0;
  dbReads.length = 0;
  storedSessions = {};
});

async function callBackfill({ method = "POST", token, query = {}, body = {} } = {}) {
  const out = {};
  const res = {
    status(code) { out.status = code; return this; },
    set() { return this; },
    json(payload) { out.body = payload; return this; },
  };
  const headers = token === undefined ? {} : { authorization: `Bearer ${token}` };
  await triggers.backfillMyDoubleSessionsToTimeLeft(
    { method, query, body, get: (name) => headers[name.toLowerCase()] }, res,
  );
  return out;
}

test("a session written by the owner is sent to Time Left with the right date and bullseye", async () => {
  await triggers.syncMyDoubleSessionToTimeLeft.run(
    change(null, eveningSession), { params: { uid: "owner-uid", sessionId: "s1" } },
  );

  assert.equal(cardCalls().length, 1);
  const [call] = cardCalls();
  assert.equal(call.url, "https://time-left.test/ingestOne");
  assert.equal(call.headers.Authorization, "Bearer test-token");
  assert.equal(call.body.calendarId, "cal-1");
  assert.equal(call.body.item.dateId, "2028-07-25");
  assert.equal(call.body.item.syncStatus, "active");
  assert.equal(call.body.item.sourceDocumentPath, "users/owner-uid/sessions/s1");
  assert.equal(call.body.item.metadata.perDouble.find((row) => row.double === "Bull").attempts, 3);
});

test("a deleted session is reported as deletedFromSource, and another user's session is ignored", async () => {
  await triggers.syncMyDoubleSessionToTimeLeft.run(
    change(eveningSession, null), { params: { uid: "owner-uid", sessionId: "s1" } },
  );
  assert.equal(cardCalls()[0].body.item.syncStatus, "deletedFromSource");

  fetchCalls.length = 0;
  await triggers.syncMyDoubleSessionToTimeLeft.run(
    change(null, eveningSession), { params: { uid: "someone-else", sessionId: "s2" } },
  );
  assert.equal(fetchCalls.length, 0);
});

test("the backfill rejects a wrong method, a missing token and a wrong token before reading anything", async () => {
  assert.equal((await callBackfill({ method: "GET" })).status, 405);
  assert.equal((await callBackfill()).status, 403);
  assert.equal((await callBackfill({ token: "nope" })).status, 403);
  assert.equal(dbReads.length, 0);
  assert.equal(fetchCalls.length, 0);
});

test("the backfill posts every session to Time Left in batches that stay under its 64 KB request limit", async () => {
  storedSessions = Object.fromEntries(
    Array.from({ length: 150 }, (_, i) => [`s${i}`, eveningSession]),
  );

  const out = await callBackfill({ token: "test-token" });

  assert.equal(out.status, undefined, "success responds with res.json(), not an error status");
  assert.equal(out.body.ok, true);
  assert.equal(out.body.scanned, 150);
  assert.equal(out.body.sent, 150);
  assert.deepEqual(dbReads, [{ path: "users/owner-uid/sessions", limit: 500, eventType: "value" }]);

  // Each item is ~3 KB, so 150 of them can't go in one or two requests.
  assert.ok(fetchCalls.length > 2, `expected several batches, got ${fetchCalls.length}`);
  for (const call of fetchCalls) {
    assert.equal(call.url, "https://time-left.test/ingestBatch");
    assert.ok(call.bytes <= 64 * 1024, `a request was ${call.bytes} bytes, over Time Left's 64 KB limit`);
    assert.ok(call.body.items.length <= 100);
  }
  assert.equal(fetchCalls.reduce((n, call) => n + call.body.items.length, 0), 150, "nothing is dropped");
  assert.equal(out.body.batches.reduce((n, b) => n + b.count, 0), 150);
  assert.equal(fetchCalls[0].body.items[0].dateId, "2028-07-25");
});

test("the backfill limit comes from the query or body and is clamped to 1..1000", async () => {
  await callBackfill({ token: "test-token", query: { limit: "7" } });
  await callBackfill({ token: "test-token", body: { limit: 25 } });
  await callBackfill({ token: "test-token", query: { limit: "5000" } });
  assert.deepEqual(dbReads.map((r) => r.limit), [7, 25, 1000]);
});

test("when Time Left reports per-item errors, the backfill shows which sessions and the distinct messages", async () => {
  storedSessions = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`s${i}`, eveningSession]));
  timeLeftResponse = (body) => ({
    updated: body.items.length,
    errors: body.items.map((_, index) => ({
      index,
      message: index % 2 ? "eventClass is not allowed for this source connection." : "Something else went wrong.",
    })),
  });

  const out = await callBackfill({ token: "test-token" });

  assert.equal(out.body.failed, 30);
  const [first] = out.body.batches;
  assert.equal(first.errors, first.count);
  assert.equal(first.errorSamples.length, 2);
  assert.match(first.errorSamples[0].sessionId, /^s\d+$/, "names the session, not just an index");
  assert.deepEqual(
    out.body.errorSummary.map((entry) => entry.message).sort(),
    ["Something else went wrong.", "eventClass is not allowed for this source connection."],
  );
  assert.equal(out.body.errorSummary.reduce((n, entry) => n + entry.count, 0), 30);
});

test("with no errors there is no errorSummary", async () => {
  storedSessions = { s1: eveningSession };
  const out = await callBackfill({ token: "test-token" });
  assert.equal(out.body.errorSummary, undefined);
  assert.equal(out.body.failed, 0);
});

// ---- the life event that gives the Activity dashboard a timed session ----

test("a saved session sends its life event first, then its card, with the duration and the same source key", async () => {
  await triggers.syncMyDoubleSessionToTimeLeft.run(
    change(null, eveningSession), { params: { uid: "owner-uid", sessionId: "s1" } },
  );

  assert.deepEqual(fetchCalls.map((call) => call.url), ["https://time-left.test/lifeEvents", "https://time-left.test/ingestOne"]);
  const [event] = lifeEventCalls();
  assert.equal(event.headers.Authorization, "Bearer test-token");
  assert.equal(event.body.calendarId, "cal-1");
  assert.equal(event.body.connectionId, "conn-1");
  assert.equal(event.body.integrationId, "conn-1", "the connection id, since the connection has no integrationId");
  const item = event.body.item;
  assert.equal(item.durationSeconds, 1200);
  assert.equal(item.activityFamily, "darts");
  assert.equal(item.eventClass, "completed_activity");
  assert.equal(item.startAt, new Date(eveningSession.startedAtMs).toISOString());
  assert.equal(item.sourceEventId, "users/owner-uid/sessions/s1");
  assert.equal(item.sourceEventId, cardCalls()[0].body.item.sourceDocumentPath, "same key as the card's own life event");
  assert.equal(item.metrics.darts, 10); // D1: 1 dart; Bull: two missed visits (6) then a hit on dart 3 = 9
});

test("a deleted session sends only the card, never a life event", async () => {
  await triggers.syncMyDoubleSessionToTimeLeft.run(
    change(eveningSession, null), { params: { uid: "owner-uid", sessionId: "s1" } },
  );
  assert.equal(lifeEventCalls().length, 0);
  assert.equal(cardCalls().length, 1);
});

test("if the life event is refused, the card is still sent", async () => {
  for (const refusal of [{ _status: 409, code: "idempotency_conflict" }, { _status: 500, message: "boom" }, { _status: 403 }]) {
    fetchCalls.length = 0;
    timeLeftResponse = (body, url) => (url.endsWith("/lifeEvents") ? refusal : { created: 1 });
    await triggers.syncMyDoubleSessionToTimeLeft.run(
      change(null, eveningSession), { params: { uid: "owner-uid", sessionId: "s1" } },
    );
    assert.equal(lifeEventCalls().length, 1, `life event attempted (${refusal._status})`);
    assert.equal(cardCalls().length, 1, `card still sent after a ${refusal._status}`);
  }
});

test("with the life-event endpoint left empty, only the card is sent", async () => {
  const saved = process.env.TIME_LEFT_LIFE_EVENT_ENDPOINT;
  process.env.TIME_LEFT_LIFE_EVENT_ENDPOINT = "";
  try {
    await triggers.syncMyDoubleSessionToTimeLeft.run(
      change(null, eveningSession), { params: { uid: "owner-uid", sessionId: "s1" } },
    );
  } finally {
    process.env.TIME_LEFT_LIFE_EVENT_ENDPOINT = saved;
  }
  assert.equal(lifeEventCalls().length, 0);
  assert.equal(cardCalls().length, 1);
});

test("a session with no start time sends no life event, but still sends its card", async () => {
  await triggers.syncMyDoubleSessionToTimeLeft.run(
    change(null, { perDouble: {} }), { params: { uid: "owner-uid", sessionId: "s1" } },
  );
  assert.equal(lifeEventCalls().length, 0);
  assert.equal(cardCalls().length, 1);
});

test("the backfill still sends cards only; it doesn't retry life events Time Left already holds", async () => {
  storedSessions = { s1: eveningSession, s2: eveningSession };
  await callBackfill({ token: "test-token" });
  assert.equal(lifeEventCalls().length, 0);
  assert.ok(fetchCalls.length > 0 && fetchCalls.every((call) => call.url.endsWith("/ingestBatch")));
});

test("an integration id set in the environment is the one sent with the life event", async () => {
  process.env.TIME_LEFT_INTEGRATION_ID = "integration-9";
  try {
    await triggers.syncMyDoubleSessionToTimeLeft.run(
      change(null, eveningSession), { params: { uid: "owner-uid", sessionId: "s1" } },
    );
  } finally {
    delete process.env.TIME_LEFT_INTEGRATION_ID;
  }
  assert.equal(lifeEventCalls()[0].body.integrationId, "integration-9");
});
