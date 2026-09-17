(() => {
  "use strict";

  const STORAGE_KEY = "dockerDoctorState";
  const CHECK_IDS = ["daemon", "modules", "context"];

  /* ---------- storage helpers ---------- */

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }

  function saveState(state) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      /* localStorage unavailable — degrade silently, app still works this session */
    }
  }

  let state = loadState();

  /* ---------- diagnostic logic ---------- */

  function diagnoseDaemon(text) {
    const t = text.trim();
    if (!t) {
      return {
        status: "unknown",
        title: "No output pasted yet",
        details: ["Paste the output of the command above, then click Diagnose."],
        fixes: [],
      };
    }

    const lower = t.toLowerCase();

    if (lower.includes("permission denied") || lower.includes("dial unix") && lower.includes("permission")) {
      return {
        status: "issue",
        title: "Daemon is running, but your user can't talk to it",
        details: [
          "Your user account isn't in the docker group, so every docker command needs sudo.",
        ],
        fixes: [
          "sudo usermod -aG docker $USER && newgrp docker",
        ],
      };
    }

    if (lower.includes("could not be found") || lower.includes("unit docker.service")) {
      return {
        status: "issue",
        title: "Docker isn't installed as a service",
        details: [
          "systemd has no docker.service unit — Docker may not be installed, or the package is broken.",
        ],
        fixes: [
          "sudo apt update && sudo apt install docker.io",
          "sudo systemctl enable --now docker",
        ],
      };
    }

    if (lower.includes("active (running)")) {
      return {
        status: "ok",
        title: "Docker daemon is running",
        details: ["systemd reports the service as active and running. No action needed."],
        fixes: [],
      };
    }

    if (lower.includes("inactive") || lower.includes("failed") || lower.includes("cannot connect to the docker daemon")) {
      return {
        status: "issue",
        title: "Docker daemon is not running",
        details: [
          "The service is installed but currently stopped or has crashed.",
        ],
        fixes: [
          "sudo systemctl start docker",
          "sudo systemctl enable docker",
        ],
      };
    }

    return {
      status: "issue",
      title: "Couldn't confirm the daemon is healthy",
      details: [
        "The pasted output didn't match a known \"running\" state. Double-check by running the command again.",
      ],
      fixes: ["sudo systemctl restart docker"],
    };
  }

  function diagnoseModules(text) {
    const t = text.trim();
    const lower = t.toLowerCase();
    const hasOverlay = /^overlay\s/m.test(t) || lower.includes("overlay ");
    const hasNetfilter = lower.includes("br_netfilter");

    if (!t) {
      return {
        status: "issue",
        title: "No modules detected",
        details: [
          "Nothing was pasted (or the command printed nothing), which usually means overlay isn't loaded.",
        ],
        fixes: [
          "sudo modprobe overlay",
          "echo overlay | sudo tee -a /etc/modules-load.d/docker.conf",
        ],
      };
    }

    const details = [];
    details.push(hasOverlay ? "✓ overlay module is loaded (storage driver OK)." : "✗ overlay module is missing.");
    details.push(hasNetfilter ? "✓ br_netfilter module is loaded (bridge networking OK)." : "✗ br_netfilter module is missing.");

    if (hasOverlay && hasNetfilter) {
      return {
        status: "ok",
        title: "Required kernel modules are loaded",
        details,
        fixes: [],
      };
    }

    const fixes = [];
    if (!hasOverlay) {
      fixes.push("sudo modprobe overlay");
      fixes.push("echo overlay | sudo tee -a /etc/modules-load.d/docker.conf");
    }
    if (!hasNetfilter) {
      fixes.push("sudo modprobe br_netfilter");
      fixes.push("echo br_netfilter | sudo tee -a /etc/modules-load.d/docker.conf");
    }

    return {
      status: "issue",
      title: "One or more kernel modules are missing",
      details,
      fixes,
    };
  }

  function diagnoseContext(text) {
    const t = text.trim();
    if (!t) {
      return {
        status: "unknown",
        title: "No output pasted yet",
        details: ["Paste the output of `docker context ls` above, then click Diagnose."],
        fixes: [],
      };
    }

    const lines = t
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !/^NAME\s/i.test(l));

    if (lines.length === 0) {
      return {
        status: "issue",
        title: "No contexts found",
        details: ["Docker should always have at least a 'default' context. This output looks empty or malformed."],
        fixes: ["docker context use default"],
      };
    }

    const currentLine = lines.find((l) => l.includes("*"));

    if (!currentLine) {
      return {
        status: "issue",
        title: "No context is currently selected",
        details: ["None of the listed contexts is marked with '*' as current."],
        fixes: ["docker context use default"],
      };
    }

    const name = currentLine.split(/\s+/)[0].replace("*", "");
    const looksValid = /unix:\/\/|tcp:\/\/|npipe:\/\//.test(currentLine);

    if (!looksValid) {
      return {
        status: "issue",
        title: `Context "${name}" has no recognizable endpoint`,
        details: [
          "The current context's DOCKER ENDPOINT column doesn't look like a valid unix:// or tcp:// address.",
        ],
        fixes: ["docker context use default", "docker context rm " + name],
      };
    }

    return {
      status: "ok",
      title: `Context "${name}" looks correctly configured`,
      details: ["A current context is selected and its endpoint is well-formed."],
      fixes: [],
    };
  }

  const DIAGNOSERS = {
    daemon: diagnoseDaemon,
    modules: diagnoseModules,
    context: diagnoseContext,
  };

  /* ---------- rendering ---------- */

  function renderResult(key, result) {
    const badge = document.getElementById(`badge-${key}`);
    const panel = document.getElementById(`result-${key}`);

    badge.dataset.status = result.status;

    panel.hidden = false;
    panel.dataset.status = result.status === "unknown" ? "" : result.status;

    const detailItems = result.details.map((d) => `<li>${escapeHtml(d)}</li>`).join("");
    const fixRows = result.fixes
      .map(
        (cmd, i) => `
        <div class="fix-row">
          <code id="fix-${key}-${i}">${escapeHtml(cmd)}</code>
          <button class="btn btn-copy" type="button" data-copy-target="fix-${key}-${i}">Copy</button>
        </div>`
      )
      .join("");

    panel.innerHTML = `
      <h3>${escapeHtml(result.title)}</h3>
      <ul>${detailItems}</ul>
      ${fixRows}
    `;
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function updateSummary() {
    const statuses = CHECK_IDS.map((key) => (state[key] && state[key].status) || "unknown");
    const dot = document.getElementById("summary-dot");
    const text = document.getElementById("summary-text");

    const issues = statuses.filter((s) => s === "issue").length;
    const unknown = statuses.filter((s) => s === "unknown").length;

    if (unknown === CHECK_IDS.length) {
      dot.dataset.state = "";
      text.textContent = "Run the checks below to see your Docker health.";
    } else if (issues === 0 && unknown === 0) {
      dot.dataset.state = "ok";
      text.textContent = "All checks passed — Docker looks healthy.";
    } else if (issues === 0) {
      dot.dataset.state = "";
      text.textContent = `${CHECK_IDS.length - unknown} of ${CHECK_IDS.length} checks passed. Finish the rest below.`;
    } else {
      dot.dataset.state = "issue";
      text.textContent = `${issues} issue${issues > 1 ? "s" : ""} found — see the highlighted card${issues > 1 ? "s" : ""} below.`;
    }
  }

  /* ---------- restore saved state on load ---------- */

  function restore() {
    CHECK_IDS.forEach((key) => {
      const saved = state[key];
      if (!saved) return;

      const textarea = document.getElementById(`paste-${key}`);
      if (textarea && saved.paste) textarea.value = saved.paste;

      if (saved.result) {
        renderResult(key, saved.result);
      }
    });
    updateSummary();
  }

  /* ---------- event wiring ---------- */

  function wireDiagnoseButtons() {
    document.querySelectorAll("[data-check]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.getAttribute("data-check");
        const textarea = document.getElementById(`paste-${key}`);
        const result = DIAGNOSERS[key](textarea.value);

        renderResult(key, result);

        state[key] = { paste: textarea.value, result };
        saveState(state);
        updateSummary();
      });
    });
  }

  function wireCopyButtons() {
    document.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-copy-target]");
      if (!btn) return;

      const targetId = btn.getAttribute("data-copy-target");
      const el = document.getElementById(targetId);
      if (!el) return;

      const text = el.textContent;
      copyToClipboard(text).then(() => {
        const original = btn.textContent;
        btn.textContent = "Copied!";
        btn.dataset.copied = "true";
        setTimeout(() => {
          btn.textContent = original;
          btn.dataset.copied = "false";
        }, 1500);
      });
    });
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    }
    return Promise.resolve(fallbackCopy(text));
  }

  function fallbackCopy(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch (e) {
      /* clipboard unavailable — nothing more we can do */
    }
    document.body.removeChild(ta);
  }

  function wireReset() {
    document.getElementById("reset-btn").addEventListener("click", () => {
      state = {};
      saveState(state);

      CHECK_IDS.forEach((key) => {
        document.getElementById(`paste-${key}`).value = "";
        document.getElementById(`badge-${key}`).dataset.status = "unknown";
        const panel = document.getElementById(`result-${key}`);
        panel.hidden = true;
        panel.innerHTML = "";
      });

      updateSummary();
    });
  }

  /* ---------- init ---------- */

  document.addEventListener("DOMContentLoaded", () => {
    restore();
    wireDiagnoseButtons();
    wireCopyButtons();
    wireReset();
  });
})();
