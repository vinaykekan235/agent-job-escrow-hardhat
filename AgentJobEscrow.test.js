const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

const ETH = ethers.ZeroAddress;
const DAY = 24 * 60 * 60;
const AMOUNT = ethers.parseEther("1");
const FEE_BPS = 250n; // 2.5%
const HASH = ethers.id("ipfs://deliverable");

// Status enum, mirrors the contract.
const S = { None: 0, Funded: 1, Delivered: 2, Released: 3, Refunded: 4, Disputed: 5, Resolved: 6 };

async function deployFixture() {
  const [owner, feeRecipient, client, provider, arbiter, other] = await ethers.getSigners();

  const escrow = await (await ethers.getContractFactory("AgentJobEscrow")).deploy(owner.address, FEE_BPS, feeRecipient.address);
  const token = await (await ethers.getContractFactory("MockERC20")).deploy();
  const Actor = await ethers.getContractFactory("Actor");
  const actor = await Actor.deploy();

  await token.mint(client.address, ethers.parseEther("1000000"));
  await token.connect(client).approve(escrow, ethers.MaxUint256);

  return { escrow, token, actor, owner, feeRecipient, client, provider, arbiter, other };
}

// Run every lifecycle test once with ETH and once with an ERC-20.
const assets = (f) => [
  { name: "ETH", token: ETH },
  { name: "ERC-20", token: f.token.target },
];

async function bal(f, asset, who) {
  const addr = who.address ?? who.target ?? who;
  return asset.token === ETH ? ethers.provider.getBalance(addr) : f.token.balanceOf(addr);
}

async function createJob(f, asset, o = {}) {
  const amount = o.amount ?? AMOUNT;
  const deadline = o.deadline ?? (await time.latest()) + 7 * DAY;
  const provider = o.provider ?? f.provider.address;
  const arbiter = o.arbiter === undefined ? f.arbiter.address : o.arbiter;
  const id = await f.escrow.nextJobId();
  await f.escrow
    .connect(o.from ?? f.client)
    .createJob(provider, asset.token, amount, deadline, arbiter, { value: asset.token === ETH ? amount : 0 });
  return id;
}

async function deliveredJob(f, asset, o) {
  const id = await createJob(f, asset, o);
  await f.escrow.connect(f.provider).submitDelivery(id, HASH);
  return id;
}

async function disputedJob(f, asset, o) {
  const id = await deliveredJob(f, asset, o);
  await f.escrow.connect(f.client).dispute(id);
  return id;
}

// Balance-change assertion that works for both ETH and ERC-20.
function expectDeltas(f, asset, tx, pairs) {
  const accounts = pairs.map(([a]) => a.address ?? a.target ?? a);
  const deltas = pairs.map(([, d]) => d);
  return asset.token === ETH
    ? expect(tx).to.changeEtherBalances(accounts, deltas)
    : expect(tx).to.changeTokenBalances(f.token, accounts, deltas);
}

