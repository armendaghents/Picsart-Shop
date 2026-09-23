// Test runner.
//
// Boots the real server against a throwaway database (atlas_test by default),
// runs every suite against it over HTTP, and tears it down. Nothing here can
// touch the development database: the connection string is overridden, and the
// schema is rebuilt from scratch on every run so the seeded demo catalogue is
// the same fixture each time.
//
//   npm test
//   TEST_DATABASE_URL=postgres://localhost:5432/other npm test

import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { makeClient } from "./helpers.mjs";
import authSuite from "./auth.test.mjs";
import adminAccountsSuite from "./admin-accounts.test.mjs";
import dashboardTrendSuite from "./dashboard-trend.test.mjs";
import shopSuite from "./shop.test.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const PORT = Number(process.env.TEST_PORT || 3199);
const BASE = `http://127.0.0.1:${PORT}`;
const DATABASE_URL = process.env.TEST_DATABASE_URL || "postgres://localhost:5432/atlas_test";
const ADMIN_PASSWORD = "test-admin-password";
const LOG_DIR = path.join(ROOT, ".test-output");
const LOG_PATH = path.join(LOG_DIR, "server.log");

// The test database is created if it doesn't exist yet, so `npm test` works on
// a fresh checkout without any setup beyond a running PostgreSQL.
async function ensureDatabaseExists() {
  const url = new URL(DATABASE_URL);
  const name = url.pathname.slice(1);
  const adminUrl = new URL(DATABASE_URL);
  adminUrl.pathname = "/postgres";

  const client = new pg.Client({ connectionString: adminUrl.toString() });
  try {
    await client.connect();
  } catch (error) {
    console.error(`\nCannot reach PostgreSQL at ${url.host} — is it running?\n  ${error.message}\n`);
    process.exit(1);
  }
  const existing = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
  if (!existing.rowCount) {
    await client.query(`CREATE DATABASE "${name}"`);
    console.log(`Created test database ${name}`);
  }
  await client.end();
}

function runNode(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: "inherit" });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${args.join(" ")} exited with ${code}`))));
  });
}

async function waitForServer(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("server did not start in time");
}

async function main() {
  await ensureDatabaseExists();

  rmSync(LOG_DIR, { recursive: true, force: true });
  mkdirSync(LOG_DIR, { recursive: true });

  console.log("Rebuilding the test schema…");
  await runNode([path.join("db", "init.js"), "--reset"], { DATABASE_URL });

  const env = {
    DATABASE_URL,
    PORT: String(PORT),
    ADMIN_PASSWORD,
    AUTH_SECRET: "test-secret-not-used-anywhere-real",
    // Deliberately no SMTP_HOST: the server logs each message instead of
    // sending it, which is how the tests read verification codes.
    SMTP_HOST: "",
    // Enough to switch the Google routes on. Every assertion stops before the
    // token exchange, so no request ever leaves the machine and the suite stays
    // runnable offline.
    GOOGLE_CLIENT_ID: "test-client.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
  };

  const log = createWriteStream(LOG_PATH);
  const server = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...process.env, ...env } });
  server.stdout.pipe(log);
  server.stderr.pipe(log);

  let exitCode = 0;
  try {
    await waitForServer();
    const client = makeClient(BASE, LOG_PATH);

    const results = [];
    for (const suite of [shopSuite, authSuite, dashboardTrendSuite, adminAccountsSuite]) {
      // The named-account suite boots a second server of its own: the shared
      // single login the rest of the suite uses is a different configuration,
      // not something one process can be in both of at once.
      results.push(await suite(client, { adminPassword: ADMIN_PASSWORD, port: PORT + 1, databaseUrl: DATABASE_URL }));
    }

    console.log("\n" + "─".repeat(60));
    let total = 0;
    let failed = 0;
    for (const result of results) {
      total += result.passed + result.failures.length;
      failed += result.failures.length;
      console.log(`  ${result.name}: ${result.passed} passed, ${result.failures.length} failed`);
    }
    console.log("─".repeat(60));
    console.log(failed ? `\n${failed} of ${total} checks FAILED` : `\nAll ${total} checks passed`);
    exitCode = failed ? 1 : 0;
  } catch (error) {
    console.error("\nTest run failed:", error.message);
    console.error(`Server log: ${LOG_PATH}`);
    exitCode = 1;
  } finally {
    server.kill("SIGTERM");
    log.end();
  }

  process.exit(exitCode);
}

main();
