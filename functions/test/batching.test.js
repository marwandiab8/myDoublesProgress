const assert = require("node:assert/strict");
const test = require("node:test");
const { MAX_BATCH_BYTES, MAX_BATCH_ITEMS, chunkBySize } = require("../timeLeftMyDouble/batching");

const envelope = { calendarId: "calendar-id", connectionId: "connection-id" };
const bodyBytes = (batch) => Buffer.byteLength(JSON.stringify({ ...envelope, items: batch }), "utf8");
const itemOfSize = (n, id = 0) => ({ id, pad: "x".repeat(n) });

test("returns no batches for no items", () => {
  assert.deepEqual(chunkBySize([], envelope), []);
});

test("keeps every item, in order", () => {
  const items = Array.from({ length: 57 }, (_, i) => itemOfSize(2000, i));
  const batches = chunkBySize(items, envelope);
  assert.deepEqual(batches.flat().map((item) => item.id), items.map((item) => item.id));
});

test("keeps each request body, envelope included, under the byte budget", () => {
  const items = Array.from({ length: 200 }, (_, i) => itemOfSize(3000, i));
  const batches = chunkBySize(items, envelope);
  assert.ok(batches.length > 1);
  for (const batch of batches) assert.ok(bodyBytes(batch) <= MAX_BATCH_BYTES, `${bodyBytes(batch)} bytes`);
  assert.ok(MAX_BATCH_BYTES < 64 * 1024, "the budget leaves headroom under Time Left's 64 KB limit");
});

test("never puts more than the item cap in a batch, even when items are tiny", () => {
  const items = Array.from({ length: 250 }, (_, i) => ({ id: i }));
  const batches = chunkBySize(items, envelope);
  assert.deepEqual(batches.map((batch) => batch.length), [MAX_BATCH_ITEMS, MAX_BATCH_ITEMS, 50]);
});

test("packs a batch as full as the budget allows rather than splitting early", () => {
  const items = Array.from({ length: 40 }, (_, i) => itemOfSize(3000, i));
  const [first, second] = chunkBySize(items, envelope);
  assert.ok(bodyBytes([...first, second[0]]) > MAX_BATCH_BYTES, "one more item would not have fit");
});

test("an item too big for any batch still gets sent, alone, so Time Left can report it", () => {
  const items = [itemOfSize(100), itemOfSize(MAX_BATCH_BYTES + 5000, 1), itemOfSize(100, 2)];
  const batches = chunkBySize(items, envelope);
  assert.deepEqual(batches.map((batch) => batch.map((item) => item.id)), [[0], [1], [2]]);
});

test("honors custom limits", () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ id: i }));
  assert.deepEqual(chunkBySize(items, envelope, { maxItems: 3 }).map((b) => b.length), [3, 3, 3, 1]);
});
