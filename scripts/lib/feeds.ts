import type { Item } from "./matcher.ts";

export const LLAMA_URL = "https://api.llama.fi/hacks";
export const REKT_URL = "https://rekt.news/rss/feed.xml";

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const httpsUrl = (s: unknown, fallback: string) => {
  if (typeof s !== "string" || !s.trim()) return fallback;
  try {
    const u = new URL(/^https?:\/\//.test(s) ? s : `https://${s}`);
    return u.protocol === "https:" ? u.href : fallback;
  } catch {
    return fallback;
  }
};

/** $12.3M, $820K, $1.2B; empty for a missing or zero amount. */
export function usd(n: unknown): string {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return "";
  const [d, u] = v >= 1e9 ? [v / 1e9, "B"] : v >= 1e6 ? [v / 1e6, "M"] : v >= 1e3 ? [v / 1e3, "K"] : [v, ""];
  return `$${(d >= 100 || !u ? Math.round(d) : Math.round(d * 10) / 10).toString()}${u}`;
}

export function parseLlama(json: unknown): Item[] {
  if (!Array.isArray(json)) throw new Error("defillama hacks: expected an array");
  return json.map((h: any) => {
    const base = [h.name, h.technique || h.classification].filter(Boolean).join(": ");
    const lost = usd(h.amount);
    const back = usd(h.returnedFunds);
    const chains = Array.isArray(h.chain) ? h.chain.join(", ") : "";
    const extras = [lost && `${lost} lost`, back && `${back} returned`].filter(Boolean);
    return {
      id: `llama:${h.defillamaId ?? "none"}:${h.date}:${h.name}`,
      source: "defillama" as const,
      date: day(Number(h.date) * 1000),
      title: [base, ...extras].join(", "),
      altTitles: [base],
      url: httpsUrl(h.source, "https://defillama.com/hacks"),
      text: `${chains ? `Chain: ${chains}. ` : ""}${h.description ?? ""}`,
      ...(h.defillamaId != null ? { defillamaId: String(h.defillamaId) } : {}),
    };
  });
}

const tag = (xml: string, name: string) => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return (m?.[1] ?? "").replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1").trim();
};

export function parseRss(xml: string): Item[] {
  if (!xml.includes("<rss")) throw new Error("rekt rss: not an RSS document");
  return xml.split("<item>").slice(1).map((chunk) => {
    const link = tag(chunk, "link");
    const t = Date.parse(tag(chunk, "pubDate"));
    return {
      id: `rekt:${tag(chunk, "guid") || link}`,
      source: "rekt" as const,
      date: Number.isNaN(t) ? day(Date.now()) : day(t),
      title: tag(chunk, "title"),
      url: httpsUrl(link, "https://rekt.news"),
      text: tag(chunk, "description"),
    };
  });
}

export async function get(url: string): Promise<string> {
  const r = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: { "user-agent": "protocol-registry" } });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.text();
}
