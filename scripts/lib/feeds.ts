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

export function parseLlama(json: unknown): Item[] {
  if (!Array.isArray(json)) throw new Error("defillama hacks: expected an array");
  return json.map((h: any) => ({
    id: `llama:${h.defillamaId ?? "none"}:${h.date}:${h.name}`,
    source: "defillama" as const,
    date: day(Number(h.date) * 1000),
    title: [h.name, h.technique || h.classification].filter(Boolean).join(": "),
    url: httpsUrl(h.source, "https://defillama.com/hacks"),
    text: String(h.description ?? ""),
    ...(h.defillamaId != null ? { defillamaId: String(h.defillamaId) } : {}),
  }));
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
