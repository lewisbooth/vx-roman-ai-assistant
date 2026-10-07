import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const prisma = createRequire(import.meta.url).resolve("prisma/build/index.js");

function runPrisma(databaseUrl, args, sql) {
  const env = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    CHECKPOINT_DISABLE: "1",
  };
  // Prisma's missing-file preflight relies on its default engine log level.
  delete env.RUST_LOG;
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [prisma, ...args],
      {
        cwd: root,
        env,
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(`Test database migration failed: ${stdout}\n${stderr}`, {
              cause: error,
            }),
          );
        } else {
          resolve();
        }
      },
    );
    child.stdin.on("error", reject);
    child.stdin.end(sql);
  });
}

// Run migrations before creating the pooled test client. SQLite PRAGMAs and
// table rebuilds must share the migration engine's connection, not the pool.
export function migrateTestDatabase(databaseUrl) {
  return runPrisma(databaseUrl, [
    "migrate",
    "deploy",
    "--schema",
    path.join(root, "prisma/schema.prisma"),
  ]);
}

// Historical migration tests need partial histories and intentional replays.
// Send intact scripts through Prisma instead of splitting SQL on semicolons.
// Disconnect any existing test client before applying schema changes.
export async function executeTestMigrations(databaseUrl, names) {
  const scripts = await Promise.all(
    names.map((name) =>
      readFile(
        path.join(root, "prisma/migrations", name, "migration.sql"),
        "utf8",
      ),
    ),
  );
  await runPrisma(
    databaseUrl,
    ["db", "execute", "--url", databaseUrl, "--stdin"],
    scripts.join("\n"),
  );
}
