# NOTES

## Design choices
- **One contract, one `Job` struct, explicit state machine** (`Funded → Delivered → Released | Disputed → Resolved`, or `Funded → Refunded`). Every transition checks caller, state, then time, and reverts with a custom error.
- **Native ETH is `token == address(0)`**; same code path for ERC-20 via low-level calls.
- **Pull-payment fallback.** Every payout tries to push; if the push fails (rejecting contract wallet, blacklisted token holder) the amount is credited to `pending[token][account]` and collected with `withdraw(token)`. A broken receiver can never block a job or the fee.
- **Fee rate is snapshotted per job** at creation, so the owner cannot raise it on funded jobs. Hard cap 1,000 bps enforced in the constructor and setter. The fee rounds down and the client side takes the exact remainder, so `net + fee + clientPart == amount` always.
- **Fee only on the provider's part** in `resolve`. Time boundaries do not overlap: deliver at or before the deadline, refund strictly after; dispute at or before `reviewEnd`, claim strictly after.
- Client, provider and arbiter must be distinct (nobody judges their own job). Ownership is two-step. Review window is an owner setting (default 3 days, max 30), snapshotted into `reviewEnd` at delivery.

## Risks considered
| Risk | Handling |
|---|---|
| Reentrancy / double payout | `nonReentrant` on every function that moves funds, state set before any external call (checks-effects-interactions); tests attack refund, claim, withdraw and createJob from a receive hook. |
| Receiver rejects ETH / gas griefing | Push with a 100k gas cap via assembly (no return data copied), fall back to `pending`. |
| Fee-on-transfer / rebasing tokens | **Rejected on purpose**: `createJob` compares balance before/after and reverts `UnsupportedToken`. Escrow accounting needs exact amounts. |
| Tokens returning no bool (USDT) | **Supported**: low-level call, success = no revert and (no data or `true`). A token returning `false` counts as failure. |
| Blacklisting tokens (USDC) | Failed push is credited to `pending`; `withdraw` reverts until the holder can receive. |
| Owner abuse | Fee capped at 10%, applies only to new jobs; owner cannot touch job funds or change parties. |
| Overflow / dust | Solidity 0.8 checks; amount capped at `uint96`; fuzz tests on the split math incl. 1 wei. |

## Left out (gaps)
- **Arbiter liveness**: if the arbiter never calls `resolve`, a disputed job stays frozen. Next step: a resolve timeout that auto-refunds or splits 50/50.
- No cancel before delivery, partial milestones, or deadline extensions. Delivery is only a `bytes32` hash; the escrow cannot judge the work itself.
- No pause switch. Rebasing and exotic tokens are unsupported. No external audit.
- Tests are seeded property tests (Hardhat has no native fuzzer); porting to Foundry/Echidna would give deeper coverage. Not deployed to Arbitrum Sepolia yet.

## How an AI agent uses this without a human
1. **Client agent** approves the token (or sends ETH) and calls `createJob(provider, token, amount, deadline, arbiter)`; it reads `jobId` from the `JobCreated` event.
2. **Provider agent** watches `JobCreated` for its address, does the work, uploads it (IPFS etc.) and calls `submitDelivery(jobId, keccak256(uri))`.
3. The client agent checks the deliverable against the hash and calls `approve`, or `dispute` inside the review window. If it says nothing, the provider agent calls `claimAfterReview` after `reviewEnd`. If the provider never delivers, the client agent calls `refund` after the deadline.
4. Both sides run a keeper loop on events/timestamps and call `withdraw(token)` whenever `PayoutCredited` names them. No step needs a human, except the arbiter, who can be a trusted agent or multisig.
