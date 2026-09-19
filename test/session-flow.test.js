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
