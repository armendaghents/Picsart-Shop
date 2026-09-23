// Named admin accounts (ADMIN_USERS): two people, one console, separate
// credentials. This suite boots its own server, because the shared-login
// configuration the rest of the suite runs against is a different mode.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { hashPassword } from "../lib/auth.js";
import { createTotpSecret, totpCodeAt, TOTP_STEP_SECONDS } from "../lib/totp.js";
import { makeRecorder } from "./helpers.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const ANNA_PASSWORD = "anna-password-abc123";
const BOB_PASSWORD = "bob-password-xyz789";

export default async function run(_client, { port, databaseUrl }) {
  const t = makeRecorder("named admin accounts");
  const base = `http://127.0.0.1:${port}`;
  const bobTotp = createTotpSecret();

  const env = {
    ...process.env,
    PORT: String(port),
    DATABASE_URL: databaseUrl,
    AUTH_SECRET: "test-secret-not-used-anywhere-real",
    SMTP_HOST: "",
    ADMIN_USERS: "anna,bob",
    ADMIN_ANNA_PASSWORD_HASH: await hashPassword(ANNA_PASSWORD),
    ADMIN_BOB_PASSWORD_HASH: await hashPassword(BOB_PASSWORD),
    ADMIN_BOB_TOTP_SECRET: bobTotp,
  };
  delete env.ADMIN_PASSWORD;
  delete env.ADMIN_PASSWORD_HASH;
  delete env.ADMIN_TOTP_SECRET;

  const server = spawn(process.execPath, ["server.js"], { cwd: ROOT, env, stdio: "ignore" });
  try {
    const deadline = Date.now() + 15000;
    for (;;) {
      try {
        if ((await fetch(`${base}/api/health`)).ok) break;
      } catch {
        // not listening yet
      }
      if (Date.now() > deadline) throw new Error("named-account server did not start in time");
      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    const code = () => totpCodeAt(bobTotp, Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS));

    async function login(body, agent = "suite-agent/1.0") {
      const jar = new Map();
      const absorb = (response) => {
        for (const raw of response.headers.getSetCookie?.() || []) {
          const [pair] = raw.split(";");
          const index = pair.indexOf("=");
          jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
        }
      };
      const cookie = () => [...jar].map(([key, value]) => `${key}=${value}`).join("; ");
      absorb(await fetch(`${base}/admin`, { headers: { "user-agent": agent } }));
      const response = await fetch(`${base}/api/admin/login`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: cookie(),
          "x-csrf-token": decodeURIComponent(jar.get("atlas_csrf")),
          "user-agent": agent,
        },
        body: JSON.stringify(body),
      });
      absorb(response);
      return { status: response.status, data: await response.json().catch(() => ({})), cookie, agent };
    }

    t.section("named admin accounts");
    const form = await (await fetch(`${base}/admin`)).text();
    t.check("the login form asks for a username", form.includes('id="username"'));

    let r = await login({ username: "anna", password: ANNA_PASSWORD });
    t.check("anna signs in with her own password", r.status === 200 && r.data.username === "anna", JSON.stringify(r.data));
    const anna = r;

    r = await login({ username: "bob", password: BOB_PASSWORD });
    t.check("bob's password alone is not enough — he has 2FA", r.status === 401, `${r.status}`);
    r = await login({ username: "bob", password: BOB_PASSWORD, code: code() }, "bob-agent/1.0");
    t.check("bob signs in with his own code", r.status === 200 && r.data.username === "bob", JSON.stringify(r.data));
    const bob = r;

    const session = await (
      await fetch(`${base}/api/admin/session`, { headers: { cookie: anna.cookie(), "user-agent": anna.agent } })
    ).json();
    t.check("the session names who is signed in", session.username === "anna", JSON.stringify(session));

    t.section("the accounts are genuinely separate");
    r = await login({ username: "bob", password: ANNA_PASSWORD, code: code() });
    t.check("anna's password does not open bob's account", r.status === 401, `${r.status}`);
    r = await login({ username: "anna", password: BOB_PASSWORD });
    t.check("bob's password does not open anna's account", r.status === 401, `${r.status}`);

    r = await login({ username: "nobody-here", password: "whatever" });
    t.check("an unknown username is refused", r.status === 401, `${r.status}`);
    const unknownMessage = r.data.message;
    r = await login({ username: "anna", password: "definitely-wrong" });
    t.check("...with the same wording as a wrong password, so names can't be probed",
      r.data.message === unknownMessage, `${unknownMessage} vs ${r.data.message}`);

    t.section("one admin cannot lock the other out");
    // Anna burns well past the five-failure threshold from this address.
    for (let attempt = 0; attempt < 8; attempt += 1) await login({ username: "anna", password: "wrong" });
    r = await login({ username: "anna", password: ANNA_PASSWORD });
    t.check("anna is locked out of her own account", r.status === 429 && r.data.error === "locked_out", JSON.stringify(r.data));
    r = await login({ username: "bob", password: BOB_PASSWORD, code: code() }, "bob-agent/1.0");
    t.check("bob still signs in from the very same address", r.status === 200, JSON.stringify(r.data));

    const dashboard = await fetch(`${base}/api/dashboard`, { headers: { cookie: bob.cookie(), "user-agent": bob.agent } });
    t.check("and bob's session still reaches the admin API", dashboard.status === 200, `${dashboard.status}`);
  } finally {
    server.kill();
  }

  return t.result();
}
