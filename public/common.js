function getProjectFromURL() {
  const params = new URLSearchParams(window.location.search);
  return params.get("project") || "";
}

function projectSelectorHTML(projects, selectedProject) {
  return `
    <div class="project-bar">
      <label class="project-label">Проект:</label>
      <select id="project_select" onchange="changeProject()">
        <option value="">-- выберите проект --</option>
        ${projects.map(p => `
          <option value="${p}" ${p === selectedProject ? "selected" : ""}>${p}</option>
        `).join("")}
      </select>
    </div>
  `;
}

function navHTML(active, project) {
  const q = project ? `?project=${encodeURIComponent(project)}` : "";

  return `
    <div class="tabs">
      <a href="/main${q}" class="tab ${active === 'main' ? 'active' : ''}">Запуск</a>
      <a href="/hosts_info${q}" class="tab ${active === 'hosts' ? 'active' : ''}">Информация о хостах</a>
      <a href="/editor${q}" class="tab ${active === 'editor' ? 'active' : ''}">Редактор</a>
    </div>
  `;
}

function injectNav(active, projects = [], selectedProject = "") {
  const nav = document.getElementById("nav");
  const projectBox = document.getElementById("project_selector");

  if (nav) {
    nav.innerHTML = navHTML(active, selectedProject);
  }

  if (projectBox) {
    projectBox.innerHTML = projectSelectorHTML(projects, selectedProject);
  }
}

function changeProject() {
  const project = document.getElementById("project_select").value;
  const path = window.location.pathname;

  if (project) {
    window.location.href = `${path}?project=${encodeURIComponent(project)}`;
  } else {
    window.location.href = path;
  }
}
