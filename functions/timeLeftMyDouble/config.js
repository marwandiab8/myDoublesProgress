const { defineSecret, defineString } = require("firebase-functions/params");

const TIME_LEFT_INGESTION_TOKEN = defineSecret("TIME_LEFT_INGESTION_TOKEN");

const TIME_LEFT_SINGLE_INGEST_ENDPOINT = defineString("TIME_LEFT_SINGLE_INGEST_ENDPOINT", {
  default: "https://northamerica-northeast1-timelefttolive.cloudfunctions.net/ingestExternalDailyItem",
});

const TIME_LEFT_BATCH_INGEST_ENDPOINT = defineString("TIME_LEFT_BATCH_INGEST_ENDPOINT", {
  default: "https://northamerica-northeast1-timelefttolive.cloudfunctions.net/ingestExternalDailyItemsBatch",
});

// Time Left's life-event API. The Activity dashboard is built from these; the card endpoints above can't
// give it a duration. Set to an empty value to stop sending life events (cards are unaffected).
const TIME_LEFT_LIFE_EVENT_ENDPOINT = defineString("TIME_LEFT_LIFE_EVENT_ENDPOINT", {
  default: "https://northamerica-northeast1-timelefttolive.cloudfunctions.net/apiV1LifeEvents",
});
// The connection's integration id is optional and read straight from the environment rather than declared
// as a param: the Firebase CLI refuses to deploy non-interactively for a param whose default is empty.
// Time Left falls back to the connection id when a connection has none (yours doesn't), so leaving
// TIME_LEFT_INTEGRATION_ID unset sends the connection id.

const TIME_LEFT_CALENDAR_ID = defineString("TIME_LEFT_CALENDAR_ID", { default: "" });
const TIME_LEFT_CONNECTION_ID = defineString("TIME_LEFT_CONNECTION_ID", { default: "" });
const MYDOUBLE_FIREBASE_PROJECT_ID = defineString("MYDOUBLE_FIREBASE_PROJECT_ID", { default: "mydoublesprogress" });
const MYDOUBLE_APP_BASE_URL = defineString("MYDOUBLE_APP_BASE_URL", { default: "https://mydoublesprogress.web.app" });
const MYDOUBLE_SOURCE_PROJECT_ID = defineString("MYDOUBLE_SOURCE_PROJECT_ID", { default: "mydoublesprogress" });
const MYDOUBLE_OWNER_UID = defineString("MYDOUBLE_OWNER_UID", { default: "" });
// IANA zone (e.g. "America/Toronto") used to date sessions saved before the app recorded `localDate`.
// Empty keeps the old behavior (server-local time, i.e. UTC on Cloud Functions).
const MYDOUBLE_TIMEZONE = defineString("MYDOUBLE_TIMEZONE", { default: "" });

function readConfig() {
  return {
    appBaseUrl: String(MYDOUBLE_APP_BASE_URL.value() || "").replace(/\/+$/, ""),
    batchEndpoint: TIME_LEFT_BATCH_INGEST_ENDPOINT.value(),
    calendarId: TIME_LEFT_CALENDAR_ID.value(),
    connectionId: TIME_LEFT_CONNECTION_ID.value(),
    integrationId: process.env.TIME_LEFT_INTEGRATION_ID || "",
    lifeEventEndpoint: TIME_LEFT_LIFE_EVENT_ENDPOINT.value(),
    ownerUid: MYDOUBLE_OWNER_UID.value(),
    singleEndpoint: TIME_LEFT_SINGLE_INGEST_ENDPOINT.value(),
    sourceFirebaseProjectId: MYDOUBLE_FIREBASE_PROJECT_ID.value() || "mydoublesprogress",
    sourceProjectId: MYDOUBLE_SOURCE_PROJECT_ID.value() || "mydoublesprogress",
    timeZone: MYDOUBLE_TIMEZONE.value(),
    token: TIME_LEFT_INGESTION_TOKEN.value(),
  };
}

module.exports = {
  MYDOUBLE_APP_BASE_URL,
  MYDOUBLE_FIREBASE_PROJECT_ID,
  MYDOUBLE_OWNER_UID,
  MYDOUBLE_SOURCE_PROJECT_ID,
  MYDOUBLE_TIMEZONE,
  TIME_LEFT_BATCH_INGEST_ENDPOINT,
  TIME_LEFT_CALENDAR_ID,
  TIME_LEFT_CONNECTION_ID,
  TIME_LEFT_INGESTION_TOKEN,
  TIME_LEFT_LIFE_EVENT_ENDPOINT,
  TIME_LEFT_SINGLE_INGEST_ENDPOINT,
  readConfig,
};
