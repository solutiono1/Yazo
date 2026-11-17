// Shared configuration for the local regtest harness.
//
// Everything is loopback-only and regtest-only. No mainnet key material, no
// real funds, and no secrets live here: the RPC user/pass below guard a
// throwaway local chain, nothing more.
import { platform } from "node:os";
import { resolve } from "node:path";

const exe = platform() === "win32" ? ".exe" : "";
const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";

export const BIN = {
  btcd: process.env.BTCD_BIN ?? resolve(home, `lnd-tools/btcd/btcd-windows-amd64-v0.27.0/btcd${exe}`),
  lnd: process.env.LND_BIN ?? resolve(home, `lnd-tools/lnd/lnd-windows-amd64-v0.21.8-beta/lnd${exe}`),
};

export const ROOT = resolve(process.env.REGTEST_DIR ?? ".regtest");

export const BTCD = {
  dir: resolve(ROOT, "btcd"),
  rpcHost: "127.0.0.1",
  rpcPort: 18334,
  p2pPort: 18444,
  rpcUser: "yazo",
  rpcPass: "yazo",
  get cert() {
    return resolve(this.dir, "rpc.cert");
  },
};

/**
 * Two nodes, because a hold invoice needs someone to pay it: `alice` is the
 * diaspora payer, `bob` is the Yazo node that issues invoices for vendors.
 */
export const NODES = {
  alice: { dir: resolve(ROOT, "alice"), rest: 8081, rpc: 10009, p2p: 9735 },
  bob: { dir: resolve(ROOT, "bob"), rest: 8082, rpc: 10010, p2p: 9736 },
};

export const NETWORK = "regtest";

export const macaroonPath = (node, name = "admin") =>
  resolve(node.dir, `data/chain/bitcoin/${NETWORK}/${name}.macaroon`);

export const tlsCertPath = (node) => resolve(node.dir, "tls.cert");

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
