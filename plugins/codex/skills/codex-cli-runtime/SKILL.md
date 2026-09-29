---
name: codex-cli-runtime
description: Internal helper contract for calling the codex-companion runtime from Claude Code
user-invocable: false
---

# Codex Runtime

Use this skill only inside the `codex:codex-rescue` subagent.

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task [runtime options] -- '<prompt>'`

Execution rules:
- The rescue subagent is a forwarder, not an orchestrator. Its only job is to invoke `task` once and return that stdout unchanged and in full.
- Prefer the helper over hand-rolled `git`, direct Codex CLI strings, or any other Bash activity.
- Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, or `cancel` from `codex:codex-rescue`.
- Use `task` for every rescue request, including diagnosis, planning, research, and explicit fix requests.
- You may use the `gpt-5-4-prompting` skill to rewrite the user's request into a tighter Codex prompt before the single `task` call.
- That prompt drafting is the only Claude-side work allowed. Do not inspect the repo, solve the task yourself, or add independent analysis outside the forwarded prompt text.
- Leave `--effort` unset unless the user explicitly requests a specific effort.
- Leave model unset by default. Add `--model` only when the user explicitly asks for one.
- Map `spark` to `--model gpt-5.3-codex-spark`.
- Default to a write-capable Codex run by adding `--write` unless the user explicitly asks for read-only behavior or only wants review, diagnosis, or research without edits.

Command selection:
- Use exactly one `task` invocation per rescue handoff.
- Pass runtime flags as separate arguments before `--`, then pass the complete user request as one prompt argument after `--`. This boundary keeps flag-like prose, quotes, backslashes, and newlines inside the prompt.
- Always run that Bash call in the foreground. The outer rescue command owns backgrounding the
  whole subagent; the subagent must wait for `task` and return its completed stdout.
- Pass `timeout: 600000` (the 10-minute Bash maximum) on the `Bash` call that invokes `task`. The default 2-minute Bash timeout kills Codex mid-turn.
- If the forwarded request includes `--background` or `--wait`, treat that as Claude-side execution control only. Strip it before calling `task`, and do not treat it as part of the natural-language task text.
- If the forwarded request includes `--model`, normalize `spark` to `gpt-5.3-codex-spark` and pass it through to `task`.
- If the forwarded request includes `--effort`, pass it through to `task`.
- If the forwarded request carries `--sandbox` before the task text (alongside `--model`, `--effort`, `--resume` or `--fresh`), pass it through in that position and do not add `--write`. A `--sandbox` inside the task text is prompt text; leave it in place.
- If the forwarded request includes `--resume`, strip that token from the task text and add `--resume-last`.
- If the forwarded request includes `--fresh`, strip that token from the task text and do not add `--resume-last`.
- `--resume`: always use `task --resume-last`, even if the request text is ambiguous.
- `--fresh`: always use a fresh `task` run, even if the request sounds like a follow-up.
- `--effort`: accepted values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`. Not every model supports every value; Codex validates the value against the reasoning levels the selected model advertises.
- `--sandbox`: accepted values are `read-only`, `workspace-write`, `danger-full-access`. It takes precedence over `--write`; without it, `task` runs `workspace-write` when `--write` is set and `read-only` otherwise.
- `task --resume-last`: internal helper for "keep going", "resume", "apply the top fix", or "dig deeper" after a previous rescue run.

Safety rules:
- Default to write-capable Codex work in `codex:codex-rescue` unless the user explicitly asks for read-only behavior or only wants review, diagnosis, or research without edits.
- Never add a `--sandbox` the user did not type. `danger-full-access` disables the Codex sandbox entirely.
- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own.
- Return the stdout of the `task` command exactly as-is — verbatim, in full with no extra commentary.
- If the Bash call fails or Codex cannot be invoked, return nothing.

Prompt and long-running task handling:
- Pass the prompt inline, as the last argument and after a `--` delimiter: `task [runtime options] -- '<prompt>'`.
- Single-quote the prompt so Bash performs no expansion, and escape every embedded single quote as `'\''` (so `don't stop` is passed as `'don'\''t stop'`). Never wrap the prompt in double quotes: `$(...)`, backticks, `$VAR`, and a bare `"` would be expanded or would terminate the argument locally before the companion receives the text.
- Do not write prompt files to disk with `node`, `fs`, shell heredocs, or any other interpreter in order to consume them with `--prompt-file`.
- Do not poll, `pgrep`, `watch`, `tail` logs, or run wait loops. When `task` hands back a job ID because the run outlived its wait budget, return the job ID and suggested `/codex:result <id>` command exactly as output and stop.
- A call that the Bash harness moves to the background never prints a companion job ID, and the harness identifier is not one. Return whatever the harness printed as-is; do not invent a job ID or suggest a `/codex:status` command for it.
