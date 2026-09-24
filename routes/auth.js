// ---------------------------------------------------------------------------
// Customer accounts — mounted at /api/auth
//
// The lifecycle, in the order a customer meets it:
//
//   lookup          does this address have an account? (drives the two-step form)
//   register        creates an unverified account and emails a code
//   verify-email    the code proves the address; only now does a session exist
//   login           password, then a two-step code if the account has one
//   refresh         rotates the session in the background
//   forgot/reset    the way back in, which also signs out every device
//   profile/password/sessions/totp   account management
// ---------------------------------------------------------------------------

import crypto from "node:crypto";

import {
  ACCESS_COOKIE,
  ACCESS_TOKEN_TTL_SECONDS,
  CHALLENGE_COOKIE,
  CHALLENGE_TTL_SECONDS,
  cookieAttributes,
  createCsrfToken,
  createFamilyId,
  createRefreshToken,
  hashPassword,
  hashRefreshToken,
  isSecureRequest,
  normalizeEmail,
  parseCookies,
  passwordProblems,
  REFRESH_COOKIE,
  REFRESH_COOKIE_PATH,
  REFRESH_TOKEN_TTL_SECONDS,
  serializeCookie,
  signAccessToken,
  TOKEN_USE_CHALLENGE,
  validateCredentials,
  verifyAccessToken,
  verifyPassword,
} from "../lib/auth.js";
import {
  AUTH_SECRET,
  clearAuthCookies,
  invalidateAccessTokens,
  issueCookies,
  mintAccessToken,
  rateLimit,
  requireUser,
} from "../lib/customer-session.js";
import { asyncRouter } from "../lib/async-routes.js";
import { requireCsrf } from "../lib/csrf.js";
import { db, NOW_SQL } from "../db/connection.js";
import { safeJsonArray } from "../lib/catalog.js";
import { isUniqueViolation } from "../db/client.js";
import {
  authorizationUrl,
  callbackUrl,
  createState,
  exchangeCodeForProfile,
  googleIsConfigured,
  STATE_COOKIE,
  STATE_TTL_SECONDS,
  statesMatch,
} from "../lib/oauth.js";
import {
  newSignInEmail,
  passwordChangedEmail,
  passwordResetEmail,
  sendMail,
  twoFactorEnabledEmail,
  verificationEmail,
} from "../lib/mailer.js";
import {
  createNumericCode,
  createRecoveryCodes,
  createTotpSecret,
  hashCode,
  hashRecoveryCode,
  otpauthUrl,
  verifyTotp,
} from "../lib/totp.js";
import QRCode from "qrcode";

const router = asyncRouter();

// ---------------------------------------------------------------------------
// Customer accounts
//
// The lifecycle, in the order a customer meets it:
//
//   lookup          does this address have an account? (drives the two-step form)
//   register        creates an unverified account and emails a code
//   verify-email    the code proves the address; only now does a session exist
//   login           password, then a two-step code if the account has one
//   refresh         rotates the session in the background
//   forgot/reset    the way back in, which also signs out every device
//   profile/password/sessions/totp   account management
// ---------------------------------------------------------------------------

// Comparing against a throwaway hash when no account matches keeps the response
// time for "unknown email" and "wrong password" indistinguishable.
const DUMMY_PASSWORD_HASH = await hashPassword(crypto.randomBytes(16).toString("hex"));

const CODE_TTL_SECONDS = 15 * 60;
const CODE_MAX_ATTEMPTS = 5;

function publicUser(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name || null,
    createdAt: row.created_at,
    emailVerified: Boolean(row.email_verified_at),
    twoFactorEnabled: Boolean(row.totp_enabled_at),
  };
}

