function getParams() {
    return new URLSearchParams(window.location.search);
}

function getProjectFromURL() {
    return getParams().get('project') || '';
}

function getObjectFromURL() {
    return getParams().get('object') || '';
}

function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
}

function projectSelectorHTML(projects, selected) {
    const currentLabel = selected || '-- выберите проект --';
    const options = projects.map((project) => `
        <button type="button" class="project-option${project === selected ? ' active' : ''}" data-project="${escapeHTML(project)}" onclick="selectProjectOption(this.dataset.project)">
            ${escapeHTML(project)}
        </button>
    `).join('');

    return `<div class="project-bar">
        <b>Проект:</b>
        <div class="project-select" id="project_select_wrap">
            <select id="project_select" hidden aria-hidden="true">
                <option value="">-- выберите проект --</option>
                ${projects.map((project) => `<option value="${escapeHTML(project)}" ${project === selected ? 'selected' : ''}>${escapeHTML(project)}</option>`).join('')}
            </select>
            <button type="button" class="project-select-button" id="project_select_button" aria-haspopup="listbox" aria-expanded="false" onclick="toggleProjectSelector(event)">
                <span class="project-select-value">${escapeHTML(currentLabel)}</span>
                <span class="project-select-arrow">▾</span>
            </button>
            <div class="project-select-list" id="project_select_list" role="listbox">
                <button type="button" class="project-option${selected ? '' : ' active'}" data-project="" onclick="selectProjectOption(this.dataset.project)">-- выберите проект --</button>
                ${options}
            </div>
        </div>
    </div>`;
}

