import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import {
  access,
  link,
  mkdir,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { UserError } from "./store.ts";

const CONFIG_DIR = ".agents";
const CONFIG_FILE = "workspace-pool.json";
const LEASE_DIR = "pool-leases";
const GIT_TIMEOUT_MS = 30_000;

export interface Workspace {
  readonly id: string;
  readonly path: string;
  readonly env: Readonly<Record<string, string>>;
  readonly note: string | null;
}

export interface Pool {
  readonly config: string;
  readonly leaseDir: string;
  readonly base: string;
  readonly prepare: string | null;
  readonly workspaces: readonly Workspace[];
}

export interface Lease {
  readonly id: string;
  readonly holder: string;
  readonly since: string;
}

export type Occupancy =
  | { readonly state: "free" }
  | {
      readonly state: "leased";
      readonly holder: string;
      readonly since: string;
    };

export type WorkspaceStatus = Occupancy & {
  readonly id: string;
  readonly branch: string;
  readonly dirty: boolean;
  readonly path: string;
};

export interface LeaseGrant {
  readonly id: string;
  readonly path: string;
  readonly env: Readonly<Record<string, string>>;
  readonly base: string;
  readonly prepare: string | null;
  readonly holder: string;
  readonly since: string;
}

export type ReleaseOutcome =
  | { readonly outcome: "already-free" }
  | { readonly outcome: "released"; readonly holder: string | null };

export type ReleaseResult = ReleaseOutcome & {
  readonly id: string;
  readonly warnings: readonly string[];
};

function errorCode(error: unknown): string | null {
  return error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function git(path: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", path, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: GIT_TIMEOUT_MS,
  }).trim();
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function discoverConfig(cwd: string): Promise<string> {
  let directory = resolve(cwd);
  for (;;) {
    const candidate = join(directory, CONFIG_DIR, CONFIG_FILE);
    if (await exists(candidate)) {
      return candidate;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      throw new UserError(
        `no ${CONFIG_DIR}/${CONFIG_FILE} found from ${cwd} upward; pass --pool <file> or set PSTACK_POOL`
      );
    }
    directory = parent;
  }
}

// A config inside .agents/ is anchored at the directory that holds .agents/,
// so workspace paths and the lease directory read the same whether the file
// was discovered or passed with --pool.
function poolRoot(config: string): string {
  const directory = dirname(config);
  return basename(directory) === CONFIG_DIR ? dirname(directory) : directory;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new UserError(`${label} must be a non-empty string`);
  }
  return value;
}

function parseEnv(value: unknown, label: string): Record<string, string> {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new UserError(`${label} must be an object of strings`);
  }
  const env: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new UserError(
        `${label} has an invalid variable name ${JSON.stringify(key)}`
      );
    }
    if (typeof entry !== "string") {
      throw new UserError(`${label}.${key} must be a string`);
    }
    env[key] = entry;
  }
  return env;
}

function parseWorkspace(
  value: unknown,
  index: number,
  root: string
): Workspace {
  const label = `workspaces[${index}]`;
  if (!isRecord(value)) {
    throw new UserError(`${label} must be an object`);
  }
  const id = requiredString(value.id, `${label}.id`);
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id === "." || id === "..") {
    throw new UserError(
      `${label}.id ${JSON.stringify(id)} must match [A-Za-z0-9._-]+`
    );
  }
  const written = requiredString(value.path, `workspace ${id} path`);
  const absolute = isAbsolute(written) ? written : resolve(root, written);
  let path: string;
  try {
    path = realpathSync(absolute);
  } catch {
    throw new UserError(`workspace ${id} path ${absolute} does not exist`);
  }
  try {
    if (git(path, ["rev-parse", "--is-inside-work-tree"]) !== "true") {
      throw new Error("not a work tree");
    }
  } catch {
    throw new UserError(`workspace ${id} path ${path} is not a git work tree`);
  }
  if (value.note !== undefined && typeof value.note !== "string") {
    throw new UserError(`workspace ${id} note must be a string`);
  }
  return {
    id,
    path,
    env: parseEnv(value.env, `workspace ${id} env`),
    note: value.note ?? null,
  };
}

