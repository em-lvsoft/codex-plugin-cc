import { spawnSync } from "node:child_process";
import process from "node:process";

export function runCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio ?? "pipe",
    shell: options.shell ?? (process.platform === "win32" ? (process.env.SHELL || true) : false),
    windowsHide: true
  });

  return {
    command,
    args,
    status: result.status ?? 0,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

export function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const result = runCommand(command, versionArgs, options);
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}

function isProcessAlive(pid, killImpl) {
  try {
    killImpl(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

export function terminateProcessTree(pid, options = {}) {
  // pid 0 signals the caller's own process group and pid <= -1 signals
  // arbitrary groups — either can take down the invoking process tree
  // (e.g. a test runner). Only ever target a concrete child pid.
  if (!Number.isInteger(pid) || pid <= 1) {
    return { attempted: false, delivered: false, method: null };
  }

  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? process.kill.bind(process);

  if (platform === "win32") {
    // Probe the root before calling taskkill instead of parsing its localized "not found"
    // message: a root that is already gone is reported as not delivered in every language.
    if (!isProcessAlive(pid, killImpl)) {
      return { attempted: false, delivered: false, method: null };
    }

    const result = runCommandImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
      cwd: options.cwd,
      env: options.env,
      // runCommand prefers process.env.SHELL on Windows, so under Git Bash this
      // ran as `bash -c "taskkill /PID ..."` and MSYS path conversion rewrote
      // the /PID switch into C:/Program Files/Git/PID, failing every kill with
      // "ERROR: Invalid argument/option". taskkill takes /-switches and an
      // argument array, so it does not need a shell.
      shell: false
    });

    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill", result };
    }

    // taskkill /T walks the tree, then terminates each entry; a descendant that exits in
    // between (short-lived git/cmd helpers) makes taskkill report "not supported" and a
    // non-zero status even though the root was killed. Trust the root's liveness instead.
    // `delivered` therefore describes the root only: like the process-group SIGTERM on
    // other platforms, it does not prove that every descendant is gone.
    if (!result.error && !isProcessAlive(pid, killImpl)) {
      return { attempted: true, delivered: true, method: "taskkill", result };
    }

    // taskkill ran but the root survived, or taskkill is missing: kill the root directly.
    if (!result.error || result.error.code === "ENOENT") {
      const detail = result.error ? {} : { result };
      try {
        killImpl(pid);
        return { attempted: true, delivered: true, method: "kill", ...detail };
      } catch (error) {
        if (error?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "kill", ...detail };
        }
        throw error;
      }
    }

    if (result.error) {
      throw result.error;
    }

  }

  try {
    killImpl(-pid, "SIGTERM");
    return { attempted: true, delivered: true, method: "process-group" };
  } catch (error) {
    if (error?.code !== "ESRCH") {
      try {
        killImpl(pid, "SIGTERM");
        return { attempted: true, delivered: true, method: "process" };
      } catch (innerError) {
        if (innerError?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "process" };
        }
        throw innerError;
      }
    }

    return { attempted: true, delivered: false, method: "process-group" };
  }
}

export function formatCommandFailure(result) {
  const parts = [`${result.command} ${result.args.join(" ")}`.trim()];
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  } else {
    parts.push(`exit=${result.status}`);
  }
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  if (stderr) {
    parts.push(stderr);
  } else if (stdout) {
    parts.push(stdout);
  }
  return parts.join(": ");
}
