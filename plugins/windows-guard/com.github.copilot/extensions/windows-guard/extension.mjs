// windows-guard: Copilot CLI extension (experimental).
//
// The same protection as the PowerShell hooks, running in one long-lived Node.js process instead
// of two PowerShell processes per tool call. The CLI loads this file when experimental features
// are on (`copilot --experimental`, or "experimental": true in settings) and resolves the
// `@github/copilot-sdk/extension` import from its bundled SDK; nothing is installed.
//
// The extension does nothing unless WINDOWS_GUARD_MODE=extension is set. That same variable makes
// the launchers in com.github.copilot/hooks/hooks.json exit immediately, so exactly one engine is
// in charge and nothing fires twice. See README.md, "Extension mode".

import path from "node:path";
import { fileURLToPath } from "node:url";
import { joinSession } from "@github/copilot-sdk/extension";
import { buildHooks, writeGuardLog } from "./guard.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const rulesDir = path.resolve(here, "..", "..", "rules");
const mode = String(process.env.WINDOWS_GUARD_MODE ?? "").trim().toLowerCase();
const active = process.platform === "win32" && mode === "extension";

const session = await joinSession({ hooks: active ? buildHooks({ rulesDir }) : {} });

if (active) {
  writeGuardLog(`extension active: session hooks registered, PowerShell launchers bypassed (node ${process.version} at ${process.execPath})`);
  try {
    await session.log("windows-guard: extension mode active (PowerShell hook launchers are bypassed).", {
      level: "info",
      ephemeral: true,
    });
  } catch {
    // the timeline message is a courtesy
  }
} else {
  writeGuardLog(
    `extension loaded but idle (WINDOWS_GUARD_MODE=${mode || "unset"}, platform=${process.platform}); the PowerShell hooks stay in charge`,
  );
}
