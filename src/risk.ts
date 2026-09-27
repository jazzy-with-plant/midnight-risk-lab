import type { PositionRisk, PositionRiskInput } from "./types.js";

export const WAD = 10n ** 18n;
export const ORACLE_PRICE_SCALE = 10n ** 36n;

export class OracleDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OracleDataError";
  }
}

/**
 * Mirrors Midnight.isHealthy exactly: each multiplication is rounded down
 * separately before the collateral contributions are summed.
 *
 * Source: morpho-org/midnight, src/Midnight.sol.
 */
export function calculatePositionRisk(input: PositionRiskInput): PositionRisk {
  if (input.debt < 0n) throw new RangeError("Debt cannot be negative");
  if (input.maturity < 0n || input.timestamp < 0n) {
    throw new RangeError("Timestamps cannot be negative");
  }

  const collaterals = input.collaterals.map((collateral) => {
    if (collateral.amount < 0n) {
      throw new RangeError(`Collateral amount cannot be negative: ${collateral.token}`);
    }
    if (collateral.lltv < 0n || collateral.lltv > WAD) {
      throw new RangeError(`LLTV must be between 0 and 1e18: ${collateral.token}`);
    }
    if (collateral.oraclePrice === null || collateral.oraclePrice <= 0n) {
      throw new OracleDataError(
        `Oracle returned missing or non-positive data for ${collateral.token}`,
      );
    }

    const valueInLoanToken =
      (collateral.amount * collateral.oraclePrice) / ORACLE_PRICE_SCALE;
    const maxDebtContribution = (valueInLoanToken * collateral.lltv) / WAD;

    return { ...collateral, valueInLoanToken, maxDebtContribution };
  });

  const totalCollateralValue = collaterals.reduce(
    (total, collateral) => total + collateral.valueInLoanToken,
    0n,
  );
  const maxDebt = collaterals.reduce(
    (total, collateral) => total + collateral.maxDebtContribution,
    0n,
  );
  const ltvWad =
    totalCollateralValue === 0n ? null : (input.debt * WAD) / totalCollateralValue;
  const weightedLiquidationThresholdWad =
    totalCollateralValue === 0n ? null : (maxDebt * WAD) / totalCollateralValue;
  const healthFactorWad = input.debt === 0n ? null : (maxDebt * WAD) / input.debt;
  const healthyByCollateral = input.debt <= maxDebt;

  // Solidity uses block.timestamp > maturity for the post-maturity path.
  const matured = input.timestamp > input.maturity;
  const liquidatable = input.debt > 0n && (!healthyByCollateral || matured);

  const status = (() => {
    if (input.debt === 0n) return "NO_DEBT" as const;
    if (!healthyByCollateral && matured) return "LIQUIDATABLE_HEALTH_OR_MATURITY" as const;
    if (!healthyByCollateral) return "LIQUIDATABLE_UNHEALTHY" as const;
    if (matured) return "LIQUIDATABLE_POST_MATURITY" as const;
    return "HEALTHY" as const;
  })();

  return {
    totalCollateralValue,
    maxDebt,
    ltvWad,
    weightedLiquidationThresholdWad,
    healthFactorWad,
    healthyByCollateral,
    matured,
    liquidatable,
    status,
    collaterals,
  };
}
