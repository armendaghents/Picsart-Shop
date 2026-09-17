// PostgreSQL connection + a thin statement wrapper.
//
// The rest of the app was written against better-sqlite3's statement API
// (`db.prepare(sql).get(...) / .all(...) / .run(...)`), so this keeps that exact
// shape — the only difference is that every call now returns a promise, and
// callers await it. Two conveniences come along for the ride:
//
//   * `?` placeholders are rewritten to PostgreSQL's `$1, $2, ...`, so the SQL
//     in the app reads the same as before.
//   * `run()` reports `changes` (rowCount) and, when the statement ends in
//     `RETURNING id`, `lastInsertRowid` — Postgres has no implicit rowid.

import pg from "pg";

const { Pool, types } = pg;

// node-postgres hands back bigint (COUNT) and numeric (SUM) as strings to avoid
// precision loss. Every such value here is a small count or a money total that
// the API previously returned as a JSON number, so parse them back to numbers
// and keep the response shape identical to the SQLite version.
types.setTypeParser(types.builtins.INT8, (value) => Number(value));
types.setTypeParser(types.builtins.NUMERIC, (value) => Number(value));

export const DATABASE_URL =
  process.env.DATABASE_URL || "postgres://localhost:5432/atlas";

// Rewrite `?` placeholders to `$1, $2, ...`, skipping anything inside string
// literals, quoted identifiers, or comments so a literal question mark in the
// SQL text is never mistaken for a parameter.
export function toPositional(sql) {
  let out = "";
  let index = 0;
  let quote = null; // "'" | '"' | "--" | "/*"

  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    const next = sql[i + 1];

    if (quote === "'" || quote === '"') {
      out += char;
      if (char === quote) quote = null;
      continue;
    }
    if (quote === "--") {
      out += char;
      if (char === "\n") quote = null;
      continue;
    }
    if (quote === "/*") {
      out += char;
      if (char === "*" && next === "/") {
        out += next;
        i += 1;
        quote = null;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      out += char;
      continue;
    }
    if (char === "-" && next === "-") {
      quote = "--";
      out += char;
      continue;
    }
    if (char === "/" && next === "*") {
      quote = "/*";
      out += char;
      continue;
    }
    if (char === "?") {
      index += 1;
      out += `$${index}`;
      continue;
    }
    out += char;
  }

  return out;
}

function statementApi(query) {
  return {
    prepare(sql) {
      const text = toPositional(sql);
      return {
        source: text,
        async all(...params) {
          const result = await query(text, params.flat());
          return result.rows;
        },
        async get(...params) {
          const result = await query(text, params.flat());
          return result.rows[0];
        },
        async run(...params) {
          const result = await query(text, params.flat());
          return {
            changes: result.rowCount,
            lastInsertRowid: result.rows?.[0]?.id,
          };
        },
      };
    },
    // Multi-statement SQL (schema.sql, DDL batches). Deliberately passes no
    // parameter array: node-postgres only allows several statements in one
    // command over the simple query protocol, which it uses when values are
    // absent.
    async exec(sql) {
      await query(sql);
    },
  };
}

export function createDatabase(connectionString = DATABASE_URL) {
  const pool = new Pool({ connectionString });

  // A pooled client can drop out from under us (server restart, idle timeout).
  // Without a listener node-postgres turns that into an uncaught exception.
  pool.on("error", (error) => {
    console.error("[db] idle client error:", error.message);
  });

  const db = statementApi((text, params) => pool.query(text, params));
  db.pool = pool;
  db.close = () => pool.end();

  // Run several statements on one connection inside a transaction. The callback
  // receives a database handle with the same prepare()/exec() API.
  db.transaction = async (callback) => {
    const client = await pool.connect();
    const scoped = statementApi((text, params) => client.query(text, params));
    try {
      await client.query("BEGIN");
      const result = await callback(scoped);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  };

  return db;
}

// PostgreSQL reports a unique violation as SQLSTATE 23505; SQLite reported it
// in the message text. Callers use this to turn a duplicate SKU into a friendly
// message instead of a raw driver error.
export function isUniqueViolation(error) {
  return error?.code === "23505" || /UNIQUE constraint failed|duplicate key value/i.test(error?.message || "");
}
