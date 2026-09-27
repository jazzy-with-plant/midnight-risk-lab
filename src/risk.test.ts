import assert from "node:assert/strict";
import test from "node:test";
import type { Address } from "viem";
import {
  calculatePositionRisk,
  OracleDataError,
  ORACLE_PRICE_SCALE,
  WAD,
} from "./risk.js";

const token = "0x0000000000000000000000000000000000000001" as Address;
const oracle = "0x0000000000000000000000000000000000000002" as Address;

function collateral(amount: bigint, price: bigint, lltv = 800_000_000_000_000_000n) {
  return {
    token,
    amount,
    oracle,
    oraclePrice: price,
    lltv,
    liquidationCursor: 300_000_000_000_000_000n,
  } as const;
}

test("calculates LTV using the protocol oracle scale", () => {
  const risk = calculatePositionRisk({
    debt: 1_000n,
    maturity: 2_000n,
    timestamp: 1_000n,
    collaterals: [collateral(2_000n, ORACLE_PRICE_SCALE)],
  });

  assert.equal(risk.totalCollateralValue, 2_000n);
  assert.equal(risk.ltvWad, 500_000_000_000_000_000n);
  assert.equal(risk.maxDebt, 1_600n);
  assert.equal(risk.weightedLiquidationThresholdWad, 800_000_000_000_000_000n);
});

test("classifies a healthy pre-maturity position", () => {
  const risk = calculatePositionRisk({
    debt: 1_000n,
    maturity: 2_000n,
    timestamp: 1_000n,
    collaterals: [collateral(2_000n, ORACLE_PRICE_SCALE)],
  });

  assert.equal(risk.healthyByCollateral, true);
  assert.equal(risk.liquidatable, false);
  assert.equal(risk.status, "HEALTHY");
});

test("keeps a near-liquidation position healthy at the exact LLTV boundary", () => {
  const risk = calculatePositionRisk({
    debt: 1_600n,
    maturity: 2_000n,
    timestamp: 1_000n,
    collaterals: [collateral(2_000n, ORACLE_PRICE_SCALE)],
  });

  assert.equal(risk.ltvWad, 800_000_000_000_000_000n);
  assert.equal(risk.healthFactorWad, WAD);
  assert.equal(risk.healthyByCollateral, true);
  assert.equal(risk.liquidatable, false);
});

test("classifies debt above maxDebt as liquidatable before maturity", () => {
  const risk = calculatePositionRisk({
    debt: 1_601n,
    maturity: 2_000n,
    timestamp: 1_000n,
    collaterals: [collateral(2_000n, ORACLE_PRICE_SCALE)],
  });

  assert.equal(risk.healthyByCollateral, false);
  assert.equal(risk.liquidatable, true);
  assert.equal(risk.status, "LIQUIDATABLE_UNHEALTHY");
});

test("classifies healthy collateral with unpaid post-maturity debt as liquidatable", () => {
  const risk = calculatePositionRisk({
    debt: 1_000n,
    maturity: 2_000n,
    timestamp: 2_001n,
    collaterals: [collateral(2_000n, ORACLE_PRICE_SCALE)],
  });

  assert.equal(risk.healthyByCollateral, true);
  assert.equal(risk.matured, true);
  assert.equal(risk.liquidatable, true);
  assert.equal(risk.status, "LIQUIDATABLE_POST_MATURITY");
});

test("rejects missing oracle data", () => {
  assert.throws(
    () =>
      calculatePositionRisk({
        debt: 1n,
        maturity: 2_000n,
        timestamp: 1_000n,
        collaterals: [{ ...collateral(2_000n, ORACLE_PRICE_SCALE), oraclePrice: null }],
      }),
    OracleDataError,
  );
});

test("rejects a zero oracle price", () => {
  assert.throws(
    () =>
      calculatePositionRisk({
        debt: 1n,
        maturity: 2_000n,
        timestamp: 1_000n,
        collaterals: [collateral(2_000n, 0n)],
      }),
    OracleDataError,
  );
});