function injectProjectSelectorStyles() {
    if (document.getElementById('project-selector-styles')) return;
    const style = document.createElement('style');
    style.id = 'project-selector-styles';
    style.textContent = `
        .project-bar { padding-left: 60px !important; }
        .project-select { position: relative; width: 170px; min-width: 190px; flex: 0 0 190px; }
        .project-select-button {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            width: 100%;
            min-height: 36px;
            height: 36px;
            box-sizing: border-box;
            padding: 7px 12px;
            border-radius: 9px;
            border: 1px solid rgba(255,255,255,.15);
            background: rgba(0,0,0,.5);
            color: #fff;
            text-align: left;
        }
        .project-select-button:hover { background: rgba(0,0,0,.62); transform: none; }
        .project-select-button[aria-expanded="true"] { border-color: rgba(0,210,106,.45); }
        .project-select-value { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .project-select-arrow { flex: 0 0 auto; color: rgba(255,255,255,.65); transition: transform .22s ease; }
        .project-select-button[aria-expanded="true"] .project-select-arrow { transform: rotate(180deg); }
        .project-select-list {
            position: absolute;
            left: 0;
            right: 0;
            top: calc(100% + 5px);
            z-index: 1100;
            max-height: 0;
            overflow: hidden;
            padding: 0 4px;
            box-sizing: border-box;
            border: 1px solid transparent;
            border-radius: 9px;
            background: #1e1e1e;
            box-shadow: 0 12px 30px rgba(0,0,0,.42);
            opacity: 0;
            transform: translateY(-5px);
            pointer-events: none;
            transition: max-height .22s ease, opacity .16s ease, transform .22s ease, padding .22s ease, border-color .22s ease;
        }
        .project-select-list.is-open {
            max-height: 320px;
            overflow-y: auto;
            padding: 4px;
            border-color: rgba(255,255,255,.16);
            opacity: 1;
            transform: translateY(0);
            pointer-events: auto;
        }
        .project-option {
            display: block;
            width: 100%;
            min-height: 34px;
            padding: 7px 10px;
            border: 0;
            border-radius: 6px;
            background: transparent;
            color: #eee;
            text-align: left;
            font-size: 13px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            transition: background .12s ease;
        }
        .project-option:hover, .project-option.active { background: rgba(255,255,255,.10); transform: none; }
        .project-option.active { background: rgba(45,90,138,.75); }

        .object-select-custom {
            position: relative;
            width: min(100%, 420px);
            flex: 0 1 420px;
        }
        .object-select-custom select {
            position: absolute !important;
            width: 1px !important;
            height: 1px !important;
            padding: 0 !important;
            margin: -1px !important;
            overflow: hidden !important;
            clip: rect(0,0,0,0) !important;
            white-space: nowrap !important;
            border: 0 !important;
            opacity: 0 !important;
            pointer-events: none !important;
        }
        .object-select-button {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            width: 100%;
            min-height: 34px;
            height: 34px;
            box-sizing: border-box;
            padding: 6px 12px;
            border-radius: 9px;
            border: 1px solid rgba(255,255,255,.15);
            background: rgba(0,0,0,.5);
            color: #fff;
            text-align: left;
        }
        .object-select-button:hover { background: rgba(0,0,0,.62); transform: none; }
        .object-select-button[aria-expanded="true"] { border-color: rgba(0,210,106,.45); }
        .object-select-value { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .object-select-arrow { flex: 0 0 auto; color: rgba(255,255,255,.65); transition: transform .22s ease; }
        .object-select-button[aria-expanded="true"] .object-select-arrow { transform: rotate(180deg); }
        .object-select-list {
            position: fixed;
            left: 0;
            top: 0;
            z-index: 10000;
            max-height: 0;
            overflow: hidden;
            padding: 0 4px;
            box-sizing: border-box;
            border: 1px solid transparent;
            border-radius: 9px;
            background: #1e1e1e;
            box-shadow: 0 12px 30px rgba(0,0,0,.42);
            opacity: 0;
            transform: translateY(-5px);
            pointer-events: none;
            transition: max-height .22s ease, opacity .16s ease, transform .22s ease, padding .22s ease, border-color .22s ease;
        }
        .object-select-list.is-open {
            max-height: 320px;
            overflow-y: auto;
            padding: 4px;
            border-color: rgba(255,255,255,.16);
            opacity: 1;
            transform: translateY(0);
            pointer-events: auto;
        }
        .object-option {
            display: block;
            width: 100%;
            min-height: 34px;
            padding: 7px 10px;
            border: 0;
            border-radius: 6px;
            background: transparent;
            color: #eee;
            text-align: left;
            font-size: 13px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            transition: background .12s ease;
        }
        .object-option:hover, .object-option.active { background: rgba(45,90,138,.75); transform: none; }

        .playbook-card { overflow: visible; }
        .playbook-roles,
        .role-children {
            width: 100%;
            max-width: none;
            box-sizing: border-box;
            max-height: none !important;
            overflow: visible !important;
        }
        .playbook-roles.smooth-panel, .role-children.smooth-panel { overflow: hidden !important; }
        .playbook-actions button[onclick*="togglePlaybookRoles"] {
            width: 160px !important;
            min-width: 160px !important;
            text-align: center;
            font-size: 0 !important;
        }
        .playbook-actions button[onclick*="togglePlaybookRoles"]::after {
            content: 'Файлы плейбука';
            font: 600 13px Arial, sans-serif;
        }

        #add_node_modal .modal-card {
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }
        #add_node_modal .modal-head,
        #add_node_modal .modal-footer { flex: 0 0 auto; }
        #add_node_modal .modal-body {
            min-height: 0;
            overflow: hidden;
        }
        #add_node_modal .node-modal-fields {
            min-height: 0;
            overflow-y: auto;
        }
    `;
    document.head.appendChild(style);
}

function positionObjectSelectorList(wrap, list) {
    if (!wrap || !list) return;
    const button = wrap.querySelector('.object-select-button');
    if (!button) return;
    const rect = button.getBoundingClientRect();
    list.style.left = `${rect.left}px`;
    list.style.top = `${rect.bottom + 5}px`;
    list.style.width = `${rect.width}px`;
}