describe("AgentJobEscrow", function () {
  // ─────────────────────────── Deployment & owner settings ───────────────────────────
  describe("deployment and settings", () => {
    it("sets initial config", async () => {
      const f = await loadFixture(deployFixture);
      expect(await f.escrow.owner()).to.equal(f.owner.address);
      expect(await f.escrow.feeBps()).to.equal(FEE_BPS);
      expect(await f.escrow.feeRecipient()).to.equal(f.feeRecipient.address);
      expect(await f.escrow.reviewWindow()).to.equal(3 * DAY);
      expect(await f.escrow.MAX_FEE_BPS()).to.equal(1000);
    });

    it("rejects a fee above 10% or a zero recipient in the constructor", async () => {
      const f = await loadFixture(deployFixture);
      const F = await ethers.getContractFactory("AgentJobEscrow");
      await expect(F.deploy(f.owner.address, 1001, f.feeRecipient.address)).to.be.revertedWithCustomError(f.escrow, "FeeTooHigh");
      await expect(F.deploy(f.owner.address, 100, ETH)).to.be.revertedWithCustomError(f.escrow, "ZeroAddress");
    });

    it("owner can set fee up to exactly 10% and not above", async () => {
      const f = await loadFixture(deployFixture);
      await expect(f.escrow.setFeeBps(1000)).to.emit(f.escrow, "FeeBpsUpdated").withArgs(1000);
      await expect(f.escrow.setFeeBps(1001)).to.be.revertedWithCustomError(f.escrow, "FeeTooHigh");
      await expect(f.escrow.setFeeBps(65535)).to.be.revertedWithCustomError(f.escrow, "FeeTooHigh");
    });

    it("owner can set the fee recipient (not zero)", async () => {
      const f = await loadFixture(deployFixture);
      await expect(f.escrow.setFeeRecipient(f.other.address)).to.emit(f.escrow, "FeeRecipientUpdated").withArgs(f.other.address);
      await expect(f.escrow.setFeeRecipient(ETH)).to.be.revertedWithCustomError(f.escrow, "ZeroAddress");
    });

    it("owner can set the review window, capped at 30 days", async () => {
      const f = await loadFixture(deployFixture);
      await expect(f.escrow.setReviewWindow(DAY)).to.emit(f.escrow, "ReviewWindowUpdated").withArgs(DAY);
      await expect(f.escrow.setReviewWindow(31 * DAY)).to.be.revertedWithCustomError(f.escrow, "ReviewWindowTooLong");
    });

    it("non-owners cannot change settings", async () => {
      const f = await loadFixture(deployFixture);
      const e = f.escrow.connect(f.other);
      await expect(e.setFeeBps(1)).to.be.revertedWithCustomError(f.escrow, "OwnableUnauthorizedAccount");
      await expect(e.setFeeRecipient(f.other.address)).to.be.revertedWithCustomError(f.escrow, "OwnableUnauthorizedAccount");
      await expect(e.setReviewWindow(1)).to.be.revertedWithCustomError(f.escrow, "OwnableUnauthorizedAccount");
    });

    it("ownership transfer is two-step", async () => {
      const f = await loadFixture(deployFixture);
      await f.escrow.transferOwnership(f.other.address);
      expect(await f.escrow.owner()).to.equal(f.owner.address);
      await f.escrow.connect(f.other).acceptOwnership();
      expect(await f.escrow.owner()).to.equal(f.other.address);
    });
  });

  // ─────────────────────────── Lifecycle, run for ETH and ERC-20 ───────────────────────────
  for (const kind of ["ETH", "ERC-20"]) {
    describe(`lifecycle with ${kind}`, () => {
      const pick = (f) => assets(f).find((a) => a.name === kind);

      describe("createJob", () => {
        it("pulls funds in, stores the job, emits JobCreated", async () => {
          const f = await loadFixture(deployFixture);
          const a = pick(f);
          const deadline = (await time.latest()) + 7 * DAY;
          const before = await bal(f, a, f.escrow);
          await expect(
            f.escrow.connect(f.client).createJob(f.provider.address, a.token, AMOUNT, deadline, f.arbiter.address, {
              value: a.token === ETH ? AMOUNT : 0,
            })
          )
            .to.emit(f.escrow, "JobCreated")
            .withArgs(1, f.client.address, f.provider.address, a.token, AMOUNT, deadline, f.arbiter.address, FEE_BPS);

          expect((await bal(f, a, f.escrow)) - before).to.equal(AMOUNT);
          const job = await f.escrow.getJob(1);
          expect(job.client).to.equal(f.client.address);
          expect(job.provider).to.equal(f.provider.address);
          expect(job.arbiter).to.equal(f.arbiter.address);
          expect(job.token).to.equal(a.token);
          expect(job.amount).to.equal(AMOUNT);
          expect(job.deadline).to.equal(deadline);
          expect(job.status).to.equal(S.Funded);
          expect(await f.escrow.nextJobId()).to.equal(2);
        });

        it("allows a job without an arbiter", async () => {
          const f = await loadFixture(deployFixture);
          await createJob(f, pick(f), { arbiter: ETH });
          expect((await f.escrow.getJob(1)).arbiter).to.equal(ETH);
        });

        it("reverts on bad inputs", async () => {
          const f = await loadFixture(deployFixture);
          const a = pick(f);
          const dl = (await time.latest()) + DAY;
          const v = (x) => ({ value: a.token === ETH ? x : 0 });
          const c = f.escrow.connect(f.client);
          await expect(c.createJob(ETH, a.token, AMOUNT, dl, f.arbiter.address, v(AMOUNT))).to.be.revertedWithCustomError(f.escrow, "ZeroAddress");
          await expect(c.createJob(f.provider.address, a.token, 0, dl, f.arbiter.address, v(0))).to.be.revertedWithCustomError(f.escrow, "ZeroAmount");
          await expect(c.createJob(f.provider.address, a.token, 2n ** 96n, dl, f.arbiter.address, v(0))).to.be.revertedWithCustomError(f.escrow, "AmountTooLarge");
          await expect(c.createJob(f.provider.address, a.token, AMOUNT, await time.latest(), f.arbiter.address, v(AMOUNT))).to.be.revertedWithCustomError(f.escrow, "InvalidDeadline");
          // client == provider, arbiter == client, arbiter == provider
          await expect(c.createJob(f.client.address, a.token, AMOUNT, dl, f.arbiter.address, v(AMOUNT))).to.be.revertedWithCustomError(f.escrow, "InvalidParties");
          await expect(c.createJob(f.provider.address, a.token, AMOUNT, dl, f.client.address, v(AMOUNT))).to.be.revertedWithCustomError(f.escrow, "InvalidParties");
          await expect(c.createJob(f.provider.address, a.token, AMOUNT, dl, f.provider.address, v(AMOUNT))).to.be.revertedWithCustomError(f.escrow, "InvalidParties");
        });
      });

      describe("submitDelivery", () => {
        it("stores the hash, starts the review window, emits DeliverySubmitted", async () => {
          const f = await loadFixture(deployFixture);
          const id = await createJob(f, pick(f));
          const tx = await f.escrow.connect(f.provider).submitDelivery(id, HASH);
          const ts = BigInt(await time.latest());
          await expect(tx).to.emit(f.escrow, "DeliverySubmitted").withArgs(id, HASH, ts + BigInt(3 * DAY));
          const job = await f.escrow.getJob(id);
          expect(job.status).to.equal(S.Delivered);
          expect(job.deliveryHash).to.equal(HASH);
          expect(job.reviewEnd).to.equal(ts + BigInt(3 * DAY));
        });

        it("is still allowed exactly at the deadline", async () => {
          const f = await loadFixture(deployFixture);
          const dl = (await time.latest()) + DAY;
          const id = await createJob(f, pick(f), { deadline: dl });
          await time.setNextBlockTimestamp(dl);
          await f.escrow.connect(f.provider).submitDelivery(id, HASH);
        });

        it("reverts: wrong caller, wrong state, after deadline, unknown job", async () => {
          const f = await loadFixture(deployFixture);
          const dl = (await time.latest()) + DAY;
          const id = await createJob(f, pick(f), { deadline: dl });
          await expect(f.escrow.connect(f.client).submitDelivery(id, HASH)).to.be.revertedWithCustomError(f.escrow, "NotProvider");
          await expect(f.escrow.connect(f.other).submitDelivery(id, HASH)).to.be.revertedWithCustomError(f.escrow, "NotProvider");
          await expect(f.escrow.connect(f.provider).submitDelivery(99, HASH)).to.be.revertedWithCustomError(f.escrow, "JobNotFound").withArgs(99);

          await time.increaseTo(dl + 1);
          await expect(f.escrow.connect(f.provider).submitDelivery(id, HASH)).to.be.revertedWithCustomError(f.escrow, "DeadlinePassed");

          const id2 = await deliveredJob(f, pick(f));
          await expect(f.escrow.connect(f.provider).submitDelivery(id2, HASH))
            .to.be.revertedWithCustomError(f.escrow, "WrongState")
            .withArgs(S.Delivered);
        });
      });

      describe("approve", () => {
        it("pays the provider minus fee, the fee to the recipient, emits JobReleased", async () => {
          const f = await loadFixture(deployFixture);
          const a = pick(f);
          const id = await deliveredJob(f, a);
          const fee = (AMOUNT * FEE_BPS) / 10000n;
          const tx = f.escrow.connect(f.client).approve(id);
          await expectDeltas(f, a, tx, [[f.provider, AMOUNT - fee], [f.feeRecipient, fee], [f.escrow, -AMOUNT]]);
          await expect(tx).to.emit(f.escrow, "JobReleased").withArgs(id, AMOUNT - fee, fee, false);
          expect((await f.escrow.getJob(id)).status).to.equal(S.Released);
        });

        it("reverts: wrong caller, not delivered, already released", async () => {
          const f = await loadFixture(deployFixture);
          const a = pick(f);
          const funded = await createJob(f, a);
          await expect(f.escrow.connect(f.client).approve(funded)).to.be.revertedWithCustomError(f.escrow, "WrongState").withArgs(S.Funded);

          const id = await deliveredJob(f, a);
          for (const s of [f.provider, f.arbiter, f.other]) {
            await expect(f.escrow.connect(s).approve(id)).to.be.revertedWithCustomError(f.escrow, "NotClient");
          }
          await f.escrow.connect(f.client).approve(id);
          await expect(f.escrow.connect(f.client).approve(id)).to.be.revertedWithCustomError(f.escrow, "WrongState").withArgs(S.Released);
        });

        it("still works after the review window if the provider has not claimed", async () => {
          const f = await loadFixture(deployFixture);
          const id = await deliveredJob(f, pick(f));
          await time.increase(10 * DAY);
          await f.escrow.connect(f.client).approve(id);
        });

        it("pays nothing as fee when the fee is zero", async () => {
          const f = await loadFixture(deployFixture);
          const a = pick(f);
          await f.escrow.setFeeBps(0);
          const id = await deliveredJob(f, a);
          const tx = f.escrow.connect(f.client).approve(id);
          await expectDeltas(f, a, tx, [[f.provider, AMOUNT], [f.feeRecipient, 0n]]);
        });

        it("uses the fee that was set when the job was created", async () => {
          const f = await loadFixture(deployFixture);
          const a = pick(f);
          const id = await deliveredJob(f, a);
          await f.escrow.setFeeBps(1000); // owner raises the fee after funding
          const fee = (AMOUNT * FEE_BPS) / 10000n;
          await expectDeltas(f, a, f.escrow.connect(f.client).approve(id), [[f.provider, AMOUNT - fee], [f.feeRecipient, fee]]);
        });
      });

      describe("claimAfterReview", () => {
        it("pays the provider once the review window is over, emits JobReleased", async () => {
          const f = await loadFixture(deployFixture);
          const a = pick(f);
          const id = await deliveredJob(f, a);
          await time.increase(3 * DAY + 1);
          const fee = (AMOUNT * FEE_BPS) / 10000n;
          const tx = f.escrow.connect(f.provider).claimAfterReview(id);
          await expectDeltas(f, a, tx, [[f.provider, AMOUNT - fee], [f.feeRecipient, fee]]);
          await expect(tx).to.emit(f.escrow, "JobReleased").withArgs(id, AMOUNT - fee, fee, true);
          expect((await f.escrow.getJob(id)).status).to.equal(S.Released);
        });

        it("reverts while the window is open (including the last second)", async () => {
          const f = await loadFixture(deployFixture);
          const id = await deliveredJob(f, pick(f));
          const end = (await f.escrow.getJob(id)).reviewEnd;
          await expect(f.escrow.connect(f.provider).claimAfterReview(id)).to.be.revertedWithCustomError(f.escrow, "ReviewWindowOpen");
          await time.setNextBlockTimestamp(end);
          await expect(f.escrow.connect(f.provider).claimAfterReview(id)).to.be.revertedWithCustomError(f.escrow, "ReviewWindowOpen");
        });

        it("reverts: wrong caller, wrong state, double claim", async () => {
          const f = await loadFixture(deployFixture);
          const a = pick(f);
          const funded = await createJob(f, a);
          await expect(f.escrow.connect(f.provider).claimAfterReview(funded)).to.be.revertedWithCustomError(f.escrow, "WrongState").withArgs(S.Funded);

          const id = await deliveredJob(f, a);
          await time.increase(4 * DAY);
          await expect(f.escrow.connect(f.client).claimAfterReview(id)).to.be.revertedWithCustomError(f.escrow, "NotProvider");
          await f.escrow.connect(f.provider).claimAfterReview(id);
          await expect(f.escrow.connect(f.provider).claimAfterReview(id)).to.be.revertedWithCustomError(f.escrow, "WrongState").withArgs(S.Released);
        });

        it("a disputed job cannot be claimed", async () => {
          const f = await loadFixture(deployFixture);
          const id = await disputedJob(f, pick(f));
          await time.increase(10 * DAY);
          await expect(f.escrow.connect(f.provider).claimAfterReview(id)).to.be.revertedWithCustomError(f.escrow, "WrongState").withArgs(S.Disputed);
        });
      });

      describe("refund", () => {
        it("returns the full amount after the deadline, emits JobRefunded", async () => {
          const f = await loadFixture(deployFixture);
          const a = pick(f);
          const dl = (await time.latest()) + DAY;
          const id = await createJob(f, a, { deadline: dl });
          await time.increaseTo(dl + 1);
          const tx = f.escrow.connect(f.client).refund(id);
          await expectDeltas(f, a, tx, [[f.client, AMOUNT], [f.escrow, -AMOUNT], [f.feeRecipient, 0n]]);
          await expect(tx).to.emit(f.escrow, "JobRefunded").withArgs(id, AMOUNT);
          expect((await f.escrow.getJob(id)).status).to.equal(S.Refunded);
        });

        it("reverts: before or at the deadline, wrong caller, wrong state, twice", async () => {
          const f = await loadFixture(deployFixture);
          const a = pick(f);
          const dl = (await time.latest()) + DAY;
          const id = await createJob(f, a, { deadline: dl });
          await expect(f.escrow.connect(f.client).refund(id)).to.be.revertedWithCustomError(f.escrow, "DeadlineNotPassed");
          await time.setNextBlockTimestamp(dl);
          await expect(f.escrow.connect(f.client).refund(id)).to.be.revertedWithCustomError(f.escrow, "DeadlineNotPassed");

          await time.increaseTo(dl + 1);
          await expect(f.escrow.connect(f.provider).refund(id)).to.be.revertedWithCustomError(f.escrow, "NotClient");
          await f.escrow.connect(f.client).refund(id);
          await expect(f.escrow.connect(f.client).refund(id)).to.be.revertedWithCustomError(f.escrow, "WrongState").withArgs(S.Refunded);

          const delivered = await deliveredJob(f, a);
          await time.increase(30 * DAY);
          await expect(f.escrow.connect(f.client).refund(delivered)).to.be.revertedWithCustomError(f.escrow, "WrongState").withArgs(S.Delivered);
        });
      });

      describe("dispute", () => {
        it("lets the client freeze a delivered job", async () => {
          const f = await loadFixture(deployFixture);
          const id = await deliveredJob(f, pick(f));
          await expect(f.escrow.connect(f.client).dispute(id)).to.emit(f.escrow, "JobDisputed").withArgs(id, f.client.address);
          expect((await f.escrow.getJob(id)).status).to.equal(S.Disputed);
        });

        it("lets the provider freeze a delivered job", async () => {
          const f = await loadFixture(deployFixture);
          const id = await deliveredJob(f, pick(f));
          await expect(f.escrow.connect(f.provider).dispute(id)).to.emit(f.escrow, "JobDisputed").withArgs(id, f.provider.address);
        });

        it("freezes approve", async () => {
          const f = await loadFixture(deployFixture);
          const id = await disputedJob(f, pick(f));
          await expect(f.escrow.connect(f.client).approve(id)).to.be.revertedWithCustomError(f.escrow, "WrongState").withArgs(S.Disputed);
        });

        it("reverts: no arbiter, outsider, wrong state, after the window", async () => {
          const f = await loadFixture(deployFixture);
          const a = pick(f);
          const noArb = await deliveredJob(f, a, { arbiter: ETH });
          await expect(f.escrow.connect(f.client).dispute(noArb)).to.be.revertedWithCustomError(f.escrow, "NoArbiter");

          const funded = await createJob(f, a);
          await expect(f.escrow.connect(f.client).dispute(funded)).to.be.revertedWithCustomError(f.escrow, "WrongState").withArgs(S.Funded);

          const id = await deliveredJob(f, a);
          await expect(f.escrow.connect(f.other).dispute(id)).to.be.revertedWithCustomError(f.escrow, "NotParty");
          await expect(f.escrow.connect(f.arbiter).dispute(id)).to.be.revertedWithCustomError(f.escrow, "NotParty");

          const end = (await f.escrow.getJob(id)).reviewEnd;
          await time.setNextBlockTimestamp(end); // last second is still inside the window
          await f.escrow.connect(f.client).dispute(id);

          const late = await deliveredJob(f, a);
          await time.increase(3 * DAY + 1);
          await expect(f.escrow.connect(f.client).dispute(late)).to.be.revertedWithCustomError(f.escrow, "ReviewWindowClosed");
        });
      });

      describe("resolve", () => {
        it("splits 70/30, charging the fee only on the provider's part", async () => {
          const f = await loadFixture(deployFixture);
          const a = pick(f);
          const id = await disputedJob(f, a);
          const providerPart = (AMOUNT * 7000n) / 10000n;
          const fee = (providerPart * FEE_BPS) / 10000n;
          const clientPart = AMOUNT - providerPart;
          const tx = f.escrow.connect(f.arbiter).resolve(id, 7000);
          await expectDeltas(f, a, tx, [[f.provider, providerPart - fee], [f.feeRecipient, fee], [f.client, clientPart], [f.escrow, -AMOUNT]]);
          await expect(tx).to.emit(f.escrow, "JobResolved").withArgs(id, 7000, providerPart - fee, fee, clientPart);
          expect((await f.escrow.getJob(id)).status).to.equal(S.Resolved);
        });

        it("0 bps refunds the client fully, no fee", async () => {
          const f = await loadFixture(deployFixture);
          const a = pick(f);
          const id = await disputedJob(f, a);
          await expectDeltas(f, a, f.escrow.connect(f.arbiter).resolve(id, 0), [[f.client, AMOUNT], [f.provider, 0n], [f.feeRecipient, 0n]]);
        });

        it("10000 bps pays the provider like an approval", async () => {
          const f = await loadFixture(deployFixture);
          const a = pick(f);
          const id = await disputedJob(f, a);
          const fee = (AMOUNT * FEE_BPS) / 10000n;
          await expectDeltas(f, a, f.escrow.connect(f.arbiter).resolve(id, 10000), [[f.provider, AMOUNT - fee], [f.feeRecipient, fee], [f.client, 0n]]);
        });

        it("reverts: wrong caller, wrong state, bps > 10000, twice", async () => {
          const f = await loadFixture(deployFixture);
          const a = pick(f);
          const delivered = await deliveredJob(f, a);
          await expect(f.escrow.connect(f.arbiter).resolve(delivered, 5000)).to.be.revertedWithCustomError(f.escrow, "WrongState").withArgs(S.Delivered);

          const id = await disputedJob(f, a);
          for (const s of [f.client, f.provider, f.other, f.owner]) {
            await expect(f.escrow.connect(s).resolve(id, 5000)).to.be.revertedWithCustomError(f.escrow, "NotArbiter");
          }
          await expect(f.escrow.connect(f.arbiter).resolve(id, 10001)).to.be.revertedWithCustomError(f.escrow, "InvalidBps");
          await f.escrow.connect(f.arbiter).resolve(id, 5000);
          await expect(f.escrow.connect(f.arbiter).resolve(id, 5000)).to.be.revertedWithCustomError(f.escrow, "WrongState").withArgs(S.Resolved);
        });
      });
    });
  }

  // ─────────────────────────── Unknown jobs ───────────────────────────
  it("every job function reverts with JobNotFound for an unknown id", async () => {
    const f = await loadFixture(deployFixture);
    const e = f.escrow;
    await expect(e.getJob(1)).to.be.revertedWithCustomError(e, "JobNotFound");
    await expect(e.approve(1)).to.be.revertedWithCustomError(e, "JobNotFound");
    await expect(e.claimAfterReview(1)).to.be.revertedWithCustomError(e, "JobNotFound");
    await expect(e.refund(1)).to.be.revertedWithCustomError(e, "JobNotFound");
    await expect(e.dispute(1)).to.be.revertedWithCustomError(e, "JobNotFound");
    await expect(e.resolve(1, 0)).to.be.revertedWithCustomError(e, "JobNotFound");
  });

  // ─────────────────────────── Token edge cases ───────────────────────────
  describe("token handling", () => {
    it("ETH: wrong msg.value reverts", async () => {
      const f = await loadFixture(deployFixture);
      const dl = (await time.latest()) + DAY;
      const c = f.escrow.connect(f.client);
      await expect(c.createJob(f.provider.address, ETH, AMOUNT, dl, ETH, { value: AMOUNT - 1n })).to.be.revertedWithCustomError(f.escrow, "WrongEthValue");
      await expect(c.createJob(f.provider.address, ETH, AMOUNT, dl, ETH, { value: AMOUNT + 1n })).to.be.revertedWithCustomError(f.escrow, "WrongEthValue");
      await expect(c.createJob(f.provider.address, ETH, AMOUNT, dl, ETH)).to.be.revertedWithCustomError(f.escrow, "WrongEthValue");
    });

    it("ERC-20: ETH sent along reverts", async () => {
      const f = await loadFixture(deployFixture);
      const dl = (await time.latest()) + DAY;
      await expect(
        f.escrow.connect(f.client).createJob(f.provider.address, f.token.target, AMOUNT, dl, ETH, { value: 1 })
      ).to.be.revertedWithCustomError(f.escrow, "UnexpectedEth");
    });

    it("ERC-20: a non-contract 'token' reverts", async () => {
      const f = await loadFixture(deployFixture);
      const dl = (await time.latest()) + DAY;
      await expect(
        f.escrow.connect(f.client).createJob(f.provider.address, f.other.address, AMOUNT, dl, ETH)
      ).to.be.revertedWithCustomError(f.escrow, "NotAContract");
    });

    it("ERC-20: missing allowance or balance reverts with TokenTransferFailed", async () => {
      const f = await loadFixture(deployFixture);
      const dl = (await time.latest()) + DAY;
      await expect(
        f.escrow.connect(f.other).createJob(f.provider.address, f.token.target, AMOUNT, dl, ETH)
      ).to.be.revertedWithCustomError(f.escrow, "TokenTransferFailed");
    });

    it("rejects fee-on-transfer tokens on purpose", async () => {
      const f = await loadFixture(deployFixture);
      const taxed = await (await ethers.getContractFactory("FeeOnTransferToken")).deploy();
      await taxed.mint(f.client.address, AMOUNT);
      await taxed.connect(f.client).approve(f.escrow, AMOUNT);
      const dl = (await time.latest()) + DAY;
      await expect(
        f.escrow.connect(f.client).createJob(f.provider.address, taxed.target, AMOUNT, dl, ETH)
      ).to.be.revertedWithCustomError(f.escrow, "UnsupportedToken");
      expect(await f.escrow.nextJobId()).to.equal(1); // whole tx reverted, no job left behind
    });

    it("supports tokens that return no bool (USDT-style) through the full flow", async () => {
      const f = await loadFixture(deployFixture);
      const usdt = await (await ethers.getContractFactory("NoBoolToken")).deploy();
      await usdt.mint(f.client.address, AMOUNT);
      await usdt.connect(f.client).approve(f.escrow, AMOUNT);
      const dl = (await time.latest()) + DAY;
      await f.escrow.connect(f.client).createJob(f.provider.address, usdt.target, AMOUNT, dl, ETH);
      await f.escrow.connect(f.provider).submitDelivery(1, HASH);
      await f.escrow.connect(f.client).approve(1);
      const fee = (AMOUNT * FEE_BPS) / 10000n;
      expect(await usdt.balanceOf(f.provider.address)).to.equal(AMOUNT - fee);
      expect(await usdt.balanceOf(f.feeRecipient.address)).to.equal(fee);
      expect(await usdt.balanceOf(f.escrow.target)).to.equal(0);
    });

    it("treats a token that returns false as a failed transfer", async () => {
      const f = await loadFixture(deployFixture);
      const bad = await (await ethers.getContractFactory("FalseReturnToken")).deploy();
      await bad.mint(f.client.address, AMOUNT);
      await bad.connect(f.client).approve(f.escrow, AMOUNT);
      const dl = (await time.latest()) + DAY;

      await bad.setFail(true);
      await expect(
        f.escrow.connect(f.client).createJob(f.provider.address, bad.target, AMOUNT, dl, ETH)
      ).to.be.revertedWithCustomError(f.escrow, "TokenTransferFailed");

      // A failing payout is credited instead of reverting, and can be withdrawn once the token works again.
      await bad.setFail(false);
      await f.escrow.connect(f.client).createJob(f.provider.address, bad.target, AMOUNT, dl, ETH);
      await f.escrow.connect(f.provider).submitDelivery(1, HASH);
      await bad.setFail(true);
      await f.escrow.connect(f.client).approve(1);
      const fee = (AMOUNT * FEE_BPS) / 10000n;
      expect(await f.escrow.pending(bad.target, f.provider.address)).to.equal(AMOUNT - fee);
      await expect(f.escrow.connect(f.provider).withdraw(bad.target)).to.be.revertedWithCustomError(f.escrow, "TokenTransferFailed");
      await bad.setFail(false);
      await f.escrow.connect(f.provider).withdraw(bad.target);
      expect(await bad.balanceOf(f.provider.address)).to.equal(AMOUNT - fee);
    });
  });

  // ─────────────────────────── Pull-payment fallback ───────────────────────────
  describe("failed payouts can be collected later", () => {
    async function callAs(actor, escrow, fn, args, value = 0n) {
      return actor.exec(escrow.target, value, escrow.interface.encodeFunctionData(fn, args));
    }

    it("ETH: provider that rejects ETH is credited, approve still succeeds, withdraw works once it accepts", async () => {
      const f = await loadFixture(deployFixture);
      await f.actor.setAcceptEth(false);
      const dl = (await time.latest()) + 7 * DAY;
      await f.escrow.connect(f.client).createJob(f.actor.target, ETH, AMOUNT, dl, f.arbiter.address, { value: AMOUNT });
      await callAs(f.actor, f.escrow, "submitDelivery", [1, HASH]);
      const fee = (AMOUNT * FEE_BPS) / 10000n;

      const tx = f.escrow.connect(f.client).approve(1);
      await expect(tx).to.emit(f.escrow, "PayoutCredited").withArgs(ETH, f.actor.target, AMOUNT - fee);
      await expect(tx).to.changeEtherBalance(f.feeRecipient, fee); // fee still delivered
      expect((await f.escrow.getJob(1)).status).to.equal(S.Released);
      expect(await f.escrow.pending(ETH, f.actor.target)).to.equal(AMOUNT - fee);

      // still rejecting: withdraw reverts and keeps the credit
      await expect(callAs(f.actor, f.escrow, "withdraw", [ETH])).to.be.revertedWithCustomError(f.escrow, "WithdrawFailed");
      expect(await f.escrow.pending(ETH, f.actor.target)).to.equal(AMOUNT - fee);

      await f.actor.setAcceptEth(true);
      await expect(callAs(f.actor, f.escrow, "withdraw", [ETH]))
        .to.emit(f.escrow, "Withdrawn")
        .withArgs(ETH, f.actor.target, AMOUNT - fee);
      expect(await ethers.provider.getBalance(f.actor.target)).to.equal(AMOUNT - fee);
      expect(await f.escrow.pending(ETH, f.actor.target)).to.equal(0);
      expect(await ethers.provider.getBalance(f.escrow.target)).to.equal(0);
    });

    it("ETH: client that rejects ETH still gets its refund credited", async () => {
      const f = await loadFixture(deployFixture);
      await f.actor.setAcceptEth(false);
      const dl = (await time.latest()) + DAY;
      await f.actor.exec(
        f.escrow.target,
        AMOUNT,
        f.escrow.interface.encodeFunctionData("createJob", [f.provider.address, ETH, AMOUNT, dl, ETH]),
        { value: AMOUNT }
      );
      await time.increaseTo(dl + 1);
      await callAs(f.actor, f.escrow, "refund", [1]);
      expect((await f.escrow.getJob(1)).status).to.equal(S.Refunded);
      expect(await f.escrow.pending(ETH, f.actor.target)).to.equal(AMOUNT);
      await f.actor.setAcceptEth(true);
      await callAs(f.actor, f.escrow, "withdraw", [ETH]);
      expect(await ethers.provider.getBalance(f.actor.target)).to.equal(AMOUNT);
    });

    it("ETH: a fee recipient that rejects ETH cannot block approvals", async () => {
      const f = await loadFixture(deployFixture);
      await f.actor.setAcceptEth(false);
      await f.escrow.setFeeRecipient(f.actor.target);
      const id = await deliveredJob(f, { token: ETH });
      await f.escrow.connect(f.client).approve(id);
      const fee = (AMOUNT * FEE_BPS) / 10000n;
      expect(await f.escrow.pending(ETH, f.actor.target)).to.equal(fee);
    });

    it("ETH: a client that rejects ETH cannot block the arbiter's resolution", async () => {
      const f = await loadFixture(deployFixture);
      await f.actor.setAcceptEth(false);
      const dl = (await time.latest()) + 7 * DAY;
      await f.actor.exec(
        f.escrow.target,
        AMOUNT,
        f.escrow.interface.encodeFunctionData("createJob", [f.provider.address, ETH, AMOUNT, dl, f.arbiter.address]),
        { value: AMOUNT }
      );
      await f.escrow.connect(f.provider).submitDelivery(1, HASH);
      await f.escrow.connect(f.provider).dispute(1);
      await f.escrow.connect(f.arbiter).resolve(1, 5000);
      expect(await f.escrow.pending(ETH, f.actor.target)).to.equal(AMOUNT / 2n);
    });

    it("ERC-20: a blacklisted provider is credited and can withdraw after being unblocked", async () => {
      const f = await loadFixture(deployFixture);
      const a = { token: f.token.target };
      const id = await deliveredJob(f, a);
      await f.token.setBlocked(f.provider.address, true);
      await f.escrow.connect(f.client).approve(id);
      const fee = (AMOUNT * FEE_BPS) / 10000n;
      expect(await f.escrow.pending(f.token.target, f.provider.address)).to.equal(AMOUNT - fee);

      await expect(f.escrow.connect(f.provider).withdraw(f.token.target)).to.be.revertedWithCustomError(f.escrow, "TokenTransferFailed");
      await f.token.setBlocked(f.provider.address, false);
      await f.escrow.connect(f.provider).withdraw(f.token.target);
      expect(await f.token.balanceOf(f.provider.address)).to.equal(AMOUNT - fee);
    });

    it("withdraw reverts when there is nothing to collect", async () => {
      const f = await loadFixture(deployFixture);
      await expect(f.escrow.connect(f.other).withdraw(ETH)).to.be.revertedWithCustomError(f.escrow, "NothingToWithdraw");
    });
  });

  // ─────────────────────────── Reentrancy ───────────────────────────
  describe("reentrancy", () => {
    it("a client that re-enters refund() from its ETH receive hook is blocked; refund pays exactly once", async () => {
      const f = await loadFixture(deployFixture);
      const dl = (await time.latest()) + DAY;
      // Two jobs in escrow so a successful double-spend would have funds to steal.
      await f.escrow.connect(f.other).createJob(f.provider.address, ETH, AMOUNT, dl + DAY, ETH, { value: AMOUNT });
      await f.actor.exec(
        f.escrow.target,
        AMOUNT,
        f.escrow.interface.encodeFunctionData("createJob", [f.provider.address, ETH, AMOUNT, dl, ETH]),
        { value: AMOUNT }
      );
      await f.actor.setAttack(f.escrow.target, 1 /* Refund */, 2);
      await time.increaseTo(dl + 1);
      await f.actor.exec(f.escrow.target, 0, f.escrow.interface.encodeFunctionData("refund", [2]));

      expect(await f.actor.attackAttempts()).to.equal(1);
      expect(await f.actor.attackReverted()).to.equal(true);
      expect(await ethers.provider.getBalance(f.actor.target)).to.equal(AMOUNT); // paid once
      expect(await ethers.provider.getBalance(f.escrow.target)).to.equal(AMOUNT); // other job untouched
    });

    it("a provider that re-enters claimAfterReview() on payout is blocked", async () => {
      const f = await loadFixture(deployFixture);
      const dl = (await time.latest()) + 7 * DAY;
      await f.escrow.connect(f.client).createJob(f.actor.target, ETH, AMOUNT, dl, ETH, { value: AMOUNT });
      await f.escrow.connect(f.other).createJob(f.provider.address, ETH, AMOUNT, dl, ETH, { value: AMOUNT });
      await f.actor.exec(f.escrow.target, 0, f.escrow.interface.encodeFunctionData("submitDelivery", [1, HASH]));
      await f.actor.setAttack(f.escrow.target, 2 /* Claim */, 1);
      await time.increase(4 * DAY);
      await f.actor.exec(f.escrow.target, 0, f.escrow.interface.encodeFunctionData("claimAfterReview", [1]));

      expect(await f.actor.attackReverted()).to.equal(true);
      const fee = (AMOUNT * FEE_BPS) / 10000n;
      expect(await ethers.provider.getBalance(f.actor.target)).to.equal(AMOUNT - fee);
      expect(await ethers.provider.getBalance(f.escrow.target)).to.equal(AMOUNT);
    });

    it("re-entering withdraw() cannot withdraw twice", async () => {
      const f = await loadFixture(deployFixture);
      // Credit the actor first (while it rejects ETH), then let it attack on the withdraw payout.
      await f.actor.setAcceptEth(false);
      const dl = (await time.latest()) + 7 * DAY;
      await f.escrow.connect(f.client).createJob(f.actor.target, ETH, AMOUNT, dl, ETH, { value: AMOUNT });
      await f.escrow.connect(f.other).createJob(f.provider.address, ETH, AMOUNT, dl, ETH, { value: AMOUNT });
      await f.actor.exec(f.escrow.target, 0, f.escrow.interface.encodeFunctionData("submitDelivery", [1, HASH]));
      await f.escrow.connect(f.client).approve(1);
      const owed = await f.escrow.pending(ETH, f.actor.target);

      await f.actor.setAcceptEth(true);
      await f.actor.setAttack(f.escrow.target, 3 /* Withdraw */, 0);
      await f.actor.exec(f.escrow.target, 0, f.escrow.interface.encodeFunctionData("withdraw", [ETH]));
      expect(await f.actor.attackReverted()).to.equal(true);
      expect(await ethers.provider.getBalance(f.actor.target)).to.equal(owed);
      expect(await ethers.provider.getBalance(f.escrow.target)).to.equal(AMOUNT); // second job intact
    });

    it("re-entering createJob() from a payout is blocked", async () => {
      const f = await loadFixture(deployFixture);
      const dl = (await time.latest()) + 7 * DAY;
      await f.escrow.connect(f.client).createJob(f.actor.target, ETH, AMOUNT, dl, ETH, { value: AMOUNT });
      await f.actor.exec(f.escrow.target, 0, f.escrow.interface.encodeFunctionData("submitDelivery", [1, HASH]));
      await f.actor.setAttack(f.escrow.target, 4 /* CreateJob */, 0);
      await f.escrow.connect(f.client).approve(1);
      expect(await f.actor.attackReverted()).to.equal(true);
      expect(await f.escrow.nextJobId()).to.equal(2);
    });
  });

  // ─────────────────────────── Split math ───────────────────────────
  describe("splitAmount", () => {
    it("matches hand-computed values", async () => {
      const f = await loadFixture(deployFixture);
      const [net, fee, client] = await f.escrow.splitAmount(ethers.parseEther("1"), 7000, 200);
      expect(fee).to.equal(ethers.parseEther("0.014"));
      expect(net).to.equal(ethers.parseEther("0.686"));
      expect(client).to.equal(ethers.parseEther("0.3"));
    });

    it("rounds dust without losing or creating wei (1 wei jobs)", async () => {
      const f = await loadFixture(deployFixture);
      const [net, fee, client] = await f.escrow.splitAmount(1, 5000, 1000);
      expect(net + fee + client).to.equal(1);
    });
  });
});
