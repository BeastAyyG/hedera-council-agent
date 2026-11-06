// Fresh code, written 2026-11-06 for ETHGlobal Mumbai.
// Hedera client, env-gated. Real mode only when HEDERA_ACCOUNT_ID and
// HEDERA_PRIVATE_KEY are set. Otherwise SIMULATED mode: the full logic
// runs, but every chain id is prefixed SIM- and output is labelled
// SIMULATED. Never invent a fake real transaction id or HashScan link.
//
// Council model: proposals move funds out of the treasury account
// (HEDERA_TREASURY_ACCOUNT_ID, default: the agent's own account). The
// agent's "seat" is its key. Signing a proposal means creating the
// Scheduled Transaction for the exact transfer (the creator's signature
// counts toward the schedule) or, if another council member already
// created the identical schedule, adding the agent's signature with
// ScheduleSign. If the treasury has a threshold key, the transfer runs
// only once enough council members have signed.

import { EMPTY_HEAD, isChainedEntry, sealEntry, type ChainedEntry, type ChainHead, type EntryMeta } from "./auditlog.js";
import { parsePrivateKey } from "./keys.js";
import { fetchTopicMessages, parseMessages } from "./mirror.js";
import type { Transfer } from "./proposal.js";

export type HederaMode = "real" | "simulated";

export interface HederaConfig {
  network: string;
  accountId: string;
  privateKey: string;
  topicId: string;
  treasuryAccountId: string;
}

export function loadHederaConfig(env: NodeJS.ProcessEnv): { config: HederaConfig; mode: HederaMode } {
  const accountId = (env.HEDERA_ACCOUNT_ID ?? "").trim();
  const privateKey = (env.HEDERA_PRIVATE_KEY ?? "").trim();
  const config: HederaConfig = {
    network: (env.HEDERA_NETWORK ?? "testnet").trim() || "testnet",
    accountId,
    privateKey,
    topicId: (env.HEDERA_TOPIC_ID ?? "").trim(),
    treasuryAccountId: (env.HEDERA_TREASURY_ACCOUNT_ID ?? "").trim() || accountId,
  };
  const mode: HederaMode = accountId && privateKey ? "real" : "simulated";
  return { config, mode };
}

export function hashscanUrl(network: string, txId: string): string {
  const host = network === "mainnet" ? "hashscan.io/mainnet" : "hashscan.io/testnet";
  return `https://${host}/transaction/${encodeURIComponent(txId)}`;
}

export interface AuditEntry {
  proposalId: string;
  event: string;
  detail: string;
  at: string;
  meta?: EntryMeta;
}

export interface ScheduleResult {
  scheduleId: string;
  // "signed": the agent added its signature. "already-signed": it was already on it.
  // "created": simulated mode only.
  action: "created" | "signed" | "already-signed";
}

type Sdk = typeof import("@hiero-ledger/sdk");

export class HederaClient {
  readonly mode: HederaMode;
  private simCounter = 0;
  // Real-mode SDK client, created lazily so simulated mode needs no keys.
  private sdkClient: import("@hiero-ledger/sdk").Client | null = null;
  private sdk: Sdk | null = null;
  private topicCreation: Promise<string> | null = null;
  private auditLock: Promise<unknown> = Promise.resolve();
  private chainHead: ChainHead | null = null;
  private simEntries: ChainedEntry[] = [];
  private policyHash = "";

  constructor(
    readonly config: HederaConfig,
    mode: HederaMode,
  ) {
    this.mode = mode;
  }

  isReal(): boolean {
    return this.mode === "real";
  }

  simId(prefix: string): string {
    this.simCounter += 1;
    return `SIM-${prefix}-${String(this.simCounter).padStart(4, "0")}`;
  }

  private async getSdk(): Promise<Sdk> {
    if (!this.sdk) this.sdk = await import("@hiero-ledger/sdk");
    return this.sdk;
  }

