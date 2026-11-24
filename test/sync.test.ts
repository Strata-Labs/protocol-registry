import { describe, expect, it } from "vitest";
import { citedDrift } from "../scripts/sync.ts";

const A = "0x" + "a".repeat(40);
const B = "0x" + "b".repeat(40);
const C = "0x" + "c".repeat(40);
const pinned = `| Pool | \`${A}\` |\n| Other | \`${B}\` |\n`;

describe("citedDrift", () => {
  it("ignores unrelated additions and removals", () => {
    const head = `| Pool | \`${A}\` |\n| Brand new | \`${C}\` |\n`;
    expect(citedDrift(pinned, head, [A])).toEqual([]);
  });
  it("flags a cited address that left the file", () => {
    expect(citedDrift(pinned, `| Other | \`${B}\` |\n`, [A])).toEqual([{ address: A }]);
  });
  it("reports the new address when the entry changed", () => {
    expect(citedDrift(pinned, `| Pool | \`${C}\` |\n| Other | \`${B}\` |\n`, [A])).toEqual([{ address: A, changedTo: C }]);
  });
  it("compares case-insensitively", () => {
    expect(citedDrift(pinned, `| Pool | \`${A.toUpperCase().replace("0X", "0x")}\` |\n`, [A])).toEqual([]);
  });
});
