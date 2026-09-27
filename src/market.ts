import {
  fetchAccrualPosition,
  type AccrualPosition,
} from "@morpho-org/midnight-sdk";
import {
  createPublicClient,
  erc20Abi,
  getAddress,
  http,
  isAddress,
  isHash,
  parseAbi,
  type Address,
  type Client,
  type Hash,
} from "viem";
import { base } from "viem/chains";
import type {
  ApiListResponse,
  ApiMarket,
  ApiPosition,
  MarketSnapshot,
  TokenMetadata,
} from "./types.js";

const DEFAULT_API_URL = "https://api.morpho.org";

// Exact official IMorpho oracle interface:
// morpho-org/midnight/src/interfaces/IOracle.sol
const oracleAbi = parseAbi(["function price() view returns (uint256)"]);

export interface DataConfig {
  readonly apiUrl: string;
  readonly rpcUrl?: string;
  readonly marketId?: Hash;
  readonly borrower?: Address;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): DataConfig {
  const marketId = env.MARKET_ID?.trim();
  const borrower = env.BORROWER_ADDRESS?.trim();

  if ((marketId && !borrower) || (!marketId && borrower)) {
    throw new Error("MARKET_ID and BORROWER_ADDRESS must be set together");
  }
  if (marketId && !isHash(marketId)) throw new Error("MARKET_ID must be a 32-byte hash");
  if (borrower && !isAddress(borrower)) throw new Error("BORROWER_ADDRESS is invalid");

  return {
    apiUrl: trimTrailingSlash(env.MORPHO_API_URL?.trim() || DEFAULT_API_URL),
    ...(env.BASE_RPC_URL?.trim() ? { rpcUrl: env.BASE_RPC_URL.trim() } : {}),
    ...(marketId ? { marketId: marketId as Hash } : {}),
    ...(borrower ? { borrower: getAddress(borrower) } : {}),
  };
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Morpho API request failed (${response.status} ${response.statusText}): ${url}`);
  }
  return (await response.json()) as T;
}

function isUsableMarket(value: unknown): value is ApiMarket {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ApiMarket>;
  return (
    item.chain_id === base.id &&
    typeof item.market_id === "string" &&
    isHash(item.market_id) &&
    typeof item.total_units === "string"
  );
}

function isBorrowPosition(value: unknown): value is ApiPosition {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ApiPosition>;
  return (
    typeof item.market_id === "string" &&
    isHash(item.market_id) &&
    typeof item.user_address === "string" &&
    isAddress(item.user_address) &&
    typeof item.debt === "string" &&
    Array.isArray(item.collaterals)
  );
}

/** Discover a real, active, listed Base market that currently has a borrower. */
export async function discoverBorrowPosition(
  apiUrl: string,
): Promise<{ marketId: Hash; borrower: Address }> {
  const marketsUrl = new URL(`${apiUrl}/v0/midnight/markets`);
  marketsUrl.searchParams.set("chain_ids", String(base.id));
  marketsUrl.searchParams.set("active_only", "true");
  marketsUrl.searchParams.set("listed", "true");

  const response = await fetchJson<ApiListResponse<unknown>>(marketsUrl.toString());
  const markets = response.data
    .filter(isUsableMarket)
    .filter((market) => BigInt(market.total_units) > 0n);

  for (const market of markets) {
    const positionsUrl = new URL(
      `${apiUrl}/v0/midnight/markets/${market.market_id}/positions`,
    );
    positionsUrl.searchParams.set("types", "borrow");
    const positionsResponse = await fetchJson<ApiListResponse<unknown>>(
      positionsUrl.toString(),
    );
    const position = positionsResponse.data.find(
      (candidate) =>
        isBorrowPosition(candidate) &&
        BigInt(candidate.debt) > 0n &&
        candidate.collaterals.some((collateral) => BigInt(collateral.amount) > 0n),
    );
    if (position && isBorrowPosition(position)) {
      return {
        marketId: market.market_id,
        borrower: getAddress(position.user_address),
      };
    }
  }

  throw new Error(
    "No active listed Base Midnight market with an open borrow position was returned by the Morpho API. Set MARKET_ID and BORROWER_ADDRESS explicitly.",
  );
}

function createBasePublicClient(rpcUrl?: string) {
  return createPublicClient({
    chain: base,
    transport: http(rpcUrl),
    batch: { multicall: true },
  });
}

type BasePublicClient = ReturnType<typeof createBasePublicClient>;

async function readTokenMetadata(
  client: BasePublicClient,
  address: Address,
  blockNumber: bigint,
): Promise<TokenMetadata> {
  const [symbol, decimals] = await Promise.all([
    client.readContract({ address, abi: erc20Abi, functionName: "symbol", blockNumber }),
    client.readContract({ address, abi: erc20Abi, functionName: "decimals", blockNumber }),
  ]);
  return { address, symbol, decimals };
}

function getActiveCollateralIndexes(position: AccrualPosition): number[] {
  return position.market.params.collateralParams.flatMap((_, index) =>
    (position.collateral[index] ?? 0n) > 0n ? [index] : [],
  );
}

export async function loadMarketSnapshot(config: DataConfig): Promise<MarketSnapshot> {
  const target =
    config.marketId && config.borrower
      ? { marketId: config.marketId, borrower: config.borrower }
      : await discoverBorrowPosition(config.apiUrl);

  const client = createBasePublicClient(config.rpcUrl);
  const block = await client.getBlock();
  // The SDK accepts viem's generic Client. A Base PublicClient supplies the
  // same runtime actions; the cast only erases Base's extra deposit tx type.
  const position = await fetchAccrualPosition(client as Client, {
    marketId: target.marketId,
    user: target.borrower,
    blockNumber: block.number,
  });

  if (position.market.id.toLowerCase() !== target.marketId.toLowerCase()) {
    throw new Error("Onchain market id does not match the requested market id");
  }

  const loanToken = await readTokenMetadata(
    client,
    position.market.params.loanToken,
    block.number,
  );
  const activeIndexes = getActiveCollateralIndexes(position);
  const collaterals = await Promise.all(
    activeIndexes.map(async (index) => {
      const params = position.market.params.collateralParams[index];
      if (!params) throw new Error(`Missing collateral params at index ${index}`);

      let oraclePrice: bigint;
      try {
        oraclePrice = await client.readContract({
          address: params.oracle,
          abi: oracleAbi,
          functionName: "price",
          blockNumber: block.number,
        });
      } catch (error) {
        throw new Error(
          `Oracle read failed for collateral ${params.token} at ${params.oracle}`,
          { cause: error },
        );
      }

      return {
        token: params.token,
        amount: position.collateral[index] ?? 0n,
        oracle: params.oracle,
        oraclePrice,
        lltv: params.lltv,
        liquidationCursor: params.liquidationCursor,
        metadata: await readTokenMetadata(client, params.token, block.number),
      };
    }),
  );

  return {
    marketId: target.marketId,
    borrower: target.borrower,
    blockNumber: block.number,
    blockTimestamp: block.timestamp,
    loanToken,
    debt: position.debt,
    maturity: position.market.params.maturity,
    collaterals,
  };
}
