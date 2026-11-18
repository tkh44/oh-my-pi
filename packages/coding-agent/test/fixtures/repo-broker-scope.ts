import * as path from "node:path";
import * as readline from "node:readline";
import { declareWorkerHostEntry, getDaemonRuntimeRoot } from "@oh-my-pi/pi-utils";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { createDaemonBrokerClient, daemonClientForGlobal } from "../../src/launch/client";
import { canonicalProjectDir, daemonBrokerEndpoint, daemonRuntimeDir } from "../../src/launch/paths";
import { registerDaemonProjectPresence } from "../../src/launch/presence";
import { DAEMON_BROKER_WORKER_ARG, type DaemonOperation } from "../../src/launch/protocol";

// Exercise production client spawning and broker election with a minimal source
// worker host. No installed binary, native lease, socket or RPC is mocked.
declareWorkerHostEntry();
if (process.argv[2] === DAEMON_BROKER_WORKER_ARG) {
	await startDaemonBrokerFromEnvironment();
} else {
	const projectDir = process.argv[2]!;
	const mode = process.argv[3] ?? "default";
	const runtimeOverride = mode === "legacy" ? daemonRuntimeDir(await canonicalProjectDir(projectDir)) : undefined;
	const client = mode === "global"
		? await daemonClientForGlobal("scope-fixture")
		: await createDaemonBrokerClient(projectDir, { runtimeDir: runtimeOverride, idleGraceMs: 150 });
	const runtimeDir = mode === "global" ? client.projectDir : runtimeOverride ?? daemonRuntimeDir(client.projectDir);
	const presence = await registerDaemonProjectPresence(projectDir, mode === "global" ? runtimeDir : runtimeOverride);
	const lines = readline.createInterface({ input: process.stdin });
	try {
		const ping = await client.request({ op: "ping" });
		const lease: { pid: number } = await Bun.file(path.join(runtimeDir, "broker.pid")).json();
		process.stdout.write(`${JSON.stringify({ projectDir: client.projectDir, runtimeDir, endpoint: daemonBrokerEndpoint(runtimeDir), pid: lease.pid, runtimeRoot: getDaemonRuntimeRoot(), ping })}\n`);
		for await (const line of lines) {
			const operation: DaemonOperation = JSON.parse(line);
			try {
				process.stdout.write(`${JSON.stringify({ ok: true, result: await client.request(operation) })}\n`);
			} catch (error) {
				process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
			}
		}
	} finally {
		lines.close();
		client.close();
		await presence.close();
	}
}
