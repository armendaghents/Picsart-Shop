// ---------------------------------------------------------------------------
// Settings read from the environment, in one place
//
// Every module that needs to know where uploads live or whether this is a real
// deployment reads it here, rather than each reaching into process.env and
// spelling the rule slightly differently.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const PUBLIC_DIR = path.join(ROOT_DIR, "public");
export const UPLOADS_DIR = path.join(PUBLIC_DIR, "uploads");

// Set by the host, and the switch behind every "behave like a real deployment"
// rule: it refuses a placeholder admin password, requires a mail server, and
// keeps the demo catalogue out of the database.
export const IS_PRODUCTION = process.env.NODE_ENV === "production";

export const PORT = Number(process.env.PORT || 3000);

// Behind a reverse proxy every request arrives from the proxy, so request.ip is
// the proxy's address and X-Forwarded-For is whatever the client sent — which
// would make the rate limits, the lockout and the admin IP allowlist both
// useless and trivially spoofable. Set to the number of proxies in front of
// this server (usually 1), and leave unset when nothing is.
export const TRUST_PROXY = process.env.TRUST_PROXY;

fs.mkdirSync(UPLOADS_DIR, { recursive: true });
