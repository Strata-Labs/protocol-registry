import { createPublicClient, getAddress, http, parseAbi, type Hex, type PublicClient } from "viem";

export const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;
export const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103" as Hex;

const clients = new Map<number, PublicClient>();
export function client(chainId: number): PublicClient {
  let c = clients.get(chainId);
  if (!c) {
    const url = process.env[`RPC_URL_${chainId}`];
    if (!url) throw new Error(`RPC_URL_${chainId} is not set`);
    c = createPublicClient({ transport: http(url, { retryCount: 3, timeout: 20_000 }) });
    clients.set(chainId, c);
  }
  return c;
}

export function slotAddress(word: Hex | undefined): string | null {
  if (!word) return null;
  const a = "0x" + word.slice(-40);
  return /^0x0{40}$/.test(a) ? null : getAddress(a);
}

/** True when the failure is the network or the node, not the contract. */
export function isTransportError(e: unknown): boolean {
  const names = ["HttpRequestError", "TimeoutError", "RpcRequestError", "InternalRpcError", "LimitExceededRpcError"];
  let cur: any = e;
  for (let i = 0; cur && i < 10; i++, cur = cur.cause) if (names.includes(cur.name)) return true;
  return false;
}

/** Calls a zero-argument view; returns undefined if the contract has no such function. */
export async function tryCall<T>(c: PublicClient, address: string, signature: string, returns: string): Promise<T | undefined> {
  const name = signature.slice(0, signature.indexOf("("));
  try {
    return (await c.readContract({
      address: address as Hex,
      abi: parseAbi([`function ${name}() view returns (${returns})`]),
      functionName: name,
    })) as T;
  } catch (e) {
    if (isTransportError(e)) throw e;
    return undefined;
  }
}
