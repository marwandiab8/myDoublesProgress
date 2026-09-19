const assert = require("node:assert/strict");
const test = require("node:test");
const {
  dateIdFromMs,
  mapSessionToLifeEvent,
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
    darts: 9, // D1: 1, D2: missed once (3) then hit on dart 2 (2), D3: missed once (3)
    extraDarts: 0,
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

test("the summary and description carry the numbers Time Left actually displays", () => {
  const item = mapSessionToTimeLeft({
    startedAtMs: new Date(2028, 6, 25, 9, 0, 0).getTime(),
    endedAtMs: new Date(2028, 6, 25, 9, 30, 0).getTime(),
    activeMs: 1800000,
    perDouble: {
      D1: { attempts: 1, completed: true, hitDart: 1 }, // 1 dart
      D2: { attempts: 2, completed: true, hitDart: 2 }, // 3 + 2 = 5 darts
      D3: { attempts: 3, completed: true, hitDart: 3 }, // 6 + 3 = 9 darts
      DBULL: { attempts: 2, completed: true, hitDart: 3 }, // 3 + 3 = 6 darts
    },
  }, { uid: "u1", sessionId: "s1" });

  assert.equal(item.summary, "4/21 doubles completed, 21 darts in 8 attempts, 30m 0s.");
  assert.equal(
    item.description,
    "Hit on dart 1: 1, dart 2: 1, dart 3: 2. Averaged 5.3 darts per double. Most darts: D3 (9), Bull (6), D2 (5).",
  );
  assert.equal(item.metadata.darts, 21);
  assert.equal(item.metadata.dartsPerDouble, 5.3);
  assert.deepEqual(item.metadata.mostDarts, [
    { double: "D3", darts: 9 }, { double: "Bull", darts: 6 }, { double: "D2", darts: 5 },
  ]);
});

test("the description leaves out 'most darts' when every double went in within one visit, and pluralizes", () => {
  const item = mapSessionToTimeLeft({
    startedAtMs: new Date(2028, 6, 25, 9, 0, 0).getTime(),
    perDouble: { D1: { attempts: 1, completed: true, hitDart: 1 } },
  }, { uid: "u1", sessionId: "s1" });

  assert.equal(item.summary, "1/21 doubles completed, 1 dart in 1 attempt.");
  assert.equal(item.description, "Hit on dart 1: 1, dart 2: 0, dart 3: 0. Averaged 1.0 darts per double.");
});

test("an empty session has an empty description and no average", () => {
  const item = mapSessionToTimeLeft({ startedAtMs: new Date(2028, 6, 25, 9, 0, 0).getTime(), perDouble: {} }, { uid: "u1", sessionId: "s1" });
  assert.equal(item.description, "");
  assert.equal(item.metadata.dartsPerDouble, null);
  assert.equal(item.summary, "0/21 doubles completed, 0 darts in 0 attempts.");
});

test("the description says which doubles were stayed on for extra darts", () => {
  const item = mapSessionToTimeLeft({
    startedAtMs: new Date(2028, 6, 25, 9, 0, 0).getTime(),
    perDouble: {
      D7: { attempts: 3, completed: true, hitDart: 1, extraDarts: 4 }, // hit on the 7th dart
      DBULL: { attempts: 3, completed: false, extraDarts: 6 }, // 9 darts, no hit
      D2: { attempts: 1, completed: true, hitDart: 2 },
    },
  }, { uid: "u1", sessionId: "s1" });

  assert.match(item.description, /Stayed on D7 \(\+4\), Bull \(\+6\) for 10 extra darts\.$/);
  assert.equal(item.metadata.extraDarts, 10);
  assert.deepEqual(item.metadata.stayedOn, [{ double: "D7", extraDarts: 4 }, { double: "Bull", extraDarts: 6 }]);
});

test("a session with no stays doesn't mention extra darts", () => {
  const item = mapSessionToTimeLeft({
    startedAtMs: new Date(2028, 6, 25, 9, 0, 0).getTime(),
    perDouble: { D1: { attempts: 2, completed: true, hitDart: 2 } },
  }, { uid: "u1", sessionId: "s1" });
  assert.doesNotMatch(item.description, /Stayed|extra/);
  assert.equal(item.metadata.extraDarts, 0);
  assert.deepEqual(item.metadata.stayedOn, []);
});

test("the title carries the darts total, since that is all the Activity dashboard shows", () => {
  const started = new Date(2028, 6, 25, 9, 0, 0).getTime();
  const withDarts = mapSessionToTimeLeft({
    startedAtMs: started,
    perDouble: { D1: { attempts: 3, completed: true, hitDart: 1, extraDarts: 4 } },
  }, { uid: "u1", sessionId: "s1" });
  assert.equal(withDarts.title, "Doubles practice - 2028-07-25 · 7 darts");

  const single = mapSessionToTimeLeft({
    startedAtMs: started,
    perDouble: { D1: { attempts: 1, completed: true, hitDart: 1 } },
  }, { uid: "u1", sessionId: "s1" });
  assert.equal(single.title, "Doubles practice - 2028-07-25 · 1 dart");

  const empty = mapSessionToTimeLeft({ startedAtMs: started, perDouble: {} }, { uid: "u1", sessionId: "s1" });
  assert.equal(empty.title, "Doubles practice - 2028-07-25", "no darts, no suffix");
});

// ---- life event for the Activity dashboard ----

const lifeSession = {
  startedAtMs: Date.UTC(2028, 6, 26, 0, 30, 0),
  endedAtMs: Date.UTC(2028, 6, 26, 1, 5, 0), // wall clock includes 10 minutes paused
  activeMs: 1500000, // 25 minutes of actual practice
  localDate: "2028-07-25",
  perDouble: {
    D1: { attempts: 1, completed: true, hitDart: 1 },
    D7: { attempts: 3, completed: true, hitDart: 1, extraDarts: 4 }, // hit on the 7th dart
  },
};
const lifeOptions = { uid: "u1", sessionId: "s1", timeZone: "America/Toronto" };

test("the life event is a timed darts session: active-time duration, start, family, class", () => {
  const event = mapSessionToLifeEvent(lifeSession, lifeOptions);
  assert.equal(event.schemaVersion, 1);
  assert.equal(event.sourceApp, "MyDoubleProgress");
  assert.equal(event.eventType, "darts_practice");
  assert.equal(event.eventClass, "completed_activity");
  assert.equal(event.activityFamily, "darts");
  assert.equal(event.categoryId, "darts");
  assert.equal(event.startAt, "2028-07-26T00:30:00.000Z");
  assert.equal(event.occurredAt, event.startAt);
  assert.equal(event.durationSeconds, 1500, "active time, not the wall-clock span");
  assert.equal(event.endAt, undefined, "no endAt, so it can't disagree with the duration");
  assert.equal(event.timezone, "America/Toronto");
  assert.equal(event.privacyLevel, "ownerOnly");
});

test("the life event shares the card's title and its source key", () => {
  const event = mapSessionToLifeEvent(lifeSession, lifeOptions);
  const card = mapSessionToTimeLeft(lifeSession, lifeOptions);
  assert.equal(event.title, card.title);
  assert.equal(event.title, "Doubles practice - 2028-07-25 · 8 darts");
  assert.equal(event.sourceEventId, card.sourceDocumentPath, "same idempotency identity as the card's own life event");
  assert.equal(event.sourceRecordId, card.sourceDocumentPath);
  assert.equal(event.sourceEventId, "users/u1/sessions/s1");
});

test("the life event carries metrics, and the summary as the note the dashboard can show", () => {
  const event = mapSessionToLifeEvent(lifeSession, lifeOptions);
  assert.deepEqual(event.metrics, { darts: 8, extraDarts: 4, attempts: 4, doublesCompleted: 2, dartsPerDouble: 4 });
  assert.match(event.metadata.note, /^2\/21 doubles completed, 8 darts in 4 attempts, 25m 0s\./);
  assert.match(event.metadata.note, /Stayed on D7 \(\+4\)/);
  assert.equal(event.metadata.summary, "2/21 doubles completed, 8 darts in 4 attempts, 25m 0s.");
  assert.equal(event.metadata.perDouble.length, 21);
  assert.equal(event.metadata.extraDarts, 4);
});

test("no start time means no life event; no active time means no duration", () => {
  assert.equal(mapSessionToLifeEvent({ perDouble: {} }, lifeOptions), null);
  const noDuration = mapSessionToLifeEvent({ ...lifeSession, activeMs: 0 }, lifeOptions);
  assert.equal("durationSeconds" in noDuration, false);
  const noTimezone = mapSessionToLifeEvent(lifeSession, { uid: "u1", sessionId: "s1" });
  assert.equal("timezone" in noTimezone, false);
});
