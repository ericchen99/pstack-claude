# Workspace pool

Some projects cannot run a writer in a git worktree. Each checkout needs its own containers, ports, and secrets, so the project keeps a fixed set of full clones instead. The project declares them in `.agents/workspace-pool.json`, and the `orch pool` commands lease one clone to one agent at a time.

When a pool is declared, it replaces worktrees for every writer and every live verifier lane. Wherever a playbook gives an agent its own worktree, lease it a pool workspace instead. Never create a worktree inside a pool workspace.

Below, `orch` stands for `bun <plugin>/skills/poteto-mode/scripts/orch/orch.ts`, where `<plugin>` is the installed plugin root. The pool needs no `orch init` store.

## Detect

```bash
bun <plugin>/skills/poteto-mode/scripts/orch/orch.ts pool status
```

The command walks up from the current directory to the nearest `.agents/workspace-pool.json`. `--pool <file>` or `PSTACK_POOL` names another config. Exit 0 means a pool is declared, and each line shows `id state holder since branch dirty path`. A nonzero exit with "no .agents/workspace-pool.json found" means there is no pool, and the playbook's worktree rule applies.

## Lease at spawn

Lease before you spawn the agent. Use the agent's unit id or label as the holder.

```bash
orch pool lease --holder <unit-or-label> --json
```

The result names the workspace `id`, its absolute `path`, its `env`, the pool's `base` branch, and the `prepare` command. A lease is idempotent per holder, so a retry returns the same workspace. The command leases only a workspace that is free and clean. `--id <ws>` asks for one workspace by name. Exit 1 means no workspace is available, and the error names each workspace and why. Wait for a release, or report the shortage. Never share a leased workspace.

## Brief

The brief carries the lease. Write these into it:

- The absolute workspace path. Run every command with `cd <path> && ...`, because the agent's shell may reset its directory between calls.
- The `env` variables. Export them for every command that starts the app, its containers, or its tests.
- The `base` branch. Fetch, then start the work branch from the current `base`.
- The `prepare` command. Run it once in the workspace before the work starts.
- The fence. Write only in this workspace. Never read from or write to another pool workspace, and never create a git worktree.

## Release

The coordinator releases the lease when the agent completes, when its work is abandoned, and when the program stops.

```bash
orch pool release <id> --holder <unit-or-label>
```

Release is idempotent. It refuses a lease that another holder holds. It warns when the workspace is left dirty or off `base`, and it still releases. Clean that workspace before the next lease, because a dirty workspace is never leased.

## Recover

Leases have no timeout. A holder that crashed keeps its lease until someone releases it. Run `orch pool status` first, and confirm that the holder's agent has stopped. Then run `orch --force pool release <id>`.
