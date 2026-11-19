// Where a webhook is allowed to be sent.
//
// A vendor hands us a URL and we make our server fetch it. That is a
// server-side request forgery primitive handed over on a plate: left
// unchecked, "https://localhost:8080/admin" or a hostname that resolves to
// 169.254.169.254 turns our outbound sender into a probe for everything the
// node can reach but the internet cannot.
//
// Two gates, because one is not enough:
//
//   1. the written URL     - scheme, credentials, literal private addresses
//   2. the resolved address - what the hostname actually points at, right
//                             before we connect
//
// Checking only the text misses a hostname that resolves inward. Checking only
// at send time misses nothing, but doing it at registration too means a vendor
// gets told immediately rather than silently never receiving anything.
//
// Residual risk, stated rather than hidden: between resolving and connecting,
// DNS can change under us. Closing that fully means pinning the resolved
// address into the socket. The sender refuses redirects for the same reason -
// a 302 to a private address would otherwise walk straight past both gates.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class WebhookTargetError extends Error {}

/** RFC1918 and friends: everything that is not the public internet. */
function isPrivateV4(ip) {
  const [a, b] = ip.split(".").map(Number);
  if (a === 10) return true;
  if (a === 127) return true; // loopback
  if (a === 0) return true; // "this network"
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0) return true; // protocol assignments / test nets
  if (a >= 224) return true; // multicast and reserved
  return false;
}

function isPrivateV6(ip) {
  const lower = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fe80")) return true; // link-local
  if (/^f[cd]/.test(lower)) return true; // unique local
  // ::ffff:a.b.c.d - a v4 address wearing a v6 costume.
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateV4(mapped[1]);
  return false;
}

export function isPrivateAddress(ip) {
  const kind = isIP(ip);
  if (kind === 4) return isPrivateV4(ip);
  if (kind === 6) return isPrivateV6(ip);
  return false;
}

/**
 * Gate 1: what the vendor typed. Pure - no network, so registration can
 * reject the obvious cases instantly.
 *
 * @param {string} raw
 * @param {object} [opts]
 * @param {boolean} [opts.allowInsecure] permit http:// (local development only)
 * @param {boolean} [opts.allowPrivate] permit private/loopback addresses (tests)
 * @returns {URL}
 */
export function parseTarget(raw, { allowInsecure = false, allowPrivate = false } = {}) {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new WebhookTargetError("a webhook url is required");
  }
  if (raw.length > 2000) throw new WebhookTargetError("webhook url is too long");

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new WebhookTargetError("webhook url is not a valid url");
  }

  const httpsOnly = !allowInsecure;
  if (url.protocol !== "https:" && !(allowInsecure && url.protocol === "http:")) {
    throw new WebhookTargetError(
      httpsOnly ? "webhook url must be https" : "webhook url must be http or https",
    );
  }

  // Credentials in the URL would be sent on every delivery and logged by
  // everything in between. Refuse rather than quietly strip them.
  if (url.username || url.password) {
    throw new WebhookTargetError("webhook url must not contain credentials");
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!allowPrivate) {
    if (isIP(host) && isPrivateAddress(host)) {
      throw new WebhookTargetError("webhook url must not point at a private address");
    }
    const lower = host.toLowerCase();
    if (
      lower === "localhost" ||
      lower.endsWith(".localhost") ||
      lower.endsWith(".local") ||
      lower.endsWith(".internal") ||
      lower.endsWith(".home.arpa")
    ) {
      throw new WebhookTargetError("webhook url must not point at a private address");
    }
  }

  return url;
}

/**
 * Gate 2: what it resolves to, checked immediately before connecting.
 * Returns the addresses so a caller can pin them if it wants to.
 */
export async function resolveTarget(url, { allowPrivate = false, resolver = lookup } = {}) {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (!allowPrivate && isPrivateAddress(host)) {
      throw new WebhookTargetError("webhook url resolves to a private address");
    }
    return [host];
  }

  let records;
  try {
    records = await resolver(host, { all: true });
  } catch {
    throw new WebhookTargetError("webhook host does not resolve");
  }
  const addresses = records.map((r) => r.address);
  if (addresses.length === 0) throw new WebhookTargetError("webhook host does not resolve");

  // Every answer must be public. One private address among several is enough
  // to make the connection a coin toss we are not willing to take.
  if (!allowPrivate && addresses.some((a) => isPrivateAddress(a))) {
    throw new WebhookTargetError("webhook url resolves to a private address");
  }
  return addresses;
}
