// Fresh code, written 2026-11-06 for ETHGlobal Mumbai.
// Small durable state: council seats (one per World ID nullifier) and
// spent approval keys. World's guidance is to record nullifiers in durable
// storage, not memory, so a restart cannot re-admit a person or replay an
// approval. A JSON file is enough for one agent process.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { monthKey, type MandateDraft, type SpendRecord, type VoteItem } from "./mandate.js";

export interface CouncilSeat {
  seat: string;
  nullifier: string;
  joinedAt: string;
  source: "world" | "mocked";
}

interface StateShape {
  seats: CouncilSeat[];
  usedApprovals: string[];
  // Bumped by every seat revocation; pending proposals carry the epoch they were created in.
  epoch: number;
  // Nullifiers of revoked seats. They stay blocked: a revoked person cannot rejoin.
  revokedSeats: string[];
  // Next seat number, so a seat id is never reused after a revocation.
  nextSeat: number;
  // Standing instructions (drafts, adopted, superseded), oldest first.
  mandates: MandateDraft[];
  nextMandate: number;
  // Council votes on proposals that went outside the active mandate.
  votes: VoteItem[];
  // Every SIGNED payment, for the monthly cap.
  spends: SpendRecord[];
}

export class StateStore {
  private state: StateShape = { seats: [], usedApprovals: [], epoch: 1, revokedSeats: [], nextSeat: 1, mandates: [], nextMandate: 1, votes: [], spends: [] };

  // path null keeps state in memory only (tests).
  constructor(private readonly path: string | null) {
    if (!path) return;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<StateShape>;
      const seats = raw.seats ?? [];
      const revokedSeats = raw.revokedSeats ?? [];
      this.state = {
        seats,
        usedApprovals: raw.usedApprovals ?? [],
        epoch: raw.epoch ?? 1,
        revokedSeats,
        nextSeat: raw.nextSeat ?? seats.length + revokedSeats.length + 1,
        mandates: raw.mandates ?? [],
        nextMandate: raw.nextMandate ?? (raw.mandates?.length ?? 0) + 1,
        votes: raw.votes ?? [],
        spends: raw.spends ?? [],
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  private save(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.path);
  }

  seats(): CouncilSeat[] {
    return [...this.state.seats];
  }

  epoch(): number {
    return this.state.epoch;
  }

  revokedSeatCount(): number {
    return this.state.revokedSeats.length;
  }

  isRevoked(nullifier: string): boolean {
    return this.state.revokedSeats.includes(nullifier);
  }

  // Revokes one seat and bumps the epoch, in one save. The seat is removed
  // and its nullifier stays blocked. Returns null when there is no such seat.
  revokeSeat(seatId: string): { seat: CouncilSeat; fromEpoch: number; toEpoch: number } | null {
    const seat = this.state.seats.find((s) => s.seat === seatId);
    if (!seat) return null;
    const fromEpoch = this.state.epoch;
    this.state.seats = this.state.seats.filter((s) => s.seat !== seatId);
    this.state.revokedSeats.push(seat.nullifier);
    this.state.epoch = fromEpoch + 1;
    this.save();
    return { seat, fromEpoch, toEpoch: this.state.epoch };
  }

  // Returns null when this nullifier already holds a seat, or was revoked.
  addSeat(nullifier: string, source: CouncilSeat["source"]): CouncilSeat | null {
    if (this.state.seats.some((s) => s.nullifier === nullifier) || this.isRevoked(nullifier)) return null;
    const seat: CouncilSeat = {
      seat: `council-seat:${this.state.nextSeat++}`,
      nullifier,
      joinedAt: new Date().toISOString(),
      source,
    };
    this.state.seats.push(seat);
    this.save();
    return seat;
  }

  // Atomically records an approval key; false if it was already used.
  consumeApproval(key: string): boolean {
    if (this.state.usedApprovals.includes(key)) return false;
    this.state.usedApprovals.push(key);
    this.save();
    return true;
  }

  // ---- standing instructions ----

  mandates(): MandateDraft[] {
    return [...this.state.mandates];
  }

  mandate(id: string): MandateDraft | null {
    return this.state.mandates.find((m) => m.id === id) ?? null;
  }

  activeMandate(): MandateDraft | null {
    return this.state.mandates.find((m) => m.status === "adopted") ?? null;
  }

  // Assigns the next id (never reused) and saves.
  addMandate(draft: Omit<MandateDraft, "id">): MandateDraft {
    const id = `M-${this.state.nextMandate++}`;
    // id first in the JSON, and never taken from the caller.
    const m: MandateDraft = Object.assign({ id }, draft, { id });
    this.state.mandates.push(m);
    this.save();
    return m;
  }

  updateMandate(m: MandateDraft): void {
    this.state.mandates = this.state.mandates.map((x) => (x.id === m.id ? m : x));
    this.save();
  }

  // Adopts one mandate and supersedes the previously active one, in one save.
  adoptMandate(id: string, at: string): { adopted: MandateDraft; superseded: MandateDraft | null } | null {
    const m = this.mandate(id);
    if (!m) return null;
    const prev = this.activeMandate();
    if (prev && prev.id !== id) prev.status = "superseded";
    m.status = "adopted";
    m.adoptedAt = at;
    this.save();
    return { adopted: m, superseded: prev && prev.id !== id ? prev : null };
  }

  // ---- council votes on proposals ----

  votes(): VoteItem[] {
    return [...this.state.votes];
  }

  vote(subject: string): VoteItem | null {
    return this.state.votes.find((v) => v.subject === subject) ?? null;
  }

  putVote(item: VoteItem): void {
    const i = this.state.votes.findIndex((v) => v.subject === item.subject);
    if (i >= 0) this.state.votes[i] = item;
    else this.state.votes.push(item);
    this.save();
  }

  // ---- spend ----

  // Idempotent per proposal: a re-signed proposal is not counted twice.
  recordSpend(r: SpendRecord): void {
    if (this.state.spends.some((s) => s.proposalId === r.proposalId)) return;
    this.state.spends.push(r);
    this.save();
  }

  spends(): SpendRecord[] {
    return [...this.state.spends];
  }

  spentThisMonth(now: Date): number {
    const key = monthKey(now);
    return this.state.spends.filter((s) => s.at.slice(0, 7) === key).reduce((n, s) => n + s.amountTinybars, 0);
  }
}
