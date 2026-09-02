const CURRENT_PROJECT = getProjectFromURL();
let CURRENT_OBJECT = getObjectFromURL();
let DATA = null;
let logIndex = 0;
let NEW_TEMPLATE = '';
let ACTIVE_GROUP = null;
let CONFIRM_ACTION = null;

function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
}

function api(path, body) {
    return fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    }).then(async (response) => {
        const data = await response.json();
        if (!response.ok || data.ok === false) throw Error(data.error || 'Ошибка');
        return data;
    });
}

function selectedHosts() {
    return [...document.querySelectorAll('.node-check:checked')].map((item) => item.value);
}

function selectedPlaybooks() {
    return [...document.querySelectorAll('.pb:checked')].map((item) => item.value);
}

function updateHostSelectionButton() {
    const button = document.getElementById('host_select_toggle');
    const label = button?.querySelector('.selection-button-label');
    if (!button || !label) return;

    const checks = [...document.querySelectorAll('.node-check')];
    const allSelected = checks.length > 0 && checks.every((item) => item.checked);
    const nextText = allSelected ? 'Отменить выбор' : 'Выбрать все узлы';
    if (label.textContent === nextText) return;

    button.classList.add('selection-changing');
    setTimeout(() => {
        label.textContent = nextText;
        button.classList.remove('selection-changing');
    }, 180);
}

function toggleHostSelection() {
    const checks = [...document.querySelectorAll('.node-check')];
    if (!checks.length) return;

    const allSelected = checks.every((item) => item.checked);
    checks.forEach((item) => item.checked = !allSelected);
    updateHostSelectionButton();
}

function selectPB(value) {
    document.querySelectorAll('.pb').forEach((item) => item.checked = value);
}

function templateLabel(node) {
    return node.template || node.node_type || 'Узел';
}

function renderNode(node) {
    const hasStatus = Object.prototype.hasOwnProperty.call(DATA.status || {}, node.hostname);
    const available = hasStatus ? DATA.status[node.hostname] === true : null;
    const params = Object.entries(node.parameters || {});
    const id = `node-${encodeURIComponent(node.hostname)}`;
    let state;
    let statusClass;

    if (!hasStatus) {
        state = '<span class="node-status pending"><span class="status-dot status-pending"></span>проверка</span>';
        statusClass = 'node-pending';
    } else if (available) {
        state = '<span class="node-status available"><span class="status-dot status-up"></span>доступен</span>';
        statusClass = 'node-available';
    } else {
        state = '<span class="node-status unavailable"><span class="status-dot status-down"></span>недоступен</span>';
        statusClass = 'node-unavailable';
    }

    const fields = params.length
        ? params.map(([key, value]) => `
            <div class="param-name" title="${esc(key)}">${esc(key)}</div>
            <input class="param-value" data-key="${esc(key)}" value="${esc(value)}" readonly>
        `).join('')
        : '<div class="empty">Параметров нет</div>';

    return `
        <div class="host-card node-card ${statusClass}" id="${id}">
            <div class="host-head" onclick="toggleNodeFromHead(event, this.closest('.node-card'))">
                ${state}
                <input class="node-check" type="checkbox" value="${esc(node.hostname)}"
                    onclick="event.stopPropagation()" onchange="updateHostSelectionButton()">
                <span class="node-expand">▸</span>
                <div class="node-main">
                    <span class="node-name">${esc(node.hostname)}</span>
                    <span class="node-ip">${esc(node.ip || '—')}</span>
                    <span class="node-template">${esc(templateLabel(node))}</span>
                </div>
                <button class="node-edit" onclick="editNode(event, '${esc(node.hostname)}')">Изменить</button>
            </div>
            <div class="host-body" hidden>
                <div class="param-grid">${fields}</div>
                <div class="host-footer">
                    <span class="edit-note">${esc(templateLabel(node))} · изменения сохраняются в hosts.yml</span>
                    <button class="edit-save primary" onclick="saveNode(event, '${esc(node.hostname)}')">Сохранить</button>
                    <button class="edit-save" onclick="cancelNodeEdit(event)">Отмена</button>
                </div>
            </div>
        </div>
    `;
}

