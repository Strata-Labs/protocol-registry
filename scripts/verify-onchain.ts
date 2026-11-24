// Usage: tsx scripts/verify-onchain.ts [--write [--refresh]] [--freeze] [--report <file>] [--protocol <slug>]
//   (none)     report drift, exit 1 if any
//   --write    record the proxy implementation/admin where not yet recorded (--refresh overwrites)
//   --freeze   freeze protocols with drift, record an incident, exit 0
// RPC endpoints come from RPC_URL_<chainId>.
import { appendFileSync } from "node:fs";
import { getAddress, type Hex } from "viem";
import { ADMIN_SLOT, IMPL_SLOT, client, slotAddress, tryCall } from "./lib/chain.ts";
import { EXPLORER, addIncident, freeze, loadAll, saveProtocol, type Contract, type Protocol } from "./lib/registry.ts";

const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const opt = (f: string) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
const write = flag("--write");
const refresh = flag("--refresh");
const doFreeze = flag("--freeze");
const reportFile = opt("--report");
const only = opt("--protocol");

type Finding = { protocol: string; chainId: number; address: string; kind: "drift" | "warn"; msg: string };

async function checkContract(p: Protocol, c: Contract, out: Finding[]): Promise<boolean> {
  const cl = client(c.chainId);
  const at = (kind: Finding["kind"], msg: string) =>
    out.push({ protocol: p.slug, chainId: c.chainId, address: c.address, kind, msg: `${c.label}: ${msg}` });
  let changed = false;

  const code = await cl.getCode({ address: c.address as Hex });
  if (!code || code === "0x") {
    at("drift", "no code at address");
    return false;
  }

  const [implWord, adminWord] = await Promise.all([
    cl.getStorageAt({ address: c.address as Hex, slot: IMPL_SLOT }),
    cl.getStorageAt({ address: c.address as Hex, slot: ADMIN_SLOT }),
  ]);
  const impl = slotAddress(implWord);
  const admin = slotAddress(adminWord);

  if (impl && !c.proxy) {
    if (write) {
      c.proxy = { implementation: impl, ...(admin ? { admin } : {}) };
      changed = true;
    } else at("warn", `looks like an EIP-1967 proxy (implementation ${impl}) but has no proxy record`);
  } else if (c.proxy) {
    if (!impl) at("drift", "recorded as a proxy but the implementation slot is empty");
    else if (!c.proxy.implementation || impl !== getAddress(c.proxy.implementation)) {
      if (write && (refresh || !c.proxy.implementation)) {
        c.proxy.implementation = impl;
        changed = true;
      } else at("drift", `implementation changed: recorded ${c.proxy.implementation}, now ${impl}`);
    }
    const recAdmin = c.proxy.admin ? getAddress(c.proxy.admin) : null;
    if (admin !== recAdmin) {
      if (write && (refresh || (!recAdmin && admin))) {
        if (admin) c.proxy.admin = admin;
        else delete c.proxy.admin;
        changed = true;
      } else at("drift", `admin changed: recorded ${recAdmin ?? "none"}, now ${admin ?? "none"}`);
    }
  }

  if ((await tryCall<boolean>(cl, c.address, "paused()", { outputs: "(bool)" })) === true) at("drift", "paused() is true");

  for (const k of c.onchainChecks ?? []) {
    const raw = await tryCall<unknown>(cl, k.target ?? c.address, k.signature, { args: k.args, outputs: k.outputs });
    const got = Array.isArray(raw) ? raw[k.outputIndex ?? 0] : raw;
    const label = `${k.signature}(${(k.args ?? []).map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(",")})`;
    if (typeof got !== "string") at("drift", `${label} no longer answers`);
    else if (getAddress(got) !== getAddress(k.returns)) at("drift", `${label} returns ${got}, registry says ${k.returns}`);
  }

  // Selector presence is a sanity check (dispatchers embed PUSH4 selectors), so it only warns.
  // Follow the code to where it runs: EIP-1967 implementation, a declared implementation getter, or per-selector facets.
  const codeOf = async (a: string) => (await cl.getCode({ address: a as Hex })) ?? "0x";
  let body = c.proxy && impl ? await codeOf(impl) : code;
  const sc = c.selectorCheck;
  if (sc && "implementation" in sc) {
    const target = await tryCall<string>(cl, c.address, sc.implementation);
    if (target) body = await codeOf(target);
    else at("warn", `${sc.implementation} did not answer; selectors checked against the proxy`);
  }
  for (const f of c.functions) {
    let where = body;
    if (sc && "facet" in sc) {
      const facet = await tryCall<string>(cl, c.address, sc.facet, { args: [f.selector] });
      if (!facet || /^0x0{40}$/.test(facet)) {
        at("warn", `selector ${f.selector} (${f.signature}) has no facet`);
        continue;
      }
      where = await codeOf(facet);
    }
    if (!where.includes(f.selector.slice(2))) at("warn", `selector ${f.selector} (${f.signature}) not found in bytecode`);
  }
  return changed;
}

const findings: Finding[] = [];
let failed = false;
const frozen: string[] = [];
for (const { data: p } of loadAll()) {
  if (only && p.slug !== only) continue;
  const mine: Finding[] = [];
  let changed = false;
  for (const c of p.contracts) {
    try {
      changed = (await checkContract(p, c, mine)) || changed;
    } catch (e) {
      failed = true;
      console.error(`${p.slug} ${c.chainId} ${c.address}: rpc error: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  const drift = mine.filter((f) => f.kind === "drift");
  if (doFreeze && drift.length && p.status !== "frozen") {
    const date = new Date().toISOString().slice(0, 10);
    freeze(p, `On-chain drift: ${drift[0]!.msg}${drift.length > 1 ? ` (+${drift.length - 1} more)` : ""}`);
    for (const d of drift) {
      addIncident(p, {
        date,
        title: `On-chain drift (chain ${d.chainId}): ${d.msg}`,
        url: EXPLORER[d.chainId]! + d.address,
        source: "onchain",
      });
    }
    changed = true;
    frozen.push(p.slug);
  }
  if (changed) saveProtocol(p);
  findings.push(...mine);
}

for (const f of findings) console.log(`${f.kind === "drift" ? "DRIFT" : "warn "} ${f.protocol} [${f.chainId}] ${f.address} ${f.msg}`);
const drifts = findings.filter((f) => f.kind === "drift").length;
console.log(`verify-onchain: ${drifts} drift, ${findings.length - drifts} warning(s)${frozen.length ? `, froze ${frozen.join(", ")}` : ""}`);
if (reportFile && frozen.length) {
  appendFileSync(
    reportFile,
    frozen.map((s) => `- ${s}: on-chain drift\n` + findings.filter((f) => f.protocol === s && f.kind === "drift").map((f) => `  - [${f.chainId}] ${f.msg}`).join("\n")).join("\n") + "\n",
  );
}
process.exit(failed ? 2 : drifts && !doFreeze ? 1 : 0);
