const admin = require("firebase-admin");

admin.initializeApp();

Object.assign(exports, require("./timeLeftMyDouble/triggers"));
