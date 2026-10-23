# Replay corpus

Real commands and tool failures, each labeled with what the plugin should do, so every change to the guard rules or the coach is measured against both precision (how often a denial or a piece of advice is right) and recall (how many bad commands and recognizable failures are caught). Both engines, the PowerShell hooks and the extension, replay the same rows and must agree.

```powershell
node --test tests/replay.test.mjs                      # extension logic -> tests/.work/replay-node.json
pwsh -NoProfile -File tests/Invoke-ReplayTests.ps1    # PowerShell hooks -> tests/.work/replay-ps.json
node tests/replay-parity.mjs                          # the two must match row by row
```

## Row formats (JSON Lines; lines starting with `#` are comments)

`commands.jsonl`, one row per shell command sent through `shell-guard`:

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Unique, stable (`c001`, `r0412`). |
| `command` | yes | The command text exactly as the agent sent it. |
| `expect` | no | `allow` or `deny`. Omit while a row is unlabeled; unlabeled rows do not count toward precision or recall but are still reported under "positive-although-succeeded". |
| `hint` | no | Case-insensitive substring the denial reason must contain. |
| `rule` | no | Tag of the rule that should decide the row (`redirect`, `unix-command`, `parser`, ...). Informational. |
| `succeeded` | no | Whether the command succeeded in history. Drives the "denied although it succeeded" count, the review's friction metric. |
| `status` | no | `known-gap`: the engine is expected to get this row wrong today. The row does not fail the run; when it starts passing, the runner says so and the label should be removed. |
| `source`, `note` | no | Where the row came from and why it matters. |

`failures.jsonl`, one row per tool failure or shell result sent through `recovery-coach`:

| Field | Required | Meaning |
|---|---|---|
| `id`, `tool` | yes | Unique id; the tool name as the CLI reports it (`edit`, `create`, `powershell`). |
| `event` | yes | `failure`: a `postToolUseFailure` payload with `error` = `text`. `result`: a `postToolUse` payload whose `textResultForLlm` = `text` (a shell result ends with `<shellId: N completed with exit code M>`). |
| `toolArgs` | no | The tool arguments (`command`, or `path` and friends). |
| `text` | yes | The error string or the result text. The CLI passes short strings to failure hooks (`No match found`, `Parent directory does not exist`, `Path already exists`). |
| `expect` | yes | `advice` or `silent`. |
| `hint` | no | Substring the advice must contain. |
| `status`, `source`, `note` | no | As above. |

## Labels and the known-gap policy

`expect` records the desired behavior, not the current one. When the plugin is wrong today, keep the desired label and add `"status": "known-gap"`; the row then documents the gap without failing the build, and precision and recall still count it, so the numbers in `baseline.json` describe what the engine really does. The unit suites (`tests/Invoke-HookTests.ps1`, `tests/extension.test.mjs`) may assert current behavior for the same command (for example the `>` inside a quoted pattern); the corpus is where the intended behavior lives.

## Metrics and the baseline

Positive class: `deny` for commands, `advice` for failures. Precision = TP / (TP + FP), recall = TP / (TP + FN), over labeled rows including known gaps. `baseline.json` holds the last accepted numbers; a run fails when precision or recall drops below it (tolerance 0.0005) or when any labeled row that is not a known gap mismatches. After an intentional change, regenerate it with the Node runner, which is the canonical writer:

```powershell
$env:WINDOWS_GUARD_UPDATE_BASELINE = '1'; node --test tests/replay.test.mjs; Remove-Item Env:WINDOWS_GUARD_UPDATE_BASELINE
```

## Adding rows from a session history

`import-replay.mjs` turns a JSON array or JSON Lines export of historical commands into unlabeled corpus rows:

```powershell
node tests/corpus/import-replay.mjs guard_replay.json --command=command --succeeded=succeeded --source=review-2026-10-23 --start=100 >> tests/corpus/commands.jsonl
```

Field names are flags (`--command`, `--succeeded`, `--exit-code`); with `--exit-code` and no success field, exit code 0 means succeeded. Rows are de-duplicated by command text. Sanitize paths, hostnames and secrets before committing, then label the rows: `expect` plus `hint` for denials, `known-gap` where the plugin is wrong today.
