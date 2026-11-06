// Fresh code, written 2026-11-06 for ETHGlobal Mumbai.
// Hedera client, env-gated. Real mode only when HEDERA_ACCOUNT_ID and
// HEDERA_PRIVATE_KEY are set. Otherwise SIMULATED mode: the full logic
// runs, but every chain id is prefixed SIM- and output is labelled
// SIMULATED. Never invent a fake real transaction id or HashScan link.

import type { Transfer } from "./proposal.js";

export type HederaMode = "real" | "simulated";

export interface HederaConfig {
  network: string;
  accountId: string;
  privateKey: string;
  topicId: string;
  checkPriceTinybars: number;
}

export function loadHederaConfig(env: NodeJS.ProcessEnv): { config: HederaConfig; mode: HederaMode } {
  const accountId = (env.HEDERA_ACCOUNT_ID ?? "").trim();
  const privateKey = (env.HEDERA_PRIVATE_KEY ?? "").trim();
  const config: HederaConfig = {
    network: (env.HEDERA_NETWORK ?? "testnet").trim() || "testnet",
    accountId,
    privateKey,
    topicId: (env.HEDERA_TOPIC_ID ?? "").trim(),
    checkPriceTinybars: Number(env.X402_CHECK_PRICE_TINYBARS ?? 100000),
  };
  const mode: HederaMode = accountId && privateKey ? "real" : "simulated";
  return { config, mode };
}

export function hashscanUrl(network: string, txId: string): string {
  const host = network === "mainnet" ? "hashscan.io" : "hashscan.io/testnet";
  return `https://${host}/transaction/${encodeURIComponent(txId)}`;
}

export interface AuditEntry {
  proposalId: string;
  event: string;
  detail: string;
  at: string;
}

export class HederaClient {
  readonly mode: HederaMode;
  private simCounter = 0;
  // Real-mode SDK client, created lazily so simulated mode needs no keys.
  private sdkClient: unknown = null;
  private sdk: typeof import("@hiero-ledger/sdk") | null = null;

  constructor(
    readonly config: HederaConfig,
    mode: HederaMode,
  ) {
    this.mode = mode;
  }

  isReal(): boolean {
    return this.mode === "real";
  }

  private simId(prefix: string): string {
    this.simCounter += 1;
    return `SIM-${prefix}-${String(this.simCounter).padStart(4, "0")}`;
  }

  private async getSdk() {
    if (!this.sdk) this.sdk = await import("@hiero-ledger/sdk");
    return this.sdk;
  }

  private async getClient() {
    if (this.sdkClient) return this.sdkClient as import("@hiero-ledger/sdk").Client;
    const sdk = await this.getSdk();
    const client =
      this.config.network === "mainnet" ? sdk.Client.forMainnet() : sdk.Client.forTestnet();
    client.setOperator(
      sdk.AccountId.fromString(this.config.accountId),
      sdk.PrivateKey.fromString(this.config.privateKey),
    );
    this.sdkClient = client;
    return client;
  }

  // Pay `amountTinybars` HBAR to `payee`. Returns the Hedera tx id.
  async pay(payee: string, amountTinybars: number, memo: string): Promise<string> {
    if (this.mode === "simulated") return this.simId("PAY");
    const sdk = await this.getSdk();
    const client = await this.getClient();
    const tx = await new sdk.TransferTransaction()
      .addHbarTransfer(sdk.AccountId.fromString(this.config.accountId), sdk.Hbar.fromTinybars(-amountTinybars))
      .addHbarTransfer(sdk.AccountId.fromString(payee), sdk.Hbar.fromTinybars(amountTinybars))
      .setTransactionMemo(memo.slice(0, 100))
      .execute(client);
    const receipt = await tx.getReceipt(client);
    void receipt;
    return tx.transactionId.toString();
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

  // Append an audit entry to the HCS topic. Returns the tx id, or a SIM id.
  async audit(entry: AuditEntry): Promise<string> {
    const message = JSON.stringify(entry);
    if (this.mode === "simulated") return this.simId("HCS");
    if (!this.config.topicId) {
      // No topic configured: fall back to a plain transfer memo is wrong,
      // so record the failure honestly and return a marker, not a fake id.
      throw new Error("HEDERA_TOPIC_ID is not set, cannot write HCS audit entry.");
    }
    const sdk = await this.getSdk();
    const client = await this.getClient();
    const tx = await new sdk.TopicMessageSubmitTransaction()
      .setTopicId(sdk.TopicId.fromString(this.config.topicId))
      .setMessage(message)
      .execute(client);
    await tx.getReceipt(client);
    return tx.transactionId.toString();
  }

  // Create an HCS topic for the audit log. Returns the topic id.
  async createTopic(memo = "hedera-council-agent audit log"): Promise<string> {
    if (this.mode === "simulated") return this.simId("TOPIC");
    const sdk = await this.getSdk();
    const client = await this.getClient();
    const tx = await new sdk.TopicCreateTransaction().setTopicMemo(memo.slice(0, 100)).execute(client);
    const receipt = await tx.getReceipt(client);
    return receipt.topicId ? receipt.topicId.toString() : tx.transactionId.toString();
  }

  // Create a Scheduled Transaction for the exact transfer. The transfer
  // is fixed at creation; council signatures approve it. Returns the
  // scheduled transaction id (real) or a SIM id.
  async createScheduledTransfer(transfer: Transfer, memo: string): Promise<string> {
    if (this.mode === "simulated") return this.simId("SCHED");
    const sdk = await this.getSdk();
    const client = await this.getClient();
    const inner = new sdk.TransferTransaction()
      .addHbarTransfer(sdk.AccountId.fromString(this.config.accountId), sdk.Hbar.fromTinybars(-transfer.amountTinybars))
      .addHbarTransfer(sdk.AccountId.fromString(transfer.payee), sdk.Hbar.fromTinybars(transfer.amountTinybars))
      .setTransactionMemo(memo.slice(0, 100));
    const scheduled = await new sdk.ScheduleCreateTransaction()
      .setScheduledTransaction(inner)
      .setScheduleMemo(`council proposal: ${memo.slice(0, 90)}`)
      .execute(client);
    const receipt = await scheduled.getReceipt(client);
    const scheduleId = (receipt as { scheduleId?: { toString(): string } }).scheduleId;
    return scheduleId ? scheduleId.toString() : scheduled.transactionId.toString();
  }
}
