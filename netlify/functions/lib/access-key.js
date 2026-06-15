const crypto = require("crypto");

const PREFIX = "NETTLY-";

function getSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not configured");
  return secret;
}

function signPayload(payloadB64) {
  return crypto.createHmac("sha256", getSecret()).update(payloadB64).digest("base64url");
}

function createAccessKey(customerId) {
  const payload = JSON.stringify({ cid: customerId, v: 1 });
  const payloadB64 = Buffer.from(payload).toString("base64url");
  const sig = signPayload(payloadB64);
  return `${PREFIX}${payloadB64}.${sig}`;
}

function parseAccessKey(accessKey) {
  if (!accessKey || !accessKey.startsWith(PREFIX)) return null;
  const rest = accessKey.slice(PREFIX.length);
  const dot = rest.lastIndexOf(".");
  if (dot === -1) return null;

  const payloadB64 = rest.slice(0, dot);
  const sig = rest.slice(dot + 1);
  const expected = signPayload(payloadB64);

  try {
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      return null;
    }
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    return payload.cid || null;
  } catch {
    return null;
  }
}

function createReturnToken(customerId, ttlSec = 3600) {
  const payload = JSON.stringify({
    cid: customerId,
    exp: Math.floor(Date.now() / 1000) + ttlSec
  });
  const payloadB64 = Buffer.from(payload).toString("base64url");
  const sig = signPayload(payloadB64);
  return `${payloadB64}.${sig}`;
}

function parseReturnToken(token) {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot === -1) return null;

  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = signPayload(payloadB64);

  try {
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      return null;
    }
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    if (!payload.cid || !payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload.cid;
  } catch {
    return null;
  }
}

module.exports = {
  PREFIX,
  createAccessKey,
  parseAccessKey,
  createReturnToken,
  parseReturnToken
};