  private async getClient() {
    if (this.sdkClient) return this.sdkClient;
    const sdk = await this.getSdk();
    const client = this.config.network === "mainnet" ? sdk.Client.forMainnet() : sdk.Client.forTestnet();
    client.setOperator(
      sdk.AccountId.fromString(this.config.accountId),
      parsePrivateKey(this.config.privateKey),
    );
    this.sdkClient = client;
    return client;
  }

  // Verify a payment tx id exists and settled. Real mode checks the
  // receipt via the SDK; simulated mode only accepts SIM- ids it made.
  async verifyPayment(txId: string): Promise<boolean> {
    if (this.mode === "simulated") return txId.startsWith("SIM-PAY-");
    try {
      const sdk = await this.getSdk();
      const client = await this.getClient();
      const receipt = await new sdk.TransactionReceiptQuery()
        .setTransactionId(sdk.TransactionId.fromString(txId))
        .execute(client);
      return receipt.status.toString() === "SUCCESS";
    } catch {
      return false;
    }
  }

  // Topic id for the audit log. Creates one on first use when
  // HEDERA_TOPIC_ID is unset, and logs it so it can be pinned in .env.
  async ensureTopic(): Promise<string> {
    if (this.config.topicId) return this.config.topicId;
    this.topicCreation ??= this.createTopic().then((id) => {
      this.config.topicId = id;
      console.log(`Created HCS audit topic ${id}. Set HEDERA_TOPIC_ID=${id} in .env to reuse it.`);
      return id;
    });
    return this.topicCreation;
  }

  // Commit the policy hash that every following audit entry carries.
  setPolicy(hash: string): void {
    this.policyHash = hash;
  }

  // Append a hash-chained audit entry to the HCS topic. Returns the tx id,
  // or a SIM id in simulated mode.
  async audit(entry: AuditEntry): Promise<string> {
    return (await this.auditEntry(entry)).txId;
  }

