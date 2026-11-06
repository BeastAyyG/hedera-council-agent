// Fresh code, written 2026-11-06 for ETHGlobal Mumbai.
// A council member proposes: creates the Scheduled Transaction for the
// exact transfer out of the treasury and prints the proposal to submit.
//   npm run propose -- <payee 0.0.x> <amount in HBAR> "<purpose>" [proposal id]
// The agent then reads the schedule back from Hedera, checks it against
// the description, and co-signs only if they match.
import { HederaChain, loadCouncilSetup } from "./chain.js";
import { hbarToTinybars } from "./proposal.js";
import { buildAgent } from "./server.js";

const [payee, amount, purpose, idArg] = process.argv.slice(2);
if (!payee || !amount || !purpose) {
  console.error('Usage: npm run propose -- <payee 0.0.x> <amount HBAR> "<purpose>" [proposal id]');
  process.exit(2);
}
const agent = buildAgent(process.env);
const council = loadCouncilSetup(process.env);
if (agent.mode !== "real" || !council) {
  console.error("Needs real mode and a council: set Hedera credentials and run npm run preflight -- --create-council");
  process.exit(1);
}
const id = idArg ?? `P-${Date.now().toString(36).toUpperCase()}`;
const tinybars = hbarToTinybars(Number(amount));
const proposal = {
  id,
  description: { payee, amountTinybars: tinybars, token: "HBAR" as const, purpose },
  transfer: { payee, amountTinybars: tinybars, token: "HBAR" as const },
  createdAt: new Date().toISOString(),
};
try {
  const onChain = await new HederaChain(agent.hedera, council).resolve(proposal);
  // Only the schedule id and the description go to the agent; it reads the transfer from Hedera.
  const { transfer: _transfer, createdAt: _c, ...submit } = proposal;
  console.log(`Scheduled ${onChain.scheduleId} (${onChain.signedBy} signature(s) so far). Submit:`);
  console.log(JSON.stringify({ proposal: { ...submit, scheduleId: onChain.scheduleId } }));
} finally {
  agent.hedera.close();
}
