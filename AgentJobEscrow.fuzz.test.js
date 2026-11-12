const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

// Hardhat has no native fuzzer, so these are seeded property tests: a deterministic PRNG drives
// random inputs (reproducible by seed) and every iteration asserts the same properties.

const ETH = ethers.ZeroAddress;
const DAY = 24 * 60 * 60;
const HASH = ethers.id("work");
const UINT96_MAX = 2n ** 96n - 1n;

function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    int: (n) => Math.floor(next() * n), // [0, n)
    big: (max) => {
      let v = 0n;
      for (let i = 0; i < 9; i++) v = (v << 32n) | BigInt(Math.floor(next() * 2 ** 32));
      return v % (max + 1n); // uniform enough, always within [0, max]
    },
    pick: (arr) => arr[Math.floor(next() * arr.length)],
  };
}

async function deployFixture() {
  const [owner, feeRecipient, client, provider, arbiter, other, other2] = await ethers.getSigners();
  const escrow = await (await ethers.getContractFactory("AgentJobEscrow")).deploy(owner.address, 250, feeRecipient.address);
  const token = await (await ethers.getContractFactory("MockERC20")).deploy();
  const actor = await (await ethers.getContractFactory("Actor")).deploy();
  for (const s of [client, other, other2]) {
    await token.mint(s.address, 2n ** 100n);
    await token.connect(s).approve(escrow, ethers.MaxUint256);
  }
  return { escrow, token, actor, owner, feeRecipient, client, provider, arbiter, other, other2 };
}

describe("AgentJobEscrow fuzz / property tests", function () {
  this.timeout(300_000);

  it("splitAmount: parts always add up to the amount, fee <= 10% of the provider's part", async () => {
    const { escrow } = await loadFixture(deployFixture);
    const r = rng(1);
    const edgeAmounts = [1n, 2n, 3n, 9_999n, 10_000n, 10_001n, UINT96_MAX, 2n ** 128n, 2n ** 200n];
    const edgeBps = [0, 1, 2, 4999, 5000, 9999, 10000];
    const edgeFees = [0, 1, 249, 250, 999, 1000];

    for (let i = 0; i < 400; i++) {
      const amount = i < edgeAmounts.length ? edgeAmounts[i] : r.big(2n ** 128n) + 1n;
      const bps = r.int(3) === 0 ? r.pick(edgeBps) : r.int(10001);
      const feeBps = r.int(3) === 0 ? r.pick(edgeFees) : r.int(1001);

      const [net, fee, clientPart] = await escrow.splitAmount(amount, bps, feeBps);
      const providerPart = net + fee;

      expect(net + fee + clientPart, `sum amount=${amount} bps=${bps} fee=${feeBps}`).to.equal(amount);
      expect(providerPart).to.be.lte(amount);
      expect(fee * 10000n).to.be.lte(providerPart * 1000n); // never above 10% of what the provider earned
      expect(fee * 10000n).to.be.lte(providerPart * BigInt(feeBps)); // and never above the configured rate
      if (bps === 0) expect(providerPart).to.equal(0n);
      if (bps === 10000) expect(clientPart).to.equal(0n);
      if (feeBps === 0) expect(fee).to.equal(0n);
    }
  });

  it("splitAmount: fee is monotonic in the provider's share", async () => {
    const { escrow } = await loadFixture(deployFixture);
    const r = rng(2);
    for (let i = 0; i < 100; i++) {
      const amount = r.big(2n ** 90n) + 1n;
      const b1 = r.int(10001);
      const b2 = Math.min(10000, b1 + r.int(2000));
      const [, f1] = await escrow.splitAmount(amount, b1, 300);
      const [, f2] = await escrow.splitAmount(amount, b2, 300);
      expect(f2).to.be.gte(f1);
    }
  });

  it("owner can never push the fee above 10%, whatever value is tried", async () => {
    const { escrow } = await loadFixture(deployFixture);
    const r = rng(3);
    for (let i = 0; i < 40; i++) {
      const v = r.int(65536);
      if (v <= 1000) {
        await escrow.setFeeBps(v);
      } else {
        await expect(escrow.setFeeBps(v)).to.be.revertedWithCustomError(escrow, "FeeTooHigh");
      }
      expect(await escrow.feeBps()).to.be.lte(1000);
    }
  });

  for (const kind of ["ETH", "ERC-20"]) {
    it(`on-chain resolve with random amount / split / fee pays out exactly the job amount (${kind})`, async () => {
      const f = await loadFixture(deployFixture);
      const r = rng(kind === "ETH" ? 10 : 11);
      const isEth = kind === "ETH";
      const tokenAddr = isEth ? ETH : f.token.target;
      const balance = (a) => (isEth ? ethers.provider.getBalance(a) : f.token.balanceOf(a));

      for (let i = 0; i < 40; i++) {
        const amount = isEth ? r.big(10n ** 20n) + 1n : r.big(UINT96_MAX) + 1n;
        const bps = r.int(4) === 0 ? r.pick([0, 1, 9999, 10000]) : r.int(10001);
        const feeBps = r.int(1001);
        await f.escrow.setFeeBps(feeBps);

        const dl = (await time.latest()) + 7 * DAY;
        await f.escrow
          .connect(f.client)
          .createJob(f.provider.address, tokenAddr, amount, dl, f.arbiter.address, { value: isEth ? amount : 0 });
        const id = (await f.escrow.nextJobId()) - 1n;
        await f.escrow.connect(f.provider).submitDelivery(id, HASH);
        await f.escrow.connect(f.client).dispute(id);

        const watch = [f.provider, f.feeRecipient, f.client, f.escrow];
        const before = await Promise.all(watch.map((w) => balance(w.address ?? w.target)));
        const tx = await f.escrow.connect(f.arbiter).resolve(id, bps);
        await tx.wait();
        const after = await Promise.all(watch.map((w) => balance(w.address ?? w.target)));
        const d = after.map((x, k) => x - before[k]);

        // d: provider, feeRecipient, client (client is not the tx sender so no gas), escrow
        expect(d[0] + d[1] + d[2], `i=${i} amount=${amount} bps=${bps} fee=${feeBps}`).to.equal(amount);
        expect(d[3]).to.equal(-amount);
        const [net, fee, back] = await f.escrow.splitAmount(amount, bps, feeBps);
        expect([d[0], d[1], d[2]]).to.deep.equal([net, fee, back]);
      }
    });
  }
});

