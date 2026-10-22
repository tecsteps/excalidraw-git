// Runs a command (wrangler) with CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID
// from the project's .env / .env.local, without putting them on the command line.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const env = { ...process.env };
for (const file of [".env", ".env.local"]) {
  const full = path.join(HERE, "..", file);
  if (existsSync(full)) {
    for (const line of readFileSync(full, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*(CLOUDFLARE_[\w]+)\s*=\s*(.*?)\s*$/);
      if (match && match[2]) {
        env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
      }
    }
  }
}
const [command, ...args] = process.argv.slice(2);
const result = spawnSync(command, args, { stdio: "inherit", env, shell: false });
process.exit(result.status ?? 1);
