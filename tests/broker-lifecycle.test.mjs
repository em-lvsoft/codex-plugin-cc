import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { makeTempDir } from "./helpers.mjs";
import {
  clearBrokerSession,
  ensureBrokerSession,
  saveBrokerSession,
  sendBrokerShutdown,
  teardownBrokerSession
} from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { createBrokerEndpoint, parseBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-endpoint.mjs";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";

test("sendBrokerShutdown returns when a broker accepts but never replies", async (t) => {
  const socketPath = path.join(makeTempDir(), "broker.sock");
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
    fs.rmSync(path.dirname(socketPath), { recursive: true, force: true });
  });

  const startedAt = Date.now();
  await sendBrokerShutdown(`unix:${socketPath}`, 50);
  assert.ok(Date.now() - startedAt < 500);
});

// The broker is spawned detached and unref'd, so it outlives the process that
// started it by design. Teardown also unlinks the pid file. If teardown removes
// the pid file without terminating the process, the broker is unreachable
// forever: nothing knows its pid and nothing will ever reap it. These tests pin
// that termination happens by default rather than only when a caller remembers
// to inject a killer.

function tempSessionFiles() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cxc-test-"));
  const pidFile = path.join(dir, "broker.pid");
  const logFile = path.join(dir, "broker.log");
  fs.writeFileSync(pidFile, "4242");
  fs.writeFileSync(logFile, "");
  return { dir, pidFile, logFile };
}

test("teardownBrokerSession terminates the broker when no killer is injected", () => {
  const { pidFile, logFile } = tempSessionFiles();
  const killed = [];

  teardownBrokerSession({
    pidFile,
    logFile,
    pid: 4242,
    killProcess: (pid) => killed.push(pid)
  });

  assert.deepEqual(killed, [4242], "an injected killer must still be honoured");
  assert.equal(fs.existsSync(pidFile), false, "pid file is removed");
});

