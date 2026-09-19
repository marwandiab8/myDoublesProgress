const assert = require("node:assert/strict");
const test = require("node:test");
const {
  dateIdFromMs,
  mapSessionToTimeLeft,
  summarizeDoubles,
} = require("../timeLeftMyDouble/mappers");

test("dateIdFromMs formats local YYYY-MM-DD", () => {
  const ms = new Date(2028, 6, 25, 10, 30, 0).getTime();
  assert.equal(dateIdFromMs(ms), "2028-07-25");
});

test("summarizeDoubles counts attempts and hits", () => {
  const stats = summarizeDoubles({
    D1: { attempts: 1, completed: true, hitDart: 1 },
    D2: { attempts: 2, completed: true, hitDart: 2 },
    D3: { attempts: 1, completed: false, hitDart: null },
  });
  assert.deepEqual(stats, {
    attempts: 4,
    completed: 2,
    hitOnOne: 1,
    hitOnTwo: 1,
    hitOnThree: 0,
    missed: 1,
  });
});

test("maps session to Time Left progress record", () => {
  const item = mapSessionToTimeLeft({
    startedAtMs: new Date(2028, 6, 25, 9, 0, 0).getTime(),
    endedAtMs: new Date(2028, 6, 25, 9, 30, 0).getTime(),
    activeMs: 1800000,
    perDouble: {
      D1: { attempts: 1, completed: true, hitDart: 1 },
    },
  }, {
    appBaseUrl: "https://mydoublesprogress.web.app",
    sourceFirebaseProjectId: "mydoublesprogress",
    sourceProjectId: "mydoublesprogress",
    uid: "u1",
    sessionId: "s1",
  });
  assert.equal(item.sourceApp, "MyDoubleProgress");
  assert.equal(item.category, "progressRecord");
  assert.equal(item.dateId, "2028-07-25");
  assert.equal(item.sourceDocumentPath, "users/u1/sessions/s1");
  assert.equal(item.metadata.sessionId, "s1");
});

test("dateIdFromMs uses the given timezone instead of server-local time", () => {
  const ms = Date.UTC(2028, 6, 26, 0, 30, 0); // 00:30 UTC == 20:30 the previous evening in Toronto
  assert.equal(dateIdFromMs(ms, "UTC"), "2028-07-26");
  assert.equal(dateIdFromMs(ms, "America/Toronto"), "2028-07-25");
});

test("dateIdFromMs falls back to local time for an invalid timezone", () => {
  const ms = new Date(2028, 6, 25, 10, 30, 0).getTime();
  assert.equal(dateIdFromMs(ms, "Not/AZone"), "2028-07-25");
});

test("mapSessionToTimeLeft prefers the app-recorded localDate", () => {
  const item = mapSessionToTimeLeft({
    startedAtMs: Date.UTC(2028, 6, 26, 0, 30, 0),
    localDate: "2028-07-25",
    perDouble: {},
  }, { timeZone: "UTC", uid: "u1", sessionId: "s1" });
  assert.equal(item.dateId, "2028-07-25");
});

test("mapSessionToTimeLeft ignores a malformed localDate and uses the timezone", () => {
  const item = mapSessionToTimeLeft({
    startedAtMs: Date.UTC(2028, 6, 26, 0, 30, 0),
    localDate: "yesterday",
    perDouble: {},
  }, { timeZone: "America/Toronto", uid: "u1", sessionId: "s1" });
  assert.equal(item.dateId, "2028-07-25");
});

test("mapSessionToTimeLeft reports the bullseye stored under the app's DBULL key", () => {
  const item = mapSessionToTimeLeft({
    startedAtMs: new Date(2028, 6, 25, 9, 0, 0).getTime(),
    perDouble: {
      DBULL: { attempts: 3, completed: true, hitDart: 3 },
    },
  }, { uid: "u1", sessionId: "s1" });
  const bull = item.metadata.perDouble.find((row) => row.double === "Bull");
  assert.equal(bull.attempts, 3);
  assert.equal(bull.completed, true);
  assert.equal(bull.hitDart, 3);
  assert.equal(item.metadata.perDouble.length, 21);
});