function enhanceObjectSelector() {
    const select = document.getElementById('object_select');
    if (!select || select.dataset.customObjectSelect === '1') return;
    select.dataset.customObjectSelect = '1';

    const wrap = document.createElement('div');
    wrap.className = 'object-select-custom';
    select.parentNode.insertBefore(wrap, select);
    wrap.appendChild(select);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'object-select-button';
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', 'false');
    button.innerHTML = '<span class="object-select-value"></span><span class="object-select-arrow">▾</span>';
    wrap.appendChild(button);

    const list = document.createElement('div');
    list.className = 'object-select-list';
    list.setAttribute('role', 'listbox');
    wrap.appendChild(list);

    function sync() {
        const options = [...select.options];
        const value = select.selectedOptions[0]?.textContent || '';
        button.querySelector('.object-select-value').textContent = value;
        list.innerHTML = options.map((option, index) => `<button type="button" class="object-option${option.selected ? ' active' : ''}" data-index="${index}">${escapeHTML(option.textContent)}</button>`).join('');
        list.querySelectorAll('.object-option').forEach((item) => {
            item.addEventListener('click', (event) => {
                event.stopPropagation();
                const index = Number(item.dataset.index);
                if (!select.options[index]) return;
                select.selectedIndex = index;
                list.classList.remove('is-open');
                button.setAttribute('aria-expanded', 'false');
                select.dispatchEvent(new Event('change', { bubbles: true }));
            });
        });
        if (list.classList.contains('is-open')) positionObjectSelectorList(wrap, list);
    }

    button.addEventListener('click', (event) => {
        event.stopPropagation();
        const open = list.classList.contains('is-open');
        document.querySelectorAll('.object-select-custom.is-open').forEach((item) => {
            item.classList.remove('is-open');
            item.querySelector('.object-select-button')?.setAttribute('aria-expanded', 'false');
        });
        if (!open) {
            positionObjectSelectorList(wrap, list);
            list.classList.add('is-open');
            button.setAttribute('aria-expanded', 'true');
        } else {
            list.classList.remove('is-open');
            button.setAttribute('aria-expanded', 'false');
        }
    });

    select.addEventListener('change', sync);
    new MutationObserver(sync).observe(select, { childList: true, subtree: true });
    window.addEventListener('resize', () => {
        if (list.classList.contains('is-open')) positionObjectSelectorList(wrap, list);
    });
    window.addEventListener('scroll', () => {
        if (list.classList.contains('is-open')) positionObjectSelectorList(wrap, list);
    }, true);
    sync();
}

function injectRoleAndModalBehavior() {
    if (document.documentElement.dataset.awcRoleModalFix === '1') return;
    document.documentElement.dataset.awcRoleModalFix = '1';

    function updateRoleAncestors(panel) {
        let parent = panel?.parentElement;
        while (parent) {
            if (parent.classList.contains('role-children') || parent.classList.contains('playbook-roles')) {
                if (!parent.hidden) parent.style.maxHeight = `${parent.scrollHeight}px`;
            }
            parent = parent.parentElement;
        }
    }

    function animateRolePanel(panel, open) {
        if (!panel || panel.dataset.animating === '1') return;
        panel.classList.add('smooth-panel');
        panel.dataset.animating = '1';
        if (open) {
            panel.hidden = false;
            panel.style.overflow = 'hidden';
            panel.style.maxHeight = '0px';
            panel.style.opacity = '0';
            requestAnimationFrame(() => {
                panel.style.maxHeight = `${panel.scrollHeight}px`;
                panel.style.opacity = '1';
                updateRoleAncestors(panel);
            });
            setTimeout(() => {
                panel.dataset.animating = '0';
                updateRoleAncestors(panel);
            }, 240);
        } else {
            panel.style.overflow = 'hidden';
            panel.style.maxHeight = `${panel.scrollHeight}px`;
            panel.style.opacity = '1';
            requestAnimationFrame(() => {
                panel.style.maxHeight = '0px';
                panel.style.opacity = '0';
            });
            setTimeout(() => {
                panel.hidden = true;
                panel.style.maxHeight = '';
                panel.style.opacity = '';
                panel.style.overflow = '';
                panel.dataset.animating = '0';
                updateRoleAncestors(panel);
            }, 240);
        }
    }

    function loadRoleReadmes(children) {
        children.querySelectorAll('pre[data-readme-path]:not([data-loaded])').forEach((pre) => {
            pre.dataset.loaded = '1';
            fetch(`/role_file?project=${encodeURIComponent(CURRENT_PROJECT)}${CURRENT_OBJECT ? `&object=${encodeURIComponent(CURRENT_OBJECT)}` : ''}&path=${encodeURIComponent(pre.dataset.readmePath)}`)
                .then((response) => { if (!response.ok) throw Error('Не удалось загрузить README.md'); return response.json(); })
                .then((data) => {
                    pre.textContent = data.content;
                    updateRoleAncestors(children);
                })
                .catch((error) => { pre.textContent = error.message; updateRoleAncestors(children); });
        });
    }

    function toggleRoleDirAnimated(button) {
        const children = button.parentElement?.querySelector('.role-children');
        if (!children) return;
        const open = children.hidden;
        animateRolePanel(children, open);
        loadRoleReadmes(children);
        const chevron = button.querySelector('.role-chevron');
        if (chevron) chevron.textContent = open ? '▾' : '▸';
    }

    function togglePlaybookRolesAnimated(button) {
        const panel = button.closest('.playbook-card')?.querySelector('.playbook-roles');
        if (!panel || panel.dataset.animating === '1') return;
        const open = panel.hidden;
        const name = button.closest('.playbook-row')?.querySelector('label span')?.textContent?.trim() || '';
        button.setAttribute('aria-expanded', String(open));
        if (open && !panel.dataset.loaded) {
            panel.innerHTML = '<div class="roles-loading">Загрузка ролей…</div>';
            animateRolePanel(panel, true);
            fetch(`/roles?project=${encodeURIComponent(CURRENT_PROJECT)}${CURRENT_OBJECT ? `&object=${encodeURIComponent(CURRENT_OBJECT)}` : ''}&playbook=${encodeURIComponent(name)}`)
                .then((response) => { if (!response.ok) throw Error('Не удалось загрузить роли'); return response.json(); })
                .then((roles) => {
                    panel.innerHTML = roles.length ? `<div class="roles-title">Роли</div>${roleTree(roles)}` : '<div class="muted">В этом плейбуке роли не указаны.</div>';
                    panel.dataset.loaded = '1';
                    requestAnimationFrame(() => {
                        panel.style.maxHeight = `${panel.scrollHeight}px`;
                        updateRoleAncestors(panel);
                    });
                })
                .catch((error) => {
                    panel.innerHTML = `<div class="muted">${escapeHTML(error.message)}</div>`;
                    requestAnimationFrame(() => { panel.style.maxHeight = `${panel.scrollHeight}px`; updateRoleAncestors(panel); });
                });
        } else {
            animateRolePanel(panel, open);
        }
        const text = open ? 'Роли ▾' : 'Роли ▸';
        button.setAttribute('data-role-state', open ? 'open' : 'closed');
        button.setAttribute('aria-label', open ? 'Файлы плейбука: свернуть' : 'Файлы плейбука: развернуть');
        button.textContent = text;
    }

    document.addEventListener('click', (event) => {
        const roleButton = event.target.closest('.role-toggle');
        if (roleButton) {
            event.preventDefault();
            event.stopImmediatePropagation();
            toggleRoleDirAnimated(roleButton);
            return;
        }
        const playbookButton = event.target.closest('.playbook-actions button[onclick*="togglePlaybookRoles"]');
        if (playbookButton) {
            event.preventDefault();
            event.stopImmediatePropagation();
            togglePlaybookRolesAnimated(playbookButton);
        }
    }, true);
}

