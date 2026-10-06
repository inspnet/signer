import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "../config.js";

const run = promisify(execFile);

/**
 * Self-update from the portal.
 *
 * The service runs as an unprivileged user with a read-only view of its own
 * code, so it never updates itself. It only drops a request file into its data
 * directory. On a server set up by deploy/install.sh, a systemd path unit
 * (signer-update.path) sees the file and starts a root-owned updater that pulls
 * the code, builds it as the service user, restarts Signer, and rolls back if
 * the new version does not come up. The request's contents are ignored, so the
 * portal can only ask for "the latest commit of the branch already installed".
 */

export type Version = { commit: string; date: string; subject: string; branch: string; remote: string };

export type UpdateCheck = {
  current: Version;
  latest: { commit: string; date?: string; subject?: string };
  updateAvailable: boolean;
  /** Commits between the installed and the latest version, newest first (GitHub remotes only). */
  commits: Array<{ commit: string; date: string; subject: string; author: string }>;
  /** True when the update changes deploy/install.sh, which the portal updater does not re-run. */
  installerChanged: boolean;
  checkedAt: string;
};

export type UpdateStatus = {
  state: "idle" | "requested" | "running" | "succeeded" | "failed" | "rolled-back" | "current";
  message: string;
  from?: string;
  to?: string;
  startedAt?: string;
  finishedAt?: string;
  log: string[];
};

const appDir = () => process.cwd();
const updateDir = () => path.join(config.dataDir, "update");

/** Only installs made by deploy/install.sh have the updater wired up. */
export function updaterAvailable(): boolean {
  return fs.existsSync(updateDir()) && fs.existsSync(path.join(appDir(), ".git"));
}

async function git(...args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", appDir(), ...args], {
    timeout: 20_000,
    env: { ...process.env, HOME: config.dataDir, GIT_TERMINAL_PROMPT: "0" }
  });
  return stdout.trim();
}

export async function currentVersion(): Promise<Version> {
  const [line, branch, remote] = await Promise.all([
    git("log", "-1", "--format=%H%x09%cI%x09%s"),
    git("rev-parse", "--abbrev-ref", "HEAD"),
    git("config", "--get", "remote.origin.url").catch(() => "")
  ]);
  const [commit = "", date = "", ...subject] = line.split("\t");
  return { commit, date, subject: subject.join("\t"), branch, remote };
}

/** owner/repo for a github.com remote, else null. */
export function githubRepo(remote: string): { owner: string; repo: string } | null {
  const match = remote.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  return match ? { owner: match[1]!, repo: match[2]! } : null;
}

let cached: UpdateCheck | null = null;
const CACHE_MS = 5 * 60 * 1000;

export async function checkForUpdates(options: { force?: boolean; fetchImpl?: typeof fetch } = {}): Promise<UpdateCheck> {
  if (!options.force && cached && Date.now() - Date.parse(cached.checkedAt) < CACHE_MS) return cached;
  const current = await currentVersion();
  // ls-remote reads the remote without writing to the (read-only) checkout.
  const lsRemote = await git("ls-remote", "origin", `refs/heads/${current.branch}`);
  const latestCommit = lsRemote.split(/\s+/)[0] ?? "";
  if (!latestCommit) throw new Error(`The remote has no branch named ${current.branch}.`);

  const result: UpdateCheck = {
    current,
    latest: { commit: latestCommit },
    updateAvailable: latestCommit !== current.commit,
    commits: [],
    installerChanged: false,
    checkedAt: new Date().toISOString()
  };

  const gh = githubRepo(current.remote);
  if (gh && result.updateAvailable) {
    const changes = await githubChanges(gh, current.commit, latestCommit, options.fetchImpl ?? fetch);
    if (changes) {
      result.commits = changes.commits;
      result.installerChanged = changes.installerChanged;
      const newest = changes.commits[0];
      if (newest) result.latest = { commit: latestCommit, date: newest.date, subject: newest.subject };
    }
  }
  cached = result;
  return result;
}

/**
 * What changed between two commits, from GitHub's compare API (public repos
 * need no token). Returns null on any failure: the commit list is a nicety and
 * the update check itself does not depend on it.
 */
export async function githubChanges(
  gh: { owner: string; repo: string },
  base: string,
  head: string,
  fetchImpl: typeof fetch
): Promise<{ commits: UpdateCheck["commits"]; installerChanged: boolean } | null> {
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${gh.owner}/${gh.repo}/compare/${base}...${head}`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "signer-updater" },
      signal: AbortSignal.timeout(10_000)
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      commits?: Array<{ sha: string; commit: { message: string; author?: { name?: string; date?: string }; committer?: { date?: string } } }>;
      files?: Array<{ filename: string }>;
    };
    return {
      commits: (body.commits ?? [])
        .map((c) => ({
          commit: c.sha,
          date: c.commit.committer?.date ?? c.commit.author?.date ?? "",
          subject: c.commit.message.split("\n")[0] ?? "",
          author: c.commit.author?.name ?? ""
        }))
        .reverse(),
      installerChanged: (body.files ?? []).some((f) => f.filename === "deploy/install.sh")
    };
  } catch {
    return null;
  }
}

function readStatusFile(): Omit<UpdateStatus, "log"> | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(updateDir(), "status.json"), "utf8")) as Omit<UpdateStatus, "log">;
  } catch {
    return null;
  }
}

export function updateStatus(): UpdateStatus {
  let log: string[] = [];
  try {
    log = fs.readFileSync(path.join(updateDir(), "last.log"), "utf8").trimEnd().split("\n").slice(-80);
  } catch {
    /* no update has run yet */
  }
  const status = readStatusFile();
  if (fs.existsSync(path.join(updateDir(), "request")) && status?.state !== "running") {
    return { state: "requested", message: "Waiting for the updater to start…", log };
  }
  return status ? { ...status, log } : { state: "idle", message: "No update has been run from the portal yet.", log };
}

export class UpdateUnavailableError extends Error {}

export function requestUpdate(requestedBy: string): void {
  if (!updaterAvailable()) {
    throw new UpdateUnavailableError(
      "Updating from the portal needs an install made with deploy/install.sh. Re-run the installer on the server once to enable it."
    );
  }
  const state = updateStatus().state;
  if (state === "requested" || state === "running") throw new UpdateUnavailableError("An update is already in progress.");
  // The updater ignores the contents; they are only for whoever reads the file.
  fs.writeFileSync(path.join(updateDir(), "request"), `${new Date().toISOString()} ${requestedBy}\n`);
  cached = null;
}