function animatePanel(body, open) {
    body.style.overflow = 'hidden';
    body.style.transition = 'max-height 220ms ease, opacity 180ms ease';
    if (open) {
        body.hidden = false;
        body.style.opacity = '0';
        body.style.maxHeight = '0px';
        requestAnimationFrame(() => {
            body.style.maxHeight = `${body.scrollHeight}px`;
            body.style.opacity = '1';
        });
    } else {
        body.style.maxHeight = `${body.scrollHeight}px`;
        body.style.opacity = '1';
        requestAnimationFrame(() => {
            body.style.maxHeight = '0px';
            body.style.opacity = '0';
        });
        setTimeout(() => {
            body.hidden = true;
            body.style.maxHeight = '';
            body.style.opacity = '';
            body.style.overflow = '';
        }, 230);
    }
}

function toggleNodeFromHead(event, card) {
    if (event.target.closest('button, input')) return;
    toggleNode(card);
}

function toggleNode(card) {
    if (card.dataset.animating === '1') return;
    const body = card.querySelector('.host-body');
    const open = body.hidden;
    card.dataset.animating = '1';
    animatePanel(body, open);
    card.querySelector('.node-expand').textContent = open ? '▾' : '▸';
    setTimeout(() => card.dataset.animating = '0', 240);
}

function editNode(event, hostname) {
    event.stopPropagation();
    const card = document.getElementById(`node-${encodeURIComponent(hostname)}`);
    const body = card.querySelector('.host-body');
    card.classList.add('editing');
    if (body.hidden) {
        card.dataset.animating = '1';
        animatePanel(body, true);
        card.querySelector('.node-expand').textContent = '▾';
        setTimeout(() => card.dataset.animating = '0', 240);
    }
    card.querySelectorAll('.param-value').forEach((input) => input.readOnly = false);
    card.querySelector('.param-value')?.focus();
}

function cancelNodeEdit(event) {
    event.stopPropagation();
    loadMain();
}

function saveNode(event, hostname) {
    event.stopPropagation();
    const card = document.getElementById(`node-${encodeURIComponent(hostname)}`);
    const values = {};
    card.querySelectorAll('[data-key]').forEach((input) => values[input.dataset.key] = input.value);
    api('/update_host', {
        project: CURRENT_PROJECT, object: CURRENT_OBJECT, hostname, new_hostname: hostname, values
    }).then(loadMain).catch((error) => alert(error.message));
}

function deleteSelectedNodes() {
    const hosts = selectedHosts();
    if (!hosts.length) return alert('Выберите узлы для удаления.');
    if (!confirm(`Удалить выбранные узлы (${hosts.length})?\nЭто изменит hosts.yml.`)) return;
    hosts.reduce(
        (promise, hostname) => promise.then(() => api('/delete_host', {
            project: CURRENT_PROJECT, object: CURRENT_OBJECT, hostname
        })),
        Promise.resolve()
    ).then(loadMain).catch((error) => alert(error.message));
}

function openAddNodeModal() {
    document.getElementById('new_node_name').value = '';
    document.getElementById('add_node_modal').hidden = false;
    renderTemplateTabs();
    setTimeout(() => document.getElementById('new_node_name').focus(), 0);
}

function closeAddNodeModal() {
    document.getElementById('add_node_modal').hidden = true;
}

function renderTemplateTabs() {
    const tabs = document.getElementById('node_template_tabs');
    const schemas = DATA?.template_schemas || {};
    const names = Object.keys(schemas);
    if (!names.length) {
        tabs.innerHTML = '<div class="new-node-empty">Не удалось определить шаблоны по hosts.yml.</div>';
        document.getElementById('new_node_fields').innerHTML = '';
        NEW_TEMPLATE = '';
        return;
    }
    if (!schemas[NEW_TEMPLATE]) NEW_TEMPLATE = names[0];
    tabs.innerHTML = names.map((name) => `
        <button type="button" class="node-type-tab ${name === NEW_TEMPLATE ? 'active' : ''}" onclick="selectTemplate('${esc(name)}')">
            <span class="node-type-title">${esc(name)}</span>
            <span class="node-type-desc">${schemas[name].length} параметров</span>
        </button>
    `).join('');
    renderTemplateFields();
}

function selectTemplate(name) {
    NEW_TEMPLATE = name;
    renderTemplateTabs();
}

