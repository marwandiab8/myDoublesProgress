// Keys match the ones the app stores in sessions/{id}/perDouble (see TARGETS in public/index.html).
const TARGETS = [
  "D1", "D2", "D3", "D4", "D5", "D6", "D7", "D8", "D9", "D10",
  "D11", "D12", "D13", "D14", "D15", "D16", "D17", "D18", "D19", "D20", "DBULL"
];

// Keep the label sent to Time Left stable ("Bull") even though the app key is "DBULL".
const OUTPUT_LABELS = { DBULL: "Bull" };

const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function compactObject(source) {
  return Object.fromEntries(Object.entries(source || {}).filter(([, value]) => value !== undefined));
}

function text(value, max = 500) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function pad(number) {
  return String(number).padStart(2, "0");
}

function dateIdInTimeZone(date, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const get = (type) => (parts.find((part) => part.type === type) || {}).value;
    const [year, month, day] = [get("year"), get("month"), get("day")];
    return year && month && day ? `${year}-${month}-${day}` : "";
  } catch (_) {
    // Invalid IANA zone name: fall back to the server's local date.
    return "";
  }
}

// With no timeZone this uses the server's local time (UTC on Cloud Functions).
function dateIdFromMs(value, timeZone) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "";
  if (timeZone) {
    const zoned = dateIdInTimeZone(date, timeZone);
    if (zoned) return zoned;
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function isoFromMs(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// Darts thrown at one double: each missed visit was 3 darts and the visit that hit it took `hitDart`.
// Mirrors dartsAt() in public/index.html, so sessions saved before the app showed darts still work.
function dartsAt(entry) {
  const attempts = Number(entry && entry.attempts || 0);
  if (!attempts) return 0;
  return entry.completed ? (attempts - 1) * 3 + (Number(entry.hitDart) || 3) : attempts * 3;
}

function summarizeDoubles(perDouble) {
  const values = Object.values(perDouble || {});
  const completed = values.filter((entry) => entry && entry.completed).length;
  const attempts = values.reduce((sum, entry) => sum + Number(entry && entry.attempts || 0), 0);
  const hitOnOne = values.filter((entry) => Number(entry && entry.hitDart) === 1).length;
  const hitOnTwo = values.filter((entry) => Number(entry && entry.hitDart) === 2).length;
  const hitOnThree = values.filter((entry) => Number(entry && entry.hitDart) === 3).length;
  const missed = values.filter((entry) => entry && !entry.completed && Number(entry.attempts || 0) > 0).length;
  const darts = values.reduce((sum, entry) => sum + dartsAt(entry), 0);
  const extraDarts = values.reduce((sum, entry) => sum + Number(entry && entry.extraDarts || 0), 0);
  return { attempts, completed, hitOnOne, hitOnTwo, hitOnThree, missed, darts, extraDarts };
}

// The doubles that took the most darts (only those that needed more than one visit), for the description.
function hardestDoubles(perDouble, limit = 3) {
  return TARGETS
    .map((key) => ({ key, darts: dartsAt(perDouble && perDouble[key]) }))
    .filter((row) => row.darts > 3)
    .sort((a, b) => b.darts - a.darts) // stable, so ties stay in D1 -> Bull order
    .slice(0, limit)
    .map((row) => ({ double: OUTPUT_LABELS[row.key] || row.key, darts: row.darts }));
}

// Doubles that were deliberately stayed on (more than 3 darts thrown in one go), with the extra darts.
function stayedOnDoubles(perDouble) {
  return TARGETS
    .map((key) => ({ double: OUTPUT_LABELS[key] || key, extraDarts: Number(perDouble && perDouble[key] && perDouble[key].extraDarts || 0) }))
    .filter((row) => row.extraDarts > 0);
}

function count(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// Time Left shows a card's title, summary and description as plain text (it never displays metadata),
// so the numbers worth seeing have to be in those. Kept as sentences in one paragraph: the card doesn't
// preserve line breaks.
function describeSession(stats, hardest, stayedOn = []) {
  const parts = [];
  if (stats.completed > 0) {
    parts.push(`Hit on dart 1: ${stats.hitOnOne}, dart 2: ${stats.hitOnTwo}, dart 3: ${stats.hitOnThree}.`);
    parts.push(`Averaged ${(stats.darts / stats.completed).toFixed(1)} darts per double.`);
  }
  if (hardest.length) {
    parts.push(`Most darts: ${hardest.map((row) => `${row.double} (${row.darts})`).join(", ")}.`);
  }
  if (stayedOn.length) {
    parts.push(`Stayed on ${stayedOn.map((row) => `${row.double} (+${row.extraDarts})`).join(", ")} for ${count(stats.extraDarts, "extra dart")}.`);
  }
  return parts.join(" ");
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(Number(ms || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const hours = Math.floor(minutes / 60);
  const mm = minutes % 60;
  if (hours > 0) return `${hours}h ${mm}m ${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function perDoubleRows(perDouble) {
  return TARGETS.map((key) => {
    const entry = perDouble && perDouble[key] ? perDouble[key] : {};
    return compactObject({
      double: OUTPUT_LABELS[key] || key,
      attempts: Number(entry.attempts || 0),
      completed: Boolean(entry.completed),
      hitDart: entry.hitDart == null ? null : Number(entry.hitDart),
      completedAt: entry.completedAt || null,
    });
  });
}

function mapSessionToTimeLeft(session, options = {}) {
  const sessionId = text(options.sessionId || "", 140);
  const startedAtMs = Number(session.startedAtMs || session.meta?.startedAtMs || 0);
  const endedAtMs = Number(session.endedAtMs || 0);
  const activeMs = Number(session.activeMs || 0);
  // Prefer the date the app recorded in the user's own timezone; older sessions
  // don't have it, so fall back to converting the timestamp.
  const localDate = LOCAL_DATE_PATTERN.test(String(session.localDate || "")) ? session.localDate : "";
  const dateId = localDate || dateIdFromMs(startedAtMs || endedAtMs, options.timeZone);
  const stats = summarizeDoubles(session.perDouble || session.doubles || {});
  const hardest = hardestDoubles(session.perDouble || session.doubles || {});
  const stayedOn = stayedOnDoubles(session.perDouble || session.doubles || {});
  const duration = activeMs ? formatDuration(activeMs) : "";
  // Time Left's Activity dashboard shows only a row's title, start and duration (never the summary or
  // description), so the darts total goes in the title to be visible there.
  const dartsInTitle = stats.darts > 0 ? ` · ${count(stats.darts, "dart")}` : "";
  const title = `${dateId ? `Doubles practice - ${dateId}` : "Doubles practice"}${dartsInTitle}`;
  const sourceDocumentPath = options.sourceDocumentPath || `users/${options.uid || ""}/sessions/${sessionId}`;

  return compactObject({
    dateId: dateId || undefined,
    sourceApp: "MyDoubleProgress",
    category: "progressRecord",
    title,
    summary: `${stats.completed}/21 doubles completed, ${count(stats.darts, "dart")} in ${count(stats.attempts, "attempt")}${duration ? `, ${duration}` : ""}.`,
    description: describeSession(stats, hardest, stayedOn),
    sourceFirebaseProjectId: options.sourceFirebaseProjectId || "mydoublesprogress",
    sourceProjectName: "MyDoubleProgress",
    sourceProjectId: options.sourceProjectId || "mydoublesprogress",
    sourceCollection: "sessions",
    sourceDocumentId: sessionId,
    sourceDocumentPath,
    sourceStoragePath: null,
    sourceUrl: options.appBaseUrl ? `${options.appBaseUrl}/#history` : "",
    fileUrl: null,
    thumbnailUrl: null,
    contentType: null,
    fileName: null,
    fileSize: null,
    originalCreatedAt: isoFromMs(startedAtMs || endedAtMs),
    originalUpdatedAt: isoFromMs(endedAtMs || startedAtMs),
    capturedAt: isoFromMs(startedAtMs || endedAtMs),
    visibility: "ownerOnly",
    syncStatus: options.syncStatus || "active",
    metadata: compactObject({
      uid: options.uid || null,
      sessionId,
      startedAtMs: startedAtMs || null,
      endedAtMs: endedAtMs || null,
      activeMs: activeMs || null,
      duration,
      attempts: stats.attempts,
      darts: stats.darts,
      dartsPerDouble: stats.completed > 0 ? Math.round((stats.darts / stats.completed) * 10) / 10 : null,
      mostDarts: hardest,
      extraDarts: stats.extraDarts,
      stayedOn,
      completed: stats.completed,
      hitOnOne: stats.hitOnOne,
      hitOnTwo: stats.hitOnTwo,
      hitOnThree: stats.hitOnThree,
      missed: stats.missed,
      perDouble: perDoubleRows(session.perDouble || session.doubles || {}),
      source: "MyDoubleProgress",
    }),
  });
}

module.exports = {
  dateIdFromMs,
  mapSessionToTimeLeft,
  summarizeDoubles,
};
