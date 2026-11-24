// Usage: tsx scripts/incidents.ts [--state <file>] [--report <file>] [--llama-file <path>] [--rss-file <path>] [--dry-run]
// Pulls DefiLlama hacks and the rekt.news feed, records matches in protocols/*.json and freezes on fresh ones.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LLAMA_URL, REKT_URL, get, parseLlama, parseRss } from "./lib/feeds.ts";
import { applyItems as run, type Item, type State } from "./lib/matcher.ts";
import { ROOT, loadAll, saveProtocol } from "./lib/registry.ts";

const args = process.argv.slice(2);
const opt = (f: string) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
const statePath = opt("--state") ?? join(ROOT, "state", "seen.json");
const reportFile = opt("--report");
const dry = args.includes("--dry-run");

const state: State = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { lastRun: null, seen: [] };

const items: Item[] = [];
let failed = false;
const sources: [string, string | undefined, string, (s: string) => Item[]][] = [
  ["defillama", opt("--llama-file"), LLAMA_URL, (s) => parseLlama(JSON.parse(s))],
  ["rekt", opt("--rss-file"), REKT_URL, parseRss],
];
for (const [name, file, url, parse] of sources) {
  try {
    const raw = file ? readFileSync(file, "utf8") : await get(url);
    const got = parse(raw);
    items.push(...got);
    console.log(`${name}: ${got.length} items`);
  } catch (e) {
    failed = true;
    console.error(`${name}: ${(e as Error).message}`);
  }
}

const all = loadAll();
const protocols = all.map((a) => a.data);
const backfill = state.lastRun === null;
const seenBefore = state.seen.length;
const lastRunBefore = state.lastRun;
const before = new Map(protocols.map((p) => [p.slug, JSON.stringify(p)]));
const res = run(protocols, items, state);
if (!failed) state.lastRun = new Date().toISOString(); else state.lastRun = lastRunBefore;

console.log(`incidents: ${backfill ? "backfill (no freezes)" : "incremental"}, ${res.recorded.length} incident(s) recorded, ${res.frozen.length} frozen`);
for (const r of res.recorded) console.log(`  recorded ${r.slug}: ${r.item.date} ${r.item.title}`);
for (const f of res.frozen) console.log(`  FROZE ${f.slug}: ${f.item.title} ${f.item.url}`);

if (!dry) {
  for (const p of protocols) if (JSON.stringify(p) !== before.get(p.slug)) saveProtocol(p);
  // Keep the state file quiet: rewrite it when something was learned, or at most daily to refresh lastRun.
  const stale = !lastRunBefore || Date.now() - Date.parse(lastRunBefore) > 24 * 3600 * 1000;
  if (state.seen.length !== seenBefore || stale) writeFileSync(statePath, JSON.stringify(state, null, 1) + "\n");
  if (reportFile && res.frozen.length) {
    appendFileSync(reportFile, res.frozen.map((f) => `- ${f.slug}: ${f.item.title} (${f.item.source}, ${f.item.date}) ${f.item.url}`).join("\n") + "\n");
  }
}
process.exit(failed ? 1 : 0);
