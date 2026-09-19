const functions = require("firebase-functions/v1");
const { getDatabase } = require("firebase-admin/database");
const {
  TIME_LEFT_INGESTION_TOKEN,
  readConfig,
} = require("./config");
const {
  sendTimeLeftMyDoubleItem,
  sendTimeLeftMyDoubleItemsBatch,
} = require("./ingestionClient");
const { isAuthorized } = require("./auth");
const { chunkBySize } = require("./batching");
const { mapSessionToTimeLeft } = require("./mappers");

const region = "us-central1";
const runtimeOptions = {
  timeoutSeconds: 300,
  memory: "512MB",
  secrets: ["TIME_LEFT_INGESTION_TOKEN"],
};

function snapshotValue(snapshot) {
  return snapshot && snapshot.exists() ? snapshot.val() || {} : null;
}

function mapSession(uid, sessionId, session, syncStatus = "active") {
  const config = readConfig();
  return mapSessionToTimeLeft(session || {}, {
    appBaseUrl: config.appBaseUrl,
    sourceDocumentPath: `users/${uid}/sessions/${sessionId}`,
    sourceFirebaseProjectId: config.sourceFirebaseProjectId,
    sourceProjectId: config.sourceProjectId,
    syncStatus,
    timeZone: config.timeZone,
    uid,
    sessionId,
  });
}

function assertBackfillAuth(req) {
  if (!isAuthorized(req.get("authorization"), TIME_LEFT_INGESTION_TOKEN.value())) {
    const error = new Error("Forbidden.");
    error.status = 403;
    throw error;
  }
}

exports.syncMyDoubleSessionToTimeLeft = functions
  .region(region)
  .runWith(runtimeOptions)
  .database
  .instance("mydoublesprogress-default-rtdb")
  .ref("/users/{uid}/sessions/{sessionId}")
  .onWrite(async (change, context) => {
    const { uid, sessionId } = context.params;
    const config = readConfig();
    if (!config.ownerUid || uid !== config.ownerUid) {
      functions.logger.info("Skipping MyDoubleProgress Time Left sync for non-configured user", { uid, sessionId });
      return null;
    }

    const before = snapshotValue(change.before);
    const after = snapshotValue(change.after);
    const source = after || before;
    if (!source) return null;

    const item = mapSession(uid, sessionId, source, after ? "active" : "deletedFromSource");
    const result = await sendTimeLeftMyDoubleItem(item);
    functions.logger.info("MyDoubleProgress Time Left sync attempted", {
      ok: !(result && result.ok === false),
      status: result && result.status ? result.status : null,
      dateId: item.dateId || null,
      sourceDocumentPath: item.sourceDocumentPath,
      sourceProjectId: item.sourceProjectId,
      sessionId,
    });
    return result;
  });

exports.backfillMyDoubleSessionsToTimeLeft = functions
  .region(region)
  .runWith(runtimeOptions)
  .https
  .onRequest(async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).set("Allow", "POST").json({ ok: false, error: "Use POST." });
      return;
    }

    try {
      assertBackfillAuth(req);
      const config = readConfig();
      if (!config.ownerUid) {
        res.status(500).json({ ok: false, error: "MYDOUBLE_OWNER_UID is not configured." });
        return;
      }

      const limit = Math.max(1, Math.min(1000, Number(req.query.limit || req.body?.limit || 500) || 500));
      const snap = await getDatabase().ref(`users/${config.ownerUid}/sessions`).limitToLast(limit).once("value");
      const sessions = snap.val() || {};
      const items = Object.entries(sessions).map(([sessionId, session]) => mapSession(config.ownerUid, sessionId, session, "active"));

      const result = {
        ok: true,
        source: "sessions",
        scanned: items.length,
        sent: 0,
        failed: 0,
        batches: [],
      };

      for (const batch of chunkBySize(items, { calendarId: config.calendarId, connectionId: config.connectionId })) {
        const response = await sendTimeLeftMyDoubleItemsBatch(batch, { throwOnError: true });
        result.sent += batch.length;
        result.failed += Array.isArray(response.errors) ? response.errors.length : 0;
        result.batches.push({
          count: batch.length,
          created: response.created || 0,
          updated: response.updated || 0,
          moved: response.moved || 0,
          needsDateReview: response.needsDateReview || 0,
          errors: Array.isArray(response.errors) ? response.errors.length : 0,
        });
      }

      res.json(result);
    } catch (error) {
      functions.logger.warn("MyDoubleProgress Time Left backfill failed", {
        status: error.status || null,
        message: String(error.message || error).slice(0, 300),
      });
      res.status(error.status || 500).json({ ok: false, error: error.message || "Backfill failed." });
    }
  });
