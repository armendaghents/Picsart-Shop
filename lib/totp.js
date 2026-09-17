// Two-step verification, RFC 6238 (TOTP) — the scheme Google Authenticator,
// 1Password, Authy and Amazon's own 2SV all speak.
//
// The shared secret lives in the users table and the code is derived from it
// plus the current 30-second window, so nothing has to travel between the phone
// and the server.

import crypto from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
// One step either side, so a phone clock that is slightly off still works.
const ALLOWED_DRIFT_STEPS = 1;

export function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input) {
  let bits = 0;
  let value = 0;
  const output = [];
  for (const char of String(input).toUpperCase().replace(/[^A-Z2-7]/g, "")) {
    value = (value << 5) | BASE32_ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

export function createTotpSecret() {
  return base32Encode(crypto.randomBytes(20)); // 160 bits, the RFC 4226 recommendation
}

export function totpCodeAt(secret, counter) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac("sha1", base32Decode(secret)).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

export function verifyTotp(secret, code, now = Date.now()) {
  const cleaned = String(code ?? "").replace(/\D/g, "");
  if (cleaned.length !== TOTP_DIGITS) return false;

  const counter = Math.floor(now / 1000 / TOTP_STEP_SECONDS);
  for (let drift = -ALLOWED_DRIFT_STEPS; drift <= ALLOWED_DRIFT_STEPS; drift += 1) {
    const expected = totpCodeAt(secret, counter + drift);
    // Constant-time compare, so response timing can't be used to guess digits.
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(cleaned))) return true;
  }
  return false;
}

// The URI an authenticator app expects behind the QR code.
export function otpauthUrl({ secret, account, issuer = "Picsart Shop" }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: String(TOTP_DIGITS), period: String(TOTP_STEP_SECONDS) });
  return `otpauth://totp/${label}?${params}`;
}

// ---------------------------------------------------------------------------
// Recovery codes — the way back in when the phone is lost. High-entropy, so a
// plain SHA-256 is enough; they don't need a slow KDF the way passwords do.
// ---------------------------------------------------------------------------
export function createRecoveryCodes(count = 10) {
  return Array.from({ length: count }, () => {
    const raw = crypto.randomBytes(5).toString("hex").toUpperCase(); // 10 chars
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

export function hashRecoveryCode(code) {
  return crypto.createHash("sha256").update(String(code).toUpperCase().replace(/[^A-Z0-9]/g, "")).digest("hex");
}

// ---------------------------------------------------------------------------
// Emailed one-time codes (verification, password reset). Stored hashed so the
// database never holds anything that can be typed straight into the app.
// ---------------------------------------------------------------------------
export function createNumericCode(digits = 6) {
  // randomInt is uniform — a modulo of randomBytes would not be.
  return String(crypto.randomInt(0, 10 ** digits)).padStart(digits, "0");
}

export function hashCode(code) {
  return crypto.createHash("sha256").update(String(code)).digest("hex");
}
