// The account lifecycle: registration, email verification, sign-in, two-step
// verification, password reset, session management, and the security emails
// that accompany them.

import { makeJar, makeRecorder } from "./helpers.mjs";
import { totpCodeAt } from "../lib/totp.js";

export default async function run(client) {
  const { call, latestCodeFor, logContains, raw } = client;
  const t = makeRecorder("account lifecycle");
  const email = `life${Date.now()}@example.com`;
  const jar = makeJar();
  await call(jar, "GET", "/api/auth/csrf");

  t.section("two-step form: who is this?");
  let r = await call(jar, "POST", "/api/auth/lookup", { email });
  t.check("unknown address reports no account", r.data.exists === false, JSON.stringify(r.data));

  t.section("registration requires a verified address");
  r = await call(jar, "POST", "/api/auth/register", { email, password: "password123", name: "Life" });
  t.check("a commonly-used password is rejected", r.status === 400 && /commonly used/.test(r.data.message), JSON.stringify(r.data));
  r = await call(jar, "POST", "/api/auth/register", { email, password: "Something1234567", name: "Life" });
  t.check("register asks for verification and issues no session", r.status === 201 && r.data.verificationRequired === true && !jar.get("atlas_access"), JSON.stringify(r.data));
  r = await call(jar, "POST", "/api/auth/lookup", { email });
  t.check("lookup reports the account is pending verification", r.data.exists && r.data.pendingVerification === true);
  r = await call(jar, "POST", "/api/auth/login", { email, password: "Something1234567" });
  t.check("cannot sign in before verifying", r.status === 403 && r.data.error === "verification_required", JSON.stringify(r.data));

  const code = latestCodeFor(email);
  t.check("a verification code was emailed", Boolean(code), `got ${code}`);
  r = await call(jar, "POST", "/api/auth/verify-email", { email, code: "000000" });
  t.check("a wrong code is rejected and counted", r.status === 400 && /attempts? left/.test(r.data.message), JSON.stringify(r.data));
  r = await call(jar, "POST", "/api/auth/verify-email", { email, code });
  t.check("the right code verifies and signs in", r.status === 200 && r.data.user?.emailVerified === true, JSON.stringify(r.data));
  t.check("session cookies are issued at verification", Boolean(jar.get("atlas_access") && jar.get("atlas_refresh")));
  r = await call(jar, "POST", "/api/auth/verify-email", { email, code });
  t.check("a used code cannot be replayed", r.status === 409 || r.status === 400, JSON.stringify(r.data));

  t.section("keep me signed in");
  const jarSession = makeJar();
  await call(jarSession, "GET", "/api/auth/csrf");
  r = await call(jarSession, "POST", "/api/auth/login", { email, password: "Something1234567", remember: false });
  t.check("sign-in without 'keep me signed in' works", r.status === 200);
  t.check("...and its cookies expire with the browser",
    r.setCookies.some((c) => c.startsWith("atlas_refresh=") && !/Max-Age/.test(c)), r.setCookies.join(" | "));
  const jarRemember = makeJar();
  await call(jarRemember, "GET", "/api/auth/csrf");
  r = await call(jarRemember, "POST", "/api/auth/login", { email, password: "Something1234567", remember: true });
  t.check("'keep me signed in' sets a 30-day cookie",
    r.setCookies.some((c) => c.startsWith("atlas_refresh=") && /Max-Age=2592000/.test(c)));

  t.section("account management");
  r = await call(jar, "PATCH", "/api/auth/profile", { name: "Renamed Person" });
  t.check("the name can be changed", r.data.user?.name === "Renamed Person", JSON.stringify(r.data));
  r = await call(jar, "GET", "/api/auth/sessions");
  t.check("active sessions are listed", (r.data.sessions || []).length >= 1, JSON.stringify(r.data).slice(0, 200));
  t.check("the current session is marked", r.data.sessions.some((s) => s.current));
  r = await call(jar, "POST", "/api/auth/change-password", { currentPassword: "wrong", newPassword: "NewPassword12345" });
  t.check("a wrong current password is rejected", r.status === 401);
  r = await call(jar, "POST", "/api/auth/change-password", { currentPassword: "Something1234567", newPassword: "NewPassword12345" });
  t.check("the password can be changed", r.status === 200, JSON.stringify(r.data));
  r = await call(jar, "GET", "/api/auth/me");
  t.check("the device that changed it stays signed in", r.data.user?.email === email);
  // The heart of it: revoking must invalidate access tokens immediately, not
  // when they happen to expire 15 minutes later.
  r = await call(jarRemember, "GET", "/api/shop/cart");
  t.check("every other device is signed out at once", r.status === 401, `got ${r.status}`);
  r = await call(jar, "POST", "/api/auth/login", { email, password: "Something1234567" });
  t.check("the old password no longer works", r.status === 401);

  t.section("forgotten password");
  const jarReset = makeJar();
  await call(jarReset, "GET", "/api/auth/csrf");
  r = await call(jarReset, "POST", "/api/auth/forgot-password", { email: "nobody@example.com" });
  t.check("forgot-password reveals nothing about unknown addresses", r.status === 200 && r.data.ok === true);
  await call(jarReset, "POST", "/api/auth/forgot-password", { email });
  const resetCode = latestCodeFor(email);
  r = await call(jarReset, "POST", "/api/auth/reset-password", { email, code: resetCode, password: "short" });
  t.check("a weak new password is rejected", r.status === 400);
  r = await call(jarReset, "POST", "/api/auth/reset-password", { email, code: resetCode, password: "ResetPassword123" });
  t.check("the password is reset and the customer signed in", r.status === 200 && r.data.user?.email === email, JSON.stringify(r.data));
  r = await call(jar, "GET", "/api/shop/cart");
  t.check("resetting signs out every previous device", r.status === 401, `got ${r.status}`);
  r = await call(jarReset, "POST", "/api/auth/reset-password", { email, code: resetCode, password: "AnotherPass1234" });
  t.check("a spent reset code cannot be reused", r.status === 400);

  t.section("two-step verification");
  r = await call(jarReset, "POST", "/api/auth/totp/setup");
  t.check("enrolment returns a secret and a QR image",
    Boolean(r.data.secret) && String(r.data.qr).startsWith("data:image/png;base64,"), JSON.stringify(r.data).slice(0, 120));
  const secret = r.data.secret;
  const totp = () => totpCodeAt(secret, Math.floor(Date.now() / 1000 / 30));
  r = await call(jarReset, "POST", "/api/auth/totp/enable", { code: "000000" });
  t.check("enabling with a wrong code fails", r.status === 400);
  r = await call(jarReset, "POST", "/api/auth/totp/enable", { code: totp() });
  t.check("enabled, with recovery codes returned once", r.status === 200 && r.data.recoveryCodes?.length === 10);
  const recovery = r.data.recoveryCodes;

  const jar2fa = makeJar();
  await call(jar2fa, "GET", "/api/auth/csrf");
  r = await call(jar2fa, "POST", "/api/auth/login", { email, password: "ResetPassword123" });
  t.check("the password alone no longer signs in", r.data.requiresTwoFactor === true && !jar2fa.get("atlas_access"), JSON.stringify(r.data));
  // Regression: the pre-2FA challenge cookie must not double as a session.
  // Presenting it as atlas_access — the token confusion that let a stolen
  // password skip the second factor entirely — has to be rejected.
  // Token-type confusion: the challenge cookie is minted once the password is
  // accepted but before the second factor. It is a validly signed token for the
  // same account, so if it were accepted as an access token, moving its value
  // into atlas_access would skip two-step verification entirely.
  const challengeToken = jar2fa.get("atlas_2fa");
  t.check("a challenge cookie is issued to replay", Boolean(challengeToken));
  r = await call(jar2fa, "GET", "/api/auth/sessions", undefined, { cookie: `atlas_access=${challengeToken}` });
  t.check("the 2FA challenge token is not accepted as a session", r.status === 401, `got ${r.status}`);
  r = await call(jar2fa, "POST", "/api/auth/two-factor", { code: "000000" });
  t.check("a wrong second factor is rejected", r.status === 401);
  r = await call(jar2fa, "POST", "/api/auth/two-factor", { code: totp() });
  t.check("the right second factor completes sign-in", r.status === 200 && Boolean(jar2fa.get("atlas_access")));

  const jarRecovery = makeJar();
  await call(jarRecovery, "GET", "/api/auth/csrf");
  await call(jarRecovery, "POST", "/api/auth/login", { email, password: "ResetPassword123" });
  r = await call(jarRecovery, "POST", "/api/auth/two-factor", { code: recovery[0] });
  t.check("a recovery code works when the phone is lost", r.status === 200, JSON.stringify(r.data));
  const jarRecoveryAgain = makeJar();
  await call(jarRecoveryAgain, "GET", "/api/auth/csrf");
  await call(jarRecoveryAgain, "POST", "/api/auth/login", { email, password: "ResetPassword123" });
  r = await call(jarRecoveryAgain, "POST", "/api/auth/two-factor", { code: recovery[0] });
  t.check("...and only once", r.status === 401);

  r = await call(jar2fa, "POST", "/api/auth/totp/disable", { password: "wrong" });
  t.check("turning it off needs the password", r.status === 401);
  r = await call(jar2fa, "POST", "/api/auth/totp/disable", { password: "ResetPassword123" });
  t.check("two-step can be turned off", r.status === 200);

  t.section("refresh token rotation");
  const stale = jar2fa.get("atlas_refresh");
  r = await call(jar2fa, "POST", "/api/auth/refresh");
  t.check("refresh returns a session", r.status === 200 && r.data.user?.email === email);
  t.check("the refresh token was rotated", jar2fa.get("atlas_refresh") !== stale);
  const replayJar = makeJar();
  await call(replayJar, "GET", "/api/auth/csrf");
  const replay = await call(replayJar, "POST", "/api/auth/refresh", undefined, {
    cookie: `atlas_refresh=${stale}; atlas_csrf=${replayJar.get("atlas_csrf")}`,
  });
  t.check("replaying a spent refresh token is rejected", replay.status === 401);
  r = await call(jar2fa, "POST", "/api/auth/refresh");
  t.check("...and it revokes the whole session family", r.status === 401, `got ${r.status}`);

  // Everything below stops before the token exchange, so nothing here talks to
  // Google and the suite still runs with no network.
  t.section("sign in with Google");
  r = await call(jar, "GET", "/api/auth/providers");
  t.check("the storefront is told Google sign-in is available", r.data.google === true, JSON.stringify(r.data));

  let redirect = await raw("/api/auth/google");
  const location = redirect.headers.get("location") || "";
  const stateCookie = (redirect.headers.getSetCookie?.() || []).find((c) => c.startsWith("atlas_oauth_state="));
  t.check("starting the flow redirects to Google", redirect.status === 302 && location.startsWith("https://accounts.google.com/"), `${redirect.status} ${location.slice(0, 60)}`);
  t.check("...asking only for identity, not offline access",
    location.includes("scope=openid+email+profile") && location.includes("access_type=online"), location);
  t.check("...and pins the attempt to this browser with a state cookie", Boolean(stateCookie), String(stateCookie));
  // Strict would be withheld on the cross-site navigation back from Google,
  // which would break every sign-in — so this attribute is load-bearing.
  t.check("...sent SameSite=Lax and HttpOnly so the callback can read it",
    /SameSite=Lax/i.test(stateCookie || "") && /HttpOnly/i.test(stateCookie || ""), String(stateCookie));

  const issuedState = decodeURIComponent((stateCookie || "").split(";")[0].split("=")[1] || "");
  t.check("the state in the cookie is the state sent to Google",
    Boolean(issuedState) && new URL(location).searchParams.get("state") === issuedState);

  redirect = await raw(`/api/auth/google/callback?code=abc&state=${encodeURIComponent(issuedState)}`);
  t.check("a callback with no state cookie is refused",
    (redirect.headers.get("location") || "").includes("auth_error=bad_state"), redirect.headers.get("location"));

  redirect = await raw("/api/auth/google/callback?code=abc&state=not-the-right-one", {
    headers: { cookie: `atlas_oauth_state=${issuedState}` },
  });
  t.check("a callback whose state doesn't match the cookie is refused",
    (redirect.headers.get("location") || "").includes("auth_error=bad_state"), redirect.headers.get("location"));

  redirect = await raw("/api/auth/google/callback?error=access_denied&state=x");
  t.check("pressing Cancel on Google comes back quietly, not as an error",
    (redirect.headers.get("location") || "").includes("auth_error=cancelled"), redirect.headers.get("location"));

  redirect = await raw("/api/auth/google/callback");
  t.check("a callback carrying no code at all is refused",
    (redirect.headers.get("location") || "").includes("auth_error=invalid_response"), redirect.headers.get("location"));

  t.section("security notifications");
  t.check("new sign-in notification sent", logContains("New sign-in to your Picsart Shop account"));
  t.check("password change notification sent", logContains("Your Picsart Shop password was changed"));
  t.check("two-step enabled notification sent", logContains("Two-step verification is on"));

  return t.result();
}
