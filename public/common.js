function getParams() {
    return new URLSearchParams(window.location.search);
}

function getProjectFromURL() {
    return getParams().get('project') || '';
}

function getObjectFromURL() {
    return getParams().get('object') || '';
}

function projectSelectorHTML(projects, selected) {
    return `<div class="project-bar"><b>Проект:</b><select id="project_select" onchange="changeProject()"><option value="">-- выберите проект --</option>${projects.map((project) => `<option value="${project}" ${project === selected ? 'selected' : ''}>${project}</option>`).join('')}</select></div>`;
}

function navHTML() {
    return '';
}

function injectNav(active, projects = [], selectedProject = '', selectedObject = '') {
    const nav = document.getElementById('nav');
    const selector = document.getElementById('project_selector');
    if (nav) nav.innerHTML = navHTML();
    if (selector) selector.innerHTML = projectSelectorHTML(projects, selectedProject);
}

// ИСПРАВЛЕНО: Сохраняем параметр object при смене проекта
function changeProject() {
    const project = document.getElementById('project_select').value;
    const currentObject = getObjectFromURL(); 
    
    let url = project ? `${window.location.pathname}?project=${encodeURIComponent(project)}` : window.location.pathname;
    
    if (project && currentObject) {
        url += `&object=${encodeURIComponent(currentObject)}`;
    }
    
    window.location.href = url;
}

function changeObject() {
    const object = document.getElementById('object_select').value;
    const project = getProjectFromURL();
    window.location.href = `${window.location.pathname}?project=${encodeURIComponent(project)}&object=${encodeURIComponent(object)}`;
}