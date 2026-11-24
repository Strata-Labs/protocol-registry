# protocol-registry

A public registry of verified DeFi protocol contract addresses, with automation that freezes a protocol when it is exploited.

Cofund vaults allowlist `(target contract, function selector)` pairs. The webapp and API read this registry to:

1. show that a target belongs to an official protocol, with a source pinned to a commit;
2. refuse new proposals to a protocol whose `status` is `frozen`.

Chains: Ethereum (1), Base (8453), Robinhood Chain (4663).

## Layout

```
protocols/<slug>.json   one file per protocol (the source of truth)
schema/protocol.schema.json
dist/registry.json      all protocols in one file, rebuilt by scripts/validate.ts
state/seen.json         incident feed items already processed, and the last run time
scripts/                validate, verify-onchain, incidents, sync
```

## File format

```jsonc
{
  "slug": "aave-v3", "name": "Aave V3", "aliases": ["aave"],      // aliases only match news headlines
  "category": "lending",                                          // lending|staking|dex|aggregator|bridge|yield
  "defillamaIds": ["1599", "parent#aave"], "website": "https://aave.com",
  "status": "ok",                                                 // ok | watch | frozen
  "statusReason": "required when frozen",
  "sources": [
    { "id": "aave-address-book-ethereum", "kind": "repo",         // repo | onchain | docs
      "url": "https://github.com/<owner>/<repo>/blob/<40-hex sha>/<path>", "description": "..." }
  ],
  "contracts": [
    { "chainId": 1, "address": "0x...checksummed", "label": "Pool", "sourceId": "aave-address-book-ethereum",
      "proxy": { "implementation": "0x...", "admin": "0x..." },   // EIP-1967; admin omitted if not in the admin slot
      "functions": [{ "selector": "0x617ba037", "signature": "supply(address,uint256,address,uint16)", "label": "Supply" }],
      "onchainChecks": [{ "signature": "getPool()", "returns": "0x..." }] }   // registry cross-checks; optional args, target, outputs, outputIndex
      // "selectorCheck": {"implementation": "implementation()"} or {"facet": "selectorToFacet(bytes4)"}: where selectors really execute
  ],
  "incidents": [{ "date": "2026-03-12", "title": "...", "url": "https://...", "source": "defillama" }] // defillama | rekt | onchain
}
```

Rules for entries:

- Every address comes from the pinned source file, never from memory. Repo sources are pinned to a commit SHA and name the file.
- `functions` lists user-facing actions only (supply, withdraw, deposit, swap). Never `approve`, `permit`, transfers or other operator calls; validate rejects them.
- A contract that is a proxy has a `proxy` record; `verify-onchain --write` fills it from the EIP-1967 slots.
- Where the protocol has its own on-chain registry, add `onchainChecks` so the address is confirmed by a read. Checks may take typed `args` (a bytes32 can be `{"ascii": "KEY"}` or `{"keccak": "text"}`) and call another contract with `target`.
- Selectors are checked in the bytecode that runs them: the contract, its EIP-1967 implementation, or where `selectorCheck` points (Aragon proxies, facet routers).
- Adding a protocol: write the file, run `npm run verify -- --write` (needs RPC env), then `npm run validate`.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run validate` | Schema, checksums, selector = keccak(signature), `sourceId` exists, repo URLs pinned to 40-hex SHAs, no contract in two protocols. Builds `dist/registry.json`. |
| `npm run sync -- --check` | Every contract address appears in its source file at the pinned commit. |
| `npm run verify` | Needs `RPC_URL_<chainId>`. Code exists at each address, proxy implementation/admin match the EIP-1967 slots, `paused()` is not true, `onchainChecks` hold, selectors exist in the bytecode (warning only). `--write` records a missing proxy implementation; `--write --refresh` overwrites after a reviewed upgrade. |
| `npm run incidents` | Pulls DefiLlama `/hacks` and the rekt.news RSS, matches them to protocols, records incidents and freezes. |
| `npm run sync` | Compares the cited addresses of each pinned source file with its default branch and moves the pin when one is gone or changed. |
| `npm test` | vitest: validation rules and the incident matcher, on fixtures. |

## Consuming it

Fetch `dist/registry.json` from raw GitHub at a commit SHA:

```
https://raw.githubusercontent.com/Strata-Labs/protocol-registry/<sha>/dist/registry.json
```

`{ generatedAt, gitSha, digest, protocols[] }`. `gitSha` is the commit the build started from. Pin the SHA you reviewed for addresses and selectors; read `main` for `status`, since a freeze only matters if it is fresh. Look up a target by `(chainId, address)` (lowercase compare), check the selector in that contract's `functions`, and refuse new proposals when `status === "frozen"`. `watch` is advisory.

## Freeze and unfreeze

Freezing is automatic and unfreezing is manual.

- `incidents.yml` runs hourly. It freezes a protocol when a feed item is new and dated no earlier than three days before the previous run (DefiLlama dates are day-granular and lag the event, so a strict "after the last run" would miss same-day hacks), and matches it:
  - DefiLlama hacks match by `defillamaId` in `defillamaIds`.
  - rekt.news items match when a protocol name or alias is in the headline and the headline or summary has incident language.
  - The first run (empty `state/seen.json`) backfills history into `incidents` without freezing. A processed item never freezes twice, so unfreezing sticks.
- The same run freezes on on-chain drift: proxy implementation or admin changed, `paused()` true, no code at an address, or an `onchainChecks` mismatch.
- A freeze commits `status`, `statusReason`, the incident and the rebuilt `dist` to `main` and opens an issue.
- Unfreezing is only a reviewed pull request that sets `status` back to `ok`. After a legitimate upgrade the PR also runs `npm run verify -- --write --refresh`.
- `sync.yml` runs daily. If a cited address is gone or changed in a repo source's default branch it opens a pull request that moves the pin, listing those addresses in the body. It never commits to `main`. The PR check fails if a cited address is missing at the new pin.

## Repository setup

- Secrets `RPC_URL_1`, `RPC_URL_8453`, `RPC_URL_4663` (used by validate and incidents).
- Actions may create pull requests, and `main` must allow the Actions bot to push (no required-PR rule for it), or freezes cannot land.
- Pull requests opened by `GITHUB_TOKEN` do not trigger `validate.yml`; `sync.yml` runs the address check itself and prints it in the PR body.
