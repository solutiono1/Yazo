// Bring up a complete local Lightning network: one btcd chain and two lnd
// nodes with a funded channel between them.
//
//   node scripts/regtest/up.mjs
//
// alice = the diaspora payer. bob = the Yazo node that issues hold invoices.
// Everything is regtest and loopback-only; no real funds exist here.
import { spawn } from "node:child_process";
import { mkdirSync, openSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { BIN, ROOT, BTCD, NODES, NETWORK, sleep } from "./config.mjs";
import { btcdRpc, waitForBtcd, generate } from "./btcd-rpc.mjs";
import { LndAdmin } from "./lnd-admin.mjs";

const log = (...a) => console.log("[up]", ...a);

function spawnDetached(bin, args, logFile) {
  mkdirSync(resolve(logFile, ".."), { recursive: true });
  const out = openSync(logFile, "a");
  const child = spawn(bin, args, { detached: true, stdio: ["ignore", out, out] });
  child.unref();
  return child.pid;
}

function startBtcd({ miningAddress } = {}) {
  mkdirSync(BTCD.dir, { recursive: true });
  const args = [
    `--${NETWORK}`,
    "--txindex",
    `--rpcuser=${BTCD.rpcUser}`,
    `--rpcpass=${BTCD.rpcPass}`,
    `--rpclisten=${BTCD.rpcHost}:${BTCD.rpcPort}`,
    `--listen=127.0.0.1:${BTCD.p2pPort}`,
    `--datadir=${BTCD.dir}`,
    `--logdir=${resolve(BTCD.dir, "logs")}`,
    `--rpccert=${BTCD.cert}`,
    `--rpckey=${resolve(BTCD.dir, "rpc.key")}`,
  ];
  if (miningAddress) args.push(`--miningaddr=${miningAddress}`);
  const pid = spawnDetached(BIN.btcd, args, resolve(BTCD.dir, "btcd.out.log"));
  log(`btcd started (pid ${pid})${miningAddress ? ` mining to ${miningAddress}` : ""}`);
  return pid;
}

function startLnd(name, node) {
  mkdirSync(node.dir, { recursive: true });
  const args = [
    `--lnddir=${node.dir}`,
    "--bitcoin.active",
    `--bitcoin.${NETWORK}`,
    "--bitcoin.node=btcd",
    `--btcd.rpchost=${BTCD.rpcHost}:${BTCD.rpcPort}`,
    `--btcd.rpcuser=${BTCD.rpcUser}`,
    `--btcd.rpcpass=${BTCD.rpcPass}`,
    `--btcd.rpccert=${BTCD.cert}`,
    // Regtest only: skips the interactive seed ceremony so the harness is
    // unattended. Never use this for a wallet holding real funds.
    "--noseedbackup",
    `--rpclisten=127.0.0.1:${node.rpc}`,
    `--restlisten=127.0.0.1:${node.rest}`,
    `--listen=127.0.0.1:${node.p2p}`,
    "--nobootstrap",
    "--trickledelay=50",
    "--accept-keysend",
  ];
  const pid = spawnDetached(BIN.lnd, args, resolve(node.dir, "lnd.out.log"));
  log(`lnd ${name} started (pid ${pid}) rest=${node.rest}`);
  return pid;
}

async function killByName(name) {
  const { execSync } = await import("node:child_process");
  try {
    if (process.platform === "win32") execSync(`taskkill /F /IM ${name}.exe`, { stdio: "ignore" });
    else execSync(`pkill -f ${name}`, { stdio: "ignore" });
  } catch {
    /* not running */
  }
}

async function main() {
  const fresh = process.argv.includes("--fresh");
  if (fresh && existsSync(ROOT)) {
    log("--fresh: clearing previous regtest state");
    await killByName("lnd");
    await killByName("btcd");
    await sleep(2000);
    rmSync(ROOT, { recursive: true, force: true });
  }

  // 1. chain
  if (!existsSync(BTCD.cert)) {
    startBtcd();
  } else {
    try {
      await btcdRpc("getblockchaininfo");
      log("btcd already running");
    } catch {
      startBtcd();
    }
  }
  const chain = await waitForBtcd();
  log(`chain up: ${chain.chain}, ${chain.blocks} blocks`);

  // 2. nodes
  const admins = {};
  for (const [name, node] of Object.entries(NODES)) {
    const admin = new LndAdmin(node, name);
    admins[name] = admin;
    try {
      await admin.getInfo();
      log(`lnd ${name} already running`);
    } catch {
      startLnd(name, node);
    }
  }
  const info = {};
  for (const [name, admin] of Object.entries(admins)) {
    info[name] = await admin.waitUntilReady();
    log(`lnd ${name} ready: ${info[name].identity_pubkey.slice(0, 16)}...`);
  }

  // 3. funds. btcd only mines to an address given at startup, so once alice
  //    exists we restart the chain pointed at her wallet.
  const balance = await admins.alice.walletBalance();
  if (BigInt(balance.confirmed_balance ?? "0") < 1_000_000n) {
    const { address } = await admins.alice.newAddress();
    log(`funding alice at ${address}`);
    await killByName("btcd");
    await sleep(2500);
    startBtcd({ miningAddress: address });
    await waitForBtcd();
    // 100 blocks to mature a coinbase, plus plenty of spendable output.
    await generate(400);
    log(`mined 400 blocks, height ${await btcdRpc("getblockcount")}`);
    for (let i = 0; i < 60; i += 1) {
      const b = await admins.alice.walletBalance();
      if (BigInt(b.confirmed_balance ?? "0") > 0n) {
        log(`alice confirmed balance: ${b.confirmed_balance} sat`);
        break;
      }
      await sleep(1000);
    }
  } else {
    log(`alice already funded: ${balance.confirmed_balance} sat`);
  }

  // 4. channel alice -> bob. Both nodes must be fully synced to the (possibly
  //    restarted) chain before they will accept peer or channel calls.
  for (const [name, admin] of Object.entries(admins)) {
    info[name] = await admin.waitUntilReady({ requireSynced: true });
    log(`lnd ${name} synced to chain at height ${info[name].block_height}`);
  }

  const channels = await admins.alice.listChannels();
  if (!channels.channels?.length) {
    await admins.alice.retrying("connect peer", () =>
      admins.alice.connectPeer(info.bob.identity_pubkey, `127.0.0.1:${NODES.bob.p2p}`),
    );
    log("alice connected to bob");
    await sleep(1500);
    await admins.alice.retrying("open channel", () =>
      admins.alice.openChannel(info.bob.identity_pubkey, 5_000_000),
    );
    log("channel opening, confirming...");
    await generate(6);
    for (let i = 0; i < 60; i += 1) {
      const list = await admins.alice.listChannels();
      if (list.channels?.some((c) => c.active)) break;
      await generate(1);
      await sleep(1000);
    }
  }
  const finalChannels = await admins.alice.listChannels();
  const active = finalChannels.channels?.filter((c) => c.active) ?? [];
  log(`active channels: ${active.length}`);
  for (const c of active) {
    log(`  capacity ${c.capacity} sat | alice can send ${c.local_balance} | bob can receive ${c.remote_balance}`);
  }
  if (!active.length) throw new Error("no active channel; check .regtest/*/lnd.out.log");

  log("network ready.");
}

main().catch((e) => {
  console.error("[up] FAILED:", e.message);
  process.exit(1);
});
