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

function summarizeDoubles(perDouble) {
  const values = Object.values(perDouble || {});
  const completed = values.filter((entry) => entry && entry.completed).length;
  const attempts = values.reduce((sum, entry) => sum + Number(entry && entry.attempts || 0), 0);
  const hitOnOne = values.filter((entry) => Number(entry && entry.hitDart) === 1).length;
  const hitOnTwo = values.filter((entry) => Number(entry && entry.hitDart) === 2).length;
  const hitOnThree = values.filter((entry) => Number(entry && entry.hitDart) === 3).length;
  const missed = values.filter((entry) => entry && !entry.completed && Number(entry.attempts || 0) > 0).length;
  return { attempts, completed, hitOnOne, hitOnTwo, hitOnThree, missed };
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
  const duration = activeMs ? formatDuration(activeMs) : "";
  const title = dateId ? `Doubles practice - ${dateId}` : "Doubles practice";
  const sourceDocumentPath = options.sourceDocumentPath || `users/${options.uid || ""}/sessions/${sessionId}`;

  return compactObject({
    dateId: dateId || undefined,
    sourceApp: "MyDoubleProgress",
    category: "progressRecord",
    title,
    summary: `${stats.completed}/21 doubles completed, ${stats.attempts} attempts${duration ? `, ${duration}` : ""}.`,
    description: "",
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
