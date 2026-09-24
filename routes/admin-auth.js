// ---------------------------------------------------------------------------
// Admin console — signing in, and serving the console itself
//
// The console can rewrite the catalogue and read every order, so it is held to
// a higher bar than a customer account: an IP allowlist in front, a second
// factor, a lockout that doubles, and a session pinned to the network and
// browser that created it. The mechanics live in lib/admin-session.js; this
// file is only the routes that use them.
// ---------------------------------------------------------------------------

import path from "node:path";

import { asyncRouter } from "../lib/async-routes.js";
import { requireCsrf } from "../lib/csrf.js";
import { PUBLIC_DIR } from "../lib/config.js";
import { CSRF_COOKIE, parseCookies, verifyPassword } from "../lib/auth.js";
import { verifyTotp } from "../lib/totp.js";
import { rateLimit } from "../lib/customer-session.js";
import {
  ADMIN_NAMED_ACCOUNTS,
  ADMIN_TOTP_IN_USE,
  adminFailureKey,
  adminLockRemainingMs,
  clearAdminFailures,
  clearSessionCookie,
  createAdminSession,
  DECOY_PASSWORD_HASH,
  destroyAdminSession,
  isAuthed,
  lookupAdminAccount,
  normalizeIp,
  normalizeUsername,
  readAdminSession,
  recordAdminFailure,
  requireAdminNetwork,
  SESSION_COOKIE,
  setSessionCookie,
} from "../lib/admin-session.js";

const router = asyncRouter();

router.post("/api/admin/login", requireAdminNetwork, requireCsrf, async (request, response) => {
  const ip = normalizeIp(request.ip);
  const { username, password, code } = request.body || {};

  // Resolved before the lockout check so the lockout can be scoped to this
  // account. An unknown name shares one bucket per address (see
  // adminFailureKey), which is what stops the map growing without bound.
  const account = lookupAdminAccount(username);
  const failureKey = adminFailureKey(account?.username, ip);
  const who = ADMIN_NAMED_ACCOUNTS ? `'${normalizeUsername(username) || "?"}' ` : "";

  const lockedFor = adminLockRemainingMs(failureKey);
  if (lockedFor > 0) {
    const seconds = Math.ceil(lockedFor / 1000);
    response.set("Retry-After", String(seconds));
    console.warn(`[auth] admin ${who}login refused from ${ip} — locked out for another ${seconds}s`);
    return response.status(429).json({
      ok: false,
      error: "locked_out",
      retryAfter: seconds,
      message: `Too many failed attempts. Try again in ${seconds} second${seconds === 1 ? "" : "s"}.`,
    });
  }

  // Three ceilings, narrowest first. The per-account one is what a single admin
  // can spend on their own; the per-address one is wide enough for every admin
  // in one office to spend theirs without touching a colleague's, but still
  // catches one address spraying many names; the global one is the backstop.
  // `||` short-circuits, so a request stopped by the first never consumes the
  // budgets behind it.
  if (
    !rateLimit(`admin-login-account:${failureKey}`, 20, 15 * 60 * 1000) ||
    !rateLimit(`admin-login-ip:${ip}`, 40, 15 * 60 * 1000) ||
    !rateLimit("admin-login-global", 60, 15 * 60 * 1000)
  ) {
    console.warn(`[auth] admin ${who}login rate limited from ${ip}`);
    return response
      .status(429)
      .json({ ok: false, error: "rate_limited", message: "Too many attempts. Try again in a few minutes." });
  }

  // An unknown username still pays the full scrypt cost, against a hash nobody
  // holds the password for. Every branch below therefore takes the same time
  // and returns the same message, so this never becomes a way to discover which
  // accounts exist.
  const passwordOk =
    typeof password === "string" &&
    password.length > 0 &&
    (await verifyPassword(password, account?.passwordHash ?? DECOY_PASSWORD_HASH)) &&
    Boolean(account);
  const codeOk = !account?.totpSecret || verifyTotp(account.totpSecret, code);

  if (!passwordOk || !codeOk) {
    const record = recordAdminFailure(failureKey);
    console.warn(
      `[auth] admin ${who}login failed from ${ip} (${record.count} consecutive)${
        record.lockedUntil > Date.now() ? " — locked out" : ""
      }`
    );
    // One message for every kind of failure: an unknown user, a wrong password
    // and a wrong code are indistinguishable from the outside.
    return response.status(401).json({ ok: false, message: ADMIN_NAMED_ACCOUNTS ? "Incorrect username, password or code." : "Incorrect password or code." });
  }

  clearAdminFailures(failureKey);

  // Sign in issues a brand new token and retires whatever the browser was
  // holding, so a session fixated before login is worth nothing.
  destroyAdminSession(parseCookies(request.headers.cookie)[SESSION_COOKIE]);

  setSessionCookie(response, request, createAdminSession(request, account.username));
  console.log(`[auth] admin '${account.username}' signed in from ${ip}`);
  response.json({ ok: true, username: ADMIN_NAMED_ACCOUNTS ? account.username : undefined });
});

