const { initializeApp } = require("firebase-admin/app");

initializeApp();

Object.assign(exports, require("./timeLeftMyDouble/triggers"));