function parsePool(config: string, text: string): Pool {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new UserError(
      `${config} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!isRecord(raw)) {
    throw new UserError(`${config} must hold a JSON object`);
  }
  if (raw.prepare !== undefined && typeof raw.prepare !== "string") {
    throw new UserError(`${config}: prepare must be a string`);
  }
  if (!Array.isArray(raw.workspaces) || raw.workspaces.length === 0) {
    throw new UserError(`${config}: workspaces must be a non-empty array`);
  }
  const root = poolRoot(config);
  const workspaces: Workspace[] = [];
  for (const [index, entry] of raw.workspaces.entries()) {
    const workspace = parseWorkspace(entry, index, root);
    if (workspaces.some((other) => other.id === workspace.id)) {
      throw new UserError(`${config}: duplicate workspace id ${workspace.id}`);
    }
    const shared = workspaces.find((other) => other.path === workspace.path);
    if (shared !== undefined) {
      throw new UserError(
        `${config}: workspaces ${shared.id} and ${workspace.id} share the path ${workspace.path}`
      );
    }
    workspaces.push(workspace);
  }
  return {
    config,
    leaseDir: join(root, CONFIG_DIR, LEASE_DIR),
    base: requiredString(raw.base, `${config}: base`),
    prepare: raw.prepare?.trim() ? raw.prepare : null,
    workspaces,
  };
}

export async function loadPool({
  cwd,
  file,
}: {
  cwd: string;
  file?: string;
}): Promise<Pool> {
  const config =
    file === undefined || file.trim().length === 0
      ? await discoverConfig(cwd)
      : resolve(cwd, file);
  let text: string;
  try {
    text = await readFile(config, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new UserError(`pool config ${config} does not exist`);
    }
    throw error;
  }
  return parsePool(config, text);
}

function leasePath(pool: Pool, id: string): string {
  return join(pool.leaseDir, `${id}.json`);
}

async function readLease(pool: Pool, id: string): Promise<Lease | null> {
  const path = leasePath(pool, id);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return null;
    }
    throw error;
  }
  try {
    const raw: unknown = JSON.parse(text);
    if (
      isRecord(raw) &&
      raw.id === id &&
      typeof raw.holder === "string" &&
      typeof raw.since === "string"
    ) {
      return { id, holder: raw.holder, since: raw.since };
    }
  } catch {}
  throw new UserError(
    `lease file ${path} is unreadable; check orch pool status, then run orch pool release ${id} --force`
  );
}

function occupancy(lease: Lease | null): Occupancy {
  return lease === null
    ? { state: "free" }
    : { state: "leased", holder: lease.holder, since: lease.since };
}

function observe(workspace: Workspace): { branch: string; dirty: boolean } {
  return {
    branch: git(workspace.path, ["branch", "--show-current"]) || "(detached)",
    dirty: git(workspace.path, ["status", "--porcelain"]).length > 0,
  };
}

function findWorkspace(pool: Pool, id: string): Workspace {
  const workspace = pool.workspaces.find((candidate) => candidate.id === id);
  if (workspace === undefined) {
    throw new UserError(
      `no workspace ${id} in ${pool.config}; ids are ${pool.workspaces.map((w) => w.id).join(", ")}`
    );
  }
  return workspace;
}

export async function poolStatus(pool: Pool): Promise<WorkspaceStatus[]> {
  return Promise.all(
    pool.workspaces.map(async (workspace) => ({
      id: workspace.id,
      ...occupancy(await readLease(pool, workspace.id)),
      ...observe(workspace),
      path: workspace.path,
    }))
  );
}

// The lease is written whole to a private file, then hard-linked into place.
// link fails with EEXIST when another leaser won, so the claim is the mutex
// and a crash leaves at most a stray temp file, never a half-written lease.
async function claim(pool: Pool, lease: Lease): Promise<boolean> {
  await mkdir(pool.leaseDir, { recursive: true });
  const target = leasePath(pool, lease.id);
  const temporary = join(
    pool.leaseDir,
    `.${lease.id}.${process.pid}.${randomUUID()}.tmp`
  );
  try {
    await writeFile(temporary, `${JSON.stringify(lease, null, 2)}\n`, {
      flag: "wx",
    });
    await link(temporary, target);
    return true;
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      return false;
    }
    throw error;
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

function grant(pool: Pool, workspace: Workspace, lease: Lease): LeaseGrant {
  return {
    id: workspace.id,
    path: workspace.path,
    env: workspace.env,
    base: pool.base,
    prepare: pool.prepare,
    holder: lease.holder,
    since: lease.since,
  };
}

function requiredHolder(holder: string): string {
  const cleaned = holder.replace(/[\t\n\r]/g, " ").trim();
  if (cleaned.length === 0) {
    throw new UserError("holder must not be empty");
  }
  return cleaned;
}

export async function leaseWorkspace(
  pool: Pool,
  { holder: rawHolder, id }: { holder: string; id?: string }
): Promise<LeaseGrant> {
  const holder = requiredHolder(rawHolder);
  const named = id === undefined ? null : findWorkspace(pool, id);
  const leases = await Promise.all(
    pool.workspaces.map((workspace) => readLease(pool, workspace.id))
  );
  const held = leases.find((lease) => lease?.holder === holder);
  if (held != null) {
    if (named !== null && named.id !== held.id) {
      throw new UserError(
        `${holder} already holds ${held.id}; release it before leasing ${named.id}`
      );
    }
    return grant(pool, findWorkspace(pool, held.id), held);
  }

  const candidates = named === null ? pool.workspaces : [named];
  const reasons: string[] = [];
  for (const workspace of candidates) {
    const current = await readLease(pool, workspace.id);
    if (current !== null) {
      reasons.push(
        `${workspace.id} leased by ${current.holder} since ${current.since}`
      );
      continue;
    }
    if (observe(workspace).dirty) {
      reasons.push(`${workspace.id} dirty`);
      continue;
    }
    const lease = { id: workspace.id, holder, since: new Date().toISOString() };
    if (await claim(pool, lease)) {
      return grant(pool, workspace, lease);
    }
    const winner = await readLease(pool, workspace.id);
    if (winner?.holder === holder) {
      return grant(pool, workspace, winner);
    }
    reasons.push(
      `${workspace.id} leased by ${winner?.holder ?? "another holder"} (lost the race)`
    );
  }
  throw new UserError(
    named === null
      ? `no free clean workspace in ${pool.config}: ${reasons.join("; ")}`
      : `workspace ${named.id} is unavailable: ${reasons.join("; ")}`
  );
}

export async function releaseWorkspace(
  pool: Pool,
  {
    id,
    holder: rawHolder,
    force,
  }: { id: string; holder?: string; force: boolean }
): Promise<ReleaseResult> {
  const workspace = findWorkspace(pool, id);
  const holder =
    rawHolder === undefined ? undefined : requiredHolder(rawHolder);
  let lease: Lease | null = null;
  try {
    lease = await readLease(pool, id);
  } catch (error) {
    if (!(force && error instanceof UserError)) {
      throw error;
    }
  }
  if (
    lease !== null &&
    holder !== undefined &&
    lease.holder !== holder &&
    !force
  ) {
    throw new UserError(
      `${id} is leased by ${lease.holder}, not ${holder}; pass --force to release it anyway`
    );
  }
  let outcome: ReleaseOutcome = { outcome: "already-free" };
  try {
    await unlink(leasePath(pool, id));
    outcome = { outcome: "released", holder: lease?.holder ?? null };
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      throw error;
    }
  }
  const { branch, dirty } = observe(workspace);
  const warnings: string[] = [];
  if (dirty) {
    warnings.push(`${id} has uncommitted changes at ${workspace.path}`);
  }
  if (branch !== pool.base) {
    warnings.push(`${id} is on ${branch}, not ${pool.base}`);
  }
  return { id, ...outcome, warnings };
}
