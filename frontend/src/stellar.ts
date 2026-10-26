import { contract, Networks } from "@stellar/stellar-sdk";
import { Buffer } from "buffer";
import * as freighter from "@stellar/freighter-api";
import { poseidon1 } from "poseidon-lite";

export const CONTRACT_ID =
  import.meta.env.VITE_CONTRACT_ID ?? "CDP3UFFH6PG5BICR4VKRTVG4LULNLOSLQYJ5KAZ2NRO536HH5SC7JXVR";
export const RPC_URL = import.meta.env.VITE_RPC_URL ?? "https://soroban-testnet.stellar.org";
export const PASSPHRASE = Networks.TESTNET;
export const USDC_DECIMALS = 7;

// BN254 scalar field order. Secrets must be smaller than this.
const FIELD = 21888242871839275222246405745257518527276117222458736883840389301201220005377n;

export type CreatorInfo = { price: bigint; member_count: number; members_root?: Buffer | null };
export type CampaignInfo = { creator: string; goal: bigint; raised: bigint; open: boolean };

const ERRORS: Record<number, string> = {
  1: "This account is already registered as a creator.",
  2: "This address is not a registered creator.",
  3: "Amount must be greater than zero.",
  4: "This membership commitment is already registered.",
  5: "The creator has not published a member list yet.",
  6: "This proof was already used.",
  7: "The proof is not valid.",
  8: "The verification key does not match the proof.",
  9: "Campaign not found.",
  10: "This campaign is closed.",
};

export function explainError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const m = msg.match(/Error\(Contract, #(\d+)\)/);
  if (m) return ERRORS[Number(m[1])] ?? `Contract error #${m[1]}`;
  if (/trustline|TrustLine|balance/i.test(msg))
    return "Your wallet has no USDC on testnet yet. Add a USDC trustline in Freighter and get test USDC first.";
  if (/User declined|rejected/i.test(msg)) return "You cancelled the signature in Freighter.";
  return msg.length > 240 ? msg.slice(0, 240) + "…" : msg;
}

export async function connectWallet(): Promise<string> {
  const conn = await freighter.isConnected();
  if (!conn.isConnected) throw new Error("Freighter is not installed. Get it at freighter.app.");
  const access = await freighter.requestAccess();
  if (access.error) throw new Error(access.error.message ?? "Freighter refused access.");
  const net = await freighter.getNetwork();
  if (net.networkPassphrase !== PASSPHRASE)
    throw new Error("Switch Freighter to Testnet, then connect again.");
  return access.address;
}

// Read-only calls need a source account for simulation but no signature.
const READ_ONLY_SOURCE = "GDSA677ALNKNBSGWL6NW7TBUDKBDVGOLZRPHAPDAR6YC42R7QQGISKDJ";

// The client is generated from the contract spec on chain, so method names
// and argument names match lib.rs exactly.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getClient(publicKey?: string): Promise<any> {
  return contract.Client.from({
    contractId: CONTRACT_ID,
    networkPassphrase: PASSPHRASE,
    rpcUrl: RPC_URL,
    publicKey: publicKey ?? READ_ONLY_SOURCE,
    signTransaction: async (xdr: string, opts?: { networkPassphrase?: string; address?: string }) => {
      const r = await freighter.signTransaction(xdr, {
        networkPassphrase: opts?.networkPassphrase ?? PASSPHRASE,
        address: opts?.address ?? publicKey,
      });
      if (r.error) throw new Error(r.error.message ?? "Signing failed");
      return { signedTxXdr: r.signedTxXdr, signerAddress: r.signerAddress };
    },
  });
}

/** Read a value. Unwraps the contract's Result type. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function unwrap<T>(res: any): T {
  if (res && typeof res === "object" && typeof res.isErr === "function") {
    if (res.isErr()) throw new Error(res.unwrapErr().message);
    return res.unwrap();
  }
  return res as T;
}

export async function readCreator(creator: string): Promise<CreatorInfo> {
  const c = await getClient();
  const tx = await c.creator({ creator });
  return unwrap<CreatorInfo>(tx.result);
}

export async function readCampaign(id: number): Promise<CampaignInfo> {
  const c = await getClient();
  const tx = await c.campaign({ campaign: id });
  return unwrap<CampaignInfo>(tx.result);
}

/** Build, sign in Freighter and submit. Returns the transaction hash. */
export async function send(
  publicKey: string,
  method: string,
  args: Record<string, unknown>,
): Promise<{ hash: string; value: unknown }> {
  const c = await getClient(publicKey);
  const tx = await c[method](args);
  const sent = await tx.signAndSend();
  const hash: string = sent.sendTransactionResponse?.hash ?? sent.getTransactionResponse?.txHash ?? "";
  return { hash, value: unwrap(sent.result) };
}

export function toUnits(amount: string): bigint {
  const [whole, frac = ""] = amount.trim().split(".");
  const f = (frac + "0".repeat(USDC_DECIMALS)).slice(0, USDC_DECIMALS);
  return BigInt(whole || "0") * 10n ** BigInt(USDC_DECIMALS) + BigInt(f || "0");
}

export function fromUnits(units: bigint | number | string): string {
  const u = BigInt(units);
  const base = 10n ** BigInt(USDC_DECIMALS);
  const frac = (u % base).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  return frac ? `${u / base}.${frac}` : `${u / base}`;
}

/** New membership identity. The secret never leaves the browser. */
export function newIdentity(): { secret: bigint; commitment: Buffer } {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const secret = BigInt("0x" + Buffer.from(bytes).toString("hex")) % FIELD;
  const commitment = poseidon1([secret]);
  return { secret, commitment: bigintTo32(commitment) };
}

function bigintTo32(n: bigint): Buffer {
  return Buffer.from(n.toString(16).padStart(64, "0"), "hex");
}

export const txLink = (hash: string) => `https://stellar.expert/explorer/testnet/tx/${hash}`;
export const contractLink = `https://stellar.expert/explorer/testnet/contract/${CONTRACT_ID}`;
