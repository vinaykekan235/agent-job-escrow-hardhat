// Runs one full job on a local chain: create -> deliver -> approve, then prints balances.
//   npx hardhat run scripts/runJob.js --network localhost
// Env: ASSET=eth (default) | erc20 (deploys a MockERC20), ESCROW=<address> to reuse a deployed escrow
//      (otherwise a fresh one is deployed). Needs several funded accounts, so it is for local nodes only.
const hre = require("hardhat");

async function main() {
  const { ethers, network } = hre;
  if (network.name === "arbitrumSepolia") throw new Error("runJob needs several funded accounts: use a local node");

  const [owner, feeRecipient, client, provider, arbiter] = await ethers.getSigners();
  const useErc20 = (process.env.ASSET ?? "eth").toLowerCase() === "erc20";
  const amount = ethers.parseEther("1");

  const escrow = process.env.ESCROW
    ? await ethers.getContractAt("AgentJobEscrow", process.env.ESCROW)
    : await (await ethers.getContractFactory("AgentJobEscrow")).deploy(owner.address, 250, feeRecipient.address);
  await escrow.waitForDeployment();
  const escrowAddr = await escrow.getAddress();
  const fee = await escrow.feeRecipient();

  let token = ethers.ZeroAddress;
  let erc20;
  if (useErc20) {
    erc20 = await (await ethers.getContractFactory("MockERC20")).deploy();
    await erc20.mint(client.address, amount);
    await (await erc20.connect(client).approve(escrowAddr, amount)).wait();
    token = await erc20.getAddress();
  }

  const balances = async () => {
    const who = { client: client.address, provider: provider.address, feeRecipient: fee, escrow: escrowAddr };
    const out = {};
    for (const [k, a] of Object.entries(who)) {
      const v = useErc20 ? await erc20.balanceOf(a) : await ethers.provider.getBalance(a);
      out[k] = ethers.formatEther(v);
    }
    return out;
  };

  console.log(`Asset: ${useErc20 ? "MockERC20" : "native ETH"}   Escrow: ${escrowAddr}`);
  console.log("Before:", await balances());

  const latest = await ethers.provider.getBlock("latest");
  const deadline = latest.timestamp + 24 * 60 * 60;
  const jobId = await escrow.nextJobId();

  await (await escrow.connect(client).createJob(provider.address, token, amount, deadline, arbiter.address, { value: useErc20 ? 0 : amount })).wait();
  console.log(`1. createJob     -> job #${jobId} Funded`);
  console.log("   balances:", await balances());

  const deliveryHash = ethers.id("ipfs://example-deliverable");
  await (await escrow.connect(provider).submitDelivery(jobId, deliveryHash)).wait();
  console.log("2. submitDelivery -> Delivered, hash", deliveryHash);

  await (await escrow.connect(client).approve(jobId)).wait();
  console.log("3. approve       -> Released");

  const job = await escrow.getJob(jobId);
  console.log("Final status:", ["None", "Funded", "Delivered", "Released", "Refunded", "Disputed", "Resolved"][Number(job.status)]);
  console.log("After: ", await balances());
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
