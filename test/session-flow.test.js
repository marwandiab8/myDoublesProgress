// Drives the real <script type="module"> from public/index.html against an in-memory stand-in for
// the Firebase SDK. Run with: node --test test/
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const html = fs.readFileSync(process.env.INDEX_HTML || path.join(__dirname, "..", "public", "index.html"), "utf8");
const pageScript = html
  .match(/<script type="module">([\s\S]*?)<\/script>/)[1]
  .replace(/import\s*\{[^}]*\}\s*from\s*"[^"]+";/g, "");

const SDK_NAMES = [
  "initializeApp", "getAuth", "GoogleAuthProvider", "signInWithPopup", "signInWithRedirect",
  "getRedirectResult", "onAuthStateChanged", "signOut", "getDatabase", "ref", "onValue",
  "runTransaction", "push", "set", "remove", "get", "update", "serverTimestamp", "query", "limitToLast",
  "orderByChild", "startAt",
];

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const tick = () => new Promise((resolve) => setImmediate(resolve));

// Realtime Database drops nulls and empty objects and resolves server timestamps on write.
function normalize(value, now) {
  if (value && typeof value === "object") {
    if (value[".sv"] === "timestamp") return now;
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const n = normalize(v, now);
      if (n !== null && n !== undefined) out[k] = n;
    }
    return Object.keys(out).length ? out : null;
  }
  return value === undefined ? null : value;
}

function prune(node) {
  for (const [k, v] of Object.entries(node)) {
    if (v && typeof v === "object") {
      prune(v);
      if (!Object.keys(v).length) delete node[k];
    }
  }
}

class FakeDb {
  constructor(initial, clock) {
    this.root = initial ? clone(initial) : {};
    this.clock = clock;
    this.listeners = new Set();
    this.keyCounter = 0;
    this.failNext = { set: 0, remove: 0, get: 0 };
    this.txPaths = []; // every path a transaction ran on
    this.interfere = null; // runs once between a transaction's read and its commit
  }

  get(p) {
    let node = this.root;
    for (const part of p.split("/").filter(Boolean)) {
      if (node === null || typeof node !== "object") return null;
      node = node[part];
    }
    return node === undefined ? null : clone(node);
  }

  write(p, value) {
    const parts = p.split("/").filter(Boolean);
    const v = normalize(value, this.clock.t);
    if (!parts.length) {
      this.root = v || {};
    } else {
      let node = this.root;
      for (const part of parts.slice(0, -1)) {
        if (node[part] === null || typeof node[part] !== "object") node[part] = {};
        node = node[part];
      }
      if (v === null) delete node[parts.at(-1)];
      else node[parts.at(-1)] = v;
      prune(this.root);
    }
    for (const l of [...this.listeners]) l.cb(this.snapshot(l.path));
  }

  snapshot(p) {
    return {
      val: () => this.get(p),
      exists: () => this.get(p) !== null,
      child: (c) => this.snapshot(`${p}/${c}`),
    };
  }

  runTransaction(p, mutator) {
    this.txPaths.push(p);
    for (let attempt = 0; attempt < 5; attempt++) {
      const before = this.get(p);
      const result = mutator(clone(before));
      if (result === undefined) return { committed: false, snapshot: this.snapshot(p) };
      if (this.interfere) {
        const run = this.interfere;
        this.interfere = null;
        run();
      }
      // Like the real SDK: if the data changed underneath, run the mutator again on the new value.
      if (JSON.stringify(this.get(p)) !== JSON.stringify(before)) continue;
      this.write(p, result);
      return { committed: true, snapshot: this.snapshot(p) };
    }
    throw new Error("transaction retried too many times");
  }
}

