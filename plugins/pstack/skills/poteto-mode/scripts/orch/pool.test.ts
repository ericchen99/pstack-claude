import { afterEach, describe, expect, it } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "orch.ts");
const directories: string[] = [];

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

function git(repo: string, args: readonly string[]): void {
  const result = Bun.spawnSync([
    "git",
    "-C",
    repo,
    "-c",
    "user.name=Pool Test",
    "-c",
    "user.email=pool@example.com",
    ...args,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

async function makePool({
  ids = ["ws1", "ws2"],
  config,
}: {
  ids?: readonly string[];
  config?: unknown;
} = {}): Promise<string> {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "orch-pool-")));
  directories.push(root);
  for (const id of ids) {
    const repo = join(root, id);
    await mkdir(repo);
    git(repo, ["init", "--initial-branch=main"]);
    git(repo, ["commit", "--allow-empty", "-m", "init"]);
  }
  await mkdir(join(root, ".agents"));
  await writeFile(
    join(root, ".agents", "workspace-pool.json"),
    JSON.stringify(
      config ?? {
        base: "main",
        prepare: "make up",
        workspaces: ids.map((id, index) => ({
          id,
          path: id,
          env: { ENV: String(index + 1) },
        })),
      }
    )
  );
  return root;
}

function env(): Record<string, string | undefined> {
  return { PATH: process.env.PATH, HOME: process.env.HOME };
}

