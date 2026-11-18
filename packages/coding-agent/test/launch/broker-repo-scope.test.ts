// Real-process integration tests: timers bound socket startup and idle drain,
// which fake timers cannot drive across independent Bun processes.
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Subprocess } from "bun";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { DaemonOperation, DaemonRpcResult } from "../../src/launch/protocol";

const fixture = path.resolve(import.meta.dir, "../fixtures/repo-broker-scope.ts");
interface Ready {
	projectDir: string;
	runtimeDir: string;
	runtimeRoot: string;
	endpoint: string;
	pid: number;
}
interface Reply {
	ok: boolean;
	result?: DaemonRpcResult;
	error?: string;
}

// Minimal, valid Git metadata, including an unborn HEAD. The linked-worktree
// fixture below shares objects/refs but has its own .git file and HEAD.
async function repository(root: string): Promise<void> {
	await fs.mkdir(path.join(root, ".git", "objects"), { recursive: true });
	await fs.mkdir(path.join(root, ".git", "refs"), { recursive: true });
	await Bun.write(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
	await Bun.write(path.join(root, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n\tbare = false\n");
}

class ClientProcess {
	readonly process: Subprocess<"pipe", "pipe", "pipe">;
	readonly #reader: ReadableStreamDefaultReader<string>;
	#buffer = "";
	readonly ready: Promise<Ready>;

	constructor(projectDir: string, state: string, mode = "default") {
		this.process = Bun.spawn([process.execPath, fixture, projectDir, mode], {
			cwd: projectDir,
			env: {
				...process.env,
				OMP_PROFILE: "",
				PI_PROFILE: "",
				HOME: path.join(state, "home"),
				USERPROFILE: path.join(state, "home"),
				PI_CODING_AGENT_DIR: path.join(state, "home", ".omp", "agent"),
				XDG_CONFIG_HOME: path.join(state, "config"),
				XDG_STATE_HOME: path.join(state, "state"),
				XDG_DATA_HOME: path.join(state, "data"),
				XDG_CACHE_HOME: path.join(state, "cache"),
			},
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		this.#reader = this.process.stdout.pipeThrough(new TextDecoderStream()).getReader();
		this.ready = this.#line().then(line => JSON.parse(line));
	}

	async #line(): Promise<string> {
		for (;;) {
			const newline = this.#buffer.indexOf("\n");
			if (newline >= 0) {
				const line = this.#buffer.slice(0, newline);
				this.#buffer = this.#buffer.slice(newline + 1);
				return line;
			}
			const chunk = await this.#reader.read();
			if (chunk.done) throw new Error(`Scope fixture exited: ${await new Response(this.process.stderr).text()}`);
			this.#buffer += chunk.value;
		}
	}

	async request(operation: DaemonOperation): Promise<Reply> {
		await this.ready;
		this.process.stdin.write(`${JSON.stringify(operation)}\n`);
		this.process.stdin.flush();
		return JSON.parse(await this.#line());
	}

	async close(): Promise<void> {
		this.process.stdin.end();
		if (await this.process.exited !== 0) throw new Error(await new Response(this.process.stderr).text());
	}
}

async function waitForDrain(runtimeDir: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (await Bun.file(path.join(runtimeDir, "broker.pid")).exists()) {
		if (Date.now() >= deadline) throw new Error(`Owned broker failed to drain: ${runtimeDir}`);
		await Bun.sleep(25);
	}
}

async function closeClients(clients: ClientProcess[]): Promise<void> {
	const ready = await Promise.allSettled(clients.map(client => client.ready));
	const runtimeDirs = new Set(ready.flatMap(result => result.status === "fulfilled" ? [result.value.runtimeDir] : []));
	await Promise.all(clients.map(client => client.close()));
	await Promise.all([...runtimeDirs].map(waitForDrain));
}

async function measurement(label: string, ready: Ready[]): Promise<void> {
	const pids = [...new Set(ready.map(client => client.pid))];
	let rssKiB: number | undefined;
	if (process.platform !== "win32") {
		const ps = Bun.spawn(["ps", "-o", "pid=,rss=", "-p", pids.join(",")], { stdout: "pipe", stderr: "pipe" });
		const output = await new Response(ps.stdout).text();
		if (await ps.exited !== 0) throw new Error(await new Response(ps.stderr).text());
		const rows = output.trim().split("\n").map(line => line.trim().split(/\s+/).map(Number));
		expect(rows.map(row => row[0]).sort()).toEqual([...pids].sort());
		rssKiB = rows.reduce((sum, row) => sum + row[1]!, 0);
	}
	process.stdout.write(`${JSON.stringify({ scenario: label, brokerProcesses: pids.length, duplicates: pids.length - 1, rssKiB, method: "unique live broker.pid owners; ps -o pid=,rss= -p <owners>; summed KiB" })}\n`);
}

function service(name: string, cwd: string, owner: string): DaemonOperation {
	return {
		op: "start", owner, replace: true,
		spec: {
			name, cwd, application: process.execPath,
			args: ["-e", "console.log(process.cwd()); setInterval(() => {}, 1000)"],
			env: {}, pty: false, restart: "no", persist: false, detached: false,
			ready: { log: ".+", timeoutMs: 5_000 },
		},
	};
}

describe("Git worktree broker scope", () => {
	it("elects one real broker for concurrent root, subdirectory and symlink clients instead of three directory owners", async () => {
		using temp = TempDir.createSync("@omp-repo-scope-");
		const root = path.join(temp.path(), "repo");
		await repository(root);
		const first = path.join(root, "a");
		const second = path.join(root, "b");
		const link = path.join(temp.path(), "linked-cwd");
		await Promise.all([fs.mkdir(first), fs.mkdir(second)]);
		await fs.symlink(first, link, "junction");
		const paths = [root, first, second, link];
		const before = [...paths, ...paths].map(cwd => new ClientProcess(cwd, path.join(temp.path(), "before"), "legacy"));
		try {
			const ready = await Promise.all(before.map(client => client.ready));
			expect(new Set(ready.map(client => client.pid)).size).toBe(3);
			await measurement("before-directory-scope", ready);
		} finally {
			await closeClients(before);
		}
		const after = [...paths, ...paths].map(cwd => new ClientProcess(cwd, path.join(temp.path(), "after")));
		try {
			const ready = await Promise.all(after.map(client => client.ready));
			expect(new Set(ready.map(client => client.pid)).size).toBe(1);
			expect(new Set(ready.map(client => client.endpoint)).size).toBe(1);
			expect(ready.every(client => client.projectDir === ready[0]!.projectDir)).toBe(true);
			const clients = await fs.readdir(path.join(ready[0]!.runtimeDir, "clients"));
			expect(clients).toHaveLength(after.length);
			await measurement("after-worktree-scope", ready);
			const endpointInode = process.platform === "win32" ? undefined : (await fs.stat(ready[0]!.endpoint)).ino;
			// All contenders remain able to RPC after election, on the same
			// socket inode; no losing process unlinked the winner's endpoint.
			for (const client of after) expect((await client.request({ op: "ping" })).ok).toBe(true);
			expect((await Bun.file(path.join(ready[0]!.runtimeDir, "broker.pid")).json()).pid).toBe(ready[0]!.pid);
			if (endpointInode !== undefined) expect((await fs.stat(ready[0]!.endpoint)).ino).toBe(endpointInode);
		} finally {
			await closeClients(after);
		}
	}, 60_000);

	it("isolates linked worktrees, nested repositories, non-Git directories and explicit/global scopes", async () => {
		using temp = TempDir.createSync("@omp-repo-isolation-");
		const root = path.join(temp.path(), "repo");
		const nested = path.join(root, "nested");
		await repository(root);
		await repository(nested);
		const linked = path.join(temp.path(), "worktree");
		const admin = path.join(root, ".git", "worktrees", "linked");
		await fs.mkdir(admin, { recursive: true });
		await fs.mkdir(linked);
		await Bun.write(path.join(linked, ".git"), `gitdir: ${admin}\n`);
		await Bun.write(path.join(admin, "commondir"), "../..\n");
		await Bun.write(path.join(admin, "gitdir"), `${path.join(linked, ".git")}\n`);
		await Bun.write(path.join(admin, "HEAD"), "ref: refs/heads/linked\n");
		const plain = path.join(temp.path(), "plain");
		const plainChild = path.join(plain, "child");
		const subdir = path.join(root, "subdir");
		await fs.mkdir(plainChild, { recursive: true });
		await fs.mkdir(subdir);
		const state = path.join(root, "isolated-state");
		const clients = [root, nested, linked, plain, plainChild].map(cwd => new ClientProcess(cwd, state));
		clients.push(new ClientProcess(subdir, state, "legacy"), new ClientProcess(root, state, "global"));
		try {
			const ready = await Promise.all(clients.map(client => client.ready));
			expect(new Set(ready.map(client => client.pid)).size).toBe(clients.length);
			expect(new Set(ready.map(client => client.endpoint)).size).toBe(clients.length);
			const global = ready.at(-1)!;
			expect(global.projectDir).toBe(global.runtimeDir);
			// Runtime state deliberately lives inside a Git repo: an explicit
			// or global client must not normalize that synthetic scope to root.
			expect(global.projectDir).not.toBe(ready[0]!.projectDir);
			for (const client of clients) expect((await client.request({ op: "ping" })).ok).toBe(true);
		} finally {
			await closeClients(clients);
		}
	}, 60_000);

	it("keeps a live legacy client usable beside the root broker and drains only after that client releases it", async () => {
		using temp = TempDir.createSync("@omp-repo-legacy-");
		const root = path.join(temp.path(), "repo");
		const subdir = path.join(root, "subdir");
		await repository(root);
		await fs.mkdir(subdir);
		const state = path.join(temp.path(), "state");
		const old = new ClientProcess(subdir, state, "legacy");
		const clients = [old];
		try {
			const legacy = await old.ready;
			const current = new ClientProcess(subdir, state);
			clients.push(current);
			const normalized = await current.ready;
			expect(normalized.pid).not.toBe(legacy.pid);
			const started = await old.request(service("legacy-work", subdir, "old-session"));
			expect(started.ok).toBe(true);
			expect((await current.request({ op: "list" })).result).toMatchObject({ op: "list", daemons: [] });
			await Bun.sleep(300); // exceed the legacy broker's actual idle grace
			expect((await old.request({ op: "describe", name: "legacy-work" })).result).toMatchObject({ daemon: { state: "ready" } });
			if (process.platform !== "win32") expect((await fs.stat(legacy.endpoint)).isSocket()).toBe(true);
			await old.close();
			clients.splice(clients.indexOf(old), 1);
			await waitForDrain(legacy.runtimeDir);
			expect((await current.request({ op: "ping" })).ok).toBe(true);
		} finally {
			await closeClients(clients);
		}
	}, 30_000);

	it("does not replace another directory's live named service during concurrent starts and preserves command cwd", async () => {
		using temp = TempDir.createSync("@omp-repo-names-");
		const root = path.join(temp.path(), "repo");
		await repository(root);
		const firstDir = path.join(root, "a");
		const secondDir = path.join(root, "b");
		await Promise.all([fs.mkdir(firstDir), fs.mkdir(secondDir)]);
		const clients = [firstDir, secondDir].map(cwd => new ClientProcess(cwd, path.join(temp.path(), "state")));
		try {
			await Promise.all(clients.map(client => client.ready));
			const results = await Promise.all(clients.map((client, index) => client.request(service("server", [firstDir, secondDir][index]!, `session-${index}`))));
			expect(results.filter(result => result.ok)).toHaveLength(1);
			const winner = results.findIndex(result => result.ok);
			const loser = 1 - winner;
			const started = results[winner]!.result!;
			if (started.op !== "start") throw new Error(`Unexpected start response: ${started.op}`);
			const originalId = started.daemon.id;
			const originalPid = started.daemon.pid;
			const collision = await clients[loser]!.request(service("server", [firstDir, secondDir][loser]!, `session-${loser}`));
			expect(collision.ok).toBe(false);
			expect(collision.error).toContain("choose a distinct service name");
			expect((await clients[winner]!.request({ op: "describe", name: "server" })).result).toMatchObject({ daemon: { id: originalId, pid: originalPid, state: "ready" } });
			const described = await clients[winner]!.request({ op: "describe", name: "server" });
			expect(described.result).toMatchObject({ spec: { cwd: [firstDir, secondDir][winner] } });
			expect(() => process.kill(originalPid!, 0)).not.toThrow();
			const logs = await clients[winner]!.request({ op: "logs", name: "server", lines: 100, head: false, follow: false, timeoutMs: 0 });
			expect(JSON.stringify(logs.result)).toContain(await fs.realpath([firstDir, secondDir][winner]!));
			// The same owner may intentionally move its service to another cwd.
			expect((await clients[winner]!.request(service("server", [firstDir, secondDir][loser]!, `session-${winner}`))).ok).toBe(true);
			// Different owners in the same cwd retain the existing replace behavior.
			expect((await clients[loser]!.request(service("server", [firstDir, secondDir][loser]!, "same-cwd-owner"))).ok).toBe(true);
		} finally {
			await closeClients(clients);
		}
	}, 30_000);
});
