# @oh-my-pi/pi-coding-agent

Core implementation package for the `omp` coding agent in the `omp` monorepo.

For installation, setup, provider configuration, model roles, slash commands, and full CLI reference, see:

- [Monorepo README (local)](../../README.md)
- [Monorepo README (GitHub)](https://github.com/can1357/oh-my-pi#readme)

Package-specific references:

- [CHANGELOG](./CHANGELOG.md)
- [MCP configuration guide](../../docs/mcp-config.md)
- [MCP runtime lifecycle](../../docs/mcp-runtime-lifecycle.md)
- [MCP server/tool authoring](../../docs/mcp-server-tool-authoring.md)
- [DEVELOPMENT](./DEVELOPMENT.md)

## Bash visualization

Embedded-shell calls default to Python-like **Pseudo**; switch to **Raw** for the original command. Syntax appears incrementally as the shell compiles it. Active commands retain their colors while inactive code fades; only failures get `×`. Values appear beside each variable's latest observed setter.

In Tern, the toggle and menu stay in the command segment; replay controls live in the inspector. In the inspector, `v` toggles Raw/Pseudo; `c/i/d/e/u` toggle color, inline variables, idioms, effects and embedded programs; `s` splits original/Pseudo. Space plays or pauses retained execution, arrows step, `r` resets, `l` returns live, and `−/+` changes speed. Escape closes.

Replay retains up to 20,000 records, 2 MiB output and 8 MiB payload; evictions are indicated. Effect badges are heuristic, not safety guarantees. Remote-script interiors are marked untraced; PTY/user-shell calls keep their plain command view.

## Memory backends

The agent supports three mutually-exclusive memory backends, selected via the `memory.backend` setting (Settings → Memory tab, or `~/.omp/config.yml`):

- `off` (default) — no memory subsystem runs.
- `local` — existing rollout-summarisation pipeline; writes `memory_summary.md` and consolidated artifacts under the agent dir.
- `hindsight` — talks to a [Hindsight](https://hindsight.vectorize.io) server (Cloud or self-hosted Docker), retains transcripts every Nth user turn, recalls memories on the first turn of a session, and exposes `retain`, `recall`, and `reflect`.

### Hindsight quickstart

1. Run a Hindsight server (Cloud or `docker run -p 8888:8888 ghcr.io/vectorize-io/hindsight:latest`).
2. Set `memory.backend = "hindsight"` and `hindsight.apiUrl = "http://localhost:8888"` (or your Cloud URL).
3. Optional environment overrides (env wins over settings):
   - `HINDSIGHT_API_URL`, `HINDSIGHT_API_TOKEN` — connection
   - `HINDSIGHT_BANK_ID`, `HINDSIGHT_DYNAMIC_BANK_ID`, `HINDSIGHT_AGENT_NAME` — bank addressing
   - `HINDSIGHT_AUTO_RECALL`, `HINDSIGHT_AUTO_RETAIN`, `HINDSIGHT_RETAIN_MODE` — lifecycle
   - `HINDSIGHT_RECALL_BUDGET`, `HINDSIGHT_RECALL_MAX_TOKENS` — recall sizing
   - `HINDSIGHT_BANK_MISSION`, `HINDSIGHT_DEBUG`

Switching backends mid-session immediately replaces the live backend, memory tools, listeners, and system-prompt context. Existing users with `memories.enabled = true|false` are migrated to `memory.backend = "local"|"off"` exactly once on first launch; afterward, `memory.backend` is the sole runtime selector.

## Broker scope

Default broker clients and project-presence leases share the canonical root of
the nearest Git **worktree**, including when launched from subdirectories or
through symlinks. Nested repositories and linked worktrees have separate scopes;
the Git common directory is not the scope key. Non-Git, missing and inaccessible
directories retain directory scope. Per-user state storage remains unchanged.
Global services and explicit runtime-directory overrides remain isolated.
Commands still run in their requested working directory, not the scope root.
Standalone stream endpoints retain their existing directory scope.

Service names are shared across the worktree. A different session cannot
implicitly replace a live same-named service launched from another directory;
choose distinct service names. Same-directory and explicit same-session
replacement retain their existing behavior.

### How to drain directory-scoped brokers after upgrading

1. Inspect existing scopes with `omp ps --all`. Legacy directory-scoped brokers
   and the new root-scoped broker may coexist during the transition.
2. Keep active sessions running until their work is finished. Upgrading does not
   move their sockets, tokens, records or presence files, disconnect their
   clients, or send them a shutdown signal.
3. Close legacy sessions normally. Their brokers use the existing idle grace
   after the last client and presence lease are released. Persistent services
   keep their broker alive; stop those services deliberately in their owning
   session or select their legacy scope in the interactive `omp ps --all` monitor
   when it is safe to do so. Detached work is not migrated or killed.
4. Start new sessions with the upgraded version. Root and subdirectory sessions
   now share one broker. Use `omp ps --all` to check that legacy scopes have no
   live owners after draining.

Do not delete runtime directories or kill brokers to force convergence. There
is no instantaneous singleton guarantee across old directory-scoped and new
root-scoped binaries: old versions cannot participate in the new election, and
may start additional legacy scopes. Avoid starting the same named work in both
generations during the transition. New brokers do not discover, adopt, rename
or restart legacy services.
