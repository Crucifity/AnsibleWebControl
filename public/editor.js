const CURRENT_PROJECT = getProjectFromURL();

function loadEditors() {
  fetch("/data?project=" + encodeURIComponent(CURRENT_PROJECT))
    .then(r => r.json())
    .then(data => {
      injectNav("editor", data.projects || [], data.selected_project || "");

      return fetch("/files?project=" + encodeURIComponent(CURRENT_PROJECT));
    })
    .then(r => r.json())
    .then(data => {
      document.getElementById("hosts_editor").value = data.hosts || "";
      document.getElementById("defaults_editor").value = data.defaults || "";
    });
}

function saveEditors() {
  fetch("/save_files", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      project: CURRENT_PROJECT,
      hosts: document.getElementById("hosts_editor").value,
      defaults: document.getElementById("defaults_editor").value
    })
  })
  .then(() => alert("Изменения сохранены"));
}

loadEditors();
