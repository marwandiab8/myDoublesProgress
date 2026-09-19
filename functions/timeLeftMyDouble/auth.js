const crypto = require("node:crypto");

function bearerToken(authorizationHeader) {
  const match = String(authorizationHeader || "").match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

// Hashing first gives both sides the same length, so timingSafeEqual can't throw on a length
// mismatch and neither the comparison time nor an early exit reveals anything about the token.
function digest(value) {
  return crypto.createHash("sha256").update(String(value)).digest();
}

// True only for "Authorization: Bearer <expectedToken>". An empty expected token never matches, so a
// missing or blank secret denies every request instead of allowing an empty one.
function isAuthorized(authorizationHeader, expectedToken) {
  const expected = String(expectedToken || "");
  const provided = bearerToken(authorizationHeader);
  if (!expected || !provided) return false;
  return crypto.timingSafeEqual(digest(provided), digest(expected));
}

module.exports = { isAuthorized };
