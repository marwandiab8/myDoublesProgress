// Checks the parts of the real Firebase Admin SDK this project relies on, without any network access.
const assert = require("node:assert/strict");
const test = require("node:test");

test("the modular Admin SDK entry points used by index.js and triggers.js exist", () => {
  const { initializeApp } = require("firebase-admin/app");
  const { getDatabase } = require("firebase-admin/database");
  assert.equal(typeof initializeApp, "function");
  assert.equal(typeof getDatabase, "function");
});

test("the backfill's query chain builds against the real Realtime Database client", async () => {
  const { initializeApp, deleteApp } = require("firebase-admin/app");
  const { getDatabase } = require("firebase-admin/database");
  const app = initializeApp({ projectId: "demo", databaseURL: "https://demo-default-rtdb.firebaseio.com" }, "sdk-check");
  try {
    const query = getDatabase(app).ref("users/some-uid/sessions").limitToLast(5);
    assert.equal(typeof query.once, "function");
    assert.match(String(query.toString()), /users\/some-uid\/sessions/);
  } finally {
    await deleteApp(app);
  }
});
