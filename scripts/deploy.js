// Deploys AgentJobEscrow. Usage:
//   npx hardhat run scripts/deploy.js --network localhost          (local node: `npx hardhat node` or anvil)
//   npx hardhat run scripts/deploy.js --network arbitrumSepolia    (needs PRIVATE_KEY in .env, throwaway wallet only)
// Optional env: FEE_BPS (default 250 = 2.5%), FEE_RECIPIENT (default: deployer).
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

async function main() {
  const { ethers, network } = hre;
  if (network.name === "hardhat") {
    console.log("Note: running on the in-process hardhat network (nothing persists).");
  }
  const [deployer] = await ethers.getSigners();
  const feeBps = Number(process.env.FEE_BPS ?? 250);
  const feeRecipient = process.env.FEE_RECIPIENT ?? deployer.address;

  console.log(`Network:       ${network.name}`);
  console.log(`Deployer:      ${deployer.address}`);
  console.log(`Fee:           ${feeBps} bps -> ${feeRecipient}`);

  const escrow = await (await ethers.getContractFactory("AgentJobEscrow")).deploy(deployer.address, feeBps, feeRecipient);
  await escrow.waitForDeployment();
  const address = await escrow.getAddress();
  console.log(`AgentJobEscrow deployed at ${address}`);

  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${network.name}.json`),
    JSON.stringify({ network: network.name, address, deployer: deployer.address, feeBps, feeRecipient }, null, 2)
  );

  if (network.name === "arbitrumSepolia") {
    console.log(`Verify with: npx hardhat verify --network arbitrumSepolia ${address} ${deployer.address} ${feeBps} ${feeRecipient}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
