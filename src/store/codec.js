// Round-tripping an order through JSON.
//
// Orders carry Buffers (payment hash, salt) and bigints (sats, cents). Plain
// JSON silently destroys both: a Buffer becomes {"type":"Buffer","data":[...]}
// and a bigint throws. So values are tagged on the way out and rebuilt on the
// way in, and the result is frozen again - a thawed order that could be mutated
// in place would undo the guarantee the state machine depends on.
export class CodecError extends Error {}

const BUF = "__buf";
const BIG = "__big";

export function encodeOrder(order) {
  assertNoSecrets(order);
  return JSON.stringify(order, (_key, value) => {
    if (typeof value === "bigint") return { [BIG]: value.toString() };
    // JSON.stringify has already converted a Buffer to its object form by the
    // time a replacer sees the parent, so detect that shape too.
    if (value && value.type === "Buffer" && Array.isArray(value.data)) {
      return { [BUF]: Buffer.from(value.data).toString("hex") };
    }
    return value;
  });
}

export function decodeOrder(text) {
  const revived = JSON.parse(text, (_key, value) => {
    if (value && typeof value === "object") {
      if (typeof value[BUF] === "string") return Buffer.from(value[BUF], "hex");
      if (typeof value[BIG] === "string") return BigInt(value[BIG]);
    }
    return value;
  });
  return deepFreeze(revived);
}

function deepFreeze(value) {
  if (Buffer.isBuffer(value) || value === null || typeof value !== "object") return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

/**
 * Defence in depth. The order object is not supposed to contain the release
 * secret or the preimage, and persistence is the one place where a mistake
 * would become permanent. Refuse rather than write it.
 */
export function assertNoSecrets(order) {
  const forbidden = ["secret", "preimage", "releaseSecret", "mnemonic", "macaroon"];
  const walk = (node, path) => {
    if (!node || typeof node !== "object" || Buffer.isBuffer(node)) return;
    for (const [key, child] of Object.entries(node)) {
      if (forbidden.includes(key)) {
        throw new CodecError(`refusing to persist "${path}${key}": secrets are never stored`);
      }
      walk(child, `${path}${key}.`);
    }
  };
  walk(order, "");
  return order;
}
