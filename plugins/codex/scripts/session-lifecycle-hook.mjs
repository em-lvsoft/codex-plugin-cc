#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { terminateProcessTree } from "./lib/process.mjs";
import { BROKER_ENDPOINT_ENV } from "./lib/app-server.mjs";
import {
  clearBrokerSession,
  LOG_FILE_ENV,
  loadBrokerSession,
  PID_FILE_ENV,
  sendBrokerShutdown,
  teardownBrokerSession
} from "./lib/broker-lifecycle.mjs";
import { loadState, PLUGIN_DATA_ENV, removeJobArtifacts, resolveStateFile, updateState } from "./lib/state.mjs";
import { TRANSCRIPT_PATH_ENV } from "./lib/claude-session-transfer.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import { readHookInput } from "./lib/hook-stdin.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
const HOST_PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const HOOK_STDIN_TIMEOUT_MS = 1000;

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

const MANAGED_ENV_VARS = [SESSION_ID_ENV, TRANSCRIPT_PATH_ENV, PLUGIN_DATA_ENV];

function isManagedExport(line) {
  if (MANAGED_ENV_VARS.some((name) => line.startsWith(`export ${name}=`))) {
    return true;
  }
  // Older versions of this plugin exported the host's generic CLAUDE_PLUGIN_DATA. Other
  // plugins may write that name too, so only drop the line when it carries our value.
  const hostDataDir = process.env[HOST_PLUGIN_DATA_ENV];
  return Boolean(hostDataDir) && line === `export ${HOST_PLUGIN_DATA_ENV}=${shellEscape(hostDataDir)}`;
}

