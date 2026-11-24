import { describe, expect, it } from "vitest";
import { parseLlama, parseRss } from "../scripts/lib/feeds.ts";
import { applyItems, matches, normalize, type Item, type State } from "../scripts/lib/matcher.ts";
import type { Protocol } from "../scripts/lib/registry.ts";

const proto = (over: Partial<Protocol> = {}): Protocol => ({
  slug: "aave-v3", name: "Aave V3", aliases: ["aave"], category: "lending", defillamaIds: ["1599", "parent#aave"],
  website: "https://aave.com", status: "ok", sources: [], contracts: [], incidents: [], ...over,
});
const llama = (over: Partial<Item> = {}): Item => ({
  id: "llama:1599:1:x", source: "defillama", date: "2026-11-23", title: "Aave V3: Oracle", url: "https://defillama.com/hacks", text: "", defillamaId: "1599", ...over,
});
const rekt = (title: string, text = ""): Item => ({ id: `rekt:${title}`, source: "rekt", date: "2026-11-23", title, url: "https://rekt.news/x", text });

describe("matches", () => {
  it("matches DefiLlama by id, including parent ids", () => {
    expect(matches(proto(), llama())).toBe(true);
    expect(matches(proto(), llama({ defillamaId: "parent#aave" }))).toBe(true);
    expect(matches(proto(), llama({ defillamaId: "1600" }))).toBe(false);
    expect(matches(proto(), llama({ defillamaId: undefined }))).toBe(false);
  });
  it("matches rss by normalised name plus incident language", () => {
    expect(matches(proto(), rekt("Aave V3 - REKT", "A drain of $5M"))).toBe(true);
    expect(matches(proto(), rekt("AAVE exploited", ""))).toBe(true);
  });
  it("does not match opinion pieces or substrings", () => {
    expect(matches(proto(), rekt("Why Aave won lending", "market share"))).toBe(false);
    expect(matches(proto(), rekt("Aavegotchi hacked"))).toBe(false);
  });
  it("normalises punctuation and diacritics", () => expect(normalize("  Ünï-swap, V3! ")).toBe("uni swap v3"));
});

describe("applyItems", () => {
  const run = (state: State, items: Item[], p = proto()) => ({ p, state, ...{ res: applyItems([p], items, state) } });

  it("backfill records history without freezing", () => {
    const { p, res, state } = run({ lastRun: null, seen: [] }, [llama()]);
    expect(p.status).toBe("ok");
    expect(p.incidents).toHaveLength(1);
    expect(res.frozen).toHaveLength(0);
    expect(state.seen).toEqual(["llama:1599:1:x"]);
  });
  it("freezes on a new item newer than the last run", () => {
    const { p, res } = run({ lastRun: "2026-11-23T10:00:00Z", seen: [] }, [llama({ date: "2026-11-23" })]);
    expect(p.status).toBe("frozen");
    expect(p.statusReason).toMatch(/Aave V3: Oracle/);
    expect(res.frozen).toHaveLength(1);
  });
  it("freezes a day-granular item dated just before the last run", () => {
    const { p } = run({ lastRun: "2026-11-23T10:00:00Z", seen: [] }, [llama({ date: "2026-11-22" })]);
    expect(p.status).toBe("frozen");
  });
  it("does not freeze for a new item that is old history", () => {
    const { p } = run({ lastRun: "2026-11-23T10:00:00Z", seen: [] }, [llama({ date: "2024-01-01" })]);
    expect(p.status).toBe("ok");
    expect(p.incidents).toHaveLength(1);
  });
  it("fires once: a seen item never freezes again, even after unfreezing", () => {
    const state: State = { lastRun: "2026-11-23T10:00:00Z", seen: [] };
    const p = proto();
    applyItems([p], [llama()], state);
    expect(p.status).toBe("frozen");
    p.status = "ok";
    delete p.statusReason;
    const res = applyItems([p], [llama()], state);
    expect(p.status).toBe("ok");
    expect(res.frozen).toHaveLength(0);
    expect(p.incidents).toHaveLength(1);
  });
  it("ignores items for other protocols", () => {
    const { p } = run({ lastRun: "2026-11-23T10:00:00Z", seen: [] }, [llama({ defillamaId: "42" }), rekt("Curve rekt")]);
    expect(p.status).toBe("ok");
    expect(p.incidents).toHaveLength(0);
  });
});

describe("feed parsers", () => {
  it("parses DefiLlama hacks", () => {
    const [i] = parseLlama([{ date: 1773273600, name: "Aave V3", technique: "Oracle", defillamaId: "1599", source: "", description: "d" }]);
    expect(i).toMatchObject({ date: "2026-03-12", defillamaId: "1599", title: "Aave V3: Oracle", url: "https://defillama.com/hacks", source: "defillama" });
  });
  it("parses the rekt RSS feed", () => {
    const xml = `<?xml version="1.0"?><rss><channel><item><title><![CDATA[Aave rekt]]></title><link>https://www.rekt.news/aave</link><guid>https://www.rekt.news/aave</guid><pubDate>Mon, 23 Nov 2026 00:00:00 GMT</pubDate><description><![CDATA[drained]]></description></item></channel></rss>`;
    expect(parseRss(xml)).toEqual([
      { id: "rekt:https://www.rekt.news/aave", source: "rekt", date: "2026-11-23", title: "Aave rekt", url: "https://www.rekt.news/aave", text: "drained" },
    ]);
  });
  it("rejects a non-RSS body", () => expect(() => parseRss("<html>")).toThrow());
});