test("ensureBrokerSession does not orphan a broker that never becomes ready", async () => {
  // Behavioural, and deliberately injects nothing: injecting a killer would
  // exercise the path that always worked. This spawns a REAL process that never
  // opens the endpoint, so readiness fails and teardown runs with whatever the
  // default is. Before the fix that default was null and this process survived
  // with its pid file already unlinked, which is the leak.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cxc-cwd-"));
  const stubPath = path.join(cwd, "never-ready-broker.mjs");
  fs.writeFileSync(stubPath, "setTimeout(() => {}, 30_000);\n");

  const session = await ensureBrokerSession(cwd, {
    timeoutMs: 250,
    scriptPath: stubPath
    // The real endpoint factory is used deliberately: overriding it with a bare
    // path makes parseBrokerEndpoint throw before teardown is ever reached, so
    // the test would fail for an unrelated reason in both directions.
  });

  assert.equal(session, null, "a broker that never becomes ready yields no session");

  // The pid file is unlinked by teardown, so recover the pid from the process
  // table instead: any surviving stub is by definition an orphan.
  let survivors = [];
  try {
    const out = execFileSync("pgrep", ["-f", stubPath], { encoding: "utf8" });
    survivors = out.trim().split("\n").filter(Boolean);
  } catch {
    // pgrep exits non-zero when nothing matches, which is the passing case.
  }

  try {
    assert.equal(
      survivors.length,
      0,
      `teardown left ${survivors.length} broker process(es) running after unlinking the pid file`
    );
  } finally {
    for (const pid of survivors) {
      try {
        process.kill(Number(pid), "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
});

function makeBrokerTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-plugin-broker-test-"));
}

function epermError() {
  const error = new Error("EPERM: operation not permitted, unlink");
  error.code = "EPERM";
  return error;
}

function throwEpermFor(target, originalUnlinkSync) {
  return (filePath) => {
    if (filePath === target) {
      throw epermError();
    }
    return originalUnlinkSync(filePath);
  };
}

test("teardownBrokerSession removes pid and log files on the happy path", (t) => {
  const sessionDir = makeBrokerTempDir();
  t.after(() => fs.rmSync(sessionDir, { recursive: true, force: true }));
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");
  fs.writeFileSync(pidFile, "1234\n", "utf8");
  fs.writeFileSync(logFile, "log line\n", "utf8");

  teardownBrokerSession({ pidFile, logFile, sessionDir });

  assert.equal(fs.existsSync(pidFile), false);
  assert.equal(fs.existsSync(logFile), false);
});

test("teardownBrokerSession tolerates EPERM on the pid file and still removes the log file", (t) => {
  const sessionDir = makeBrokerTempDir();
  t.after(() => fs.rmSync(sessionDir, { recursive: true, force: true }));
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");
  fs.writeFileSync(pidFile, "1234\n", "utf8");
  fs.writeFileSync(logFile, "log line\n", "utf8");

  const originalUnlinkSync = fs.unlinkSync;
  fs.unlinkSync = throwEpermFor(pidFile, originalUnlinkSync);
  t.after(() => {
    fs.unlinkSync = originalUnlinkSync;
  });

  teardownBrokerSession({ pidFile, logFile, sessionDir });

  assert.equal(fs.existsSync(pidFile), true);
  assert.equal(fs.existsSync(logFile), false);
});

test("teardownBrokerSession tolerates EPERM on the log file and completes teardown", (t) => {
  const sessionDir = makeBrokerTempDir();
  t.after(() => fs.rmSync(sessionDir, { recursive: true, force: true }));
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");
  fs.writeFileSync(pidFile, "1234\n", "utf8");
  fs.writeFileSync(logFile, "log line\n", "utf8");

  const originalUnlinkSync = fs.unlinkSync;
  fs.unlinkSync = throwEpermFor(logFile, originalUnlinkSync);
  t.after(() => {
    fs.unlinkSync = originalUnlinkSync;
  });

  teardownBrokerSession({ pidFile, logFile, sessionDir });

  assert.equal(fs.existsSync(pidFile), false);
  assert.equal(fs.existsSync(logFile), true);
});

test("teardownBrokerSession is a no-op for missing pid and log files", (t) => {
  const sessionDir = makeBrokerTempDir();
  t.after(() => fs.rmSync(sessionDir, { recursive: true, force: true }));
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");

  teardownBrokerSession({ pidFile, logFile, sessionDir });

  assert.equal(fs.existsSync(pidFile), false);
  assert.equal(fs.existsSync(logFile), false);
});

test("teardownBrokerSession runs remaining cleanup when the pid unlink fails", (t) => {
  const sessionDir = makeBrokerTempDir();
  t.after(() => fs.rmSync(sessionDir, { recursive: true, force: true }));
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");
  const endpoint = createBrokerEndpoint(sessionDir, process.platform);
  const endpointTarget = parseBrokerEndpoint(endpoint);
  fs.writeFileSync(pidFile, "1234\n", "utf8");
  fs.writeFileSync(logFile, "log line\n", "utf8");
  if (endpointTarget.kind === "unix") {
    fs.writeFileSync(endpointTarget.path, "", "utf8");
  }

  const originalUnlinkSync = fs.unlinkSync;
  fs.unlinkSync = throwEpermFor(pidFile, originalUnlinkSync);
  t.after(() => {
    fs.unlinkSync = originalUnlinkSync;
  });

  teardownBrokerSession({ endpoint, pidFile, logFile, sessionDir });

  assert.equal(fs.existsSync(logFile), false);
  if (endpointTarget.kind === "unix") {
    assert.equal(fs.existsSync(endpointTarget.path), false);
  }
});

test("clearBrokerSession tolerates EPERM on the state file and does not throw", (t) => {
  const dataDir = makeBrokerTempDir();
  const cwd = makeBrokerTempDir();
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  t.after(() => {
    delete process.env.CLAUDE_PLUGIN_DATA;
  });

  saveBrokerSession(cwd, { endpoint: "pipe://test", pid: 1234 });
  const stateFile = path.join(resolveStateDir(cwd), "broker.json");
  assert.equal(fs.existsSync(stateFile), true);

  const originalUnlinkSync = fs.unlinkSync;
  fs.unlinkSync = throwEpermFor(stateFile, originalUnlinkSync);
  t.after(() => {
    fs.unlinkSync = originalUnlinkSync;
  });

  clearBrokerSession(cwd);

  assert.equal(fs.existsSync(stateFile), true);

  fs.unlinkSync = originalUnlinkSync;
});
