// Fresh code, written 2026-11-06 for ETHGlobal Mumbai.
// How a council proposal lives on Hedera (real mode).
//   treasury : an account whose key is a 2-of-2 threshold key over the
//              agent's key and a council member's key
//   proposer : a council member. Creates the Scheduled Transaction for the
//              exact transfer, signed with the member key only
//   agent    : reads the schedule back from the mirror node, compares what
//              it will really execute with the proposal's description, and
//              only then co-signs with ScheduleSign. Either both signatures
//              exist and the transfer runs, or it does not run.
// The transfer the agent checks is the one on Hedera, never one supplied
// with the request.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { HederaClient, ScheduleResult } from "./hedera.js";
import { parsePrivateKey } from "./keys.js";
import { fetchSchedule, type OnChainSchedule } from "./mirror.js";
import type { Proposal } from "./proposal.js";

export interface ChainPort {
  // Schedule to check for this proposal: the one named by proposal.scheduleId,
  // or, when none is given, a new one created by the proposer.
  resolve(proposal: Proposal): Promise<OnChainSchedule>;
  // Co-sign an already-checked schedule.
  sign(scheduleId: string): Promise<ScheduleResult>;
  // Delete a not-yet-executed schedule the proposer created (seat revocation).
  cancel?(scheduleId: string): Promise<void>;
}

export interface CouncilSetup {
  treasuryAccountId: string;
  memberAccountId: string;
  memberPrivateKey: string; // DER hex
}

export const COUNCIL_FILE = ".data/council.json";

export function loadCouncilSetup(env: NodeJS.ProcessEnv, path = env.COUNCIL_FILE?.trim() || COUNCIL_FILE): CouncilSetup | null {
  const memberAccountId = env.COUNCIL_PROPOSER_ACCOUNT_ID?.trim();
  const memberPrivateKey = env.COUNCIL_PROPOSER_PRIVATE_KEY?.trim();
  if (memberAccountId && memberPrivateKey) {
    return { treasuryAccountId: env.HEDERA_TREASURY_ACCOUNT_ID?.trim() ?? "", memberAccountId, memberPrivateKey };
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as CouncilSetup;
  } catch {
    return null;
  }
}

export function saveCouncilSetup(setup: CouncilSetup, path = COUNCIL_FILE): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(setup, null, 2), { mode: 0o600 });
}

// Pure policy: is this on-chain schedule one the agent may sign for this proposal?
export function scheduleProblem(s: OnChainSchedule, treasuryAccountId: string): string | null {
  if (s.problem) return s.problem;
  if (s.deleted) return "The schedule was deleted.";
  if (s.executed) return "The schedule already executed, there is nothing left to sign.";
  if (!s.transfer) return "The schedule holds no transfer.";
  if (treasuryAccountId && s.transfer.from !== treasuryAccountId) {
    return `The transfer pays out of ${s.transfer.from}, not the council treasury ${treasuryAccountId}.`;
  }
  return null;
}

export class HederaChain implements ChainPort {
  constructor(
    private readonly hedera: HederaClient,
    private readonly setup: CouncilSetup | null,
  ) {}

  async resolve(proposal: Proposal): Promise<OnChainSchedule> {
    let scheduleId = proposal.scheduleId;
    if (!scheduleId) {
      if (!this.setup) {
        throw new Error(
          "No scheduleId given and no council proposer configured. Have a council member create the Scheduled Transaction (npm run propose), or run npm run preflight -- --create-council.",
        );
      }
      scheduleId = await this.hedera.proposeSchedule(
        {
          treasuryAccountId: this.hedera.config.treasuryAccountId,
          proposerAccountId: this.setup.memberAccountId,
          proposerPrivateKey: parsePrivateKey(this.setup.memberPrivateKey),
        },
        proposal.transfer,
        `council proposal ${proposal.id}`,
      );
    }
    return fetchSchedule(this.hedera.config.network, scheduleId);
  }

  sign(scheduleId: string): Promise<ScheduleResult> {
    return this.hedera.signSchedule(scheduleId);
  }

  async cancel(scheduleId: string): Promise<void> {
    if (!this.setup) throw new Error("No council proposer configured, so the schedule admin key is not available to delete it.");
    await this.hedera.deleteSchedule(scheduleId, {
      proposerAccountId: this.setup.memberAccountId,
      proposerPrivateKey: parsePrivateKey(this.setup.memberPrivateKey),
    });
  }
}