router.post("/api/admin/logout", requireAdminNetwork, requireCsrf, (request, response) => {
  const session = destroyAdminSession(parseCookies(request.headers.cookie)[SESSION_COOKIE]);
  clearSessionCookie(response, request);
  console.log(`[auth] admin '${session?.username ?? "?"}' signed out from ${normalizeIp(request.ip)}`);
  response.json({ ok: true });
});

// Whether a second factor is configured is not a secret — the login form has to
// know whether to ask for a code.
router.get("/api/admin/session", requireAdminNetwork, (request, response) => {
  const session = readAdminSession(request);
  response.json({
    authenticated: Boolean(session),
    username: session && ADMIN_NAMED_ACCOUNTS ? session.username : undefined,
    namedAccounts: ADMIN_NAMED_ACCOUNTS,
    twoFactorRequired: ADMIN_TOTP_IN_USE,
  });
});

// Gate the admin page itself: an unauthenticated visitor never sees the
// dashboard shell, only a login prompt. /admin is the canonical URL (serves
// content directly, no redirect); /admin.html keeps working the same way
// for anyone with an old link.
function serveAdmin(request, response) {
  if (isAuthed(request)) {
    // The console is never a cached artefact and never framed.
    response.set("Cache-Control", "no-store");
    return response.sendFile(path.join(PUBLIC_DIR, "admin.html"));
  }
  const twoFactor = ADMIN_TOTP_IN_USE;
  response.set("Cache-Control", "no-store");
  response.send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="robots" content="noindex, nofollow" />
    <title>PicsArt Shop — Admin Login</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <div style="min-height:100vh; display:grid; place-items:center; background:var(--page-gradient);">
      <form id="loginForm" style="width:100%; max-width:340px; padding:26px; border:1px solid var(--line); border-radius:12px; background:var(--panel); box-shadow:var(--shadow);">
        <h2 style="margin:0 0 4px;">Admin login</h2>
        <p style="margin:0 0 16px; color:var(--muted); font-size:0.88rem;">Staff access only.</p>
        ${
          ADMIN_NAMED_ACCOUNTS
            ? `<input id="username" type="text" placeholder="Username" autocomplete="username" autocapitalize="none" autofocus
          style="width:100%; padding:10px 12px; margin-bottom:12px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--text); font-size:0.95rem;" />`
            : ""
        }
        <input id="password" type="password" placeholder="Password" autocomplete="current-password"${ADMIN_NAMED_ACCOUNTS ? "" : " autofocus"}
          style="width:100%; padding:10px 12px; margin-bottom:12px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--text); font-size:0.95rem;" />
        ${
          twoFactor
            ? `<input id="code" type="text" placeholder="6-digit code" inputmode="numeric" autocomplete="one-time-code" maxlength="6"
          style="width:100%; padding:10px 12px; margin-bottom:12px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--text); font-size:0.95rem; letter-spacing:0.2em;" />`
            : ""
        }
        <p id="loginError" style="display:none; margin:0 0 12px; color:var(--danger); font-size:0.85rem;"></p>
        <button type="submit" class="command-button" style="width:100%; justify-content:center;">Log in</button>
      </form>
    </div>
    <script nonce="${response.locals.cspNonce}">
      function readCookie(name) {
        const prefix = name + "=";
        const match = document.cookie.split("; ").find((entry) => entry.startsWith(prefix));
        return match ? decodeURIComponent(match.slice(prefix.length)) : "";
      }
      document.getElementById("loginForm").addEventListener("submit", async (event) => {
        event.preventDefault();
        const password = document.getElementById("password").value;
        const usernameField = document.getElementById("username");
        const codeField = document.getElementById("code");
        const errorBox = document.getElementById("loginError");
        try {
          const response = await fetch("/api/admin/login", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json", "X-CSRF-Token": readCookie("${CSRF_COOKIE}") },
            body: JSON.stringify({
              username: usernameField ? usernameField.value.trim() : undefined,
              password,
              code: codeField ? codeField.value.trim() : undefined,
            }),
          });
          if (response.ok) return window.location.reload();
          const data = await response.json().catch(() => ({}));
          throw new Error(data.message || "Sign in failed.");
        } catch (error) {
          errorBox.textContent = error.message || "Sign in failed.";
          errorBox.style.display = "block";
          if (codeField) codeField.value = "";
        }
      });
    </script>
  </body>
</html>`);
}

router.get("/admin", requireAdminNetwork, serveAdmin);
router.get("/admin.html", requireAdminNetwork, serveAdmin);

export default router;