function renderTemplateFields() {
    const keys = (DATA.template_schemas || {})[NEW_TEMPLATE] || [];
    document.getElementById('new_node_fields').innerHTML = keys.map((key) => `
        <label class="new-node-field">
            <span>${esc(key)}</span>
            <input data-new-key="${esc(key)}" type="text" placeholder="Значение">
        </label>
    `).join('');
}

function createNode() {
    const name = document.getElementById('new_node_name').value.trim();
    const keys = (DATA.template_schemas || {})[NEW_TEMPLATE] || [];
    if (!name) return document.getElementById('new_node_name').focus();
    if (!keys.length) return alert('Выберите шаблон параметров.');
    const values = {};
    document.querySelectorAll('[data-new-key]').forEach((input) => values[input.dataset.newKey] = input.value);
    api('/add_host', {
        project: CURRENT_PROJECT, object: CURRENT_OBJECT, hostname: name, node_type: NEW_TEMPLATE, values
    }).then(() => {
        closeAddNodeModal();
        loadMain();
    }).catch((error) => alert(error.message));
}

function contextQuery(extra = '') {
    const object = CURRENT_OBJECT ? `&object=${encodeURIComponent(CURRENT_OBJECT)}` : '';
    return `project=${encodeURIComponent(CURRENT_PROJECT)}${object}${extra}`;
}

function editPlaybook(name) {
    const modal = document.getElementById('playbook_modal');
    const editor = document.getElementById('playbook_editor');
    const title = document.getElementById('playbook_modal_title');
    if (!modal || !editor || !title) return;

    window.CURRENT_EDITING_PLAYBOOK = name;
    title.textContent = name;
    editor.value = 'Загрузка…';
    editor.readOnly = true;
    modal.hidden = false;

    fetch(`/playbook?${contextQuery(`&name=${encodeURIComponent(name)}`)}`)
        .then((response) => {
            if (!response.ok) throw Error('Не удалось открыть плейбук');
            return response.json();
        })
        .then((data) => {
            editor.value = data.content || '';
            editor.readOnly = false;
            fitPlaybookEditor();
            editor.focus();
        })
        .catch((error) => {
            editor.value = '';
            alert(error.message);
            closePlaybookModal();
        });
}

function closePlaybookModal() {
    document.getElementById('playbook_modal').hidden = true;
    window.CURRENT_EDITING_PLAYBOOK = '';
}

function savePlaybookFromModal() {
    const name = window.CURRENT_EDITING_PLAYBOOK;
    const editor = document.getElementById('playbook_editor');
    if (!name || !editor) return;
    editor.disabled = true;
    fetch('/save_playbook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: CURRENT_PROJECT, object: CURRENT_OBJECT, name, content: editor.value })
    }).then(async (response) => {
        const data = await response.json();
        if (!response.ok || data.ok === false) throw Error(data.error || 'Не удалось сохранить плейбук');
        closePlaybookModal();
        loadMain();
    }).catch((error) => alert(error.message)).finally(() => editor.disabled = false);
}

function fitPlaybookEditor() {
    const editor = document.getElementById('playbook_editor');
    const card = document.getElementById('playbook_editor_card');
    if (!editor || !card) return;
    const longestLine = editor.value.split('\n').reduce((max, line) => Math.max(max, line.length), 0);
    const width = Math.min(1100, Math.max(620, longestLine * 7.2 + 70));
    editor.style.width = `${width}px`;
    card.style.width = `${Math.min(width + 42, window.innerWidth - 40)}px`;
}

function renderGroups(groups) {
    const element = document.getElementById('groups');
    element.innerHTML = groups?.length
        ? groups.map((group) => `
            <button type="button" class="group-chip group-filter${ACTIVE_GROUP?.name === group.name ? ' active' : ''}"
                data-group-name="${esc(group.name)}">
                <b>${esc(group.name)}</b>${group.hosts.length}
            </button>
        `).join('')
        : '';
}

function groupHosts(group) {
    return new Set((group?.hosts || []).map((host) => typeof host === 'string' ? host : host?.hostname || host?.name));
}

