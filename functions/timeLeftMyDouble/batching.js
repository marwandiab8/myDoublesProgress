// Time Left rejects any request body over 64 KB ("Payload too large") and its batch endpoint takes at
// most 100 items. Our items are about 3 KB each, so a fixed 100 per batch would be ~300 KB and every
// batch would be refused. Fill each batch up to a size budget instead.
const MAX_BATCH_ITEMS = 100;
const MAX_BATCH_BYTES = 60 * 1024; // under Time Left's 64 KB limit, with headroom

const bytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");

// Splits `items` into batches in order, each within `maxItems` and (with the request envelope, e.g.
// calendarId and connectionId) within `maxBytes`. An item too large to fit alone still gets its own
// batch, so it is reported by Time Left instead of being silently dropped.
function chunkBySize(items, envelope = {}, { maxItems = MAX_BATCH_ITEMS, maxBytes = MAX_BATCH_BYTES } = {}) {
  const base = bytes({ ...envelope, items: [] });
  const batches = [];
  let current = [];
  let size = base;

  for (const item of items) {
    const itemBytes = bytes(item) + 1; // +1 for the comma between items
    if (current.length && (current.length >= maxItems || size + itemBytes > maxBytes)) {
      batches.push(current);
      current = [];
      size = base;
    }
    current.push(item);
    size += itemBytes;
  }
  if (current.length) batches.push(current);
  return batches;
}

module.exports = { MAX_BATCH_BYTES, MAX_BATCH_ITEMS, chunkBySize };
