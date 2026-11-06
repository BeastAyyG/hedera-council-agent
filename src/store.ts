// Fresh code, written 2026-11-06 for ETHGlobal Mumbai.
// Small durable state: council seats (one per World ID nullifier) and
// spent approval keys. World's guidance is to record nullifiers in durable
// storage, not memory, so a restart cannot re-admit a person or replay an
// approval. A JSON file is enough for one agent process.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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
}

export class StateStore {
  private state: StateShape = { seats: [], usedApprovals: [], epoch: 1, revokedSeats: [], nextSeat: 1 };

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
}
