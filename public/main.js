const CURRENT_PROJECT = getProjectFromURL();

injectNav("main");

let logExpanded = false;
let logIndex = 0;

function selectAll() {
  document.querySelectorAll(".host").forEach(x => x.checked = true);
}

function clearAll() {
  document.querySelectorAll(".host").forEach(x => x.checked = false);
}

function selectServers() {
  document.querySelectorAll("#servers .host").forEach(x => x.checked = true);
  document.querySelectorAll("#arms .host").forEach(x => x.checked = false);
}

function selectArms() {
  document.querySelectorAll("#arms .host").forEach(x => x.checked = true);
  document.querySelectorAll("#servers .host").forEach(x => x.checked = false);
}

function selectPB() {
  document.querySelectorAll(".pb").forEach(x => x.checked = true);
}

function clearPB() {
  document.querySelectorAll(".pb").forEach(x => x.checked = false);
}

function toggleLogHeight() {
  const log = document.getElementById("log");
  if (!logExpanded) {
    log.style.height = "700px";
    logExpanded = true;
  } else {
    log.style.height = "360px";
    logExpanded = false;
  }
}

function hostRowHTML(h, status) {
  const cls = status ? "status-up" : "status-down";
  return `
    <label class="host-line">
      <input type="checkbox" class="host" value="${h.hostname}">
      <span class="status-dot ${cls}" id="status_${h.hostname}"></span>
      <span>${h.hostname}</span>
    </label>
  `;
}

function loadMain() {
  fetch("/data?project=" + encodeURIComponent(CURRENT_PROJECT))
    .then(r => r.json())
    .then(data => {
      injectNav("main", data.projects || [], data.selected_project || "");

      document.getElementById("local_ip").innerText = data.local_ip || "UNKNOWN";

      document.getElementById("autodeploy").innerHTML = "";
      document.getElementById("playbooks").innerHTML = "";
      document.getElementById("servers").innerHTML = "";
      document.getElementById("arms").innerHTML = "";

      data.autodeploy.forEach(p => {
        document.getElementById("autodeploy").innerHTML +=
          `<label><input type="checkbox" class="pb" value="${p.name}">${p.name}</label><br>`;
      });

      data.playbooks.forEach(p => {
        document.getElementById("playbooks").innerHTML +=
          `<label><input type="checkbox" class="pb" value="${p.name}">${p.name}</label><br>`;
      });

      data.hosts.servers.forEach(h => {
        document.getElementById("servers").innerHTML += hostRowHTML(h, data.status[h.hostname]);
      });

      data.hosts.arm.forEach(h => {
        document.getElementById("arms").innerHTML += hostRowHTML(h, data.status[h.hostname]);
      });
    });
}

function refreshStatus() {
  fetch("/status?project=" + encodeURIComponent(CURRENT_PROJECT))
    .then(r => r.json())
    .then(data => {
      for (const [host, up] of Object.entries(data)) {
        const el = document.getElementById("status_" + host);
        if (el) {
          el.className = "status-dot " + (up ? "status-up" : "status-down");
        }
      }
    });
}

function runSelected() {
  fetch("/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
        project: CURRENT_PROJECT,
        hosts: Array.from(document.querySelectorAll(".host:checked")).map(x => x.value),
        playbooks: Array.from(document.querySelectorAll(".pb:checked")).map(x => x.value)
      })
  });
}

function runAutodeploy() {
  fetch("/run_autodeploy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      project: CURRENT_PROJECT
    })
  });
}

function stopExecution() {
  fetch("/stop", {
    method: "POST",
    headers: { "Content-Type": "application/json" }
  });
}

function refreshLog() {
  fetch("/log_new?start=" + logIndex)
    .then(r => r.json())
    .then(d => {
      const logEl = document.getElementById("log");
      const atBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 20;

      if (d.lines.length > 0) {
        logEl.innerHTML += (logEl.innerHTML ? "<br>" : "") + d.lines.join("<br>");
        logIndex = d.next;
      }

      if (atBottom) {
        logEl.scrollTop = logEl.scrollHeight;
      }
    });
}

loadMain();
refreshStatus();
refreshLog();

setInterval(refreshStatus, 60000);
setInterval(refreshLog, 2000);