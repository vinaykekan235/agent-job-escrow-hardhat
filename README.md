# AgentJobEscrow

One contract that holds a client's payment (native ETH or any ERC-20) until an AI agent (the provider) has
delivered the job. Optional arbiter for disputes, platform fee capped at 10% in code.
Built with **Hardhat** + Solidity 0.8.24 + OpenZeppelin 5. Design, risks and gaps: see [NOTES.md](NOTES.md).

## Setup (one command)

```bash
npm install        # or: npm run setup
```

Needs Node 18+. No `.env` is required to build, test or run locally.

## Functions (one line each)

| Function | Who | What it does |
|---|---|---|
| `createJob(provider, token, amount, deadline, arbiter)` | Anyone (becomes client) | Pulls ETH (`token = 0x0`) or ERC-20 into escrow; job is `Funded`. |
| `submitDelivery(jobId, deliveryHash)` | Provider | Funded and before deadline: stores the work hash, job is `Delivered`, review window starts. |
| `approve(jobId)` | Client | Delivered: pays the provider minus platform fee; job is `Released`. |
| `claimAfterReview(jobId)` | Provider | Delivered and review window over: same payout as `approve`. |
| `refund(jobId)` | Client | Funded and deadline passed: returns the full amount; job is `Refunded`. |
| `dispute(jobId)` | Client or provider | Delivered, inside review window, arbiter set: freezes the job (`Disputed`). |
| `resolve(jobId, providerBps)` | Arbiter | Disputed: splits funds, fee only on the provider's part; job is `Resolved`. |
| `withdraw(token)` | Anyone owed funds | Collects a payout that could not be pushed earlier (e.g. receiver rejected ETH). |
| `setFeeBps` / `setFeeRecipient` / `setReviewWindow` | Owner | Fee (max 10%), fee recipient, review window (default 3 days, max 30). |

## Build and test

```bash
npx hardhat compile            # npm run build
npx hardhat test               # npm test  (unit + property/fuzz + invariant tests)
npx hardhat coverage           # npm run coverage (about 100% lines, 98% branches on AgentJobEscrow.sol)
```

Tests live in `test/`:
- `AgentJobEscrow.test.js`: every function, every allowed path and the main reverts (wrong caller / state / time),
  run for both ETH and an ERC-20; token edge cases (fee-on-transfer, no-bool, returns-false, blacklisting);
  pull-payment fallback; reentrancy attacks.
- `AgentJobEscrow.fuzz.test.js`: seeded randomized property tests of the fee/split math (sum always equals the
  amount, fee never above 10%), and a randomized-sequence **invariant** test (escrow balance of each token always
  equals open jobs + uncollected payouts, checked after every step, plus a final drain to exactly zero).
  Hardhat has no built-in fuzzer, so these use a deterministic seeded PRNG (reproducible by seed).

## Run locally (works with `hardhat node` or anvil)

```bash
npx hardhat node                                        # terminal 1 (or: anvil)
npm run deploy:local                                    # terminal 2: deploys, writes deployments/localhost.json
npm run job:local                                       # full job: create -> deliver -> approve, prints balances
ASSET=erc20 npm run job:local                           # same flow with a mock ERC-20
```

`job:local` deploys its own escrow unless you set `ESCROW=<address>`.

## Arbitrum Sepolia (optional, not deployed yet)

```bash
cp .env.example .env            # fill PRIVATE_KEY with a THROWAWAY wallet. Never commit .env
npx hardhat run scripts/deploy.js --network arbitrumSepolia
npx hardhat verify --network arbitrumSepolia <address> <owner> <feeBps> <feeRecipient>   # printed by the deploy script
```

Deployed address: **not deployed** (add it here after deploying).

## Time spent and AI tools

- **Time spent: about 3.5 hours** in total, covering contract writing, test cases, scenario testing and bug fixing.
- **AI tool: Claude (Claude Code, Anthropic).** Used for first drafts of the contract, unit/fuzz/invariant tests, scripts and docs, and for scenario testing and bug fixing (including mutation checks to confirm the tests catch real bugs).