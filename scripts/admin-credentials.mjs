// Generates the two secrets the admin console wants in .env:
//
//   ADMIN_PASSWORD_HASH   a scrypt hash, so the clear password is never stored
//   ADMIN_TOTP_SECRET     the shared secret for an authenticator app
//
// With --user it emits the per-account variables for a named admin instead,
// which is how two people share one console without sharing one login.
//
// Usage:
//   node scripts/admin-credentials.mjs                 the single shared login
//   node scripts/admin-credentials.mjs --user anna     a named admin
//   node scripts/admin-credentials.mjs --no-totp       password hash only
//   node scripts/admin-credentials.mjs --totp-only     new authenticator secret only

import readline from "node:readline";
import QRCode from "qrcode";

import { hashPassword, passwordProblems } from "../lib/auth.js";
import { createTotpSecret, otpauthUrl } from "../lib/totp.js";

const argv = process.argv.slice(2);
const args = new Set(argv);
const wantsPassword = !args.has("--totp-only");
const wantsTotp = !args.has("--no-totp");

const userIndex = argv.indexOf("--user");
const username = userIndex === -1 ? null : String(argv[userIndex + 1] ?? "").trim().toLowerCase();
if (userIndex !== -1 && !/^[a-z0-9][a-z0-9._-]{0,31}$/.test(username || "")) {
  console.error("--user needs a name of letters, digits, dot, dash or underscore, starting with a letter or digit.");
  process.exit(1);
}

// anna -> ADMIN_ANNA_PASSWORD_HASH; no --user -> the shared ADMIN_PASSWORD_HASH.
function envKey(suffix) {
  return username ? `ADMIN_${username.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_${suffix}` : `ADMIN_${suffix}`;
}
const label = username ? `admin '${username}'` : "the admin console";

// Reads without echoing, so the password never lands in the terminal scrollback
// or the shell history.
function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const output = rl.output;
    let muted = false;
    output.write(question);
    const originalWrite = output.write.bind(output);
    output.write = (chunk, ...rest) => (muted ? true : originalWrite(chunk, ...rest));
    muted = true;
    rl.question("", (answer) => {
      muted = false;
      output.write = originalWrite;
      output.write("\n");
      rl.close();
      resolve(answer);
    });
  });
}

const lines = [];

if (wantsPassword) {
  const password = await promptHidden(`New password for ${label}: `);
  const confirmation = await promptHidden("Confirm: ");
  if (password !== confirmation) {
    console.error("\nThe two entries do not match. Nothing was generated.");
    process.exit(1);
  }
  const problem = passwordProblems(password, "");
  if (problem) {
    console.error(`\n${problem.message}`);
    process.exit(1);
  }
  lines.push(`${envKey("PASSWORD_HASH")}=${await hashPassword(password)}`);
}

if (wantsTotp) {
  const secret = createTotpSecret();
  const url = otpauthUrl({ secret, account: username || "admin", issuer: "Picsart Shop" });
  console.log("\nScan this with Google Authenticator, 1Password, Authy — anything that speaks TOTP:\n");
  console.log(await QRCode.toString(url, { type: "terminal", small: true }));
  console.log(`Or enter the secret by hand: ${secret}\n`);
  lines.push(`${envKey("TOTP_SECRET")}=${secret}`);
}

console.log("Put these in .env:\n");
if (username) console.log(`ADMIN_USERS=${username}   # comma-separated; add each admin's name here`);
for (const line of lines) console.log(line);
console.log(
  username
    ? "\nDrop the shared ADMIN_PASSWORD / ADMIN_PASSWORD_HASH lines once every admin is listed in ADMIN_USERS."
    : "\nReplace any existing ADMIN_PASSWORD line with the hash above."
);
console.log("Then restart the server. Confirm the code works before you close this window.");
