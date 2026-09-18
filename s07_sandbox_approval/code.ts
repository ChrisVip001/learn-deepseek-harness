#!/usr/bin/env node
/**
 * s07_sandbox_approval.ts - Fail Closed, Escalate Once
 *
 * dsh's safety stack (packages/sandbox + packages/interaction/user-approval):
 *
 *   Sandbox modes:  read-only | workspace-write | danger-full-access
 *                   (backed by real OS sandboxes: Landlock/Seatbelt/restricted tokens)
 *   Approval:       ctx.approval.request(justification) -> answerer waterfall;
 *                   NO answerer => DENY (fail-closed)
 *   Elevation:      a denied restricted call may be retried ONCE after an
 *                   explicit user approval - then the sandbox snaps back
 *
 * Real sandbox backends live in the OS; this chapter models the DECISION
 * layer that sits in front of them (the part every dsh consumer shares).
 *
 * Usage: node s07_sandbox_approval/code.ts   (offline, deterministic)
 */

// ---------------------------------------------------------------------------
// 1. The sandbox: mode-based decisions, escalation hints
// ---------------------------------------------------------------------------

type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
type Operation = { op: "read" | "write" | "exec"; target: string };

type Decision = { allowed: true } | { allowed: false; reason: string; canEscalate: boolean; justification: string };

class Sandbox {
	public readonly mode: SandboxMode;
	private readonly workspace: string;

	constructor(mode: SandboxMode, workspace: string) {
		this.mode = mode;
		this.workspace = workspace;
	}

	check({ op, target }: Operation): Decision {
		if (this.mode === "danger-full-access") return { allowed: true };
		const inWorkspace = target.startsWith(this.workspace);

		if (op === "read") return { allowed: true }; // reads are free in every mode
		if (op === "write") {
			if (inWorkspace) return { allowed: true };
			return {
				allowed: false,
				reason: `write to '${target}' is outside the workspace (mode: ${this.mode})`,
				canEscalate: true,
				justification: `agent needs to write outside the workspace: '${target}'`,
			};
		}
		// exec
		if (this.mode === "read-only") {
			return { allowed: false, reason: `exec is forbidden in read-only mode`, canEscalate: false, justification: "" };
		}
		if (/curl|wget|ssh|nc /.test(target)) {
			return {
				allowed: false,
				reason: `network command '${target}' requires approval (mode: ${this.mode})`,
				canEscalate: true,
				justification: `agent requests network access: '${target}'`,
			};
		}
		return { allowed: true };
	}
}

// ---------------------------------------------------------------------------
// 2. The approval service: answerer waterfall, fail-closed by construction
// ---------------------------------------------------------------------------

type Answerer = (justification: string) => "allow" | "deny" | "abstain";

class ApprovalService {
	private grantsUsed = 0;
	private readonly answerers: Answerer[];

	constructor(answerers: Answerer[]) {
		this.answerers = answerers;
	}

	/** No answerer (or all abstain) => DENY. Silence can never mean yes. */
	async request(justification: string): Promise<{ granted: boolean; by: string }> {
		if (this.answerers.length === 0) return { granted: false, by: "fail-closed (no answerer registered)" };
		for (const answerer of this.answerers) {
			const verdict = answerer(justification);
			if (verdict !== "abstain") {
				if (verdict === "allow") this.grantsUsed++;
				return { granted: verdict === "allow", by: answerer.name || "answerer" };
			}
		}
		return { granted: false, by: "fail-closed (all answerers abstained)" };
	}
}

// ---------------------------------------------------------------------------
// 3. The executor: check -> maybe escalate (once) -> run -> snap back
// ---------------------------------------------------------------------------

class SandboxedExecutor {
	private readonly sandbox: Sandbox;
	private readonly approval: ApprovalService;
	private readonly world: { run: (op: Operation) => string };

	constructor(sandbox: Sandbox, approval: ApprovalService, world: { run: (op: Operation) => string }) {
		this.sandbox = sandbox;
		this.approval = approval;
		this.world = world;
	}

	async run(op: Operation): Promise<string> {
		const decision = this.sandbox.check(op);
		if (decision.allowed) return `\x1b[32m✓ ${this.world.run(op)}\x1b[0m`;

		console.log(`    \x1b[31m✗ denied: ${decision.reason}\x1b[0m`);
		if (!decision.canEscalate) return `\x1b[31m✗ no escalation possible\x1b[0m`;

		// One-shot elevation: explicit approval, ONE retry, then snap back.
		const verdict = await this.approval.request(decision.justification);
		console.log(`    \x1b[35m[approval] ${verdict.granted ? "GRANTED" : "denied"} by ${verdict.by}\x1b[0m`);
		if (!verdict.granted) return `\x1b[31m✗ escalation refused - operation never ran\x1b[0m`;

		const elevated: Sandbox = new Sandbox("danger-full-access", "");
		const oneShot = elevated.check(op);
		if (!oneShot.allowed) return `\x1b[31m✗ still denied even elevated\x1b[0m`;
		const output = `\x1b[33m⚡ (elevated, one-shot) ${this.world.run(op)}\x1b[0m`;
		console.log(`    \x1b[2m[sandbox] snapped back to ${this.sandbox.mode} after the one shot\x1b[0m`);
		return output;
	}
}

// ---------------------------------------------------------------------------
// 4. Demo: five operations against the decision layer
// ---------------------------------------------------------------------------

const WORKSPACE = "/tmp/demo-workspace";

const world = {
	run: (op: Operation) => {
		switch (op.op) {
			case "read":
				return `read '${op.target}'`;
			case "write":
				return `wrote '${op.target}'`;
			case "exec":
				return `executed '${op.target}'`;
		}
	},
};

async function main() {
	console.log("s07: Sandbox & Approval\n");
	const sandbox = new Sandbox("workspace-write", WORKSPACE);
	// The answerer waterfall: a session-level policy first, a human-stand-in second.
	const approval = new ApprovalService([
		function sessionPolicy(justification: string) {
			return justification.includes("build-output") ? "allow" : "abstain";
		},
		function humanStandIn(justification: string) {
			return justification.includes("network access") ? "allow" : "deny";
		},
	]);
	const executor = new SandboxedExecutor(sandbox, approval, world);

	const ops: Operation[] = [
		{ op: "read", target: `${WORKSPACE}/a.txt` }, // free read
		{ op: "write", target: `${WORKSPACE}/b.txt` }, // workspace write: allowed
		{ op: "write", target: "/var/log/build-output.txt" }, // outside -> escalate -> sessionPolicy allows
		{ op: "write", target: "/etc/hosts" }, // outside -> escalate -> humanStandIn denies
		{ op: "exec", target: "curl https://api.example.com" }, // network -> escalate -> allowed (one-shot)
		{ op: "exec", target: "nc -l 4444" }, // network -> but no granting answerer this time
	];

	for (const op of ops) {
		console.log(`\x1b[33m⚡ ${op.op} ${op.target}\x1b[0m`);
		const result = await executor.run(op);
		console.log(`  ${result}`);
	}

	// What fail-closed looks like when nobody can answer:
	console.log("\n-- fail-closed: an approval with NO answerer registered --");
	const emptyApproval = new ApprovalService([]);
	const verdict = await emptyApproval.request("agent needs anything at all");
	console.log(`  \x1b[31m✗ ${verdict.granted ? "granted" : "denied"} by ${verdict.by}\x1b[0m`);

	console.log("\nDeny by default. Silence never means yes. Elevation is one-shot and logged.");
	console.log("Real dsh backs these decisions with Landlock / Seatbelt / restricted tokens - the decision layer stays the same.");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
