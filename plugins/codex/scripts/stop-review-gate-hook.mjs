#!/usr/bin/env node

import process from "node:process";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { getCodexAvailability } from "./lib/codex.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import { getConfig, listJobs } from "./lib/state.mjs";
import { formatStopReviewProcessFailure, parseStopReviewPayload } from "./lib/stop-review-output.mjs";
import { sortJobsNewestFirst } from "./lib/job-control.mjs";
import { reapDeadJobs, SESSION_ID_ENV } from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import { readHookInput } from "./lib/hook-stdin.mjs";

const STOP_REVIEW_TIMEOUT_MS = 14 * 60 * 1000;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";
// Gate-off path must not wait on Windows stdin EOF (#530). Keep this short.
const DISABLED_GATE_STDIN_TIMEOUT_MS = 500;
// Gate-on still needs the payload; bound the wait so a stuck pipe cannot eat the full hook budget.
const ENABLED_GATE_STDIN_TIMEOUT_MS = 30_000;

function emitDecision(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function logNote(message) {
  if (!message) {
    return;
  }
  process.stderr.write(`${message}\n`);
}

function filterJobsForCurrentSession(jobs, input = {}) {
  const sessionId = input.session_id || process.env[SESSION_ID_ENV] || null;
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function buildStopReviewPrompt(input = {}) {
  const lastAssistantMessage = String(input.last_assistant_message ?? "").trim();
  const template = loadPromptTemplate(ROOT_DIR, "stop-review-gate");
  const claudeResponseBlock = lastAssistantMessage
    ? ["Previous Claude response:", lastAssistantMessage].join("\n")
    : "";
  return interpolateTemplate(template, {
    CLAUDE_RESPONSE_BLOCK: claudeResponseBlock
  });
}

function buildSetupNote(cwd) {
  const availability = getCodexAvailability(cwd);
  if (availability.available) {
    return null;
  }

  const detail = availability.detail ? ` ${availability.detail}.` : "";
  return `Codex is not set up for the review gate.${detail} Run /codex:setup.`;
}

function runStopReview(cwd, input = {}) {
  const scriptPath = path.join(SCRIPT_DIR, "codex-companion.mjs");
  const prompt = buildStopReviewPrompt(input);
  const childEnv = {
    ...process.env,
    ...(input.session_id ? { [SESSION_ID_ENV]: input.session_id } : {})
  };
  const result = spawnSync(process.execPath, [scriptPath, "task", "--json", prompt], {
    cwd,
    env: childEnv,
    encoding: "utf8",
    timeout: STOP_REVIEW_TIMEOUT_MS
  });

  if (result.error?.code === "ETIMEDOUT") {
    return {
      ok: false,
      reason:
        "The stop-time Codex review task timed out after 14 minutes. Run /codex:review --wait manually, or turn the gate off with /codex:setup --disable-review-gate."
    };
  }

  if (result.status !== 0) {
    return {
      ok: false,
      reason: formatStopReviewProcessFailure(result)
    };
  }

  return parseStopReviewPayload(result.stdout);
}

function logRunningTaskNote(workspaceRoot, input = {}) {
  const jobs = sortJobsNewestFirst(filterJobsForCurrentSession(reapDeadJobs(workspaceRoot, listJobs(workspaceRoot)), input));
  const runningJob = jobs.find((job) => job.status === "queued" || job.status === "running");
  const runningTaskNote = runningJob
    ? `Codex task ${runningJob.id} is still running. Check /codex:status and use /codex:cancel ${runningJob.id} if you want to stop it before ending the session.`
    : null;
  return runningTaskNote;
}

async function main() {
  // Resolve config from env/cwd first so a disabled gate never waits on stdin EOF (#530).
  const cwdGuess = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const preliminaryRoot = resolveWorkspaceRoot(cwdGuess);
  const preliminaryConfig = getConfig(preliminaryRoot);

  if (!preliminaryConfig.stopReviewGate) {
    const input = await readHookInput(DISABLED_GATE_STDIN_TIMEOUT_MS);
    const cwd = input.cwd || cwdGuess;
    const workspaceRoot = resolveWorkspaceRoot(cwd);
    logNote(logRunningTaskNote(workspaceRoot, input));
    return;
  }

  const input = await readHookInput(ENABLED_GATE_STDIN_TIMEOUT_MS);
  const cwd = input.cwd || cwdGuess;
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);
  const runningTaskNote = logRunningTaskNote(workspaceRoot, input);

  if (!config.stopReviewGate) {
    logNote(runningTaskNote);
    return;
  }

  if (input.stop_hook_active) {
    // Claude Code re-invokes the Stop hook with stop_hook_active: true when a
    // prior invocation returned a "block" decision. Running the review again
    // here would just block again -- every non-ok outcome (no output, timeout,
    // failure, invalid JSON) re-blocks unconditionally -- until the harness's
    // forced-retry cap kicks in and ends the turn anyway. Skip the re-run and
    // let this retry succeed instead of repeating it up to the cap.
    //
    // logNote() alone is invisible to the user (it only writes to stderr, which
    // isn't surfaced for a successful hook run) -- a skipped review would look
    // identical to a passed one. Emit a systemMessage instead: it reaches the
    // user without blocking (no "decision" key), so the skip is visible right
    // when it matters -- the previous review blocked on something.
    emitDecision({
      systemMessage:
        "Codex stop-gate review skipped on this continuation turn. Run /codex:review --wait to verify the fixes."
    });
    logNote(runningTaskNote);
    return;
  }

  const setupNote = buildSetupNote(cwd);
  if (setupNote) {
    logNote(setupNote);
    logNote(runningTaskNote);
    return;
  }

  const review = runStopReview(cwd, input);
  if (!review.ok) {
    emitDecision({
      decision: "block",
      reason: runningTaskNote ? `${runningTaskNote} ${review.reason}` : review.reason
    });
    return;
  }

  logNote(runningTaskNote);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exit(1);
}