function runCli(cwd: string, args: readonly string[]): RunResult {
  const result = Bun.spawnSync([process.execPath, SCRIPT, ...args], {
    cwd,
    env: env(),
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function scrub(text: string, root: string): string {
  return text
    .replaceAll(root, "<root>")
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, "<since>");
}

function run(root: string, args: readonly string[], cwd = root): RunResult {
  const result = runCli(cwd, args);
  return {
    code: result.code,
    stdout: scrub(result.stdout, root),
    stderr: scrub(result.stderr, root),
  };
}

describe("orch pool", () => {
  it("shows every workspace of a fresh pool as free and clean", async () => {
    const root = await makePool();
    expect(run(root, ["pool", "status"])).toEqual({
      code: 0,
      stdout:
        "ws1\tfree\t-\t-\tmain\tclean\t<root>/ws1\n" +
        "ws2\tfree\t-\t-\tmain\tclean\t<root>/ws2\n",
      stderr: "",
    });
    expect(JSON.parse(run(root, ["--json", "pool", "status"]).stdout)).toEqual([
      {
        id: "ws1",
        state: "free",
        branch: "main",
        dirty: false,
        path: "<root>/ws1",
      },
      {
        id: "ws2",
        state: "free",
        branch: "main",
        dirty: false,
        path: "<root>/ws2",
      },
    ]);
  });

  it("leases the first clean free workspace, again for the same holder, and the next for another", async () => {
    const root = await makePool();
    const first = run(root, ["pool", "lease", "--holder", "unit-a"]);
    expect(first).toEqual({
      code: 0,
      stdout: "ws1\t<root>/ws1\tENV=1\tbase=main\tprepare=make up\n",
      stderr: "",
    });
    expect(run(root, ["pool", "lease", "--holder", "unit-a"])).toEqual(first);
    expect(
      JSON.parse(
        run(root, ["--json", "pool", "lease", "--holder", "unit-b"]).stdout
      )
    ).toEqual({
      id: "ws2",
      path: "<root>/ws2",
      env: { ENV: "2" },
      base: "main",
      prepare: "make up",
      holder: "unit-b",
      since: "<since>",
    });
    expect(run(root, ["pool", "status"]).stdout).toBe(
      "ws1\tleased\tunit-a\t<since>\tmain\tclean\t<root>/ws1\n" +
        "ws2\tleased\tunit-b\t<since>\tmain\tclean\t<root>/ws2\n"
    );
  });

  it("skips a dirty workspace and names each reason when the pool is exhausted", async () => {
    const root = await makePool();
    await writeFile(join(root, "ws1", "scratch.txt"), "left behind\n");
    expect(run(root, ["pool", "lease", "--holder", "unit-a"]).stdout).toBe(
      "ws2\t<root>/ws2\tENV=2\tbase=main\tprepare=make up\n"
    );
    expect(run(root, ["pool", "lease", "--holder", "unit-b"])).toEqual({
      code: 1,
      stdout: "",
      stderr:
        "error: no free clean workspace in <root>/.agents/workspace-pool.json: " +
        "ws1 dirty; ws2 leased by unit-a since <since>\n",
    });
  });

  it("refuses a named workspace another holder leases", async () => {
    const root = await makePool();
    run(root, ["pool", "lease", "--holder", "unit-a"]);
    expect(
      run(root, ["pool", "lease", "--holder", "unit-b", "--id", "ws1"])
    ).toEqual({
      code: 1,
      stdout: "",
      stderr:
        "error: workspace ws1 is unavailable: ws1 leased by unit-a since <since>\n",
    });
    expect(
      run(root, ["pool", "lease", "--holder", "unit-b", "--id", "ws2"]).stdout
    ).toBe("ws2\t<root>/ws2\tENV=2\tbase=main\tprepare=make up\n");
  });

  it("prints a leased workspace's brief block and refuses a free one", async () => {
    const root = await makePool({
      ids: ["ws1"],
      config: {
        base: "main",
        workspaces: [
          {
            id: "ws1",
            path: "ws1",
            env: { ENV: "1", GREETING: "it's on" },
            note: "web on :10000, db minty1",
          },
        ],
      },
    });
    expect(run(root, ["pool", "brief", "ws1"])).toEqual({
      code: 1,
      stdout: "",
      stderr:
        "error: ws1 is not leased; run orch pool lease --holder <unit> first\n",
    });
    run(root, ["pool", "lease", "--holder", "unit-a"]);
    expect(run(root, ["pool", "brief", "ws1"])).toEqual({
      code: 0,
      stdout: [
        "WORKSPACE    ws1, leased to unit-a since <since>",
        "CLONE        <root>/ws1",
        "             run every command as cd <root>/ws1 && ...",
        "ENV          export ENV=1; export GREETING='it'\\''s on'",
        "BASE         fetch, then start the work branch from the current main",
        "PREPARE      (none)",
        "NOTE         web on :10000, db minty1",
        "FIRST        read this clone's CLAUDE.md or AGENTS.md; you started outside it, so they did not load",
        "FENCE        write only in <root>/ws1; never touch another pool workspace;",
        "             never create a git worktree; no gt outside this clone",
        "",
      ].join("\n"),
      stderr: "",
    });
  });

  it("releases idempotently and refuses the wrong holder unless forced", async () => {
    const root = await makePool();
    run(root, ["pool", "lease", "--holder", "unit-a"]);
    expect(run(root, ["pool", "release", "ws1", "--holder", "unit-b"])).toEqual(
      {
        code: 1,
        stdout: "",
        stderr:
          "error: ws1 is leased by unit-a, not unit-b; pass --force to release it anyway\n",
      }
    );
    expect(
      run(root, ["--force", "pool", "release", "ws1", "--holder", "unit-b"])
    ).toEqual({ code: 0, stdout: "ws1\treleased\tunit-a\n", stderr: "" });
    expect(run(root, ["pool", "release", "ws1"])).toEqual({
      code: 0,
      stdout: "ws1\talready free\n",
      stderr: "",
    });
    expect(run(root, ["pool", "status"]).stdout).toBe(
      "ws1\tfree\t-\t-\tmain\tclean\t<root>/ws1\n" +
        "ws2\tfree\t-\t-\tmain\tclean\t<root>/ws2\n"
    );
  });

  it("warns when a released workspace is dirty or off base", async () => {
    const root = await makePool();
    run(root, ["pool", "lease", "--holder", "unit-a"]);
    git(join(root, "ws1"), ["checkout", "-b", "feature"]);
    await writeFile(join(root, "ws1", "scratch.txt"), "left behind\n");
    expect(run(root, ["pool", "release", "ws1", "--holder", "unit-a"])).toEqual(
      {
        code: 0,
        stdout: "ws1\treleased\tunit-a\n",
        stderr:
          "warning: ws1 has uncommitted changes at <root>/ws1\n" +
          "warning: ws1 is on feature, not main\n",
      }
    );
  });

  it("finds the config by walking up from a nested directory, or takes --pool", async () => {
    const root = await makePool();
    const nested = join(root, "ws2", "src", "deep");
    await mkdir(nested, { recursive: true });
    expect(
      run(root, ["pool", "lease", "--holder", "unit-a"], nested).stdout
    ).toBe("ws1\t<root>/ws1\tENV=1\tbase=main\tprepare=make up\n");

    const elsewhere = realpathSync(await mkdtemp(join(tmpdir(), "orch-cwd-")));
    directories.push(elsewhere);
    expect(run(root, ["pool", "status"], elsewhere)).toEqual({
      code: 1,
      stdout: "",
      stderr: `error: no .agents/workspace-pool.json found from ${elsewhere} upward; pass --pool <file> or set PSTACK_POOL\n`,
    });
    expect(
      run(
        root,
        [
          "pool",
          "--pool",
          join(root, ".agents", "workspace-pool.json"),
          "status",
        ],
        elsewhere
      ).stdout
    ).toBe(
      "ws1\tleased\tunit-a\t<since>\tmain\tclean\t<root>/ws1\n" +
        "ws2\tfree\t-\t-\tmain\tclean\t<root>/ws2\n"
    );
  });

  it("rejects a duplicate id, a missing path, and a path outside git", async () => {
    const duplicate = await makePool({
      config: {
        base: "main",
        workspaces: [
          { id: "ws1", path: "ws1" },
          { id: "ws1", path: "ws2" },
        ],
      },
    });
    expect(run(duplicate, ["pool", "status"]).stderr).toBe(
      "error: <root>/.agents/workspace-pool.json: duplicate workspace id ws1\n"
    );

    const missing = await makePool({
      config: { base: "main", workspaces: [{ id: "ws9", path: "ws9" }] },
    });
    expect(run(missing, ["pool", "status"])).toEqual({
      code: 1,
      stdout: "",
      stderr: "error: workspace ws9 path <root>/ws9 does not exist\n",
    });

    const plain = await makePool({
      config: { base: "main", workspaces: [{ id: "plain", path: ".agents" }] },
    });
    expect(run(plain, ["pool", "status"]).stderr).toBe(
      "error: workspace plain path <root>/.agents is not a git work tree\n"
    );

    const badId = await makePool({
      config: { base: "main", workspaces: [{ id: "a/b", path: "ws1" }] },
    });
    expect(run(badId, ["pool", "status"]).stderr).toBe(
      'error: workspaces[0].id "a/b" must match [A-Za-z0-9._-]+\n'
    );
  });

  it("gives k of N racing leasers k distinct workspaces and refuses the rest", async () => {
    const ids = ["ws1", "ws2", "ws3"];
    const root = await makePool({ ids });
    const racers = Array.from({ length: 8 }, (_, index) =>
      Bun.spawn(
        [
          process.execPath,
          SCRIPT,
          "--json",
          "pool",
          "lease",
          "--holder",
          `racer-${index}`,
        ],
        { cwd: root, env: env(), stdout: "pipe", stderr: "pipe" }
      )
    );
    const results = await Promise.all(
      racers.map(async (racer) => ({
        code: await racer.exited,
        stdout: await new Response(racer.stdout).text(),
      }))
    );
    const winners = results.filter((result) => result.code === 0);
    expect(
      winners.map((result) => JSON.parse(result.stdout).id).sort()
    ).toEqual(ids);
    expect(results.map((result) => result.code).sort()).toEqual([
      0, 0, 0, 1, 1, 1, 1, 1,
    ]);
    expect(
      (await readdir(join(root, ".agents", "pool-leases"))).sort()
    ).toEqual(["ws1.json", "ws2.json", "ws3.json"]);
  });
});
