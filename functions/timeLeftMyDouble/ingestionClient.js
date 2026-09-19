const logger = require("firebase-functions/logger");
const { readConfig } = require("./config");

function assertConfig(config, batch = false) {
  const missing = [];
  if (!(batch ? config.batchEndpoint : config.singleEndpoint)) {
    missing.push(batch ? "TIME_LEFT_BATCH_INGEST_ENDPOINT" : "TIME_LEFT_SINGLE_INGEST_ENDPOINT");
  }
  if (!config.calendarId) missing.push("TIME_LEFT_CALENDAR_ID");
  if (!config.connectionId) missing.push("TIME_LEFT_CONNECTION_ID");
  if (!config.ownerUid) missing.push("MYDOUBLE_OWNER_UID");
  if (!config.token) missing.push("TIME_LEFT_INGESTION_TOKEN");
  if (missing.length) {
    const error = new Error(`MyDoubleProgress Time Left sync is not configured: ${missing.join(", ")}`);
    error.code = "time-left-mydouble-not-configured";
    throw error;
  }
}

async function parseResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (_) {
    return { raw: text.slice(0, 1000) };
  }
}

async function postToTimeLeft(url, token, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const body = await parseResponse(response);
  if (!response.ok) {
    const error = new Error(body.error || body.message || `Time Left ingestion failed with HTTP ${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

async function sendTimeLeftMyDoubleItem(item, options = {}) {
  const config = readConfig();
  try {
    assertConfig(config, false);
    return await postToTimeLeft(config.singleEndpoint, config.token, {
      calendarId: config.calendarId,
      connectionId: config.connectionId,
      item,
    });
  } catch (error) {
    logger.warn("MyDoubleProgress Time Left single ingestion failed", {
      sourceDocumentPath: item && item.sourceDocumentPath,
      sourceProjectId: item && item.sourceProjectId,
      category: item && item.category,
      dateId: item && item.dateId,
      status: error.status || null,
      code: error.code || null,
      message: String(error.message || error).slice(0, 300),
    });
    if (options.throwOnError) throw error;
    return { ok: false, error: error.message, status: error.status || null };
  }
}

async function sendTimeLeftMyDoubleItemsBatch(items, options = {}) {
  const config = readConfig();
  try {
    assertConfig(config, true);
    return await postToTimeLeft(config.batchEndpoint, config.token, {
      calendarId: config.calendarId,
      connectionId: config.connectionId,
      items,
    });
  } catch (error) {
    logger.warn("MyDoubleProgress Time Left batch ingestion failed", {
      itemCount: Array.isArray(items) ? items.length : 0,
      status: error.status || null,
      code: error.code || null,
      message: String(error.message || error).slice(0, 300),
    });
    if (options.throwOnError) throw error;
    return { ok: false, error: error.message, status: error.status || null };
  }
}

// Sends the session's canonical life event to Time Left's life-event API (see mapSessionToLifeEvent).
// Never throws unless asked to: the card is what matters most, so a failure here is logged and the caller
// carries on. A 409 means Time Left already holds a life event for this session and never overwrites one,
// which is expected for a session that was sent before, so it isn't a warning.
async function sendTimeLeftMyDoubleLifeEvent(event, options = {}) {
  const config = readConfig();
  if (!config.lifeEventEndpoint) return { ok: false, skipped: true };
  try {
    const missing = [];
    if (!config.calendarId) missing.push("TIME_LEFT_CALENDAR_ID");
    if (!config.connectionId) missing.push("TIME_LEFT_CONNECTION_ID");
    if (!config.token) missing.push("TIME_LEFT_INGESTION_TOKEN");
    if (missing.length) {
      const error = new Error(`MyDoubleProgress Time Left life events are not configured: ${missing.join(", ")}`);
      error.code = "time-left-mydouble-not-configured";
      throw error;
    }
    const body = await postToTimeLeft(config.lifeEventEndpoint, config.token, {
      calendarId: config.calendarId,
      connectionId: config.connectionId,
      integrationId: config.integrationId || config.connectionId,
      item: event,
    });
    return { ok: true, duplicate: Boolean(body && body.duplicate) };
  } catch (error) {
    const conflict = error.status === 409;
    logger[conflict ? "info" : "warn"](
      conflict ? "Time Left already has a life event for this session" : "MyDoubleProgress Time Left life event failed",
      {
        sourceEventId: event && event.sourceEventId,
        status: error.status || null,
        code: error.code || null,
        message: String(error.message || error).slice(0, 300),
      },
    );
    if (options.throwOnError) throw error;
    return { ok: false, conflict, error: error.message, status: error.status || null };
  }
}

module.exports = {
  sendTimeLeftMyDoubleItem,
  sendTimeLeftMyDoubleLifeEvent,
  sendTimeLeftMyDoubleItemsBatch,
};
