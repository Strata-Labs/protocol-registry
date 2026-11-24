// Usage: tsx scripts/sync.ts [--check] [--report <file>]
//   --check   every address a contract cites must appear in its source file at the pinned commit; exit 1 otherwise
//   (default) for each repo source, compare addresses in the pinned file with the default branch; where they
//             differ, move the pin to the default branch head and write a report. Never touches status.
// GITHUB_TOKEN is optional (raises the API rate limit).
import { appendFileSync } from "node:fs";
import { loadAll, parseRepoUrl, saveProtocol, type Protocol } from "./lib/registry.ts";

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
    const pinned = addresses(await raw(u.owner, u.repo, u.sha, u.path));
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
    let now: Set<string>;
    try {
      now = addresses(await raw(u.owner, u.repo, head, u.path));
    } catch (e) {
      say(`- ${p.slug}/${s.id}: ${u.path} is gone at ${head.slice(0, 7)} (${(e as Error).message}); pin left at ${u.sha.slice(0, 7)}`);
      continue;
    }
    const added = [...now].filter((a) => !pinned.has(a));
    const removed = [...pinned].filter((a) => !now.has(a));
    if (!added.length && !removed.length) continue;
    s.url = s.url.replace(u.sha, head);
    changed = true;
    say(`- ${p.slug}/${s.id}: pin ${u.sha.slice(0, 7)} -> ${head.slice(0, 7)}; ${added.length} address(es) added, ${removed.length} removed`);
    for (const a of added) say(`    + ${a}`);
    for (const a of removed) say(`    - ${a}${cited.some((c) => c.address.toLowerCase() === a) ? "  (CITED BY A CONTRACT)" : ""}`);
  }
  if (changed) saveProtocol(p as Protocol);
}
if (reportFile && lines.length) appendFileSync(reportFile, lines.join("\n") + "\n");
console.log(check ? `sync --check: ${problems ? `${problems} problem(s)` : "ok"}` : `sync: ${lines.length ? "drift found" : "pins current"}`);
process.exit(problems ? 1 : 0);