  // Same, also returning the sealed entry (seq and hash) for evidence bundles.
  // Writes are serialised so two decisions can never fork the chain.
  auditEntry(entry: AuditEntry): Promise<{ txId: string; entry: ChainedEntry }> {
    const run = this.auditLock.then(() => this.writeAudit(entry));
    this.auditLock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async writeAudit(entry: AuditEntry): Promise<{ txId: string; entry: ChainedEntry }> {
    const input = { ...entry, policy: this.policyHash };
    if (this.mode === "simulated") {
      const head = this.simEntries.at(-1) ?? EMPTY_HEAD;
      const sealed = sealEntry(head, input);
      this.simEntries.push(sealed);
      return { txId: this.simId("HCS"), entry: sealed };
    }
    const topicId = await this.ensureTopic();
    const sealed = sealEntry(await this.loadHead(topicId), input);
    const sdk = await this.getSdk();
    const client = await this.getClient();
    const tx = await new sdk.TopicMessageSubmitTransaction()
      .setTopicId(sdk.TopicId.fromString(topicId))
      .setMessage(JSON.stringify(sealed))
      .execute(client);
    await tx.getReceipt(client);
    this.chainHead = { seq: sealed.seq, hash: sealed.hash };
    return { txId: tx.transactionId.toString(), entry: sealed };
  }

  // After a restart, continue the chain from the topic's latest entry
  // rather than starting a second chain.
  private async loadHead(topicId: string): Promise<ChainHead> {
    if (this.chainHead) return this.chainHead;
    const { messages } = await fetchTopicMessages(this.config.network, topicId, { order: "desc", limit: 25, maxPages: 1 });
    const latest = parseMessages(messages).find(isChainedEntry);
    this.chainHead = latest ? { seq: latest.seq, hash: latest.hash } : EMPTY_HEAD;
    return this.chainHead;
  }

  // Everything on the audit topic, in consensus order, for verification.
  async readAuditLog(): Promise<{ source: "hcs" | "simulated"; topicId: string | null; messages: unknown[]; truncated: boolean }> {
    if (this.mode === "simulated") return { source: "simulated", topicId: null, messages: [...this.simEntries], truncated: false };
    if (!this.config.topicId) return { source: "hcs", topicId: null, messages: [], truncated: false };
    const { messages, truncated } = await fetchTopicMessages(this.config.network, this.config.topicId);
    return { source: "hcs", topicId: this.config.topicId, messages: parseMessages(messages), truncated };
  }

  // Create an HCS topic for the audit log. Returns the topic id.
  async createTopic(memo = "hedera-council-agent audit log"): Promise<string> {
    if (this.mode === "simulated") return this.simId("TOPIC");
    const sdk = await this.getSdk();
    const client = await this.getClient();
    // Only the agent key can append, so the log cannot be polluted or forged by anyone else.
    const tx = await new sdk.TopicCreateTransaction()
      .setTopicMemo(memo.slice(0, 100))
      .setSubmitKey(parsePrivateKey(this.config.privateKey).publicKey)
      .execute(client);
    const receipt = await tx.getReceipt(client);
    if (!receipt.topicId) throw new Error("TopicCreateTransaction returned no topic id");
    return receipt.topicId.toString();
  }

  // Simulated mode only: stand-in for propose + sign, with a SIM id.
  simulateSign(): ScheduleResult {
    return { scheduleId: this.simId("SCHED"), action: "created" };
  }

  // A council member proposes: create the Scheduled Transaction for the
  // exact transfer out of the treasury, signed with the member key only.
  // The treasury needs more signatures, so nothing runs yet. Returns the schedule id.
  async proposeSchedule(
    p: { treasuryAccountId: string; proposerAccountId: string; proposerPrivateKey: import("@hiero-ledger/sdk").PrivateKey },
    transfer: Transfer,
    memo: string,
  ): Promise<string> {
    const sdk = await this.getSdk();
    const client = this.config.network === "mainnet" ? sdk.Client.forMainnet() : sdk.Client.forTestnet();
    client.setOperator(sdk.AccountId.fromString(p.proposerAccountId), p.proposerPrivateKey);
    try {
      const inner = new sdk.TransferTransaction()
        .addHbarTransfer(sdk.AccountId.fromString(p.treasuryAccountId), sdk.Hbar.fromTinybars(-transfer.amountTinybars))
        .addHbarTransfer(sdk.AccountId.fromString(transfer.payee), sdk.Hbar.fromTinybars(transfer.amountTinybars))
        .setTransactionMemo(memo.slice(0, 100));
      const created = await new sdk.ScheduleCreateTransaction()
        .setScheduledTransaction(inner)
        // The proposer can delete its own proposal (seat revocation).
        .setAdminKey(p.proposerPrivateKey.publicKey)
        .setScheduleMemo(memo.slice(0, 100))
        .execute(client);
      const receipt = await created.getReceipt(client);
      if (!receipt.scheduleId) throw new Error("ScheduleCreateTransaction returned no schedule id");
      return receipt.scheduleId.toString();
    } finally {
      client.close();
    }
  }

  // Delete a pending schedule, signed by the proposer (the schedule's admin key).
  async deleteSchedule(
    scheduleId: string,
    p: { proposerAccountId: string; proposerPrivateKey: import("@hiero-ledger/sdk").PrivateKey },
  ): Promise<void> {
    if (this.mode === "simulated") return;
    const sdk = await this.getSdk();
    const client = this.config.network === "mainnet" ? sdk.Client.forMainnet() : sdk.Client.forTestnet();
    client.setOperator(sdk.AccountId.fromString(p.proposerAccountId), p.proposerPrivateKey);
    try {
      const tx = await new sdk.ScheduleDeleteTransaction().setScheduleId(sdk.ScheduleId.fromString(scheduleId)).execute(client);
      await tx.getReceipt(client);
    } finally {
      client.close();
    }
  }

  // Co-sign a schedule the agent has already checked.
  async signSchedule(scheduleId: string): Promise<ScheduleResult> {
    if (this.mode === "simulated") return this.simulateSign();
    const sdk = await this.getSdk();
    const client = await this.getClient();
    const id = sdk.ScheduleId.fromString(scheduleId);
    try {
      const signed = await new sdk.ScheduleSignTransaction().setScheduleId(id).execute(client);
      await signed.getReceipt(client);
      return { scheduleId, action: "signed" };
    } catch (err) {
      if (err instanceof sdk.ReceiptStatusError && err.status === sdk.Status.NoNewValidSignatures) {
        return { scheduleId, action: "already-signed" };
      }
      if (err instanceof sdk.PrecheckStatusError && err.status === sdk.Status.NoNewValidSignatures) {
        return { scheduleId, action: "already-signed" };
      }
      throw err;
    }
  }

  // --- Setup helpers used by `npm run preflight` (real mode only) ---

  async balances(accountId = this.config.accountId): Promise<{ hbar: string; tokens: Record<string, string> }> {
    const sdk = await this.getSdk();
    const client = await this.getClient();
    const b = await new sdk.AccountBalanceQuery().setAccountId(sdk.AccountId.fromString(accountId)).execute(client);
    const json = b.toJSON();
    return { hbar: json.hbars, tokens: Object.fromEntries(json.tokens.map((t) => [t.tokenId, t.balance])) };
  }

  // Associate the agent account with an HTS token. Returns false if it
  // was already associated.
  async associateToken(tokenId: string): Promise<boolean> {
    const sdk = await this.getSdk();
    const client = await this.getClient();
    try {
      const tx = await new sdk.TokenAssociateTransaction()
        .setAccountId(sdk.AccountId.fromString(this.config.accountId))
        .setTokenIds([sdk.TokenId.fromString(tokenId)])
        .execute(client);
      await tx.getReceipt(client);
      return true;
    } catch (err) {
      if (err instanceof sdk.StatusError && err.status === sdk.Status.TokenAlreadyAssociatedToAccount) return false;
      throw err;
    }
  }

  // Create a second account to receive x402 check fees (the check
  // seller). It shares the agent's key and auto-associates tokens, so it
  // can receive testnet USDC without a separate association step.
  async createFeeAccount(initialHbar = 1): Promise<string> {
    const sdk = await this.getSdk();
    const client = await this.getClient();
    const key = parsePrivateKey(this.config.privateKey);
    const tx = await new sdk.AccountCreateTransaction()
      .setKeyWithoutAlias(key.publicKey)
      .setInitialBalance(new sdk.Hbar(initialHbar))
      .setMaxAutomaticTokenAssociations(10)
      .setAccountMemo("hedera-council-agent x402 check fees")
      .execute(client);
    const receipt = await tx.getReceipt(client);
    if (!receipt.accountId) throw new Error("AccountCreateTransaction returned no account id");
    return receipt.accountId.toString();
  }

  // One-time council setup: a member account with its own key, and a
  // treasury whose key is a 2-of-2 threshold over the agent and the member.
  async createCouncil(treasuryHbar = 5, memberHbar = 5): Promise<{ treasuryAccountId: string; memberAccountId: string; memberPrivateKey: string }> {
    const sdk = await this.getSdk();
    const client = await this.getClient();
    const agentKey = parsePrivateKey(this.config.privateKey);
    const memberKey = sdk.PrivateKey.generateECDSA();
    const member = await (await new sdk.AccountCreateTransaction()
      .setKeyWithoutAlias(memberKey.publicKey)
      .setInitialBalance(new sdk.Hbar(memberHbar))
      .setAccountMemo("council member (proposer)")
      .execute(client)).getReceipt(client);
    const thresholdKey = new sdk.KeyList([agentKey.publicKey, memberKey.publicKey], 2);
    const frozen = await new sdk.AccountCreateTransaction()
      .setKeyWithoutAlias(thresholdKey)
      .setInitialBalance(new sdk.Hbar(treasuryHbar))
      .setAccountMemo("council treasury, 2-of-2")
      .freezeWith(client)
      .sign(memberKey);
    const treasury = await (await frozen.execute(client)).getReceipt(client);
    if (!member.accountId || !treasury.accountId) throw new Error("Council account creation returned no account id");
    return {
      treasuryAccountId: treasury.accountId.toString(),
      memberAccountId: member.accountId.toString(),
      memberPrivateKey: memberKey.toStringDer(),
    };
  }

  close(): void {
    this.sdkClient?.close();
    this.sdkClient = null;
  }
}
