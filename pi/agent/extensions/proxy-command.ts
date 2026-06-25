import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

// ── Paths ──────────────────────────────────────────────────────────────────
const HOME = process.env.HOME || "/home/albertshalaj";
const ZED_PROXY_JS = join(HOME, ".zed-proxy/zed-proxy.js");
const ZED_PROXY_LOG = join(HOME, ".local/share/opencode/log/zed-proxy.log");

// ── Helpers ────────────────────────────────────────────────────────────────
function parsePm2Output(stdout: string): { online: boolean; uptime?: string } {
  const online = stdout.includes("online");
  const uptime = stdout.match(/uptime\s+│\s+(\S+)/)?.[1];
  return { online, uptime };
}

async function isPortOpen(port: number, exec: ExtensionAPI["exec"]): Promise<boolean> {
  const { stdout } = await exec("ss", ["-tlnp"]);
  return stdout.includes(`:${port}`);
}

// ── Extension ──────────────────────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
  // ══════════════════════════════════════════════════════════════════════════
  //  9ROUTER (PM2-managed) — /9router
  // ══════════════════════════════════════════════════════════════════════════

  /** Auto-stop both proxies when Pi quits */
  pi.on("session_shutdown", async (event) => {
    if (event.reason !== "quit") return;

    // Stop 9router if running
    const { code, stdout } = await pi.exec("pm2", ["show", "9router-proxy"]);
    if (code === 0 && parsePm2Output(stdout).online) {
      console.log("Stopping 9Router proxy...");
      await pi.exec("pm2", ["stop", "9router-proxy"]);
    }

    // Stop zed-proxy if running
    const zedRunning = await isPortOpen(5005, pi.exec);
    if (zedRunning) {
      console.log("Stopping Zed proxy...");
      await pi.exec("bash", ["-c", 'pkill -f "node.*zed-proxy.js" 2>/dev/null']);
    }
  });

  async function handle9Router(args: string | undefined, ctx: any) {
    const action = (args ?? "").trim().toLowerCase();

    if (!action || action === "status") {
      const { code, stdout } = await pi.exec("pm2", ["show", "9router-proxy"]);
      if (code !== 0) {
        ctx.ui.notify("9Router is not registered in PM2.", "error");
        return;
      }
      const { online, uptime } = parsePm2Output(stdout);
      if (online) {
        ctx.ui.notify(`9Router proxy is RUNNING (uptime: ${uptime ?? "?"})`, "success");
      } else {
        ctx.ui.notify("9Router proxy is STOPPED. Use /9router start to launch it.", "warning");
      }
      return;
    }

    if (action === "start") {
      // Check if already running using pm2 jlist (JSON - most reliable)
      const { stdout: jsonOut } = await pi.exec("pm2", ["jlist"]);
      try {
        const procs = JSON.parse(jsonOut || "[]");
        const running = procs.find((p: any) => p.name === "9router-proxy" && p.pm2_env?.status === "online");
        if (running) {
          ctx.ui.notify("9Router proxy is already running.", "info");
          return;
        }
        // Clean up any stale instances before starting
        const stale = procs.filter((p: any) => p.name === "9router-proxy" && p.pm2_env?.status !== "online");
        for (const p of stale) {
          await pi.exec("pm2", ["delete", String(p.pm_id)]);
        }
        // Stale instances cleaned silently
      } catch { /* ignore parse errors */ }

      ctx.ui.notify("Starting 9Router proxy...", "info");
      const { code, stderr } = await pi.exec(
        "pm2",
        ["start", "9router", "--name", "9router-proxy", "--", "--host", "127.0.0.1", "--skip-update"]
      );

      if (code === 0) {
        await new Promise((r) => setTimeout(r, 2000));
        const { stdout } = await pi.exec("pm2", ["show", "9router-proxy"]);
        if (parsePm2Output(stdout).online) {
          ctx.ui.notify("9Router proxy started on http://localhost:20128", "success");
        } else {
          ctx.ui.notify("9Router proxy may have failed to start. Check PM2 logs.", "error");
        }
      } else {
        ctx.ui.notify(`Failed to start: ${stderr}`, "error");
      }
      return;
    }

    if (action === "stop") {
      const { code, stderr } = await pi.exec("pm2", ["stop", "9router-proxy"]);
      if (code === 0) {
        ctx.ui.notify("9Router proxy stopped.", "success");
      } else {
        ctx.ui.notify(`Failed to stop: ${stderr}`, "error");
      }
      return;
    }

    if (action === "restart") {
      ctx.ui.notify("Restarting 9Router proxy...", "info");
      const { code, stderr } = await pi.exec("pm2", ["restart", "9router-proxy"]);
      if (code === 0) {
        await new Promise((r) => setTimeout(r, 2000));
        const { stdout } = await pi.exec("pm2", ["show", "9router-proxy"]);
        if (parsePm2Output(stdout).online) {
          ctx.ui.notify("9Router proxy restarted.", "success");
        } else {
          ctx.ui.notify("9Router proxy may have failed to restart.", "error");
        }
      } else {
        ctx.ui.notify(`Failed to restart: ${stderr}`, "error");
      }
      return;
    }

    ctx.ui.notify("Usage: /9router [start|stop|restart|status]", "info");
  }

  pi.registerCommand("9router", {
    description: "Manage the 9Router proxy (start/stop/status) — port 20128",
    handler: handle9Router,
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  ZED PROXY (standalone node) — /zed
  // ══════════════════════════════════════════════════════════════════════════

  async function handleZed(args: string | undefined, ctx: any) {
    const action = (args ?? "").trim().toLowerCase();

    if (!action || action === "status") {
      const running = await isPortOpen(5005, pi.exec);
      if (running) {
        // Try to get more info via health endpoint
        const { code, stdout } = await pi.exec("curl", ["-sf", "http://127.0.0.1:5005/health"]);
        if (code === 0) {
          ctx.ui.notify("Zed proxy is RUNNING on port 5005", "success");
        } else {
          ctx.ui.notify("Zed proxy port is open but health check failed", "warning");
        }
      } else {
        ctx.ui.notify("Zed proxy is STOPPED. Use /zed start to launch it.", "warning");
      }
      return;
    }

    if (action === "start") {
      // Auto-sync token if Zed editor is running
      const { stdout: zedProcs } = await pi.exec("pgrep", ["-f", "zed-editor"]);
      if (zedProcs.trim()) {
        ctx.ui.notify("Syncing Zed token...", "info");
        const { code: tokenCode } = await pi.exec("sudo", [`${HOME}/.local/bin/zed-token`]);
        if (tokenCode === 0) {
          ctx.ui.notify("Token synced.", "info");
        } else {
          ctx.ui.notify("Token sync may have failed, continuing...", "warning");
        }
      }

      // Clean up any stale zed-proxy process on port 5005 before starting
      await pi.exec("bash", ["-c", 'pkill -f "node.*zed-proxy.js" 2>/dev/null; sleep 0.5']);

      ctx.ui.notify("Starting Zed proxy...", "info");
      await pi.exec("bash", [
        "-c",
        `mkdir -p "${HOME}/.local/share/opencode/log" && nohup node "${ZED_PROXY_JS}" > "${ZED_PROXY_LOG}" 2>&1 &`
      ]);

      // Wait for it to come up (up to 3 seconds)
      let ready = false;
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 100));
        ready = await isPortOpen(5005, pi.exec);
        if (ready) break;
      }

      if (ready) {
        ctx.ui.notify("Zed proxy started on http://localhost:5005", "success");
      } else {
        // Check logs for the actual error
        const { stdout: logTail } = await pi.exec("tail", ["-10", ZED_PROXY_LOG]);
        ctx.ui.notify(`Zed proxy failed to start. Logs:\n${logTail}`, "error");
      }
      return;
    }

    if (action === "stop") {
      const running = await isPortOpen(5005, pi.exec);
      if (!running) {
        ctx.ui.notify("Zed proxy is not running.", "info");
        return;
      }

      ctx.ui.notify("Stopping Zed proxy...", "info");
      // Kill the node process running zed-proxy.js
      const { code, stderr } = await pi.exec("bash", [
        "-c",
        'pkill -f "node.*zed-proxy.js" 2>/dev/null; sleep 0.5; lsof -ti:5005 | xargs -r kill 2>/dev/null'
      ]);

      // Verify it stopped
      await new Promise((r) => setTimeout(r, 500));
      const stillRunning = await isPortOpen(5005, pi.exec);
      if (!stillRunning) {
        ctx.ui.notify("Zed proxy stopped.", "success");
      } else {
        ctx.ui.notify("Zed proxy may still be running. Try: /zed kill", "warning");
      }
      return;
    }

    if (action === "restart") {
      ctx.ui.notify("Restarting Zed proxy...", "info");

      // Stop first
      await pi.exec("bash", [
        "-c",
        'pkill -f "node.*zed-proxy.js" 2>/dev/null; sleep 0.5; lsof -ti:5005 | xargs -r kill 2>/dev/null'
      ]);
      await new Promise((r) => setTimeout(r, 1000));

      // Start
      await pi.exec("mkdir", ["-p", `${HOME}/.local/share/opencode/log`]);
      await pi.exec("bash", [
        "-c",
        `nohup node "${ZED_PROXY_JS}" > "${ZED_PROXY_LOG}" 2>&1 &`
      ]);

      let ready = false;
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 100));
        ready = await isPortOpen(5005, pi.exec);
        if (ready) break;
      }

      if (ready) {
        ctx.ui.notify("Zed proxy restarted on http://localhost:5005", "success");
      } else {
        ctx.ui.notify("Zed proxy failed to restart. Check: /zed logs", "error");
      }
      return;
    }

    if (action === "logs") {
      const { code, stdout } = await pi.exec("tail", ["-30", ZED_PROXY_LOG]);
      if (code === 0 && stdout.trim()) {
        ctx.ui.notify(`Last 30 lines of zed-proxy.log:\n${stdout}`, "info");
      } else {
        ctx.ui.notify("No log file found or log is empty.", "warning");
      }
      return;
    }

    if (action === "token") {
      // Check if Zed editor is running
      const { stdout: zedProcs } = await pi.exec("pgrep", ["-f", "zed-editor"]);
      if (!zedProcs.trim()) {
        ctx.ui.notify("Zed editor is not running. Launch Zed and log in first.", "warning");
        return;
      }
      ctx.ui.notify("Syncing Zed token...", "info");
      const { code, stderr } = await pi.exec("sudo", [`${HOME}/.local/bin/zed-token`]);
      if (code === 0) {
        ctx.ui.notify("Zed token synced successfully.", "success");
      } else {
        ctx.ui.notify(`Token sync failed: ${stderr}`, "error");
      }
      return;
    }

    ctx.ui.notify("Usage: /zed [start|stop|restart|status|logs|token]", "info");
  }

  pi.registerCommand("zed", {
    description: "Manage the Zed AI proxy (start/stop/status/logs/token) — port 5005",
    handler: handleZed,
  });
}
