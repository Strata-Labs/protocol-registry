// Usage: tsx scripts/sync.ts [--check] [--report <file>]
//   --check   every address a contract cites must appear in its source file at the pinned commit; exit 1 otherwise
//   (default) for each repo source, compare the addresses the registry cites from it with the default branch.
//             If a cited address is gone or changed, move the pin to the head and write a report. Unrelated
//             additions or removals in the file are ignored. Never touches status.
// GITHUB_TOKEN is optional (raises the API rate limit).
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { loadAll, parseRepoUrl, saveProtocol, type Protocol } from "./lib/registry.ts";

const ADDR = /0x[0-9a-fA-F]{40}/g;
const lineKey = (line: string) => line.replace(ADDR, "<addr>").trim();

/** Cited addresses that are missing at head, with the new address when the same line now holds another one. */
export function citedDrift(pinnedSrc: string, headSrc: string, cited: string[]) {
  const headAddrs = new Set((headSrc.match(ADDR) ?? []).map((a) => a.toLowerCase()));
  const headByKey = new Map<string, string[]>();
  for (const line of headSrc.split("\n")) {
    const found = (line.match(ADDR) ?? []).map((a) => a.toLowerCase());
    if (found.length) headByKey.set(lineKey(line), found);
  }
  const drift: { address: string; changedTo?: string }[] = [];
  for (const a of cited.map((x) => x.toLowerCase())) {
    if (headAddrs.has(a)) continue;
    const line = pinnedSrc.split("\n").find((l) => l.toLowerCase().includes(a));
    const now = line ? headByKey.get(lineKey(line)) : undefined;
    drift.push({ address: a, ...(now && now.length === 1 ? { changedTo: now[0]! } : {}) });
  }
  return drift;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();

async function main() {
const args = process.argv.slice(2);
const check = args.includes("--check");
const reportFile = args.includes("--report") ? args[args.indexOf("--report") + 1] : undefined;

const gh: Record<string, string> = { "user-agent": "protocol-registry", ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) };
const cache = new Map<string, Promise<string>>();
const text = (url: string, headers: Record<string, string> = {}) => {
  if (!cache.has(url)) {
    cache.set(url, fetch(url, { headers, signal: AbortSignal.timeout(30_000) }).then((r) => {
      if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
      return r.text();
    }));
  }
  return cache.get(url)!;
};
const raw = (o: string, r: string, sha: string, path: string) => text(`https://raw.githubusercontent.com/${o}/${r}/${sha}/${path}`);
const addresses = (src: string) => new Set((src.match(/0x[0-9a-fA-F]{40}/g) ?? []).map((a) => a.toLowerCase()));
const headSha = async (o: string, r: string) => (JSON.parse(await text(`https://api.github.com/repos/${o}/${r}/commits/HEAD`, gh)).sha as string);

let problems = 0;
const lines: string[] = [];
const say = (s: string) => {
  console.log(s);
  lines.push(s);
};

for (const { data: p } of loadAll()) {
  let changed = false;
  for (const s of p.sources) {
    const u = s.kind === "repo" ? parseRepoUrl(s.url) : null;
    if (!u) continue;
    const cited = p.contracts.filter((c) => c.sourceId === s.id);
    const pinnedSrc = await raw(u.owner, u.repo, u.sha, u.path);
    const pinned = addresses(pinnedSrc);
    if (check) {
      for (const c of cited) {
        if (!pinned.has(c.address.toLowerCase())) {
          problems++;
          console.error(`${p.slug}: ${c.label} (chain ${c.chainId}) ${c.address} is not in ${s.id} at the pinned commit`);
        }
      }
      continue;
    }
    const head = await headSha(u.owner, u.repo);
    if (head === u.sha) continue;
    let headSrc: string;
    try {
      headSrc = await raw(u.owner, u.repo, head, u.path);
    } catch (e) {
      say(`- ${p.slug}/${s.id}: ${u.path} is gone at ${head.slice(0, 7)} (${(e as Error).message}); pin left at ${u.sha.slice(0, 7)}`);
      continue;
    }
    const drift = citedDrift(pinnedSrc, headSrc, cited.map((c) => c.address));
    if (!drift.length) continue;
    s.url = s.url.replace(u.sha, head);
    changed = true;
    say(`- ${p.slug}/${s.id}: pin ${u.sha.slice(0, 7)} -> ${head.slice(0, 7)}; ${drift.length} cited address(es) gone or changed`);
    for (const d of drift) say(`    - ${d.address}${d.changedTo ? ` (now ${d.changedTo})` : " (no longer in the file)"}`);
  }
  if (changed) saveProtocol(p as Protocol);
}
if (reportFile && lines.length) appendFileSync(reportFile, lines.join("\n") + "\n");
console.log(check ? `sync --check: ${problems ? `${problems} problem(s)` : "ok"}` : `sync: ${lines.length ? "drift found" : "pins current"}`);
process.exit(problems ? 1 : 0);
}