// Rewrite this plugin's exports instead of appending them. SessionStart fires on
// startup, on resume and on every compaction, so appending grew CLAUDE_ENV_FILE by
// three lines every time and nothing ever pruned it. Only the last assignment of a
// name takes effect, so every earlier copy did nothing but grow the file. Claude Code
// inlines the whole file into the single `bash -c <script>` argument, so a long-running
// session eventually pushed that argument past the operating system's limit on the
// length of one argument, and no shell could be started at all.
function writeManagedEnvVars(entries) {
  const envFile = process.env.CLAUDE_ENV_FILE;
  if (!envFile) {
    return;
  }

  let existing = "";
  try {
    existing = fs.readFileSync(envFile, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  const existingLines = existing.split(/\r?\n/).filter((line) => line !== "");
  const managedLines = existingLines.filter(isManagedExport);
  const wanted = entries
    .filter(([, value]) => value != null && value !== "")
    .map(([name, value]) => `export ${name}=${shellEscape(value)}`);

  // Already exactly what we want: leave the file alone.
  if (managedLines.length === wanted.length && wanted.every((line) => managedLines.includes(line))) {
    return;
  }

  // Nothing of ours yet: append. SessionStart hooks of several plugins run in parallel,
  // and an append cannot drop a line a sibling plugin writes at the same moment.
  if (managedLines.length === 0) {
    if (wanted.length > 0) {
      const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
      fs.appendFileSync(envFile, `${separator}${wanted.join("\n")}\n`, "utf8");
    }
    return;
  }

  // Stale or duplicated exports of ours: rewrite, keeping every other plugin's line verbatim.
  const lines = [...existingLines.filter((line) => !isManagedExport(line)), ...wanted];
  const next = lines.length > 0 ? `${lines.join("\n")}\n` : "";

  // Write and rename, so that a reader never sees a half-written file. Fall back to a
  // direct write if Windows refuses the rename because the file is open elsewhere.
  const tmpFile = `${envFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmpFile, next, "utf8");
  try {
    fs.renameSync(tmpFile, envFile);
  } catch {
    fs.writeFileSync(envFile, next, "utf8");
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // Ignore cleanup failures for the temp file.
    }
  }
}

function cleanupSessionJobs(cwd, sessionId) {
  if (!cwd || !sessionId) {
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stateFile = resolveStateFile(workspaceRoot);
  if (!fs.existsSync(stateFile)) {
    return;
  }

  const state = loadState(workspaceRoot);
  const removedJobs = state.jobs.filter((job) => job.sessionId === sessionId);
  if (removedJobs.length === 0) {
    return;
  }

  for (const job of removedJobs) {
    const stillRunning = job.status === "queued" || job.status === "running";
    if (stillRunning) {
      try {
        terminateProcessTree(job.pid ?? Number.NaN);
      } catch {
        // Ignore teardown failures during session shutdown.
      }
    }
    // We own these jobs and are deliberately removing them. saveState's GC
    // now protects active jobs' files (for other sessions' sake), so delete
    // our own artifacts explicitly — otherwise killed jobs leak .json/.log.
    removeJobArtifacts(workspaceRoot, job);
  }

  // Use updateState so the read-modify-write is atomic under the state lock.
  // This prevents a concurrent upsertJob from being silently dropped (and its
  // artifacts deleted) when the stale snapshot loaded above is saved back.
  updateState(workspaceRoot, (currentState) => {
    currentState.jobs = currentState.jobs.filter((job) => job.sessionId !== sessionId);
  });
}

function isQueuedOrRunning(job) {
  return job?.status === "queued" || job?.status === "running";
}

function hasOtherActiveSessionJobs(cwd, sessionId) {
  if (!cwd) {
    return false;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stateFile = resolveStateFile(workspaceRoot);
  if (!fs.existsSync(stateFile)) {
    return false;
  }

  // Read the state file directly rather than via loadState(), which maps
  // read/parse failures to an empty default. An unreadable state file means
  // we cannot prove sole ownership of the broker — fail closed and skip
  // teardown rather than risk killing another session's live work.
  let state;
  try {
    state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return true;
  }
  const jobs = Array.isArray(state?.jobs) ? state.jobs : [];
  return jobs.some((job) => {
    if (!isQueuedOrRunning(job)) {
      return false;
    }
    if (!sessionId || !job.sessionId) {
      return true;
    }
    return job.sessionId !== sessionId;
  });
}

function handleSessionStart(input) {
  writeManagedEnvVars([
    [SESSION_ID_ENV, input.session_id],
    [TRANSCRIPT_PATH_ENV, input.transcript_path],
    [PLUGIN_DATA_ENV, process.env[HOST_PLUGIN_DATA_ENV]]
  ]);
}

async function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  const brokerSession =
    loadBrokerSession(cwd) ??
    (process.env[BROKER_ENDPOINT_ENV]
      ? {
          endpoint: process.env[BROKER_ENDPOINT_ENV],
          pidFile: process.env[PID_FILE_ENV] ?? null,
          logFile: process.env[LOG_FILE_ENV] ?? null
        }
      : null);
  const brokerEndpoint = brokerSession?.endpoint ?? null;
  const pidFile = brokerSession?.pidFile ?? null;
  const logFile = brokerSession?.logFile ?? null;
  const sessionDir = brokerSession?.sessionDir ?? null;
  const pid = brokerSession?.pid ?? null;
  const sessionId = input.session_id || process.env[SESSION_ID_ENV] || null;

  cleanupSessionJobs(cwd, sessionId);
  if (hasOtherActiveSessionJobs(cwd, sessionId)) {
    return;
  }

  if (brokerEndpoint) {
    await sendBrokerShutdown(brokerEndpoint);
  }

  teardownBrokerSession({
    endpoint: brokerEndpoint,
    pidFile,
    logFile,
    sessionDir,
    pid,
    killProcess: terminateProcessTree
  });
  clearBrokerSession(cwd);
}

async function main() {
  // Timed read: a blocking readFileSync(0) throws EAGAIN on non-blocking pipes and can
  // hang on Windows when the write end stays open. SessionEnd only gets ~3s in total.
  const input = await readHookInput(HOOK_STDIN_TIMEOUT_MS);
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    handleSessionStart(input);
    return;
  }

  if (eventName === "SessionEnd") {
    await handleSessionEnd(input);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
