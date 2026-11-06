// Fresh code, written 2026-11-06 for ETHGlobal Mumbai.
// The council's own payee registry. It is this project's list of Hedera
// accounts the council is willing to pay, with optional validity windows.
// It is NOT an implementation of ERC-8004 or ERC-8478 and reads nothing
// from any on-chain registry. Two uses:
//   1. A proposal's actual recipient must be registered and unexpired.
//   2. The x402 check seller's wallet (payTo) is compared with the
//      registered check service before the agent pays anything.

import { readFileSync, renameSync, writeFileSync } from "node:fs";

export interface PayeeEntry {
  account: string;
  label: string;
  validFrom?: string;
  validUntil?: string;
  // Set when the council revokes the payee at runtime.
  revokedAt?: string;
}

export type PayeeStatus = "registered" | "unregistered" | "expired" | "not-yet-valid" | "revoked" | "not-enforced";

export interface PayeeLookup {
  account: string;
  status: PayeeStatus;
  label: string | null;
  detail: string;
}

export type PayeeSource = "env" | "file" | "env+file" | "demo registry" | "empty";

// Demo accounts used by the rehearsal and the console's judge mode.
export const DEMO_PAYEES: PayeeEntry[] = ["0.0.1001", "0.0.1002", "0.0.1003", "0.0.1004", "0.0.6666"].map((account) => ({
  account,
  label: "demo payee",
}));

const ACCOUNT = /^(\d+)\.(\d+)\.(\d+)(?:-[a-z]{5})?$/;

// Hedera account id equality: same shard.realm.num, optional checksum ignored.
export function sameAccount(a: string, b: string): boolean {
  const x = ACCOUNT.exec(a.trim());
  const y = ACCOUNT.exec(b.trim());
  return !!x && !!y && x[1] === y[1] && x[2] === y[2] && x[3] === y[3];
}

function parseEntries(raw: unknown): PayeeEntry[] {
  if (!Array.isArray(raw)) throw new Error("payee registry must be a JSON array");
  return raw.map((item) => {
    const e = (typeof item === "string" ? { account: item } : item) as Partial<PayeeEntry> | null;
    if (!e || typeof e.account !== "string" || !ACCOUNT.test(e.account.trim())) {
      throw new Error(`payee registry entry needs a Hedera account id (0.0.x): ${JSON.stringify(item)}`);
    }
    for (const k of ["validFrom", "validUntil", "revokedAt"] as const) {
      if (e[k] !== undefined && Number.isNaN(Date.parse(String(e[k])))) throw new Error(`payee ${e.account}: ${k} is not a date`);
    }
    return {
      account: e.account.trim(),
      label: typeof e.label === "string" && e.label ? e.label.slice(0, 60) : "registered payee",
      ...(e.validFrom ? { validFrom: String(e.validFrom) } : {}),
      ...(e.validUntil ? { validUntil: String(e.validUntil) } : {}),
      ...(e.revokedAt ? { revokedAt: String(e.revokedAt) } : {}),
    };
  });
}

// PAYEE_REGISTRY is a JSON array or a comma list of account ids.
function parseEnvList(value: string): PayeeEntry[] {
  const v = value.trim();
  if (!v) return [];
  return parseEntries(v.startsWith("[") ? JSON.parse(v) : v.split(",").map((s) => s.trim()).filter(Boolean));
}

export class PayeeRegistry {
  readonly entries: PayeeEntry[];

  constructor(
    entries: PayeeEntry[],
    readonly opts: { source: PayeeSource; requireRegistered?: boolean; onRevoke?: (account: string, at: string) => void } = { source: "empty" },
  ) {
    // Copies, so revoking never mutates a shared list such as DEMO_PAYEES.
    this.entries = entries.map((e) => ({ ...e }));
  }

