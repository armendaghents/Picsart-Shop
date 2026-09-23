// Shared test plumbing: a cookie jar that behaves like a browser, a fetch
// wrapper that carries CSRF tokens, and a reader for the codes the server
// prints when no SMTP is configured.

import { readFileSync } from "node:fs";

export function makeJar() {
  const jar = new Map();
  return {
    header: () => [...jar].map(([key, value]) => `${key}=${value}`).join("; "),
    get: (name) => jar.get(name),
    absorb(response) {
      for (const raw of response.headers.getSetCookie?.() || []) {
        const [pair] = raw.split(";");
        const index = pair.indexOf("=");
        const name = pair.slice(0, index).trim();
        const value = pair.slice(index + 1).trim();
        // Max-Age=0 is how the server clears a cookie.
        if (/Max-Age=0/i.test(raw) || !value) jar.delete(name);
        else jar.set(name, value);
      }
    },
  };
}

export function makeClient(base, logPath) {
  return {
    base,

    // Redirects are followed automatically by fetch, which would hide the very
    // thing a redirect-based flow needs asserting. This returns the 302 itself.
    raw(path, { headers = {} } = {}) {
      return fetch(base + path, { method: "GET", headers, redirect: "manual" });
    },

    // Multipart, for the admin photo upload. fetch builds the boundary itself,
    // so Content-Type is deliberately not set here.
    async upload(jar, path, field, files) {
      const form = new FormData();
      for (const [name, bytes] of files) {
        // The server filters on MIME type, and a Blob built without one arrives
        // as application/octet-stream and is refused.
        const type = name.endsWith(".png") ? "image/png" : name.endsWith(".webp") ? "image/webp" : "image/jpeg";
        form.append(field, new Blob([bytes], { type }), name);
      }
      const csrf = jar.get("atlas_csrf");
      const response = await fetch(base + path, {
        method: "POST",
        headers: { cookie: jar.header(), ...(csrf ? { "x-csrf-token": decodeURIComponent(csrf) } : {}) },
        body: form,
      });
      jar.absorb(response);
      return { status: response.status, data: await response.json().catch(() => ({})) };
    },

    async call(jar, method, path, body, extraHeaders = {}) {
      const headers = { cookie: jar.header(), ...extraHeaders };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const csrf = jar.get("atlas_csrf");
      if (csrf && !("x-csrf-token" in extraHeaders)) headers["x-csrf-token"] = decodeURIComponent(csrf);

      const response = await fetch(base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      jar.absorb(response);
      return {
        status: response.status,
        data: await response.json().catch(() => ({})),
        setCookies: response.headers.getSetCookie?.() || [],
      };
    },

    // Without SMTP the server logs each message instead of sending it, which is
    // where the six-digit codes come from in these tests.
    latestCodeFor(address) {
      const blocks = readFileSync(logPath, "utf8")
        .split("──────────── email")
        .filter((block) => block.includes(`To:      ${address}`));
      return ((blocks.at(-1) || "").match(/\b(\d{6})\b/) || [])[1];
    },

    logContains(text) {
      return readFileSync(logPath, "utf8").includes(text);
    },
  };
}

export function makeRecorder(name) {
  let passed = 0;
  const failures = [];
  return {
    section(title) {
      console.log(`\n  ${title}`);
    },
    check(label, condition, detail = "") {
      if (condition) {
        passed += 1;
        console.log(`    ok   ${label}`);
      } else {
        failures.push({ label, detail });
        console.log(`    FAIL ${label}${detail ? ` — ${String(detail).slice(0, 300)}` : ""}`);
      }
    },
    result() {
      return { name, passed, failures };
    },
  };
}
