// windows-guard: Copilot CLI extension (experimental).
//
// The same protection as the PowerShell hooks, running in one long-lived Node.js process instead
// of two PowerShell processes per tool call. The CLI loads this file when experimental features
// are on (`copilot --experimental`, or "experimental": true in settings) and resolves the
// `@github/copilot-sdk/extension` import from its bundled SDK; nothing is installed.
//
// The extension does nothing unless WINDOWS_GUARD_MODE=extension is set. With that variable set,
// the launchers in com.github.copilot/hooks/hooks.json look for the liveness marker this process
// writes (<LOCALAPPDATA>/copilot-windows-guard/active/<sessionId>, holding this PID) and exit at
// once while it is present and the PID is alive. If the extension is disabled, not approved, or
// fails to load, there is no marker and the PowerShell scripts run as usual. See README.md,
// "Extension mode".

import path from "node:path";
import { fileURLToPath } from "node:url";
import { joinSession } from "@github/copilot-sdk/extension";
import { buildHooks, removeActiveMarker, writeActiveMarker, writeGuardLog } from "./guard.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const rulesDir = path.resolve(here, "..", "..", "rules");
const mode = String(process.env.WINDOWS_GUARD_MODE ?? "").trim().toLowerCase();
const active = process.platform === "win32" && mode === "extension";

const session = await joinSession({ hooks: active ? buildHooks({ rulesDir }) : {} });

if (active) {
  const sessionId = session.sessionId;
  const marker = writeActiveMarker(sessionId);
  const cleanup = () => removeActiveMarker(sessionId);
  process.on("exit", cleanup);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      cleanup();
      process.exit(0);
    });
  }
  writeGuardLog(
    `extension active: session ${sessionId ?? "?"} hooks registered, marker ${marker ?? "NOT WRITTEN (launchers will run the scripts)"} (node ${process.version} at ${process.execPath})`,
  );
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
