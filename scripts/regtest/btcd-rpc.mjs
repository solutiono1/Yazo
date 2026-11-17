// Minimal JSON-RPC client for btcd, used only by the local regtest harness.
// btcd listens on loopback over TLS using the self-signed certificate it
// generates on first run; we pin that certificate rather than skipping
// verification. Nothing here touches mainnet or any real key material.
import https from "node:https";
import { readFileSync } from "node:fs";

const RPC_USER = process.env.BTCD_RPC_USER ?? "yazo";
const RPC_PASS = process.env.BTCD_RPC_PASS ?? "yazo";
const RPC_HOST = process.env.BTCD_RPC_HOST ?? "127.0.0.1";
const RPC_PORT = Number(process.env.BTCD_RPC_PORT ?? 18334);
const RPC_CERT = process.env.BTCD_RPC_CERT ?? ".regtest/btcd/rpc.cert";

let ca;
function certificate() {
  if (!ca) ca = readFileSync(RPC_CERT);
  return ca;
}

export function btcdRpc(method, params = []) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "1.0", id: "yazo", method, params }));
  const auth = Buffer.from(`${RPC_USER}:${RPC_PASS}`).toString("base64");

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: RPC_HOST,
        port: RPC_PORT,
        method: "POST",
        path: "/",
        ca: certificate(),
        checkServerIdentity: () => undefined, // self-signed loopback cert, pinned above
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/json",
          "Content-Length": body.length,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed;
          try {
            parsed = JSON.parse(text);
          } catch {
            return reject(new Error(`btcd returned non-JSON (${res.statusCode}): ${text.slice(0, 200)}`));
          }
          if (parsed.error) return reject(new Error(`btcd ${method}: ${parsed.error.message}`));
          resolve(parsed.result);
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

export async function waitForBtcd({ attempts = 30, delayMs = 1000 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await btcdRpc("getblockchaininfo");
    } catch {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error("btcd did not become reachable");
}

export const generate = (blocks) => btcdRpc("generate", [blocks]);
export const getBlockCount = () => btcdRpc("getblockcount");