function renderNodes() {
    const hosts = ACTIVE_GROUP
        ? (DATA.hosts || []).filter((node) => groupHosts(ACTIVE_GROUP).has(node.hostname))
        : (DATA.hosts || []);
    document.getElementById('nodes').innerHTML = hosts.map(renderNode).join('') || '<div class="empty">Узлов нет</div>';
    updateHostSelectionButton();
}

function toggleGroup(name) {
    const group = (DATA.groups || []).find((item) => item.name === name);
    ACTIVE_GROUP = ACTIVE_GROUP?.name === name ? null : group || null;
    renderGroups(DATA.groups || []);
    renderNodes();
}

function renderAutodeploy(enabled) {
    const element = document.getElementById('autodeploy_block');
    if (!enabled) return element.innerHTML = '';
    element.innerHTML = `
        <div class="block autodeploy-card">
            <div class="section-head">
                <h3>Авторазвертывание</h3>
                <div class="autodeploy-action">
                    <span class="autodeploy-file">autodeploy.yml</span>
                    <button class="primary" onclick="runAutodeploy()">Запустить</button>
                </div>
            </div>
        </div>
    `;
}

function roleTree(nodes) {
    return (nodes || []).map((node) => {
        if (node.type === 'dir') {
            const readme = (node.children || []).find((child) => child.type === 'file' && child.name.toLowerCase() === 'readme.md');
            const children = (node.children || []).filter((child) => !(child.type === 'file' && child.name.toLowerCase() === 'readme.md'));
            return `
                <div class="role-dir">
                    <button class="role-toggle" onclick="toggleRoleDir(this)">
                        <span class="role-chevron">▸</span> ${esc(node.name)}
                    </button>
                    <div class="role-children" hidden>
                        ${readme ? `<details class="role-readme"><summary>README.md</summary><pre data-readme-path="${esc(readme.path)}">Загрузка…</pre></details>` : ''}
                        ${roleTree(children)}
                    </div>
                </div>
            `;
        }
        return `<button class="role-file" onclick="openRoleFile('${esc(node.path)}')">${esc(node.name)}</button>`;
    }).join('');
}

function renderPlaybooks(items) {
    const element = document.getElementById('playbooks');
    if (!items?.length) return element.innerHTML = '<div class="muted">Плейбуков нет.</div>';
    element.innerHTML = items.map((playbook) => `
        <div class="playbook-card">
            <div class="playbook-row">
                <label>
                    <input type="checkbox" class="pb" value="${esc(playbook.name)}">
                    <span>${esc(playbook.name)}</span>
                </label>
                <div class="playbook-actions">
                    <button onclick="editPlaybook('${esc(playbook.name)}')">Просмотр плейбука</button>
                    <button onclick="togglePlaybookRoles(this, '${esc(playbook.name)}')">Роли ▸</button>
                </div>
            </div>
            <div class="playbook-roles" hidden></div>
        </div>
    `).join('');
}

function togglePlaybookRoles(button, name) {
    const panel = button.closest('.playbook-card').querySelector('.playbook-roles');
    if (!panel.hidden) {
        panel.hidden = true;
        button.textContent = 'Роли ▸';
        return;
    }
    if (!panel.dataset.loaded) {
        panel.innerHTML = '<div class="roles-loading">Загрузка ролей…</div>';
        fetch(`/roles?${contextQuery(`&playbook=${encodeURIComponent(name)}`)}`)
            .then((response) => {
                if (!response.ok) throw Error('Не удалось загрузить роли');
                return response.json();
            })
            .then((roles) => {
                panel.innerHTML = roles.length
                    ? `<div class="roles-title">Роли</div>${roleTree(roles)}`
                    : '<div class="muted">В этом плейбуке роли не указаны.</div>';
                panel.dataset.loaded = '1';
            })
            .catch((error) => panel.innerHTML = `<div class="muted">${esc(error.message)}</div>`);
    }
    panel.hidden = false;
    button.textContent = 'Роли ▾';
}

function toggleRoleDir(button) {
    const children = button.parentElement.querySelector('.role-children');
    const open = !children.hidden;
    children.hidden = open;
    button.querySelector('.role-chevron').textContent = open ? '▸' : '▾';
    if (open) return;
    children.querySelectorAll('pre[data-readme-path]:not([data-loaded])').forEach((pre) => {
        pre.dataset.loaded = '1';
        fetch(`/role_file?${contextQuery(`&path=${encodeURIComponent(pre.dataset.readmePath)}`)}`)
            .then((response) => {
                if (!response.ok) throw Error('Не удалось загрузить README.md');
                return response.json();
            })
            .then((data) => pre.textContent = data.content)
            .catch((error) => pre.textContent = error.message);
    });
}

