import type { Address, Hash } from "viem";

export interface ApiMarket {
  readonly chain_id: number;
  readonly market_id: Hash;
  readonly total_units: string;
}

export interface ApiPosition {
  readonly market_id: Hash;
  readonly user_address: Address;
  readonly debt: string;
  readonly collaterals: readonly {
    readonly token: Address;
    readonly amount: string;
  }[];
}

export interface ApiListResponse<T> {
  readonly cursor: string | null;
  readonly data: readonly T[];
}

export interface TokenMetadata {
  readonly address: Address;
  readonly symbol: string;
  readonly decimals: number;
}

export interface CollateralRiskInput {
  readonly token: Address;
  readonly amount: bigint;
  readonly oracle: Address;
  readonly oraclePrice: bigint | null;
  readonly lltv: bigint;
  readonly liquidationCursor: bigint;
}

export interface PositionRiskInput {
  readonly debt: bigint;
  readonly maturity: bigint;
  readonly timestamp: bigint;
  readonly collaterals: readonly CollateralRiskInput[];
}

export type LiquidationStatus =
  | "NO_DEBT"
  | "HEALTHY"
  | "LIQUIDATABLE_UNHEALTHY"
  | "LIQUIDATABLE_POST_MATURITY"
  | "LIQUIDATABLE_HEALTH_OR_MATURITY";

export interface CollateralRisk extends CollateralRiskInput {
  readonly valueInLoanToken: bigint;
  readonly maxDebtContribution: bigint;
}

export interface PositionRisk {
  readonly totalCollateralValue: bigint;
  readonly maxDebt: bigint;
  readonly ltvWad: bigint | null;
  readonly weightedLiquidationThresholdWad: bigint | null;
  readonly healthFactorWad: bigint | null;
  readonly healthyByCollateral: boolean;
  readonly matured: boolean;
  readonly liquidatable: boolean;
  readonly status: LiquidationStatus;
  readonly collaterals: readonly CollateralRisk[];
}

export interface MarketSnapshot {
  readonly marketId: Hash;
  readonly borrower: Address;
  readonly blockNumber: bigint;
  readonly blockTimestamp: bigint;
  readonly loanToken: TokenMetadata;
  readonly debt: bigint;
  readonly maturity: bigint;
  readonly collaterals: readonly (CollateralRiskInput & {
    readonly metadata: TokenMetadata;
  })[];
}
