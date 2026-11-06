// Hedera private key parsing. PrivateKey.fromString() treats a raw 32-byte
// hex key as ED25519, but the portal's x402-compatible accounts are ECDSA,
// so raw hex is parsed as ECDSA. DER-encoded keys carry their own type.
// HEDERA_KEY_TYPE=ed25519 overrides for raw ED25519 keys.
import { PrivateKey, PublicKey } from "@hiero-ledger/sdk";

export function parsePrivateKey(raw: string, keyType = process.env.HEDERA_KEY_TYPE): PrivateKey {
  const s = raw.trim().replace(/^0x/i, "");
  if (/^30[0-9a-f]+$/i.test(s) && s.length > 64) return PrivateKey.fromStringDer(s);
  return keyType?.trim().toLowerCase() === "ed25519" ? PrivateKey.fromStringED25519(s) : PrivateKey.fromStringECDSA(s);
}

// Public keys use the same encoding rules. Used for the audit topic's admin key
// (HEDERA_TOPIC_ADMIN_KEY): the council's key, held by the council, never the agent's.
// PublicKey.fromString accepts both DER-encoded and raw hex keys.
export function parsePublicKey(raw: string, keyType = process.env.HEDERA_KEY_TYPE): PublicKey {
  const s = raw.trim().replace(/^0x/i, "");
  if (/^30[0-9a-f]+$/i.test(s) && s.length > 64) return PublicKey.fromString(s);
  return keyType?.trim().toLowerCase() === "ed25519" ? PublicKey.fromStringED25519(s) : PublicKey.fromStringECDSA(s);
}