function openRoleFile(path) {
    fetch(`/role_file?${contextQuery(`&path=${encodeURIComponent(path)}`)}`)
        .then((response) => {
            if (!response.ok) throw Error('Не удалось открыть файл');
            return response.json();
        })
        .then((data) => {
            const windowRef = window.open('', '_blank');
            if (!windowRef) throw Error('Браузер заблокировал новое окно');
            windowRef.document.write(`
                <!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${esc(data.name)}</title>
                <style>body{margin:0;background:#171717;color:#eee;font-family:monospace}header{padding:12px 20px;border-bottom:1px solid #333;color:#aaa}pre{margin:0;padding:22px;white-space:pre-wrap;line-height:1.5}</style>
                </head><body><header>${esc(data.name)}</header><pre>${esc(data.content)}</pre></body></html>
            `);
            windowRef.document.close();
        })
        .catch((error) => alert(error.message));
}

function runAutodeploy() {
    const hosts = selectedHosts();
    document.getElementById('run_state').textContent = '● Выполняется';
    api('/run_autodeploy', { project: CURRENT_PROJECT, hosts }).catch((error) => alert(error.message));
}

function runSelected() {
    const playbooks = selectedPlaybooks();
    const hosts = selectedHosts();
    if (!playbooks.length) return alert('Выберите хотя бы один плейбук');
    document.getElementById('run_state').textContent = '● Выполняется';
    api('/run', { project: CURRENT_PROJECT, object: CURRENT_OBJECT, playbooks, hosts })
        .catch((error) => alert(error.message));
}

function stopExecution() {
    api('/stop', {}).finally(() => {
        document.getElementById('run_state').textContent = 'Остановлено';
    });
}

function showConfirmation(title, text, action) {
    let modal = document.getElementById('run_confirm_modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'run_confirm_modal';
        modal.className = 'modal-backdrop';
        modal.hidden = true;
        modal.innerHTML = `
            <div class="modal-card run-confirm-card" role="dialog" aria-modal="true">
                <div class="modal-head"><div><div class="modal-kicker">Подтверждение запуска</div><h3 id="run_confirm_title"></h3></div><button class="modal-close" type="button">×</button></div>
                <div class="modal-body"><div id="run_confirm_text" class="run-confirm-text"></div></div>
                <div class="modal-footer"><button type="button" class="modal-secondary" id="run_confirm_cancel">Отмена</button><button type="button" class="primary" id="run_confirm_ok">Запустить</button></div>
            </div>
        `;
        document.body.appendChild(modal);
        const close = () => { modal.hidden = true; CONFIRM_ACTION = null; };
        modal.querySelector('.modal-close').onclick = close;
        modal.querySelector('#run_confirm_cancel').onclick = close;
        modal.addEventListener('click', (event) => { if (event.target === modal) close(); });
        modal.querySelector('#run_confirm_ok').onclick = () => {
            const action = CONFIRM_ACTION;
            close();
            if (action) action();
        };
    }
    CONFIRM_ACTION = action;
    modal.querySelector('#run_confirm_title').textContent = title;
    modal.querySelector('#run_confirm_text').innerHTML = text;
    modal.hidden = false;
}

