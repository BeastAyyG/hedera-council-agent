// Fresh tests, written 2026-11-06 for ETHGlobal Mumbai.
// The audit topic's admin key is a public key, parsed with the same encoding
// rules as private keys, and read from HEDERA_TOPIC_ADMIN_KEY.
import test from "node:test";
import assert from "node:assert/strict";
import { PrivateKey } from "@hiero-ledger/sdk";
import { parsePrivateKey, parsePublicKey } from "../src/keys.js";
import { loadHederaConfig } from "../src/hedera.js";

test("parsePublicKey round-trips a DER public key", () => {
  const priv = PrivateKey.generateECDSA();
  const der = priv.publicKey.toStringDer();
  assert.equal(parsePublicKey(der).toStringDer(), der);
  assert.equal(parsePublicKey(der).toString(), priv.publicKey.toString());
  // The admin key is never the agent's own private key: parsing the private key's
  // public half is the same value the submit key uses, by construction.
  assert.equal(parsePrivateKey(priv.toString()).publicKey.toStringDer(), der);
});

test("loadHederaConfig reads HEDERA_TOPIC_ADMIN_KEY, blank by default", () => {
  const { config } = loadHederaConfig({ HEDERA_TOPIC_ADMIN_KEY: " 0xabcd " } as NodeJS.ProcessEnv);
  assert.equal(config.topicAdminKey, "0xabcd");
  assert.equal(loadHederaConfig({}).config.topicAdminKey, "");
});