function injectNav(active, projects = [], selectedProject = '', selectedObject = '') {
    const selector = document.getElementById('project_selector');
    injectProjectSelectorStyles();
    if (selector) selector.innerHTML = projectSelectorHTML(projects, selectedProject);
    enhanceObjectSelector();
}

function toggleProjectSelector(event) {
    event?.stopPropagation();
    const button = document.getElementById('project_select_button');
    const list = document.getElementById('project_select_list');
    if (!button || !list) return;
    const open = list.classList.toggle('is-open');
    button.setAttribute('aria-expanded', String(open));
}

function closeProjectSelector() {
    const button = document.getElementById('project_select_button');
    const list = document.getElementById('project_select_list');
    if (!button || !list) return;
    list.classList.remove('is-open');
    button.setAttribute('aria-expanded', 'false');
}

function selectProjectOption(project) {
    const select = document.getElementById('project_select');
    if (!select) return;
    select.value = project;
    changeProject();
}

document.addEventListener('click', (event) => {
    const projectWrap = document.getElementById('project_select_wrap');
    if (projectWrap && !projectWrap.contains(event.target)) closeProjectSelector();
    const objectWrap = document.querySelector('.object-select-custom');
    if (objectWrap && !objectWrap.contains(event.target)) {
        objectWrap.classList.remove('is-open');
        objectWrap.querySelector('.object-select-button')?.setAttribute('aria-expanded', 'false');
    }
});

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

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        injectProjectSelectorStyles();
        enhanceObjectSelector();
        injectRoleAndModalBehavior();
    }, { once: true });
} else {
    injectProjectSelectorStyles();
    enhanceObjectSelector();
    injectRoleAndModalBehavior();
}
