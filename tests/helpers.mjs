import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

// Keep the suite hermetic when it runs from inside a live Claude Code
// session. Two inherited variables otherwise change behavior:
// - CLAUDE_PLUGIN_DATA points at the user's real plugin data directory, so
//   in-process state writes and spawned companions (which inherit it through
//   buildEnv) leak fixture workspaces and job records into that real
//   directory. Pin it to a fresh temp root for the whole test process.
// - CODEX_COMPANION_SESSION_ID makes status/result session-filter jobs that
//   fixtures seed without a sessionId, hiding them. Session-scoped tests set
//   the variable explicitly in the env they compose.
process.env.CLAUDE_PLUGIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "codex-plugin-cc-tests-"));
// This plugin prefers its own CODEX_COMPANION_PLUGIN_DATA export (#683); pin it to the same root.
process.env.CODEX_COMPANION_PLUGIN_DATA = process.env.CLAUDE_PLUGIN_DATA;
delete process.env.CODEX_COMPANION_SESSION_ID;

import {
  clearBrokerSession,
  loadBrokerSession,
  teardownBrokerSession
} from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";

/**
 * Workspaces handed out by makeTempDir, so cleanup can find the brokers that
 * were started for them.
 */
const tempDirs = new Set();

export function makeTempDir(prefix = "codex-plugin-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.add(dir);
  return dir;
}

/**
 * Stop the broker registered for a workspace, if one is still running, and
 * clear its session so nothing later reads a dead PID.
 *
 * The broker is deliberately long-lived so it can be reused across companion
 * invocations, which means nothing in a test run ever shuts it down. Each test
 * that runs the companion therefore leaves a broker and its app-server child
 * behind for the lifetime of the machine.
 *
 * The session file has to go too. It records a bare PID, so leaving it behind
 * for a stable workspace such as the repository root means a later run can read
 * it and signal whatever process has since inherited that PID.
 */
export function stopBrokerFor(cwd) {
  let session = null;
  try {
    session = loadBrokerSession(cwd);
  } catch {
    return;
  }

  if (!session) {
    return;
  }

  try {
    teardownBrokerSession({
      endpoint: session.endpoint ?? null,
      pidFile: session.pidFile ?? null,
      logFile: session.logFile ?? null,
      sessionDir: session.sessionDir ?? null,
      pid: Number.isFinite(session.pid) ? session.pid : null,
      killProcess: (pid) => terminateProcessTree(pid)
    });
  } catch {
    // Best effort: teardown must never fail the suite.
  }

  try {
    clearBrokerSession(cwd);
  } catch {
    // Best effort.
  }
}

/**
 * Stop the brokers of every workspace handed out so far, keeping the directories.
 * Run after each test so brokers do not pile up over a long suite: each one is an
 * idle node process plus its app-server child until the suite ends.
 */
export function stopTempBrokers() {
  for (const cwd of tempDirs) {
    stopBrokerFor(cwd);
  }
}

/**
 * Tear down every workspace created by makeTempDir: stop its broker, then
 * remove the directory. Extra workspaces (for example the repository root,
 * which some tests use as the companion cwd) can be passed in.
 */
export function cleanupTempWorkspaces(extraWorkspaces = []) {
  for (const cwd of [...tempDirs, ...extraWorkspaces]) {
    stopBrokerFor(cwd);
  }

  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort: a leftover temp dir is not worth failing the suite over.
    }
  }

  tempDirs.clear();
}

export function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { encoding: "utf8", mode: 0o755 });
}

export function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    timeout: options.timeout,
    shell: options.shell ?? (process.platform === "win32" && !path.isAbsolute(command)),
    windowsHide: true
  });
}

export function initGitRepo(cwd) {
  run("git", ["init", "-b", "main"], { cwd });
  run("git", ["config", "user.name", "Codex Plugin Tests"], { cwd });
  run("git", ["config", "user.email", "tests@example.com"], { cwd });
  run("git", ["config", "commit.gpgsign", "false"], { cwd });
  run("git", ["config", "tag.gpgsign", "false"], { cwd });
}
