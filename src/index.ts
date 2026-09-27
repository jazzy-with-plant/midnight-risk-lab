import "dotenv/config";
import { formatUnits } from "viem";
import { loadMarketSnapshot, readConfig } from "./market.js";
import { calculatePositionRisk, WAD } from "./risk.js";

function formatPercent(value: bigint | null): string {
  if (value === null) return "n/a";
  return `${Number(value * 10_000n / WAD) / 100}%`;
}

function formatOraclePrice(
  price: bigint,
  collateralDecimals: number,
  loanDecimals: number,
): string {
  const decimals = 36 + loanDecimals - collateralDecimals;
  return decimals >= 0
    ? formatUnits(price, decimals)
    : (price * 10n ** BigInt(-decimals)).toString();
}

function formatTimestamp(timestamp: bigint): string {
  return new Date(Number(timestamp) * 1_000).toISOString();
}

async function main(): Promise<void> {
  const config = readConfig();
  const snapshot = await loadMarketSnapshot(config);
  const risk = calculatePositionRisk({
    debt: snapshot.debt,
    maturity: snapshot.maturity,
    timestamp: snapshot.blockTimestamp,
    collaterals: snapshot.collaterals,
  });

  console.log(`Market: ${snapshot.marketId}`);
  console.log(`Chain: Base (${8453})`);
  console.log(`Block: ${snapshot.blockNumber}`);
  console.log(`Borrower: ${snapshot.borrower}`);
  console.log(
    `Loan asset: ${snapshot.loanToken.symbol} (${snapshot.loanToken.address})`,
  );

  for (const [index, collateral] of risk.collaterals.entries()) {
    const metadata = snapshot.collaterals[index]?.metadata;
    if (!metadata || collateral.oraclePrice === null) continue;
    console.log(`Collateral asset: ${metadata.symbol} (${metadata.address})`);
    console.log(
      `Collateral amount: ${formatUnits(collateral.amount, metadata.decimals)} ${metadata.symbol}`,
    );
    console.log(`Oracle: ${collateral.oracle}`);
    console.log(
      `Oracle price: ${formatOraclePrice(
        collateral.oraclePrice,
        metadata.decimals,
        snapshot.loanToken.decimals,
      )} ${snapshot.loanToken.symbol} per ${metadata.symbol} (raw: ${collateral.oraclePrice})`,
    );
    console.log(`LLTV: ${formatPercent(collateral.lltv)}`);
  }

  console.log(
    `Debt: ${formatUnits(snapshot.debt, snapshot.loanToken.decimals)} ${snapshot.loanToken.symbol}`,
  );
  console.log(
    `Collateral value: ${formatUnits(risk.totalCollateralValue, snapshot.loanToken.decimals)} ${snapshot.loanToken.symbol}`,
  );
  console.log(`LTV: ${formatPercent(risk.ltvWad)}`);
  console.log(
    `Liquidation threshold (weighted): ${formatPercent(risk.weightedLiquidationThresholdWad)}`,
  );
  console.log(
    `Maximum healthy debt: ${formatUnits(risk.maxDebt, snapshot.loanToken.decimals)} ${snapshot.loanToken.symbol}`,
  );
  console.log(`Health factor: ${formatPercent(risk.healthFactorWad)}`);
  console.log(`Maturity: ${formatTimestamp(snapshot.maturity)} (${snapshot.maturity})`);
  console.log(`Matured at sampled block: ${risk.matured ? "yes" : "no"}`);
  console.log(`Liquidation status: ${risk.status}`);
  console.log(
    "Data source: Morpho public API for discovery; Morpho Midnight SDK + Base RPC for same-block market, position, token, and oracle reads.",
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`midnight-risk-lab failed: ${message}`);
  if (error instanceof Error && error.cause instanceof Error) {
    console.error(`cause: ${error.cause.message}`);
  }
  process.exitCode = 1;
});
