import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress, isAddress, toFunctionSelector } from "viem";
import Ajv from "ajv";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const PROTOCOLS_DIR = join(ROOT, "protocols");

export type Status = "ok" | "watch" | "frozen";
export type Source = { id: string; kind: "repo" | "onchain" | "docs"; url: string; description: string };
export type Contract = {
  chainId: number;
  address: string;
  label: string;
  sourceId: string;
  alsoSourceIds?: string[];
  proxy?: { implementation: string; admin?: string };
  functions: { selector: string; signature: string; label: string }[];
  onchainChecks?: OnchainCheck[];
  selectorCheck?: { implementation: string } | { facet: string };
};
export type ArgValue = string | number | boolean | { ascii: string } | { keccak: string };
export type OnchainCheck = {
  signature: string;
  args?: ArgValue[];
  target?: string;
  outputs?: string;
  outputIndex?: number;
  returns: string;
};
export type Incident = { date: string; title: string; url: string; source: "defillama" | "rekt" | "onchain" };
export type Protocol = {
  slug: string;
  name: string;
  aliases?: string[];
  category: string;
  defillamaIds: string[];
  website: string;
  status: Status;
  statusReason?: string;
  sources: Source[];
  contracts: Contract[];
  incidents: Incident[];
};

export const REPO_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/blob\/([0-9a-f]{40})\/(.+)$/;
export function parseRepoUrl(url: string) {
  const m = REPO_URL.exec(url);
  return m ? { owner: m[1]!, repo: m[2]!, sha: m[3]!, path: m[4]! } : null;
}

// Operator calls must never be allowlisted through the registry.
const OPERATOR_NAMES = new Set([
  "approve", "increaseAllowance", "decreaseAllowance", "setApprovalForAll", "permit",
  "transfer", "transferFrom", "safeTransferFrom",
]);

const ajv = new Ajv({ allErrors: true });
const schema = JSON.parse(readFileSync(join(ROOT, "schema", "protocol.schema.json"), "utf8"));
const validateSchema = ajv.compile(schema);

/** Returns a list of human-readable problems; empty means valid. */
export function checkProtocol(p: unknown, file = "protocol"): string[] {
  if (!validateSchema(p)) {
    return (validateSchema.errors ?? []).map((e) => `${file}: schema ${e.instancePath || "/"} ${e.message}`);
  }
  const x = p as Protocol;
  const errs: string[] = [];
  const err = (m: string) => errs.push(`${file}: ${m}`);
  const checksummed = (a: string, where: string) => {
    if (!isAddress(a, { strict: false })) return err(`${where} is not an address: ${a}`);
    if (getAddress(a) !== a) err(`${where} is not checksummed: ${a} (expected ${getAddress(a)})`);
  };
  if (file.endsWith(".json") && file.replace(/\.json$/, "") !== x.slug) err(`slug "${x.slug}" must match the file name`);

  const sourceIds = new Set<string>();
  for (const s of x.sources) {
    if (sourceIds.has(s.id)) err(`duplicate source id ${s.id}`);
    sourceIds.add(s.id);
    if (s.kind === "repo" && !parseRepoUrl(s.url)) {
      err(`source ${s.id}: repo url must be https://github.com/<owner>/<repo>/blob/<40-hex sha>/<path>, got ${s.url}`);
    }
  }
  const seen = new Set<string>();
  for (const c of x.contracts) {
    const at = `${c.label} (chain ${c.chainId})`;
    checksummed(c.address, `${at} address`);
    const key = `${c.chainId}:${c.address.toLowerCase()}`;
    if (seen.has(key)) err(`duplicate contract ${key}`);
    seen.add(key);
    if (!sourceIds.has(c.sourceId)) err(`${at}: unknown sourceId ${c.sourceId}`);
    for (const id of c.alsoSourceIds ?? []) {
      if (!sourceIds.has(id)) err(`${at}: unknown alsoSourceIds entry ${id}`);
      if (id === c.sourceId) err(`${at}: alsoSourceIds repeats sourceId ${id}`);
    }
    if (c.proxy) {
      checksummed(c.proxy.implementation, `${at} proxy.implementation`);
      if (c.proxy.admin) checksummed(c.proxy.admin, `${at} proxy.admin`);
    }
    for (const k of c.onchainChecks ?? []) {
      checksummed(k.returns, `${at} ${k.signature} returns`);
      if (k.target) checksummed(k.target, `${at} ${k.signature} target`);
      const arity = k.signature.slice(k.signature.indexOf("(") + 1, -1).split(",").filter(Boolean).length;
      if ((k.args?.length ?? 0) !== arity) err(`${at}: ${k.signature} takes ${arity} argument(s), args has ${k.args?.length ?? 0}`);
    }
    for (const f of c.functions) {
      let sel: string;
      try {
        sel = toFunctionSelector(f.signature);
      } catch {
        err(`${at}: bad signature ${f.signature}`);
        continue;
      }
      if (sel !== f.selector) err(`${at}: ${f.signature} selector is ${sel}, file says ${f.selector}`);
      const name = f.signature.slice(0, f.signature.indexOf("("));
      if (OPERATOR_NAMES.has(name)) err(`${at}: ${name} is an operator call and must not be listed`);
    }
  }
  return errs;
}

/** Cross-file checks: a contract (chain, address) belongs to one protocol. */
export function checkAll(all: Protocol[]): string[] {
  const errs: string[] = [];
  const owner = new Map<string, string>();
  const slugs = new Set<string>();
  for (const p of all) {
    if (slugs.has(p.slug)) errs.push(`duplicate slug ${p.slug}`);
    slugs.add(p.slug);
    for (const c of p.contracts) {
      const k = `${c.chainId}:${c.address.toLowerCase()}`;
      const o = owner.get(k);
      if (o && o !== p.slug) errs.push(`${k} is listed by both ${o} and ${p.slug}`);
      owner.set(k, p.slug);
    }
  }
  return errs;
}

export function protocolFiles(): string[] {
  return readdirSync(PROTOCOLS_DIR).filter((f) => f.endsWith(".json")).sort();
}
export function loadAll(): { file: string; data: Protocol }[] {
  return protocolFiles().map((file) => ({
    file,
    data: JSON.parse(readFileSync(join(PROTOCOLS_DIR, file), "utf8")) as Protocol,
  }));
}
export function saveProtocol(p: Protocol) {
  writeFileSync(join(PROTOCOLS_DIR, `${p.slug}.json`), JSON.stringify(p, null, 2) + "\n");
}

export const EXPLORER: Record<number, string> = {
  1: "https://etherscan.io/address/",
  8453: "https://basescan.org/address/",
  4663: "https://robinhoodchain.blockscout.com/address/",
};

/** Freeze a protocol in place. Returns true if it changed state. */
export function freeze(p: Protocol, reason: string): boolean {
  if (p.status === "frozen") return false;
  p.status = "frozen";
  p.statusReason = reason;
  return true;
}
export function addIncident(p: Protocol, i: Incident): boolean {
  if (p.incidents.some((j) => j.source === i.source && j.title === i.title && j.date === i.date)) return false;
  p.incidents.push(i);
  p.incidents.sort((a, b) => a.date.localeCompare(b.date));
  return true;
}