function boot(initial) {
  const clock = { t: Date.UTC(2028, 6, 26, 15, 0, 0) };
  const db = new FakeDb(initial, clock);
  const alerts = [];
  const confirms = [];
  const state = { confirmAnswer: true, authCb: null, ticker: null };

  class FakeDate extends Date {
    constructor(...args) { if (args.length) super(...args); else super(clock.t); }
    static now() { return clock.t; }
  }

  const elements = new Map();
  const el = (id) => {
    if (!elements.has(id)) {
      const handlers = {};
      const node = {
        id, handlers, style: {}, disabled: false, className: "", value: "",
        writes: { innerHTML: 0, textContent: 0 }, // how many times the page assigned each property
        classList: { toggle() {}, add() {}, remove() {} },
        addEventListener(type, fn) { handlers[type] = fn; },
        scrollIntoView() {}, getBoundingClientRect() { return { top: 0 }; },
        querySelectorAll() { return []; }, closest() { return null; }, getAttribute() { return null; },
      };
      for (const prop of ["innerHTML", "textContent"]) {
        let value = "";
        Object.defineProperty(node, prop, {
          get: () => value,
          set: (v) => { value = v; node.writes[prop]++; },
        });
      }
      elements.set(id, node);
    }
    return elements.get(id);
  };

  const sdk = {
    initializeApp: () => ({}),
    getAuth: () => ({}),
    GoogleAuthProvider: class { setCustomParameters() {} },
    signInWithPopup: async () => {},
    signInWithRedirect: async () => {},
    getRedirectResult: async () => null,
    onAuthStateChanged: (_auth, cb) => { state.authCb = cb; },
    signOut: async () => { state.authCb(null); },
    getDatabase: () => ({}),
    ref: (_db, p) => ({ path: p }),
    query: (r) => r,
    limitToLast: () => null,
    orderByChild: () => null,
    startAt: () => null,
    serverTimestamp: () => ({ ".sv": "timestamp" }),
    push: (r) => {
      const key = `-K${String(++db.keyCounter).padStart(6, "0")}`;
      return { path: `${r.path}/${key}`, key };
    },
    onValue: (q, cb) => {
      const listener = { path: q.path, cb };
      db.listeners.add(listener);
      queueMicrotask(() => { if (db.listeners.has(listener)) cb(db.snapshot(q.path)); });
      return () => db.listeners.delete(listener);
    },
    runTransaction: async (r, fn) => db.runTransaction(r.path, fn),
    set: async (r, value) => {
      if (db.failNext.set > 0) {
        db.failNext.set--;
        throw Object.assign(new Error("network down"), { code: "network-error" });
      }
      db.write(r.path, value);
    },
    get: async (r) => {
      if (db.failNext.get > 0) {
        db.failNext.get--;
        throw Object.assign(new Error("network down"), { code: "network-error" });
      }
      return db.snapshot(r.path);
    },
    update: async (r, values) => {
      for (const [key, value] of Object.entries(values)) db.write(`${r.path}/${key}`, value);
    },
    remove: async (r) => {
      if (db.failNext.remove > 0) {
        db.failNext.remove--;
        throw Object.assign(new Error("network down"), { code: "network-error" });
      }
      db.write(r.path, null);
    },
  };

  const sandbox = {
    __sdk: sdk,
    Date: FakeDate,
    queueMicrotask,
    console: { error() {}, log() {}, warn() {} },
    alert: (message) => { alerts.push(message); },
    confirm: (message) => { confirms.push(message); return state.confirmAnswer; },
    document: { getElementById: el, addEventListener() {}, visibilityState: "visible" },
    window: { pageYOffset: 0, scrollTo() {} },
    history: { replaceState() {} },
    localStorage: { getItem: () => null, setItem() {} },
    setInterval: (fn) => { state.ticker = fn; return 1; }, clearInterval() {}, setTimeout: () => 0, requestAnimationFrame() {},
  };
  vm.runInNewContext(`const { ${SDK_NAMES.join(", ")} } = __sdk;\n${pageScript}`, sandbox);

  return {
    db, alerts, confirms, clock, el,
    setConfirm(answer) { state.confirmAnswer = answer; },
    // What the page treats as the user's data: state (activeSession, lifetime) plus the sessions history.
    user: () => ({ ...(db.get("users/u1/state") || {}), sessions: db.get("users/u1/sessions") ?? undefined }),
    raw: () => db.get("users/u1") || {},
    errorText: () => el("errorBox").textContent,
    // The page re-renders every 250ms; run that tick so button states reflect the latest change.
    renderTick() { state.ticker(); },
    async signOut() { state.authCb(null); await tick(); },
    async signIn() { state.authCb({ uid: "u1", email: "player@example.com" }); await tick(); },
    async click(id) { await el(id).handlers.click({ target: el(id) }); await tick(); },
    // Each throw takes one second, so a full round of 21 hits lasts 21s of active time.
    async throwHit(times = 1, id = "btnHit1") {
      for (let i = 0; i < times; i++) { clock.t += 1000; await this.click(id); }
    },
  };
}

async function startedApp() {
  const app = boot();
  await app.signIn();
  await app.click("btnStartNew");
  return app;
}

