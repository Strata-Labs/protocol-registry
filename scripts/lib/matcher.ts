import { addIncident, freeze, type Incident, type Protocol } from "./registry.ts";

export type Item = {
  id: string; // stable across runs, used for dedupe
  source: "defillama" | "rekt";
  date: string; // YYYY-MM-DD
  title: string;
  url: string;
  text: string;
  defillamaId?: string;
};
export type State = { lastRun: string | null; seen: string[] };

/** A new item older than this (relative to the last run) is history, not news. DefiLlama dates are day-granular and lag the event. */
export const FRESH_WINDOW_MS = 3 * 24 * 3600 * 1000;

export const normalize = (s: string) =>
  s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const INCIDENT_WORDS = /\b(rekt|exploit\w*|hack\w*|drain\w*|attack\w*|stolen|breach\w*|compromis\w*|vulnerab\w*)\b/;

export function matches(p: Protocol, item: Item): boolean {
  if (item.source === "defillama") return item.defillamaId != null && p.defillamaIds.includes(item.defillamaId);
  // RSS: a protocol name in the headline AND incident language in headline or summary.
  const title = ` ${normalize(item.title)} `;
  const named = [p.name, ...(p.aliases ?? [])].some((n) => title.includes(` ${normalize(n)} `));
  return named && INCIDENT_WORDS.test(normalize(`${item.title} ${item.text}`));
}

export function toIncident(item: Item): Incident {
  return { date: item.date, title: item.title, url: item.url, source: item.source };
}

export type Result = { frozen: { slug: string; item: Item }[]; recorded: { slug: string; item: Item }[] };

/** Mutates protocols and state. Freezes only unseen items that are fresh relative to the last run. */
export function applyItems(protocols: Protocol[], items: Item[], state: State): Result {
  const res: Result = { frozen: [], recorded: [] };
  const seen = new Set(state.seen);
  const backfill = state.lastRun === null;
  const cutoff = backfill ? Infinity : Date.parse(state.lastRun!) - FRESH_WINDOW_MS;
  for (const item of items) {
    const isNew = !seen.has(item.id);
    seen.add(item.id);
    for (const p of protocols) {
      if (!matches(p, item)) continue;
      if (addIncident(p, toIncident(item))) res.recorded.push({ slug: p.slug, item });
      if (isNew && !backfill && Date.parse(item.date) >= cutoff) {
        if (freeze(p, `Reported exploit (${item.source}, ${item.date}): ${item.title}`)) res.frozen.push({ slug: p.slug, item });
      }
    }
  }
  state.seen = [...seen].sort();
  return res;
}
