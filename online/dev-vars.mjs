// Writes .dev.vars (secrets for `wrangler dev`) from the project's .env /
// .env.local: KURVIQ_GITHUB_CLIENT_SECRET, plus a cookie key made once.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
const target = path.join(HERE, ".dev.vars");
const old = existsSync(target) ? readFileSync(target, "utf8") : "";
const cookieKey = old.match(/^COOKIE_KEY=(.+)$/m)?.[1] || randomBytes(32).toString("base64");
if (!env.KURVIQ_GITHUB_CLIENT_SECRET) {
  console.warn("[dev-vars] KURVIQ_GITHUB_CLIENT_SECRET is not set in .env — Connect GitHub won't work locally");
}
writeFileSync(
  target,
  `GITHUB_CLIENT_SECRET=${env.KURVIQ_GITHUB_CLIENT_SECRET || ""}\nCOOKIE_KEY=${cookieKey}\n` +
    (env.KURVIQ_GITHUB_CLIENT_ID ? `GITHUB_CLIENT_ID=${env.KURVIQ_GITHUB_CLIENT_ID}\n` : "") +
    (env.KURVIQ_GITHUB_APP_SLUG ? `GITHUB_APP_SLUG=${env.KURVIQ_GITHUB_APP_SLUG}\n` : ""),
  { mode: 0o600 },
);
console.log("[dev-vars] wrote online/.dev.vars");
