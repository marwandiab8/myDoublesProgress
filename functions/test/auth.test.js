const assert = require("node:assert/strict");
const test = require("node:test");
const { isAuthorized } = require("../timeLeftMyDouble/auth");

const TOKEN = "s3cret-token-value";

test("accepts the exact bearer token", () => {
  assert.equal(isAuthorized(`Bearer ${TOKEN}`, TOKEN), true);
});

test("accepts the scheme in any case and surrounding whitespace, as before", () => {
  assert.equal(isAuthorized(`bearer ${TOKEN}`, TOKEN), true);
  assert.equal(isAuthorized(`BEARER   ${TOKEN}  `, TOKEN), true);
});

test("rejects a wrong token, including a prefix, a longer value and a different case", () => {
  assert.equal(isAuthorized("Bearer wrong", TOKEN), false);
  assert.equal(isAuthorized(`Bearer ${TOKEN.slice(0, -1)}`, TOKEN), false);
  assert.equal(isAuthorized(`Bearer ${TOKEN}x`, TOKEN), false);
  assert.equal(isAuthorized(`Bearer ${TOKEN.toUpperCase()}`, TOKEN), false);
});

test("rejects a missing header, another scheme, or a bare token", () => {
  assert.equal(isAuthorized(undefined, TOKEN), false);
  assert.equal(isAuthorized("", TOKEN), false);
  assert.equal(isAuthorized(`Basic ${TOKEN}`, TOKEN), false);
  assert.equal(isAuthorized(TOKEN, TOKEN), false);
  assert.equal(isAuthorized("Bearer", TOKEN), false);
});

test("fails closed when the expected secret is empty or missing", () => {
  assert.equal(isAuthorized("Bearer anything", ""), false);
  assert.equal(isAuthorized("Bearer anything", undefined), false);
  assert.equal(isAuthorized("Bearer ", ""), false);
  assert.equal(isAuthorized(undefined, undefined), false);
});

test("does not throw on very different token lengths", () => {
  assert.equal(isAuthorized(`Bearer ${"a".repeat(5000)}`, TOKEN), false);
  assert.equal(isAuthorized("Bearer a", "a".repeat(5000)), false);
});