function interceptRunButtons() {
    document.addEventListener('click', (event) => {
        const button = event.target.closest('button');
        if (!button) return;
        const onclick = button.getAttribute('onclick') || '';
        const isRun = /\brunSelected\s*\(/.test(onclick);
        const isAutodeploy = /\brunAutodeploy\s*\(/.test(onclick);
        if (!isRun && !isAutodeploy) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const hosts = selectedHosts();
        if (isRun) {
            const playbooks = selectedPlaybooks();
            if (!playbooks.length) return alert('Выберите хотя бы один плейбук');
            showConfirmation(
                'Запустить выбранные плейбуки?',
                `<strong>Плейбуки:</strong><br>${playbooks.map(esc).join('<br>')}<br><br><strong>Узлы:</strong> ${hosts.length ? `${hosts.length} ${hosts.length === 1 ? 'узел' : 'узлов'}` : 'все узлы'}`,
                runSelected,
            );
        } else {
            showConfirmation(
                'Запустить авторазвертывание?',
                `<strong>Плейбук:</strong> autodeploy.yml<br><br><strong>Узлы:</strong> ${hosts.length ? `${hosts.length} ${hosts.length === 1 ? 'выбранный узел' : 'выбранных узлов'}` : 'все узлы'}`,
                runAutodeploy,
            );
        }
    }, true);
}

function updateNodeStatuses() {
    if (!CURRENT_PROJECT) return;
    const query = `?project=${encodeURIComponent(CURRENT_PROJECT)}${CURRENT_OBJECT ? `&object=${encodeURIComponent(CURRENT_OBJECT)}` : ''}&_=${Date.now()}`;
    fetch(`/status${query}`)
        .then((response) => response.json())
        .then((status) => {
            if (!DATA) return;
            DATA.status = status;
            const selected = new Set(selectedHosts());
            renderNodes();
            document.querySelectorAll('.node-check').forEach((item) => item.checked = selected.has(item.value));
            updateHostSelectionButton();
        })
        .catch(() => {});
}

function loadMain() {
    const objectParam = CURRENT_OBJECT ? `&object=${encodeURIComponent(CURRENT_OBJECT)}` : '';
    fetch(`/data?project=${encodeURIComponent(CURRENT_PROJECT)}${objectParam}&_=${Date.now()}`)
        .then((response) => response.json())
        .then((data) => {
            DATA = data;
            const objectBlock = document.getElementById('object_block');
            if (data.single_object_mode) {
                CURRENT_OBJECT = '';
                if (objectBlock) objectBlock.style.display = 'none';
            } else {
                if (objectBlock) objectBlock.style.display = '';
                const objects = data.objects || [];
                if (!CURRENT_OBJECT && objects.length) {
                    CURRENT_OBJECT = objects[0];
                    history.replaceState({}, '', `/main?project=${encodeURIComponent(CURRENT_PROJECT)}&object=${encodeURIComponent(CURRENT_OBJECT)}`);
                    return loadMain();
                }
                const select = document.getElementById('object_select');
                if (select) select.innerHTML = objects.map((object) => `<option value="${esc(object)}" ${object === CURRENT_OBJECT ? 'selected' : ''}>${esc(object)}</option>`).join('');
            }
            if (ACTIVE_GROUP && !(data.groups || []).some((group) => group.name === ACTIVE_GROUP.name)) ACTIVE_GROUP = null;
            injectNav('main', data.projects || [], data.selected_project || '', CURRENT_OBJECT);
            renderNodes();
            renderGroups(data.groups || []);
            renderAutodeploy(data.autodeploy);
            renderPlaybooks(data.playbooks || []);
        })
        .catch((error) => {
            console.error(error);
            document.getElementById('nodes').innerHTML = '<div class="empty">Не удалось загрузить данные проекта.</div>';
        });
}

function refreshLog() {
    fetch(`/log_new?start=${logIndex}`)
        .then((response) => response.json())
        .then((data) => {
            const element = document.getElementById('log');
            if (data.lines.length) {
                element.textContent += (element.textContent ? '\n' : '') + data.lines.join('\n');
                logIndex = data.next;
                element.scrollTop = element.scrollHeight;
            }
        });
}

document.addEventListener('click', (event) => {
    const group = event.target.closest('.group-filter');
    if (group) toggleGroup(group.dataset.groupName);
});

window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    closeAddNodeModal();
    closePlaybookModal();
    const modal = document.getElementById('run_confirm_modal');
    if (modal) {
        modal.hidden = true;
        CONFIRM_ACTION = null;
    }
});

window.addEventListener('click', (event) => {
    const modal = document.getElementById('add_node_modal');
    if (event.target === modal) closeAddNodeModal();
});

window.addEventListener('resize', () => {
    const modal = document.getElementById('playbook_modal');
    if (modal && !modal.hidden) fitPlaybookEditor();
});

interceptRunButtons();
loadMain();
refreshLog();
setInterval(refreshLog, 1000);
setInterval(updateNodeStatuses, 10000);
