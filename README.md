# midnight-risk-lab

A small, read-only TypeScript CLI that inspects one real borrower position in a
[Morpho Midnight](https://docs.morpho.org/learn/concepts/midnight/) fixed-maturity market.
It is intentionally a terminal application rather than a dashboard: the first version makes the
data provenance and risk math easy to audit.

## What it reads

```text
Morpho API (discovery only)
          │
          ▼
market id + borrower
          │
          ▼
Morpho Midnight SDK + Base RPC (one sampled block)
          │
          ├── market parameters: loan token, maturity, collateral list, LLTV
          ├── position: collateral balances and debt units
          └── each official IOracle.price()
                         │
                         ▼
      LTV + maxDebt + maturity-aware liquidation status
```

By default, the CLI asks Morpho's public REST API for active, listed Base markets and selects the
first real open borrow position. The actual market, position, token metadata, and oracle prices are
then read onchain at the same Base block. No fixture or made-up market data is used by the CLI.

To inspect a specific position, set both `MARKET_ID` and `BORROWER_ADDRESS`.

## Requirements

- Node.js 20 or newer
- pnpm 11 (the repository pins the package-manager version)
- Network access to `api.morpho.org` and a Base RPC endpoint

No private key, mnemonic, or wallet secret is needed. This application is read-only.

## Install and run

```bash
cp .env.example .env
pnpm install
pnpm build
pnpm start
```

For development:

```bash
pnpm dev
pnpm test
pnpm check
```

`BASE_RPC_URL` is optional. When it is empty, viem uses Base's public default RPC. A dedicated RPC
is recommended if the public endpoint is rate-limited.

Example configuration for one position:

```dotenv
BASE_RPC_URL=https://mainnet.base.org
MORPHO_API_URL=https://api.morpho.org
MARKET_ID=0x...
BORROWER_ADDRESS=0x...
```

## Example output

The values change with the selected live position and sampled block:

```text
Market: 0x...
Chain: Base (8453)
Block: 00000000
Borrower: 0x...
Loan asset: USDC (0x...)
Collateral asset: WETH (0x...)
Collateral amount: 2 WETH
Oracle: 0x...
Oracle price: 3000 USDC per WETH (raw: ...)
LLTV: 86%
Debt: 4500 USDC
Collateral value: 6000 USDC
LTV: 75%
Liquidation threshold (weighted): 86%
Maximum healthy debt: 5160 USDC
Health factor: 114.66%
Maturity: 2026-12-31T00:00:00.000Z (...)
Matured at sampled block: no
Liquidation status: HEALTHY
```

## Risk calculation

Midnight can accept several collateral assets in one market. Each collateral has its own oracle and
LLTV. The implementation mirrors the rounding order in `Midnight.isHealthy`:

```text
collateralValue[i] = floor(collateralAmount[i] × oraclePrice[i] / 1e36)
maxDebt[i]         = floor(collateralValue[i] × LLTV[i] / 1e18)
maxDebt            = sum(maxDebt[i])
healthy            = debt <= maxDebt
```

The oracle price is collateral quoted in the market's loan token. It is not necessarily a USD
price. `LTV` is `debt / totalCollateralValue`; the displayed weighted liquidation threshold is
`maxDebt / totalCollateralValue`.

Liquidation status is not hard-coded to a generic lending model:

- Before and exactly at maturity, `debt > maxDebt` is liquidatable through the health-based path.
- Strictly after maturity, any non-zero debt is liquidatable through Midnight's post-maturity path,
  even when `debt <= maxDebt`.
- An unhealthy post-maturity position can satisfy both paths.
- The recovery close factor and liquidation incentive affect liquidation execution and sizing; they
  do not change the yes/no status shown by this monitor.

A missing, reverting, or non-positive oracle result fails the run. The monitor never substitutes a
fake price. This is deliberately stricter than presenting a misleading health value.

Official sources used by the implementation:

- [Morpho Midnight contract](https://github.com/morpho-org/midnight/blob/main/src/Midnight.sol)
- [Official `IMidnight` and `IOracle` interfaces](https://github.com/morpho-org/midnight/tree/main/src/interfaces)
- [Official Midnight SDK](https://github.com/morpho-org/sdks/tree/main/packages/midnight-sdk)
- [Morpho Midnight API guide](https://docs.morpho.org/developers/api/morpho-midnight/)
- [Collateral, health, and liquidations](https://docs.morpho.org/developers/midnight/concepts/collateral-health-liquidations/)

## Variable-rate lending vs fixed-rate / fixed-maturity lending

```text
Variable-rate:
Borrower → pool → floating borrow rate → open-ended debt

Fixed maturity:
Borrower → fixed-term market → fixed borrowing terms → maturity → repayment/refinancing
```

### Variable-rate lending

In a typical Aave market or Morpho Blue market, the borrow rate changes over time. It is generally a
function of market utilization and an interest-rate model: when available liquidity becomes scarce,
the rate tends to rise; when liquidity is abundant, it tends to fall. Debt is open-ended as long as
the borrower remains sufficiently collateralized and keeps paying the changing interest cost.

### Fixed-rate and fixed-maturity lending

Midnight models lending and borrowing as trading units with a fixed payoff at a known maturity.
The price paid or received when the trade is matched determines the borrowing cost for that term.
For example, receiving less than one loan token today in exchange for owing one debt unit at
maturity locks in the discount—and therefore the implied fixed rate—at execution. The protocol does
not continuously reset that rate from pool utilization.

Maturity is the date when debt is due and lenders expect repayment liquidity. Before maturity, a
borrower's liquidation status is primarily collateral-health driven: debt above the LLTV-adjusted
collateral capacity is liquidatable. Strictly after maturity, unpaid debt can be liquidated even if
the collateral still covers it. Midnight's post-maturity liquidation incentive ramps from 1.0 to
the collateral's maximum liquidation incentive over 60 minutes, and that path does not use the
pre-maturity recovery close factor cap.

This creates risks that look different from an ordinary open-ended pool:

- **Liquidity and refinancing risk:** a borrower may be solvent but unable to source the loan token
  at maturity, or may only be able to refinance into an expensive/illiquid later maturity. A lender
  may depend on borrower repayment or liquidation before all credit becomes withdrawable.
- **Liquidation risk:** collateral price declines can make a position unhealthy before maturity;
  after maturity, failure to repay is independently sufficient for liquidation.
- **Oracle risk:** every active collateral's oracle is part of the health calculation. A wrong,
  stale, zero, or reverting price can distort risk assessment or affect protocol liveness.
- **Term concentration:** debt is concentrated at explicit dates instead of rolling indefinitely.
  Supply and demand can fragment across maturities, producing thinner books and rollover cliffs.
- **Rate trade-off:** the borrower removes floating-rate uncertainty for the chosen term, but takes
  on a hard repayment/refinancing deadline. The lender knows the agreed term economics, but bears
  default, delayed repayment liquidity, collateral, and oracle risk until settlement.

That deadline-driven risk structure is why a Midnight position cannot be assessed with only the
usual Aave/Morpho Blue LTV check. A correct monitor must evaluate both collateral health and the
market's exact maturity.

## Project structure

```text
midnight-risk-lab/
├── src/
│   ├── index.ts       # CLI and readable terminal output
│   ├── market.ts      # API discovery and same-block onchain reads
│   ├── risk.ts        # protocol-aligned risk math
│   ├── risk.test.ts   # core unit tests
│   └── types.ts
├── .env.example
├── package.json
├── pnpm-lock.yaml
└── tsconfig.json
```

## Current limitations

- The CLI reports one borrower at a time; it is not yet a full-market scanner or daemon.
- Morpho's REST API is used only to discover an active market and borrower. The API is currently
  versioned `v0`, so discovery response changes may require a small adapter update.
- Token metadata calls assume ERC-20 `symbol()` and `decimals()` compatibility.
- The monitor reports whether liquidation is allowed by health/maturity rules. It does not simulate
  a liquidator transaction, gate authorization, recovery-close-factor sizing, slippage, gas, or
  realized bad debt.
- Public Base RPC endpoints may rate-limit requests; set `BASE_RPC_URL` to a reliable provider for
  production monitoring.
