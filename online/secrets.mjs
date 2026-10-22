// Sets the Worker's secrets on Cloudflare once: GITHUB_CLIENT_SECRET (from
// KURVIQ_GITHUB_CLIENT_SECRET in ../.env) and a new random COOKIE_KEY.
// Re-running makes a new COOKIE_KEY, which disconnects every browser's GitHub
// connection (they reconnect with one click) — only do that on purpose.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const env = {};
for (const file of [".env", ".env.local"]) {
  const full = path.join(HERE, "..", file);
  if (existsSync(full)) {
    for (const line of readFileSync(full, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*?)\s*$/);
      if (match) {
        env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
      }
    }
  }
}
const only = process.argv.slice(2);
const secrets = {
  GITHUB_CLIENT_SECRET: env.KURVIQ_GITHUB_CLIENT_SECRET,
  COOKIE_KEY: randomBytes(32).toString("base64"),
};
for (const [name, value] of Object.entries(secrets)) {
  if (only.length && !only.includes(name)) {
    continue;
  }
  if (!value) {
    console.error(`[secrets] ${name}: no value (set KURVIQ_GITHUB_CLIENT_SECRET in .env)`);
    process.exit(1);
  }
  const result = spawnSync("node", [path.join(HERE, "with-env.mjs"), "npx", "wrangler", "secret", "put", name], {
    input: value,
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