function utcNow() {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

function utcIn(seconds) {
  return new Date(Date.now() + seconds * 1000).toISOString().slice(0, 19).replace("T", " ");
}

function clientDescription(request) {
  return {
    userAgent: String(request.headers["user-agent"] || "").slice(0, 200),
    ip: request.ip,
  };
}

// Issues a fresh access token plus a refresh token belonging to `familyId`
// (a new family for a new login, the existing one when rotating).
async function startSession(request, response, user, { familyId = createFamilyId(), persistent = true } = {}) {
  const refreshToken = createRefreshToken();
  const client = clientDescription(request);
  await db
    .prepare(
      `INSERT INTO refresh_tokens (user_id, token_hash, family_id, expires_at, user_agent, ip, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(user.id, hashRefreshToken(refreshToken), familyId, utcIn(REFRESH_TOKEN_TTL_SECONDS), client.userAgent, client.ip, utcNow());

  const secure = isSecureRequest(request);
  response.append(
    "Set-Cookie",
    serializeCookie(
      ACCESS_COOKIE,
      mintAccessToken(user),
      cookieAttributes({ secure, maxAgeSeconds: ACCESS_TOKEN_TTL_SECONDS, persistent })
    )
  );
  response.append(
    "Set-Cookie",
    serializeCookie(
      REFRESH_COOKIE,
      refreshToken,
      cookieAttributes({ secure, maxAgeSeconds: REFRESH_TOKEN_TTL_SECONDS, path: REFRESH_COOKIE_PATH, persistent })
    )
  );
  // Rotated alongside the session so a token captured before sign-in can't be
  // reused afterwards.
  issueCookies(response, request, { csrfToken: createCsrfToken() });
}

// ---------------------------------------------------------------------------
// One-time codes
// ---------------------------------------------------------------------------
async function issueCode(userId, purpose) {
  // Only the newest code for a purpose is valid — requesting a new one
  // invalidates whatever was sent before.
  await db.prepare("DELETE FROM auth_codes WHERE user_id = ? AND purpose = ?").run(userId, purpose);
  const code = createNumericCode(6);
  await db
    .prepare("INSERT INTO auth_codes (user_id, purpose, code_hash, expires_at) VALUES (?, ?, ?, ?)")
    .run(userId, purpose, hashCode(code), utcIn(CODE_TTL_SECONDS));
  return code;
}

// Returns null when the code is good; a message when it isn't. Wrong guesses are
// counted so a six-digit code can't simply be enumerated.
async function consumeCode(userId, purpose, code) {
  const row = await db
    .prepare(
      `SELECT id, code_hash, attempts, expires_at, used_at FROM auth_codes
       WHERE user_id = ? AND purpose = ? ORDER BY id DESC LIMIT 1`
    )
    .get(userId, purpose);

  if (!row || row.used_at) return "That code is no longer valid. Request a new one.";
  if (row.expires_at < utcNow()) return "That code has expired. Request a new one.";
  if (row.attempts >= CODE_MAX_ATTEMPTS) return "Too many incorrect attempts. Request a new code.";

  const cleaned = String(code ?? "").replace(/\D/g, "");
  if (hashCode(cleaned) !== row.code_hash) {
    await db.prepare("UPDATE auth_codes SET attempts = attempts + 1 WHERE id = ?").run(row.id);
    const left = CODE_MAX_ATTEMPTS - (row.attempts + 1);
    return left > 0 ? `Incorrect code. ${left} attempt${left === 1 ? "" : "s"} left.` : "Too many incorrect attempts. Request a new code.";
  }

  await db.prepare(`UPDATE auth_codes SET used_at = ${NOW_SQL} WHERE id = ?`).run(row.id);
  return null;
}

async function revokeAllSessions(userId, exceptFamilyId = null) {
  // Kills the refresh tokens *and* every access token already out there. The
  // device performing the action is given a fresh session immediately after.
  await invalidateAccessTokens(userId);
  if (exceptFamilyId) {
    await db
      .prepare(`UPDATE refresh_tokens SET revoked_at = ${NOW_SQL} WHERE user_id = ? AND family_id <> ? AND revoked_at IS NULL`)
      .run(userId, exceptFamilyId);
  } else {
    await db.prepare(`UPDATE refresh_tokens SET revoked_at = ${NOW_SQL} WHERE user_id = ? AND revoked_at IS NULL`).run(userId);
  }
}

function findUserByEmail(email) {
  return db
    .prepare(
      `SELECT id, email, name, password_hash, created_at, last_login_at, email_verified_at,
              totp_secret, totp_enabled_at, recovery_codes, google_sub
       FROM users WHERE email = ?`
    )
    .get(email);
}

// ---------------------------------------------------------------------------
// Step 1 — who is this?
//
// The two-step form needs to know whether to ask for a password or offer to
// create an account. This does confirm whether an address is registered, which
// is the same trade every large shop makes (Amazon's sign-in page says "We
// cannot find an account with that email address"); registration has to reject
// duplicates anyway, so the fact is already discoverable. It is rate limited so
// it can't be used to harvest a list.
// ---------------------------------------------------------------------------
router.post("/lookup", requireCsrf, async (request, response) => {
  const email = normalizeEmail(request.body?.email);
  if (!email) return response.status(400).json({ error: "validation_failed", message: "Enter an email address." });
  if (!rateLimit(`lookup:${request.ip}`, 30, 15 * 60 * 1000)) {
    return response.status(429).json({ error: "rate_limited", message: "Too many attempts. Try again in a few minutes." });
  }

  try {
    const user = await findUserByEmail(email);
    response.json({
      exists: Boolean(user),
      // An account that never finished verifying should resume at the code step
      // rather than being asked for a password it can't yet use.
      pendingVerification: Boolean(user && !user.email_verified_at),
    });
  } catch (error) {
    console.error("[auth] lookup failed:", error);
    response.status(500).json({ error: "lookup_failed", message: error.message });
  }
});

// Send a code the customer cannot continue without, and report whether they can
// actually be told to go and read it.
//
// sendMail resolves three ways: delivered, logged (development, no SMTP —
// perfectly fine, the code is in the server log), or a real delivery failure.
// Only the last one is a problem, and it used to be invisible: the caller
// ignored the result and answered "check your email" regardless, leaving the
// customer waiting on a message that was never sent.
async function deliverCode({ to, subject, text }) {
  const result = await sendMail({ to, subject, text });
  if (result.delivered || result.logged) return true;
  console.error(`[auth] could not deliver "${subject}" to ${to} — answering with an error`);
  return false;
}

const EMAIL_FAILED = {
  error: "email_failed",
  message: "We couldn't send that email just now. Please try again in a moment.",
};

// ---------------------------------------------------------------------------
// Step 2a — create an account. No session is issued here: the account is inert
// until the emailed code proves the address is real.
// ---------------------------------------------------------------------------
router.post("/register", requireCsrf, async (request, response) => {
  const { email, password, name } = request.body || {};

  const problems = validateCredentials({ email, password, name });
  if (problems.length) {
    return response.status(400).json({
      error: "validation_failed",
      message: problems.map((problem) => problem.message).join(" "),
      problems,
    });
  }
  if (!rateLimit(`register:${request.ip}`, 10, 60 * 60 * 1000)) {
    return response.status(429).json({ error: "rate_limited", message: "Too many attempts. Try again later." });
  }

  const normalizedEmail = normalizeEmail(email);
  try {
    const existing = await findUserByEmail(normalizedEmail);

    if (existing?.email_verified_at) {
      return response.status(409).json({ error: "email_taken", message: "An account with that email already exists." });
    }

    let userId;
    if (existing) {
      // An abandoned signup: take the new password and send a fresh code rather
      // than stranding the address forever.
      userId = existing.id;
      await db
        .prepare("UPDATE users SET password_hash = ?, name = ? WHERE id = ?")
        .run(await hashPassword(password), String(name ?? "").trim() || existing.name, userId);
    } else {
      const created = await db
        .prepare("INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?) RETURNING id")
        .get(normalizedEmail, await hashPassword(password), String(name ?? "").trim() || null);
      userId = created.id;
    }

    const code = await issueCode(userId, "verify");
    const message = verificationEmail(code);
    if (!(await deliverCode({ to: normalizedEmail, ...message }))) {
      // The row stays behind unverified, which is exactly the abandoned-signup
      // case handled above — registering again reissues a code rather than
      // reporting the address as taken.
      return response.status(502).json(EMAIL_FAILED);
    }

    console.log(`[auth] verification code issued for ${normalizedEmail}`);
    response.status(201).json({ verificationRequired: true, email: normalizedEmail });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return response.status(409).json({ error: "email_taken", message: "An account with that email already exists." });
    }
    console.error("[auth] register failed:", error);
    response.status(500).json({ error: "register_failed", message: error.message });
  }
});

router.post("/verify-email", requireCsrf, async (request, response) => {
  const email = normalizeEmail(request.body?.email);
  if (!rateLimit(`verify:${request.ip}`, 30, 15 * 60 * 1000)) {
    return response.status(429).json({ error: "rate_limited", message: "Too many attempts. Try again in a few minutes." });
  }

  try {
    const user = await findUserByEmail(email);
    if (!user) return response.status(400).json({ error: "invalid_code", message: "That code is no longer valid. Request a new one." });
    if (user.email_verified_at) {
      return response.status(409).json({ error: "already_verified", message: "That address is already verified. Please sign in." });
    }

    const problem = await consumeCode(user.id, "verify", request.body?.code);
    if (problem) return response.status(400).json({ error: "invalid_code", message: problem });

    await db.prepare(`UPDATE users SET email_verified_at = ${NOW_SQL}, last_login_at = ${NOW_SQL} WHERE id = ?`).run(user.id);
    await startSession(request, response, user, { persistent: request.body?.remember !== false });

    console.log(`[auth] verified ${email}`);
    response.json({ user: publicUser({ ...user, email_verified_at: utcNow() }) });
  } catch (error) {
    console.error("[auth] verify failed:", error);
    response.status(500).json({ error: "verify_failed", message: error.message });
  }
});

// Re-send a verification or reset code. Answers the same way whether or not the
// address exists, and is throttled so it can't be used to send someone mail
// repeatedly.
router.post("/resend-code", requireCsrf, async (request, response) => {
  const email = normalizeEmail(request.body?.email);
  const purpose = request.body?.purpose === "reset" ? "reset" : "verify";

  if (!rateLimit(`resend:${email}`, 5, 15 * 60 * 1000) || !rateLimit(`resend-ip:${request.ip}`, 20, 60 * 60 * 1000)) {
    return response.status(429).json({ error: "rate_limited", message: "Too many requests. Try again in a few minutes." });
  }

  try {
    const user = await findUserByEmail(email);
    if (user && (purpose === "reset" || !user.email_verified_at)) {
      const code = await issueCode(user.id, purpose);
      const message = purpose === "reset" ? passwordResetEmail(code) : verificationEmail(code);
      if (!(await deliverCode({ to: email, ...message }))) {
        return response.status(502).json(EMAIL_FAILED);
      }
    }
    response.json({ ok: true });
  } catch (error) {
    console.error("[auth] resend failed:", error);
    response.status(500).json({ error: "resend_failed", message: error.message });
  }
});

// ---------------------------------------------------------------------------
// Step 2b — sign in
// ---------------------------------------------------------------------------
router.post("/login", requireCsrf, async (request, response) => {
  const { email, password } = request.body || {};
  const remember = request.body?.remember !== false;
  const normalizedEmail = normalizeEmail(email);

  // Throttled per address and per client, so neither one account nor one
  // attacker can be hammered.
  const allowed =
    rateLimit(`login-ip:${request.ip}`, 20, 15 * 60 * 1000) &&
    rateLimit(`login-email:${normalizedEmail}`, 10, 15 * 60 * 1000);
  if (!allowed) {
    return response.status(429).json({ error: "rate_limited", message: "Too many attempts. Try again in a few minutes." });
  }

  try {
    const user = await findUserByEmail(normalizedEmail);
    // Always spend the same work on a password, so the response time says
    // nothing about whether the account exists or how it was created.
    const ok = user?.password_hash
      ? await verifyPassword(String(password ?? ""), user.password_hash)
      : await verifyPassword(String(password ?? ""), DUMMY_PASSWORD_HASH);

    // Created through Google and never given a password: there is nothing here
    // to check, so say so rather than rejecting a password they never set.
    if (user && !user.password_hash) {
      return response.status(409).json({
        error: "use_google",
        message: "This account signs in with Google. Use the Continue with Google button.",
      });
    }

    // One message for both failures: never reveal whether a password was close.
    if (!user || !ok) {
      console.warn(`[auth] failed login for ${normalizedEmail || "(no email)"} from ${request.ip}`);
      return response.status(401).json({ error: "invalid_credentials", message: "Incorrect email or password." });
    }

    if (!user.email_verified_at) {
      const code = await issueCode(user.id, "verify");
      // Safe to report a mail failure here: the password already checked out,
      // so this says nothing to anyone who isn't the account holder.
      if (!(await deliverCode({ to: normalizedEmail, ...verificationEmail(code) }))) {
        return response.status(502).json(EMAIL_FAILED);
      }
      return response.status(403).json({
        error: "verification_required",
        message: "Confirm your email address to finish setting up your account. We've sent you a new code.",
        email: normalizedEmail,
      });
    }

    // Two-step verification: the password was right, but it isn't a session yet.
    if (user.totp_enabled_at) {
      response.append(
        "Set-Cookie",
        serializeCookie(
          CHALLENGE_COOKIE,
          signAccessToken(
            { sub: user.id, use: TOKEN_USE_CHALLENGE, purpose: "totp", remember },
            AUTH_SECRET,
            CHALLENGE_TTL_SECONDS
          ),
          cookieAttributes({ secure: isSecureRequest(request), maxAgeSeconds: CHALLENGE_TTL_SECONDS })
        )
      );
      return response.json({ requiresTwoFactor: true });
    }

    await completeLogin(request, response, user, remember);
    response.json({ user: publicUser(user) });
  } catch (error) {
    console.error("[auth] login failed:", error);
    response.status(500).json({ error: "login_failed", message: error.message });
  }
});

async function completeLogin(request, response, user, remember) {
  await db.prepare(`UPDATE users SET last_login_at = ${NOW_SQL} WHERE id = ?`).run(user.id);
  // Housekeeping: drop this account's dead tokens on the way through.
  await db.prepare("DELETE FROM refresh_tokens WHERE user_id = ? AND expires_at < ?").run(user.id, utcNow());
  await startSession(request, response, user, { persistent: remember });

  const client = clientDescription(request);
  // Fire-and-forget: a slow mail server must not slow down signing in.
  sendMail({ to: user.email, ...newSignInEmail({ when: utcNow(), ...client }) }).catch(() => {});
  console.log(`[auth] customer login ${user.email}`);
}

router.post("/two-factor", requireCsrf, async (request, response) => {
  const cookies = parseCookies(request.headers.cookie);
  // Verified as a challenge token specifically — an ordinary access token (or a
  // token of any other use) will not satisfy this, just as the challenge token
  // can no longer satisfy attachUser's access-token check.
  const challenge = verifyAccessToken(cookies[CHALLENGE_COOKIE], AUTH_SECRET, TOKEN_USE_CHALLENGE);
  if (!challenge || challenge.purpose !== "totp") {
    return response.status(401).json({ error: "challenge_expired", message: "That took too long. Please sign in again." });
  }
  if (!rateLimit(`totp:${challenge.sub}`, 10, 15 * 60 * 1000)) {
    return response.status(429).json({ error: "rate_limited", message: "Too many attempts. Try again in a few minutes." });
  }

  try {
    const user = await db
      .prepare(
        `SELECT id, email, name, created_at, email_verified_at, totp_secret, totp_enabled_at, recovery_codes
         FROM users WHERE id = ?`
      )
      .get(challenge.sub);
    if (!user?.totp_enabled_at) {
      return response.status(401).json({ error: "challenge_expired", message: "Please sign in again." });
    }

    const submitted = String(request.body?.code ?? "");
    let accepted = verifyTotp(user.totp_secret, submitted);

    // A recovery code works once, and is spent whether or not it was the last one.
    if (!accepted) {
      const remaining = safeJsonArray(user.recovery_codes);
      const hashed = hashRecoveryCode(submitted);
      const index = remaining.indexOf(hashed);
      if (index !== -1) {
        remaining.splice(index, 1);
        await db.prepare("UPDATE users SET recovery_codes = ? WHERE id = ?").run(JSON.stringify(remaining), user.id);
        accepted = true;
        console.warn(`[auth] recovery code used for ${user.email}; ${remaining.length} left`);
      }
    }

    if (!accepted) {
      return response.status(401).json({ error: "invalid_code", message: "That code isn't right. Check your authenticator app." });
    }

    response.append(
      "Set-Cookie",
      serializeCookie(CHALLENGE_COOKIE, "", cookieAttributes({ secure: isSecureRequest(request), maxAgeSeconds: 0 }))
    );
    await completeLogin(request, response, user, challenge.remember !== false);
    response.json({ user: publicUser(user) });
  } catch (error) {
    console.error("[auth] two-factor failed:", error);
    response.status(500).json({ error: "two_factor_failed", message: error.message });
  }
});

// ---------------------------------------------------------------------------
// Forgotten passwords
// ---------------------------------------------------------------------------
router.post("/forgot-password", requireCsrf, async (request, response) => {
  const email = normalizeEmail(request.body?.email);
  if (!rateLimit(`forgot:${email}`, 5, 15 * 60 * 1000) || !rateLimit(`forgot-ip:${request.ip}`, 20, 60 * 60 * 1000)) {
    return response.status(429).json({ error: "rate_limited", message: "Too many requests. Try again in a few minutes." });
  }

  try {
    const user = await findUserByEmail(email);
    if (user) {
      const code = await issueCode(user.id, "reset");
      if (!(await deliverCode({ to: email, ...passwordResetEmail(code) }))) {
        return response.status(502).json(EMAIL_FAILED);
      }
      console.log(`[auth] password reset code issued for ${email}`);
    }
    // Always the same answer: this endpoint needs no account to exist, and
    // shouldn't become a way to test addresses.
    response.json({ ok: true });
  } catch (error) {
    console.error("[auth] forgot-password failed:", error);
    response.status(500).json({ error: "forgot_failed", message: error.message });
  }
});

router.post("/reset-password", requireCsrf, async (request, response) => {
  const email = normalizeEmail(request.body?.email);
  const { code, password } = request.body || {};

  if (!rateLimit(`reset:${request.ip}`, 20, 15 * 60 * 1000)) {
    return response.status(429).json({ error: "rate_limited", message: "Too many attempts. Try again in a few minutes." });
  }

  const problem = passwordProblems(password, email);
  if (problem) {
    return response.status(400).json({ error: "validation_failed", message: problem.message, problems: [problem] });
  }

  try {
    const user = await findUserByEmail(email);
    if (!user) return response.status(400).json({ error: "invalid_code", message: "That code is no longer valid. Request a new one." });

    const codeProblem = await consumeCode(user.id, "reset", code);
    if (codeProblem) return response.status(400).json({ error: "invalid_code", message: codeProblem });

    await db
      .prepare(`UPDATE users SET password_hash = ?, password_changed_at = ${NOW_SQL}, email_verified_at = COALESCE(email_verified_at, ${NOW_SQL}) WHERE id = ?`)
      .run(await hashPassword(password), user.id);

    // Whoever knew the old password — including whoever the customer is resetting
    // because of — loses every session.
    await revokeAllSessions(user.id);
    sendMail({ to: user.email, ...passwordChangedEmail() }).catch(() => {});

    await startSession(request, response, user);
    console.log(`[auth] password reset for ${email}`);
    response.json({ user: publicUser({ ...user, email_verified_at: user.email_verified_at || utcNow() }) });
  } catch (error) {
    console.error("[auth] reset-password failed:", error);
    response.status(500).json({ error: "reset_failed", message: error.message });
  }
});

// ---------------------------------------------------------------------------
// Session upkeep
// ---------------------------------------------------------------------------

// Rotation with reuse detection. A refresh token is single-use: presenting one
// that has already been exchanged means it leaked, so the entire family — every
// token descended from that login — is revoked.
router.post("/refresh", requireCsrf, async (request, response) => {
  const cookies = parseCookies(request.headers.cookie);
  const presented = cookies[REFRESH_COOKIE];
  if (!presented) {
    return response.status(401).json({ error: "auth_required", message: "Not signed in." });
  }
  if (!rateLimit(`refresh:${request.ip}`, 120, 15 * 60 * 1000)) {
    return response.status(429).json({ error: "rate_limited", message: "Too many attempts. Try again later." });
  }

  try {
    const record = await db
      .prepare(
        `SELECT t.id, t.user_id, t.family_id, t.expires_at, t.used_at, t.revoked_at,
                u.id AS uid, u.email, u.name, u.created_at, u.email_verified_at, u.totp_enabled_at
         FROM refresh_tokens t
         JOIN users u ON u.id = t.user_id
         WHERE t.token_hash = ?`
      )
      .get(hashRefreshToken(presented));

    if (!record) {
      clearAuthCookies(response, request);
      return response.status(401).json({ error: "auth_required", message: "Session expired. Please sign in again." });
    }

    if (record.used_at || record.revoked_at) {
      await db
        .prepare(`UPDATE refresh_tokens SET revoked_at = ${NOW_SQL} WHERE family_id = ? AND revoked_at IS NULL`)
        .run(record.family_id);
      clearAuthCookies(response, request);
      console.warn(`[auth] refresh token reuse detected for user ${record.user_id}; session family revoked`);
      return response.status(401).json({ error: "auth_required", message: "Session expired. Please sign in again." });
    }

    if (record.expires_at < utcNow()) {
      clearAuthCookies(response, request);
      return response.status(401).json({ error: "auth_required", message: "Session expired. Please sign in again." });
    }

    await db.prepare(`UPDATE refresh_tokens SET used_at = ${NOW_SQL}, last_used_at = ${NOW_SQL} WHERE id = ?`).run(record.id);
    const user = {
      id: record.uid,
      email: record.email,
      name: record.name,
      created_at: record.created_at,
      email_verified_at: record.email_verified_at,
      totp_enabled_at: record.totp_enabled_at,
    };
    await startSession(request, response, user, { familyId: record.family_id });
    response.json({ user: publicUser(user) });
  } catch (error) {
    console.error("[auth] refresh failed:", error);
    response.status(500).json({ error: "refresh_failed", message: error.message });
  }
});

router.post("/logout", requireCsrf, async (request, response) => {
  const cookies = parseCookies(request.headers.cookie);
  const presented = cookies[REFRESH_COOKIE];

  try {
    if (presented) {
      // Revoke the whole family, so no outstanding token from this login works.
      await db
        .prepare(
          `UPDATE refresh_tokens SET revoked_at = ${NOW_SQL}
           WHERE family_id = (SELECT family_id FROM refresh_tokens WHERE token_hash = ?)
             AND revoked_at IS NULL`
        )
        .run(hashRefreshToken(presented));
    }
  } catch (error) {
    // Signing out must succeed for the browser even if the bookkeeping fails.
    console.error("[auth] logout cleanup failed:", error);
  }

  clearAuthCookies(response, request);
  response.json({ ok: true });
});

// Called on page load to restore a session. Returns null rather than 401 so a
// signed-out visit isn't an error in the console on every load.
router.get("/me", async (request, response) => {
  if (!request.user) return response.json({ user: null });
  try {
    const row = await db
      .prepare("SELECT id, email, name, created_at, email_verified_at, totp_enabled_at FROM users WHERE id = ?")
      .get(request.user.id);
    response.json({ user: row ? publicUser(row) : null });
  } catch (error) {
    console.error("[auth] me failed:", error);
    response.status(500).json({ error: "me_failed", message: error.message });
  }
});

// Guarantees the caller has a CSRF cookie before it posts anything.
router.get("/csrf", (request, response) => {
  response.json({ csrfToken: request.csrfToken });
});

// ---------------------------------------------------------------------------
// Sign in with Google
//
// An account created this way is verified the moment it exists — Google has
// already proved the address — and has no password, so neither a verification
// code nor a reset link is ever sent. That is what lets a deployment run
// without a mail server at all.
// ---------------------------------------------------------------------------

// The storefront asks before drawing the button, so a deployment without Google
// credentials simply shows the email and password form.
router.get("/providers", (_request, response) => {
  response.json({ google: googleIsConfigured });
});

function findUserByGoogleId(googleId) {
  return db
    .prepare(
      `SELECT id, email, name, password_hash, created_at, last_login_at, email_verified_at,
              totp_secret, totp_enabled_at, recovery_codes, google_sub
       FROM users WHERE google_sub = ?`
    )
    .get(googleId);
}

// Anything that goes wrong lands back on the storefront with a reason, rather
// than showing a bare JSON error to somebody who just clicked a button.
function failedSignIn(response, reason, detail) {
  console.error(`[auth] google sign-in failed (${reason}):`, detail);
  response.redirect(`/?auth_error=${encodeURIComponent(reason)}`);
}

router.get("/google", (request, response) => {
  if (!googleIsConfigured) {
    return response.status(404).json({ error: "google_disabled", message: "Google sign-in is not configured." });
  }
  if (!rateLimit(`google:${request.ip}`, 20, 15 * 60 * 1000)) {
    return response.status(429).json({ error: "rate_limited", message: "Too many attempts. Try again in a few minutes." });
  }

  const state = createState();
  response.append(
    "Set-Cookie",
    serializeCookie(
      STATE_COOKIE,
      state,
      cookieAttributes({
        secure: isSecureRequest(request),
        maxAgeSeconds: STATE_TTL_SECONDS,
        sameSite: "Lax",
      })
    )
  );

  response.redirect(
    authorizationUrl({
      state,
      redirectUri: callbackUrl(request),
      // Prefills the chooser when the customer already typed an address.
      loginHint: normalizeEmail(request.query?.email) || undefined,
    })
  );
});

router.get("/google/callback", async (request, response) => {
  // One use only, and cleared before anything else can fail and leave it behind.
  response.append(
    "Set-Cookie",
    serializeCookie(STATE_COOKIE, "", cookieAttributes({ secure: isSecureRequest(request), maxAgeSeconds: 0, sameSite: "Lax" }))
  );

  if (!googleIsConfigured) return failedSignIn(response, "google_disabled", "no client credentials");
  // The customer pressed Cancel on Google's consent screen.
  if (request.query?.error) return failedSignIn(response, "cancelled", request.query.error);

  const code = String(request.query?.code ?? "");
  if (!code) return failedSignIn(response, "invalid_response", "no code in callback");
  const cookies = parseCookies(request.headers.cookie);
  if (!statesMatch(cookies[STATE_COOKIE], request.query?.state)) {
    return failedSignIn(response, "bad_state", "state cookie did not match the callback");
  }

  try {
    const profile = await exchangeCodeForProfile({ code, redirectUri: callbackUrl(request) });
    const email = normalizeEmail(profile.email);

    let user = await findUserByGoogleId(profile.googleId);

    if (!user) {
      // Same person, already registered with a password: link the two rather
      // than failing on the unique email, and treat the address as verified
      // since Google has just confirmed they hold it.
      const byEmail = await findUserByEmail(email);
      if (byEmail) {
        await db
          .prepare(
            `UPDATE users SET google_sub = ?, email_verified_at = COALESCE(email_verified_at, ${NOW_SQL}),
                              name = COALESCE(name, ?) WHERE id = ?`
          )
          .run(profile.googleId, profile.name, byEmail.id);
        user = await findUserByGoogleId(profile.googleId);
      } else {
        const created = await db
          .prepare(
            `INSERT INTO users (email, password_hash, name, google_sub, email_verified_at)
             VALUES (?, NULL, ?, ?, ${NOW_SQL}) RETURNING id`
          )
          .get(email, profile.name, profile.googleId);
        console.log(`[auth] account created through google for ${email}`);
        user = await findUserByGoogleId(profile.googleId);
        if (!user) throw new Error(`account ${created.id} vanished immediately after being created`);
      }
    }

    // Two-step verification still applies: someone who turned it on chose to
    // need a second factor, and arriving through Google doesn't waive that.
    if (user.totp_enabled_at) {
      response.append(
        "Set-Cookie",
        serializeCookie(
          CHALLENGE_COOKIE,
          signAccessToken(
            { sub: user.id, use: TOKEN_USE_CHALLENGE, purpose: "totp", remember: true },
            AUTH_SECRET,
            CHALLENGE_TTL_SECONDS
          ),
          cookieAttributes({ secure: isSecureRequest(request), maxAgeSeconds: CHALLENGE_TTL_SECONDS })
        )
      );
      return response.redirect("/?auth=two_factor");
    }

    await completeLogin(request, response, user, true);
    response.redirect("/");
  } catch (error) {
    failedSignIn(response, "exchange_failed", error.message);
  }
});

// ---------------------------------------------------------------------------
// Account management
// ---------------------------------------------------------------------------
router.patch("/profile", requireUser, requireCsrf, async (request, response) => {
  const name = String(request.body?.name ?? "").trim();
  if (name.length > 100) {
    return response.status(400).json({ error: "validation_failed", message: "Name must be at most 100 characters." });
  }

  try {
    const row = await db
      .prepare("UPDATE users SET name = ? WHERE id = ? RETURNING id, email, name, created_at, email_verified_at, totp_enabled_at")
      .get(name || null, request.user.id);
    response.json({ user: publicUser(row) });
  } catch (error) {
    console.error("[auth] profile update failed:", error);
    response.status(500).json({ error: "profile_failed", message: error.message });
  }
});

router.post("/change-password", requireUser, requireCsrf, async (request, response) => {
  const { currentPassword, newPassword } = request.body || {};

  try {
    const user = await db.prepare("SELECT id, email, password_hash FROM users WHERE id = ?").get(request.user.id);
    if (!user || !(await verifyPassword(String(currentPassword ?? ""), user.password_hash))) {
      return response.status(401).json({ error: "invalid_credentials", message: "Your current password isn't right." });
    }

    const problem = passwordProblems(newPassword, user.email);
    if (problem) {
      return response.status(400).json({ error: "validation_failed", message: problem.message, problems: [problem] });
    }

    await db
      .prepare(`UPDATE users SET password_hash = ?, password_changed_at = ${NOW_SQL} WHERE id = ?`)
      .run(await hashPassword(newPassword), user.id);

    // Every other device is signed out; this one keeps its session by getting a
    // brand new one after the revocation.
    await revokeAllSessions(user.id);
    await startSession(request, response, user);
    sendMail({ to: user.email, ...passwordChangedEmail() }).catch(() => {});

    console.log(`[auth] password changed for ${user.email}`);
    response.json({ ok: true });
  } catch (error) {
    console.error("[auth] change-password failed:", error);
    response.status(500).json({ error: "change_password_failed", message: error.message });
  }
});

// Where this account is signed in. One row per login, not per token: rotation
// would otherwise make a single browser look like hundreds of sessions.
router.get("/sessions", requireUser, async (request, response) => {
  try {
    const cookies = parseCookies(request.headers.cookie);
    const current = cookies[REFRESH_COOKIE]
      ? await db.prepare("SELECT family_id FROM refresh_tokens WHERE token_hash = ?").get(hashRefreshToken(cookies[REFRESH_COOKIE]))
      : null;

    const rows = await db
      .prepare(
        `SELECT family_id,
                MIN(issued_at) AS started_at,
                MAX(COALESCE(last_used_at, issued_at)) AS last_used_at,
                MAX(user_agent) AS user_agent,
                MAX(ip) AS ip
         FROM refresh_tokens
         WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
         GROUP BY family_id
         ORDER BY MAX(COALESCE(last_used_at, issued_at)) DESC`
      )
      .all(request.user.id, utcNow());

    response.json({
      sessions: rows.map((row) => ({
        id: row.family_id,
        startedAt: row.started_at,
        lastUsedAt: row.last_used_at,
        device: row.user_agent || null,
        ip: row.ip || null,
        current: current ? row.family_id === current.family_id : false,
      })),
    });
  } catch (error) {
    console.error("[auth] sessions failed:", error);
    response.status(500).json({ error: "sessions_failed", message: error.message });
  }
});

router.delete("/sessions", requireUser, requireCsrf, async (request, response) => {
  try {
    const cookies = parseCookies(request.headers.cookie);
    const current = cookies[REFRESH_COOKIE]
      ? await db.prepare("SELECT family_id FROM refresh_tokens WHERE token_hash = ?").get(hashRefreshToken(cookies[REFRESH_COOKIE]))
      : null;

    await revokeAllSessions(request.user.id, current?.family_id || null);

    // This device's access token was just invalidated along with the rest, so
    // hand it a new one rather than signing the customer out of the page they
    // are standing on.
    const user = await db.prepare("SELECT id, email FROM users WHERE id = ?").get(request.user.id);
    response.append(
      "Set-Cookie",
      serializeCookie(
        ACCESS_COOKIE,
        mintAccessToken(user),
        cookieAttributes({ secure: isSecureRequest(request), maxAgeSeconds: ACCESS_TOKEN_TTL_SECONDS })
      )
    );

    console.log(`[auth] signed out other devices for user ${request.user.id}`);
    response.json({ ok: true });
  } catch (error) {
    console.error("[auth] sign out everywhere failed:", error);
    response.status(500).json({ error: "sessions_failed", message: error.message });
  }
});

// ---------------------------------------------------------------------------
// Two-step verification
// ---------------------------------------------------------------------------
router.post("/totp/setup", requireUser, requireCsrf, async (request, response) => {
  try {
    const user = await db.prepare("SELECT id, email, totp_enabled_at FROM users WHERE id = ?").get(request.user.id);
    if (user.totp_enabled_at) {
      return response.status(409).json({ error: "already_enabled", message: "Two-step verification is already on." });
    }

    // Stored but not yet active: it only counts once a code from the app proves
    // the secret actually made it there.
    const secret = createTotpSecret();
    await db.prepare("UPDATE users SET totp_secret = ? WHERE id = ?").run(secret, user.id);

    const url = otpauthUrl({ secret, account: user.email });
    response.json({ secret, otpauthUrl: url, qr: await QRCode.toDataURL(url, { margin: 1, width: 220 }) });
  } catch (error) {
    console.error("[auth] totp setup failed:", error);
    response.status(500).json({ error: "totp_setup_failed", message: error.message });
  }
});

router.post("/totp/enable", requireUser, requireCsrf, async (request, response) => {
  try {
    const user = await db.prepare("SELECT id, email, totp_secret, totp_enabled_at FROM users WHERE id = ?").get(request.user.id);
    if (user.totp_enabled_at) {
      return response.status(409).json({ error: "already_enabled", message: "Two-step verification is already on." });
    }
    if (!user.totp_secret || !verifyTotp(user.totp_secret, request.body?.code)) {
      return response.status(400).json({ error: "invalid_code", message: "That code isn't right. Check your authenticator app." });
    }

    // Shown once, stored hashed — the same treatment as a password.
    const recoveryCodes = createRecoveryCodes(10);
    await db
      .prepare(`UPDATE users SET totp_enabled_at = ${NOW_SQL}, recovery_codes = ? WHERE id = ?`)
      .run(JSON.stringify(recoveryCodes.map(hashRecoveryCode)), user.id);

    sendMail({ to: user.email, ...twoFactorEnabledEmail(true) }).catch(() => {});
    console.log(`[auth] two-step verification enabled for ${user.email}`);
    response.json({ ok: true, recoveryCodes });
  } catch (error) {
    console.error("[auth] totp enable failed:", error);
    response.status(500).json({ error: "totp_enable_failed", message: error.message });
  }
});

// Turning it off needs the password: otherwise a borrowed, already-signed-in
// browser could quietly remove the second factor.
router.post("/totp/disable", requireUser, requireCsrf, async (request, response) => {
  try {
    const user = await db.prepare("SELECT id, email, password_hash FROM users WHERE id = ?").get(request.user.id);
    if (!user || !(await verifyPassword(String(request.body?.password ?? ""), user.password_hash))) {
      return response.status(401).json({ error: "invalid_credentials", message: "Your password isn't right." });
    }

    await db.prepare("UPDATE users SET totp_secret = NULL, totp_enabled_at = NULL, recovery_codes = NULL WHERE id = ?").run(user.id);
    sendMail({ to: user.email, ...twoFactorEnabledEmail(false) }).catch(() => {});
    console.log(`[auth] two-step verification disabled for ${user.email}`);
    response.json({ ok: true });
  } catch (error) {
    console.error("[auth] totp disable failed:", error);
    response.status(500).json({ error: "totp_disable_failed", message: error.message });
  }
});

export default router;