test("a new session gets a fixed history key", async () => {
  const app = await startedApp();
  const session = app.user().activeSession;
  assert.match(session.meta.sessionKey, /^-K\d+$/);
  assert.equal(session.meta.startedAtMs, app.clock.t);
});

test("finishing a round saves one history row under the session key and clears the active session", async () => {
  const app = await startedApp();
  const { sessionKey, startedAtMs } = app.user().activeSession.meta;

  await app.throwHit(21);

  const user = app.user();
  assert.equal(user.activeSession, undefined);
  assert.deepEqual(Object.keys(user.sessions), [sessionKey]);
  const row = user.sessions[sessionKey];
  assert.equal(row.startedAtMs, startedAtMs);
  assert.equal(row.activeMs, 21000);
  assert.equal(row.endedAtMs, app.clock.t);
  assert.equal(Object.keys(row.perDouble).length, 21);
  const d = new Date(startedAtMs);
  const pad = (n) => String(n).padStart(2, "0");
  assert.equal(row.localDate, `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
  assert.equal(user.lifetime.doubles.DBULL.hits, 1);
  assert.deepEqual(app.alerts, ["✅ Session saved automatically."]);
});

test("a failed save keeps the finished round, and Save session retries it without duplicating", async () => {
  const app = await startedApp();
  const { sessionKey } = app.user().activeSession.meta;
  await app.throwHit(20);
  app.db.failNext.set = 1;
  await app.throwHit(1);

  assert.match(app.errorText(), /network-error/);
  let user = app.user();
  assert.ok(user.activeSession, "finished round must stay in activeSession");
  assert.equal(user.sessions, undefined);
  assert.equal(app.el("btnSaveDone").disabled, false);
  assert.equal(app.el("btnPauseResume").disabled, true, "a finished round's timer must not be resumable");

  await app.click("btnSaveDone");
  user = app.user();
  assert.equal(user.activeSession, undefined);
  assert.deepEqual(Object.keys(user.sessions), [sessionKey]);
});

test("a finished round left behind by an interrupted save is saved on the next load", async () => {
  const app = await startedApp();
  const { sessionKey } = app.user().activeSession.meta;
  await app.throwHit(20);
  app.db.failNext.set = 1;
  await app.throwHit(1);

  const reloaded = boot({ users: { u1: app.raw() } });
  await reloaded.signIn();

  const user = reloaded.user();
  assert.equal(user.activeSession, undefined);
  assert.deepEqual(Object.keys(user.sessions), [sessionKey]);
  assert.deepEqual(reloaded.alerts, [], "recovery on load should be silent");
});

test("undo reverses only the last throw and keeps pauses taken since", async () => {
  const app = await startedApp();
  await app.throwHit(1); // D1 hit
  await app.throwHit(1, "btnMiss"); // D2 miss
  app.clock.t += 5000;
  await app.click("btnPauseResume");
  app.clock.t += 10 * 60 * 1000; // ten minutes paused
  await app.click("btnPauseResume");
  const timerBefore = app.user().activeSession.timer;

  await app.click("btnUndo");

  const user = app.user();
  assert.deepEqual(user.activeSession.timer, timerBefore, "undo must not touch the timer");
  assert.equal(user.activeSession.doubles.D2.attempts ?? 0, 0);
  assert.equal(user.activeSession.doubles.D1.completed, true);
  assert.equal(user.activeSession.flow.cursorIndex, 1);
  assert.equal(user.lifetime.doubles.D2.attempts ?? 0, 0);
  assert.equal(user.lifetime.doubles.D1.attempts, 1);
  app.renderTick();
  assert.equal(app.el("btnUndo").disabled, true);
});

test("undoing the finishing throw restores the round, un-freezes the timer and removes the saved row", async () => {
  const app = await startedApp();
  await app.throwHit(21);
  app.clock.t += 60 * 1000; // time spent looking at the finished board

  await app.click("btnUndo");

  const user = app.user();
  const session = user.activeSession;
  assert.ok(session, "round is active again");
  assert.equal(session.doubles.DBULL.attempts ?? 0, 0);
  assert.equal(session.doubles.DBULL.completed ?? false, false);
  assert.equal(session.flow.cursorIndex, 20);
  assert.equal(session.timer.isPaused, false);
  assert.equal(session.timer.activeMsAccum, 21000, "the minute spent finished must not count");
  assert.equal(session.timer.lastResumedAtMs, app.clock.t);
  assert.equal(user.sessions, undefined, "history row removed");
  assert.equal(user.lifetime.doubles.DBULL.attempts ?? 0, 0);
  assert.equal(user.lifetime.doubles.DBULL.hits ?? 0, 0);
  assert.equal(user.lifetime.doubles.DBULL.hits1 ?? 0, 0);
  assert.equal(user.lifetime.doubles.D1.attempts, 1);
});

test("if removing the history row fails, finishing again overwrites that same row", async () => {
  const app = await startedApp();
  const { sessionKey } = app.user().activeSession.meta;
  await app.throwHit(21);
  app.db.failNext.remove = 1;

  await app.click("btnUndo");

  assert.match(app.errorText(), /history-not-removed/);
  assert.ok(app.user().activeSession, "the round itself was still restored");
  assert.deepEqual(Object.keys(app.user().sessions), [sessionKey]);
  app.renderTick();
  assert.equal(app.el("btnUndo").disabled, true);

  await app.throwHit(1);

  const user = app.user();
  assert.equal(user.activeSession, undefined);
  assert.deepEqual(Object.keys(user.sessions), [sessionKey]);
  assert.equal(user.sessions[sessionKey].activeMs, 22000);
});

test("undo is refused when the double was changed elsewhere since", async () => {
  const app = await startedApp();
  await app.throwHit(1);
  app.db.write("users/u1/state/activeSession/doubles/D1/attempts", 5); // e.g. a throw logged on another device

  await app.click("btnUndo");

  assert.match(app.alerts.at(-1), /changed since/);
  assert.equal(app.user().activeSession.doubles.D1.attempts, 5);
  assert.equal(app.user().lifetime.doubles.D1.attempts, 1);
});

test("a throw retried by a contended transaction is counted, and undone, exactly once", async () => {
  const app = await startedApp();
  app.db.interfere = () => app.db.write("users/u1/state/lifetime/doubles/D20/attempts", 7);

  await app.throwHit(1);
  assert.equal(app.user().lifetime.doubles.D1.attempts, 1);
  assert.equal(app.user().lifetime.doubles.D20.attempts, 7);

  await app.click("btnUndo");
  assert.equal(app.user().lifetime.doubles.D1.attempts ?? 0, 0);
  assert.equal(app.user().lifetime.doubles.D20.attempts, 7, "undo must not touch other doubles");
});

test("Start new session asks first when throws are logged, and only then discards them", async () => {
  const app = await startedApp();
  await app.throwHit(1);
  const startedAtMs = app.user().activeSession.meta.startedAtMs;

  app.setConfirm(false);
  app.clock.t += 1000;
  await app.click("btnStartNew");
  assert.equal(app.confirms.length, 1);
  assert.match(app.confirms[0], /1 throw logged/);
  assert.equal(app.user().activeSession.meta.startedAtMs, startedAtMs);

  app.setConfirm(true);
  await app.click("btnStartNew");
  assert.notEqual(app.user().activeSession.meta.startedAtMs, startedAtMs);
  assert.equal(app.user().activeSession.doubles.D1.attempts, 0);
});

test("throws and listeners stay off the sessions history", async () => {
  const app = await startedApp();
  await app.throwHit(2);
  await app.throwHit(1, "btnMiss");
  await app.click("btnUndo");

  assert.ok(app.db.txPaths.length > 0);
  assert.deepEqual([...new Set(app.db.txPaths)], ["users/u1/state"]);
  const listened = [...app.db.listeners].map((l) => l.path);
  assert.ok(listened.includes("users/u1/state"));
  assert.ok(!listened.includes("users/u1"), "nothing may listen on the whole user node");
});

test("a new user can start straight away and nothing is written until they act", async () => {
  const app = boot();
  await app.signIn();
  app.renderTick();
  assert.equal(app.el("btnStartNew").disabled, false);
  assert.deepEqual(app.raw(), {});
});

const legacyRound = (startedAtMs) => ({
  meta: { startedAtMs, sessionKey: "-Kold" },
  timer: { isPaused: false, pauseStartedAtMs: null, activeMsAccum: 0, lastResumedAtMs: startedAtMs },
  flow: { cursorIndex: 0 },
  doubles: { D1: { attempts: 0, completed: false } },
});

test("data from before the state split is moved over once, and the round carries on", async () => {
  const startedAtMs = Date.UTC(2028, 6, 26, 14, 0, 0);
  const app = boot({ users: { u1: {
    lifetime: { doubles: { D1: { attempts: 4, hits: 2, hits1: 2, hits2: 0, hits3: 0 } } },
    activeSession: legacyRound(startedAtMs),
    sessions: { "-Kprev": { startedAtMs: 1, activeMs: 5, perDouble: {} } },
  } } });
  await app.signIn();

  const raw = app.raw();
  assert.equal(raw.state.lifetime.doubles.D1.attempts, 4);
  assert.equal(raw.state.activeSession.meta.startedAtMs, startedAtMs);
  assert.equal(raw.lifetime, undefined, "old copy removed after the move");
  assert.equal(raw.activeSession, undefined, "old copy removed after the move");
  assert.deepEqual(Object.keys(raw.sessions), ["-Kprev"], "history untouched");

  await app.throwHit(1);
  assert.equal(app.user().activeSession.doubles.D1.completed, true);
  assert.equal(app.user().lifetime.doubles.D1.attempts, 5);
});

test("an existing state node is never overwritten by leftover old data", async () => {
  const app = boot({ users: { u1: {
    state: { lifetime: { doubles: { D1: { attempts: 10, hits: 5, hits1: 5, hits2: 0, hits3: 0 } } } },
    lifetime: { doubles: { D1: { attempts: 1, hits: 1, hits1: 1, hits2: 0, hits3: 0 } } },
  } } });
  await app.signIn();

  assert.equal(app.raw().state.lifetime.doubles.D1.attempts, 10);
  assert.equal(app.raw().lifetime.doubles.D1.attempts, 1, "leftovers are left alone, not deleted");
});

test("if the move can't run, nothing is enabled and the old data is untouched", async () => {
  const oldLifetime = { doubles: { D1: { attempts: 4, hits: 2, hits1: 2, hits2: 0, hits3: 0 } } };
  const app = boot({ users: { u1: { lifetime: oldLifetime } } });
  app.db.failNext.get = 1;
  await app.signIn();
  app.renderTick();

  assert.match(app.errorText(), /network-error/);
  assert.equal(app.el("btnStartNew").disabled, true, "must not let a throw create a fresh state");
  assert.equal(app.raw().state, undefined);
  assert.equal(app.raw().lifetime.doubles.D1.attempts, 4);
});

test("the 250ms tick advances the timer but doesn't rewrite the board or history when nothing changed", async () => {
  const app = await startedApp();
  await app.throwHit(3);
  const board = app.el("boardBody");
  const history = app.el("historyBody");
  const before = { board: board.writes.innerHTML, history: history.writes.innerHTML };
  assert.ok(before.board > 0, "the board was rendered");

  app.clock.t += 58 * 1000;
  for (let i = 0; i < 40; i++) app.renderTick();

  assert.equal(board.writes.innerHTML, before.board, "idle ticks must not rebuild the board");
  assert.equal(history.writes.innerHTML, before.history, "idle ticks must not rebuild the history");
  assert.equal(app.el("timer").textContent, "1:01", "the timer still advances on a tick");

  await app.throwHit(1);
  assert.ok(board.writes.innerHTML > before.board, "a real change still updates the board");
});

test("signing out clears the board, and signing back in shows it again despite the write cache", async () => {
  const app = await startedApp();
  await app.throwHit(2);
  assert.match(app.el("boardBody").innerHTML, /D1/);

  await app.signOut();
  app.renderTick();
  assert.match(app.el("boardBody").innerHTML, /Sign in to load/);
  assert.match(app.el("historyBody").innerHTML, /Sign in to load/);

  await app.signIn();
  app.renderTick();
  assert.match(app.el("boardBody").innerHTML, /D1/, "rows come back, not a stale skipped write");
});

// ---- "Hit a later double": one entry for a run of misses followed by a hit ----

// Picks the double and total darts in the two dropdowns and presses Log, as a player would.
async function logLater(app, doubleKey, totalDarts) {
  app.el("laterDouble").value = doubleKey;
  app.el("laterDarts").value = String(totalDarts);
  app.renderTick();
  await app.click("btnLater");
}

test("hitting D3 after 9 darts records D1 and D2 as misses and D3 as hit on dart 3", async () => {
  const app = await startedApp();
  await logLater(app, "D3", 9);

  const { activeSession: session, lifetime } = app.user();
  for (const key of ["D1", "D2"]) {
    assert.equal(session.doubles[key].attempts, 1, `${key} gets one missed visit`);
    assert.notEqual(session.doubles[key].completed, true);
    assert.equal(lifetime.doubles[key].attempts, 1);
    assert.equal(lifetime.doubles[key].hits ?? 0, 0);
  }
  assert.equal(session.doubles.D3.attempts, 1);
  assert.equal(session.doubles.D3.completed, true);
  assert.equal(session.doubles.D3.hitDart, 3);
  assert.equal(lifetime.doubles.D3.hits, 1);
  assert.equal(lifetime.doubles.D3.hits3, 1);
  assert.equal(session.flow.cursorIndex, 3, "play carries on at D4; D1 and D2 come round again");

  app.renderTick();
  assert.equal(app.el("progressPill").textContent, "1/21");
  assert.equal(app.el("dartsPill").textContent, "9 darts");
});

test("the total decides which dart hit: one skipped double, 4/5/6 darts means dart 1/2/3", async () => {
  for (const [total, expectedDart] of [[4, 1], [5, 2], [6, 3]]) {
    const app = await startedApp();
    await logLater(app, "D2", total);
    assert.equal(app.user().activeSession.doubles.D2.hitDart, expectedDart, `${total} darts`);
    assert.equal(app.user().lifetime.doubles.D2[`hits${expectedDart}`], 1);
  }
});

test("the darts total keeps adding up across ordinary throws and entries", async () => {
  const app = await startedApp();
  await logLater(app, "D3", 9); // 9 darts
  await app.throwHit(1); // D4 hit on dart 1: +1
  await app.throwHit(1, "btnMiss"); // D5 missed: +3
  app.renderTick();
  assert.equal(app.el("progressPill").textContent, "2/21");
  assert.equal(app.el("dartsPill").textContent, "13 darts");
});

test("a total that doesn't add up is refused and changes nothing", async () => {
  const app = await startedApp();
  const before = app.user();
  app.el("laterDouble").value = "D3";
  app.el("laterDarts").value = "10"; // D1 and D2 took 6 darts, so D3 needs 7, 8 or 9
  await app.click("btnLater"); // no render in between, so the dropdown's own filtering is bypassed

  assert.match(app.alerts.at(-1), /7, 8 or 9/);
  assert.deepEqual(app.user(), before);
});

test("the Log button stays disabled until a double and a valid total are both chosen", async () => {
  const app = await startedApp();
  app.renderTick();
  assert.equal(app.el("btnLater").disabled, true);

  app.el("laterDouble").value = "D3";
  app.renderTick();
  assert.equal(app.el("btnLater").disabled, true, "no total yet");

  app.el("laterDarts").value = "8";
  app.renderTick();
  assert.equal(app.el("btnLater").disabled, false);

  app.el("laterDarts").value = "12"; // not one of D3's totals
  app.renderTick();
  assert.equal(app.el("btnLater").disabled, true);
  assert.equal(app.el("laterDarts").value, "", "an invalid total is cleared");
});

test("skipping past DBULL wraps round to the earlier open double", async () => {
  const app = await startedApp();
  await app.throwHit(1); // D1 hit
  await app.throwHit(1, "btnMiss"); // D2 missed, stays open
  await app.throwHit(18); // D3..D20 hit; now on DBULL, with D2 still open behind it

  await logLater(app, "D2", 5); // DBULL missed (3 darts), then D2 hit on dart 2

  const { activeSession: session } = app.user();
  assert.equal(session.doubles.DBULL.attempts, 1);
  assert.notEqual(session.doubles.DBULL.completed, true);
  assert.equal(session.doubles.D2.attempts, 2, "the earlier miss plus this hit");
  assert.equal(session.doubles.D2.completed, true);
  assert.equal(session.doubles.D2.hitDart, 2);
  app.renderTick();
  assert.equal(app.el("progressPill").textContent, "20/21");
  assert.equal(app.el("targetLabel").textContent, "DBULL");
});

test("undo reverses the whole entry: every skipped double, the hit, the lifetime counts and the darts", async () => {
  const app = await startedApp();
  await logLater(app, "D3", 9);

  await app.click("btnUndo");

  const { activeSession: session, lifetime } = app.user();
  for (const key of ["D1", "D2", "D3"]) {
    assert.equal(session.doubles[key].attempts ?? 0, 0, `${key} session attempts`);
    assert.equal(lifetime.doubles[key]?.attempts ?? 0, 0, `${key} lifetime attempts`);
  }
  assert.equal(session.doubles.D3.completed ?? false, false);
  assert.equal(lifetime.doubles.D3?.hits ?? 0, 0);
  assert.equal(session.flow.cursorIndex, 0);
  app.renderTick();
  assert.equal(app.el("dartsPill").textContent, "0 darts");
});

test("the Hit/Double dropdowns are only rewritten when their options change, not on idle ticks", async () => {
  const app = await startedApp();
  app.renderTick();
  const before = [app.el("laterDouble").writes.innerHTML, app.el("laterDarts").writes.innerHTML];

  for (let i = 0; i < 40; i++) app.renderTick();

  assert.deepEqual([app.el("laterDouble").writes.innerHTML, app.el("laterDarts").writes.innerHTML], before);
  app.el("laterDouble").value = "D3";
  app.renderTick();
  assert.equal(app.el("laterDouble").value, "D3", "the player's choice survives ticks");
});

test("a finished round is saved with its total darts", async () => {
  const app = await startedApp();
  const { sessionKey } = app.user().activeSession.meta;
  await app.throwHit(21); // every double hit on the first dart

  assert.equal(app.user().sessions[sessionKey].totalDarts, 21);
});

test("the history shows darts, working them out for sessions saved before they were recorded", async () => {
  const app = boot({ users: { u1: { sessions: {
    "-Kold": {
      startedAtMs: Date.UTC(2028, 0, 1), activeMs: 60000,
      // D1: missed once (3) then hit on dart 2 (2) = 5 darts; D2: missed once = 3 darts
      perDouble: { D1: { attempts: 2, completed: true, hitDart: 2 }, D2: { attempts: 1, completed: false } },
    },
    "-Knew": { startedAtMs: Date.UTC(2028, 0, 2), activeMs: 90000, totalDarts: 57, perDouble: {} },
  } } } });
  await app.signIn();

  const html = app.el("historyBody").innerHTML;
  assert.match(html, /mono">8<\/td>/, "derived: 5 + 3");
  assert.match(html, /mono">57<\/td>/, "stored total is used as is");
});

// ---- "Stayed on this double": more than 3 darts at the same number ----

async function logStay(app, outcome) {
  app.el("stayOutcome").value = outcome;
  app.renderTick();
  await app.click("btnStay");
}

test("hitting D1 on the 7th dart is two missed visits and a hit, with 4 darts counted as extra", async () => {
  const app = await startedApp();
  await logStay(app, "hit:7");

  const { activeSession: session, lifetime } = app.user();
  assert.equal(session.doubles.D1.attempts, 3);
  assert.equal(session.doubles.D1.completed, true);
  assert.equal(session.doubles.D1.hitDart, 1, "the 7th dart is the 1st dart of the third visit");
  assert.equal(session.doubles.D1.extraDarts, 4);
  assert.equal(lifetime.doubles.D1.attempts, 3);
  assert.equal(lifetime.doubles.D1.hits, 1);
  assert.equal(lifetime.doubles.D1.hits1, 1);
  assert.equal(session.flow.cursorIndex, 1, "play carries on at D2");

  app.renderTick();
  assert.equal(app.el("dartsPill").textContent, "7 darts · 4 extra");
  assert.equal(app.el("progressPill").textContent, "1/21");
  assert.match(app.el("boardBody").innerHTML, /\(\+4\)/, "the board marks the double that was stayed on");
});

test("the dart number decides the visits: 4 and 5 darts are two visits, 6 is two visits ending on dart 3", async () => {
  for (const [dart, visits, hitDart, extra] of [[4, 2, 1, 1], [5, 2, 2, 2], [6, 2, 3, 3], [9, 3, 3, 6], [15, 5, 3, 12]]) {
    const app = await startedApp();
    await logStay(app, `hit:${dart}`);
    const d1 = app.user().activeSession.doubles.D1;
    assert.deepEqual([d1.attempts, d1.hitDart, d1.extraDarts], [visits, hitDart, extra], `hit on dart ${dart}`);
    app.renderTick();
    assert.match(app.el("dartsPill").textContent, new RegExp(`^${dart} darts`));
  }
});

test("missing after 9 darts moves on, leaves the double open, and still counts the darts", async () => {
  const app = await startedApp();
  await logStay(app, "miss:9");

  const { activeSession: session, lifetime } = app.user();
  assert.equal(session.doubles.D1.attempts, 3);
  assert.notEqual(session.doubles.D1.completed, true);
  assert.equal(session.doubles.D1.extraDarts, 6);
  assert.equal(lifetime.doubles.D1.attempts, 3);
  assert.equal(lifetime.doubles.D1.hits ?? 0, 0);
  assert.equal(session.flow.cursorIndex, 1);
  app.renderTick();
  assert.equal(app.el("dartsPill").textContent, "9 darts · 6 extra");
  assert.equal(app.el("targetLabel").textContent, "D2");
});

test("an ordinary miss that comes round again later is not counted as extra darts", async () => {
  const app = await startedApp();
  await app.throwHit(1, "btnMiss"); // D1 missed, moves on
  await app.throwHit(20); // D2..DBULL hit, then back round to D1
  await app.throwHit(1); // D1 hit on its second visit

  const d1 = app.user().activeSession?.doubles.D1 ?? app.user().sessions[Object.keys(app.user().sessions)[0]].perDouble.D1;
  assert.equal(d1.attempts, 2);
  assert.equal(d1.extraDarts, undefined, "coming back is not staying");
});

test("undo reverses a stay completely, even though it touched one double several times", async () => {
  const app = await startedApp();
  await logStay(app, "hit:7");

  await app.click("btnUndo");

  const { activeSession: session, lifetime } = app.user();
  assert.equal(session.doubles.D1.attempts ?? 0, 0);
  assert.equal(session.doubles.D1.completed ?? false, false);
  assert.equal(session.doubles.D1.extraDarts, undefined);
  assert.equal(lifetime.doubles.D1?.attempts ?? 0, 0);
  assert.equal(lifetime.doubles.D1?.hits ?? 0, 0);
  assert.equal(lifetime.doubles.D1?.hits1 ?? 0, 0);
  assert.equal(session.flow.cursorIndex, 0);
  app.renderTick();
  assert.equal(app.el("dartsPill").textContent, "0 darts");
});

test("undoing a stay is refused if that double has changed since", async () => {
  const app = await startedApp();
  await logStay(app, "miss:6");
  app.db.write("users/u1/state/activeSession/doubles/D1/attempts", 9); // another device logged more

  await app.click("btnUndo");

  assert.match(app.alerts.at(-1), /changed since/);
  assert.equal(app.user().activeSession.doubles.D1.attempts, 9);
});

test("an outcome that isn't one of the choices is refused and changes nothing", async () => {
  const app = await startedApp();
  const before = app.user();
  for (const bad of ["hit:3", "miss:7", "hit:16", "miss:3", "nonsense"]) {
    app.el("stayOutcome").value = bad;
    await app.click("btnStay"); // no render in between, so the dropdown's own filtering is bypassed
    assert.match(app.alerts.at(-1), /how the extra darts ended/, bad);
  }
  assert.deepEqual(app.user(), before);
});

test("the stay Log button waits for a choice, and the dropdown isn't rewritten by idle ticks", async () => {
  const app = await startedApp();
  app.renderTick();
  assert.equal(app.el("btnStay").disabled, true);
  const writes = app.el("stayOutcome").writes.innerHTML;

  app.el("stayOutcome").value = "hit:5";
  for (let i = 0; i < 40; i++) app.renderTick();

  assert.equal(app.el("btnStay").disabled, false);
  assert.equal(app.el("stayOutcome").value, "hit:5", "the choice survives ticks");
  assert.equal(app.el("stayOutcome").writes.innerHTML, writes);
});

test("a finished round saves its extra darts, and the history shows them", async () => {
  const app = await startedApp();
  const { sessionKey } = app.user().activeSession.meta;
  await app.throwHit(20);
  await logStay(app, "hit:4"); // DBULL on the 4th dart: 1 extra

  const row = app.user().sessions[sessionKey];
  assert.equal(row.totalDarts, 24);
  assert.equal(row.extraDarts, 1);
  assert.equal(row.perDouble.DBULL.extraDarts, 1);
  assert.match(app.el("historyBody").innerHTML, /mono">24 <span[^>]*>\+1<\/span>/);
});

test("the history works out extra darts for a row that only has per-double data", async () => {
  const app = boot({ users: { u1: { sessions: {
    "-Kx": {
      startedAtMs: Date.UTC(2028, 0, 1), activeMs: 60000,
      perDouble: { D1: { attempts: 3, completed: true, hitDart: 1, extraDarts: 4 } },
    },
  } } } });
  await app.signIn();
  assert.match(app.el("historyBody").innerHTML, /mono">7 <span[^>]*>\+4<\/span>/);
});
