import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, checkAll, checkProtocol, loadAll } from "./lib/registry.ts";

const all = loadAll();
const errors = [...all.flatMap(({ file, data }) => checkProtocol(data, file)), ...checkAll(all.map((a) => a.data))];
if (errors.length) {
  console.error(errors.map((e) => `  ${e}`).join("\n"));
  console.error(`\nvalidate: ${errors.length} problem(s)`);
  process.exit(1);
}

const protocols = all.map((a) => a.data);
const digest = createHash("sha256").update(JSON.stringify(protocols)).digest("hex");
const out = join(ROOT, "dist", "registry.json");
const rebuilt = !(existsSync(out) && JSON.parse(readFileSync(out, "utf8")).digest === digest);
if (rebuilt) {
  let gitSha = "unknown";
  try {
    gitSha = execSync("git rev-parse HEAD", { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {}
  mkdirSync(join(ROOT, "dist"), { recursive: true });
  writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), gitSha, digest, protocols }, null, 2) + "\n");
}
const contracts = protocols.reduce((n, p) => n + p.contracts.length, 0);
console.log(`validate: ok, ${protocols.length} protocols, ${contracts} contracts, dist ${rebuilt ? "rebuilt" : "unchanged"}`);