// ─────────────────────────── Invariant test ───────────────────────────
// Random sequences of every public action (valid and invalid) from many accounts, including a contract
// wallet that sometimes rejects ETH. After EVERY step we check, for ETH and the ERC-20:
//   escrow balance == sum(amount of open jobs: Funded/Delivered/Disputed) + sum(pending payouts)
describe("AgentJobEscrow invariants", function () {
  this.timeout(600_000);

  const OPEN = [1, 2, 5]; // Funded, Delivered, Disputed

  async function checkInvariant(f, accounts) {
    const next = await f.escrow.nextJobId();
    const openSum = { [ETH]: 0n, [f.token.target]: 0n };
    for (let id = 1n; id < next; id++) {
      const j = await f.escrow.getJob(id);
      if (OPEN.includes(Number(j.status))) openSum[j.token] += j.amount;
    }
    for (const token of [ETH, f.token.target]) {
      let owed = openSum[token];
      for (const a of accounts) owed += await f.escrow.pending(token, a);
      const held = token === ETH ? await ethers.provider.getBalance(f.escrow.target) : await f.token.balanceOf(f.escrow.target);
      expect(held, `invariant broken for ${token}`).to.equal(owed);
    }
  }

  for (const seed of [100, 200, 300]) {
    it(`escrow balance == open jobs + uncollected payouts after every step (seed ${seed})`, async () => {
      const f = await loadFixture(deployFixture);
      const r = rng(seed);
      const providers = [f.provider, f.actor, f.actor]; // the actor is a contract wallet that can reject ETH
      const clients = [f.client, f.other];
      const accounts = [f.client, f.provider, f.arbiter, f.other, f.other2, f.owner, f.feeRecipient].map((s) => s.address).concat(f.actor.target);
      const e = f.escrow;

      const asProvider = (p, fn, args) =>
        p === f.actor
          ? f.actor.exec(e.target, 0, e.interface.encodeFunctionData(fn, args))
          : e.connect(p)[fn](...args);

      for (let step = 0; step < 250; step++) {
        const next = Number(await e.nextJobId());
        const id = next > 1 ? 1 + r.int(next - 1) : 1;
        let op = r.int(12);
        if (next > 1 && r.int(10) < 7) {
          // Bias towards the natural next step of the chosen job so the deep paths (payouts, disputes,
          // failed pushes) are actually reached instead of every call reverting on state.
          const st = Number((await e.getJob(id)).status);
          if (st === 1) op = r.pick([3, 3, 3, 6, 10]);
          else if (st === 2) op = r.pick([4, 5, 7, 7, 10]);
          else if (st === 5) op = 8;
          else op = r.pick([9, 9, 0]);
        }
        try {
          if (op <= 2) {
            // create (ETH or ERC-20), random provider/arbiter/amount/deadline
            const isEth = r.int(2) === 0;
            const amount = BigInt(1 + r.int(1_000_000)) * (r.int(2) === 0 ? 1n : 10n ** 12n);
            const dl = (await time.latest()) + (1 + r.int(5)) * DAY;
            const arbiter = r.int(4) === 0 ? ETH : f.arbiter.address;
            const p = r.pick(providers);
            await e
              .connect(r.pick(clients))
              .createJob(p === f.actor ? f.actor.target : p.address, isEth ? ETH : f.token.target, amount, dl, arbiter, { value: isEth ? amount : 0 });
          } else if (op === 3) {
            const j = next > 1 ? await e.getJob(id) : null;
            if (j) await asProvider(j.provider === f.actor.target ? f.actor : f.provider, "submitDelivery", [id, HASH]);
          } else if (op === 4) {
            await e.connect(r.pick([...clients, f.other2])).approve(id);
          } else if (op === 5) {
            const j = await e.getJob(id);
            await asProvider(j.provider === f.actor.target ? f.actor : f.provider, "claimAfterReview", [id]);
          } else if (op === 6) {
            await e.connect(r.pick(clients)).refund(id);
          } else if (op === 7) {
            const j = await e.getJob(id);
            if (r.int(2) === 0) await asProvider(j.provider === f.actor.target ? f.actor : f.provider, "dispute", [id]);
            else await e.connect(r.pick(clients)).dispute(id);
          } else if (op === 8) {
            await e.connect(f.arbiter).resolve(id, r.int(10001));
          } else if (op === 9) {
            const token = r.int(2) === 0 ? ETH : f.token.target;
            if (r.int(2) === 0) await f.actor.exec(e.target, 0, e.interface.encodeFunctionData("withdraw", [token]));
            else await e.connect(r.pick([f.provider, f.client, f.other, f.feeRecipient])).withdraw(token);
          } else if (op === 10) {
            await time.increase(r.int(4 * DAY));
          } else {
            await f.actor.setAcceptEth(r.int(4) === 0);
            if (r.int(3) === 0) await e.setFeeBps(r.int(1001));
          }
        } catch (err) {
          // Invalid actions are expected to revert (custom errors); anything else is a real failure.
          if (!/reverted|custom error|ReentrancyGuard|WrongState|Not|Deadline|Review/.test(String(err.message))) throw err;
        }
        await checkInvariant(f, accounts);
      }

      const credited = await e.queryFilter(e.filters.PayoutCredited());
      const statuses = new Set();
      for (let id = 1; id < Number(await e.nextJobId()); id++) statuses.add(Number((await e.getJob(id)).status));
      expect(credited.length, "run never exercised the pull-payment fallback").to.be.gt(0);
      expect([...statuses].some((x) => x === 3 || x === 6), "run never completed a job").to.equal(true);

      // Drain: close every job and collect every credit; the escrow must end at exactly zero.
      await f.actor.setAcceptEth(true);
      await time.increase(40 * DAY);
      const total = Number(await e.nextJobId());
      for (let id = 1; id < total; id++) {
        const j = await e.getJob(id);
        const st = Number(j.status);
        if (st === 1) await e.connect(j.client === f.client.address ? f.client : f.other).refund(id);
        else if (st === 2) await asProvider(j.provider === f.actor.target ? f.actor : f.provider, "claimAfterReview", [id]);
        else if (st === 5) await e.connect(f.arbiter).resolve(id, 5000);
      }
      for (const token of [ETH, f.token.target]) {
        for (const s of [f.provider, f.client, f.other, f.feeRecipient]) {
          if ((await e.pending(token, s.address)) > 0n) await e.connect(s).withdraw(token);
        }
        if ((await e.pending(token, f.actor.target)) > 0n) {
          await f.actor.exec(e.target, 0, e.interface.encodeFunctionData("withdraw", [token]));
        }
      }
      await checkInvariant(f, accounts);
      expect(await ethers.provider.getBalance(e.target)).to.equal(0n);
      expect(await f.token.balanceOf(e.target)).to.equal(0n);
    });
  }
});