  // Marks every entry for this account revoked from `now`. Returns how many
  // entries changed (0: nothing to revoke). File-backed registries are
  // written back; env and demo registries are revoked in memory only.
  revoke(account: string, now = new Date()): number {
    const at = now.toISOString();
    let n = 0;
    for (const e of this.entries) {
      if (sameAccount(e.account, account) && !e.revokedAt) {
        e.revokedAt = at;
        n += 1;
      }
    }
    if (n > 0) this.opts.onRevoke?.(account, at);
    return n;
  }

  // Enforced when asked for explicitly, or whenever there is anything in it.
  get enforce(): boolean {
    return this.opts.requireRegistered === true || this.entries.length > 0;
  }

  get source(): PayeeSource {
    return this.opts.source;
  }

  lookup(account: string, now = new Date()): PayeeLookup {
    if (!this.enforce) return { account, status: "not-enforced", label: null, detail: `Payee registry not enforced; ${account} not checked.` };
    const matches = this.entries.filter((e) => sameAccount(e.account, account));
    if (matches.length === 0) {
      return { account, status: "unregistered", label: null, detail: `Recipient ${account} is not in the council payee registry.` };
    }
    const t = now.getTime();
    const live = matches.find((e) => !(e.revokedAt && Date.parse(e.revokedAt) <= t) && (!e.validFrom || Date.parse(e.validFrom) <= t) && (!e.validUntil || Date.parse(e.validUntil) > t));
    if (live) return { account, status: "registered", label: live.label, detail: `Recipient ${account} is registered (${live.label}).` };
    const revoked = matches.find((e) => e.revokedAt && Date.parse(e.revokedAt) <= t);
    if (revoked) {
      return { account, status: "revoked", label: revoked.label, detail: `Recipient ${account} is not in the council payee registry (its entry was revoked ${revoked.revokedAt}).` };
    }
    const expired = matches.find((e) => e.validUntil && Date.parse(e.validUntil) <= t);
    if (expired) {
      return { account, status: "expired", label: expired.label, detail: `Recipient ${account} is not in the council payee registry (its entry expired ${expired.validUntil}).` };
    }
    return { account, status: "not-yet-valid", label: matches[0]!.label, detail: `Recipient ${account} is not in the council payee registry (its entry is valid from ${matches[0]!.validFrom}).` };
  }

  summary(): { count: number; enforce: boolean; source: PayeeSource } {
    return { count: this.entries.length, enforce: this.enforce, source: this.source };
  }
}

// Env: PAYEE_REGISTRY (JSON array or comma list), PAYEE_REGISTRY_FILE
// (JSON array), REQUIRE_REGISTERED_PAYEE=true. `fallback` (the demo
// payees) applies only when nothing is configured; the caller passes it
// in simulated mode only.
export function loadPayeeRegistry(env: NodeJS.ProcessEnv, fallback: PayeeEntry[] = []): PayeeRegistry {
  const requireRegistered = (env.REQUIRE_REGISTERED_PAYEE ?? "").trim().toLowerCase() === "true";
  const fromEnv = parseEnvList(env.PAYEE_REGISTRY ?? "");
  const file = (env.PAYEE_REGISTRY_FILE ?? "").trim();
  const fromFile = file ? parseEntries(JSON.parse(readFileSync(file, "utf8"))) : [];
  const entries = [...fromEnv, ...fromFile];
  if (entries.length === 0 && fallback.length > 0) return new PayeeRegistry(fallback, { source: "demo registry", requireRegistered });
  const source: PayeeSource = fromEnv.length && fromFile.length ? "env+file" : fromEnv.length ? "env" : fromFile.length ? "file" : "empty";
  // Revocations of file entries are written back to the file, atomically.
  const onRevoke = file
    ? (account: string, at: string) => {
        let changed = false;
        for (const e of fromFile) {
          if (sameAccount(e.account, account) && !e.revokedAt) {
            e.revokedAt = at;
            changed = true;
          }
        }
        if (!changed) return;
        writeFileSync(`${file}.tmp`, JSON.stringify(fromFile, null, 2));
        renameSync(`${file}.tmp`, file);
      }
    : undefined;
  return new PayeeRegistry(entries, { source, requireRegistered, onRevoke });
}
