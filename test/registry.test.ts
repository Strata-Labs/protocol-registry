import { describe, expect, it } from "vitest";
import { toFunctionSelector } from "viem";
import { checkAll, checkProtocol, parseRepoUrl, type Protocol } from "../scripts/lib/registry.ts";

const SHA = "a".repeat(40);
const POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
const base = (): Protocol => ({
  slug: "demo",
  name: "Demo",
  category: "lending",
  defillamaIds: ["1"],
  website: "https://demo.test",
  status: "ok",
  sources: [{ id: "repo", kind: "repo", url: `https://github.com/o/r/blob/${SHA}/a.sol`, description: "d" }],
  contracts: [
    {
      chainId: 1,
      address: POOL,
      label: "Pool",
      sourceId: "repo",
      functions: [{ selector: toFunctionSelector("supply(address,uint256,address,uint16)"), signature: "supply(address,uint256,address,uint16)", label: "Supply" }],
    },
  ],
  incidents: [],
});
const problems = (p: unknown) => checkProtocol(p, "demo.json");

describe("checkProtocol", () => {
  it("accepts a valid entry", () => expect(problems(base())).toEqual([]));

  it("rejects a lowercase address (checksum)", () => {
    const p = base();
    p.contracts[0]!.address = POOL.toLowerCase();
    expect(problems(p).join("\n")).toMatch(/not checksummed/);
  });

  it("rejects a selector that is not keccak of the signature", () => {
    const p = base();
    p.contracts[0]!.functions[0]!.selector = "0xdeadbeef";
    expect(problems(p).join("\n")).toMatch(/selector is 0x617ba037/);
  });

  it("rejects operator calls such as approve", () => {
    const p = base();
    const sig = "approve(address,uint256)";
    p.contracts[0]!.functions = [{ selector: toFunctionSelector(sig), signature: sig, label: "Approve" }];
    expect(problems(p).join("\n")).toMatch(/operator call/);
  });

  it("rejects an unknown sourceId", () => {
    const p = base();
    p.contracts[0]!.sourceId = "nope";
    expect(problems(p).join("\n")).toMatch(/unknown sourceId/);
  });

  it("requires repo urls pinned to a 40-hex commit", () => {
    for (const url of ["https://github.com/o/r/blob/main/a.sol", `https://github.com/o/r/blob/${"a".repeat(39)}/a.sol`, "https://github.com/o/r"]) {
      const p = base();
      p.sources[0]!.url = url;
      expect(problems(p).join("\n")).toMatch(/pinned|<40-hex/i);
    }
  });

  it("requires statusReason when frozen", () => {
    const p = base();
    p.status = "frozen";
    expect(problems(p).length).toBeGreaterThan(0);
    p.statusReason = "exploit";
    expect(problems(p)).toEqual([]);
  });

  it("requires the slug to match the file name", () => {
    expect(checkProtocol(base(), "other.json").join("\n")).toMatch(/slug/);
  });

  it("rejects the same contract in two protocols", () => {
    const a = base();
    const b = { ...base(), slug: "demo2" };
    expect(checkAll([a, b]).join("\n")).toMatch(/listed by both/);
  });
});

describe("parseRepoUrl", () => {
  it("splits owner, repo, sha and path", () => {
    expect(parseRepoUrl(`https://github.com/bgd-labs/aave-address-book/blob/${SHA}/src/X.sol`)).toEqual({
      owner: "bgd-labs", repo: "aave-address-book", sha: SHA, path: "src/X.sol",
    });
  });
});
