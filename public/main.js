const CURRENT_PROJECT = getProjectFromURL();
let CURRENT_OBJECT = getObjectFromURL();
let DATA = null;
let logIndex = 0;
let RUNNING = false;
let NEW_TEMPLATE = '';

function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[char]));
}

function api(path, body) {
    return fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    }).then(async (response) => {
        const data = await response.json();
        if (!response.ok || data.ok === false) {
            throw Error(data.error || 'Ошибка');
        }
        return data;
    });
}

function selectPB(value) {
    document.querySelectorAll('.pb').forEach((item) => item.checked = value);
    updateRunHint();
}

function selectHosts(value) {
    document.querySelectorAll('.node-check').forEach((item) => item.checked = value);
    updateRunHint();
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
                <input class="node-check" type="checkbox" value="${esc(node.hostname)}" onclick="event.stopPropagation()" onchange="updateRunHint()">
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
    const first = card.querySelector('.param-value');
    if (first) first.focus();
}

function cancelNodeEdit(event) {
    event.stopPropagation();
    loadMain();
}

function saveNode(event, hostname) {
    event.stopPropagation();
    const card = document.getElementById(`node-${encodeURIComponent(hostname)}`);
    const values = {};
    card.querySelectorAll('[data-key]').forEach((input) => {
        values[input.dataset.key] = input.value;
    });

    api('/update_host', {
        project: CURRENT_PROJECT,
        object: CURRENT_OBJECT,
        hostname,
        new_hostname: hostname,
        values
    }).then(loadMain).catch((error) => alert(error.message));
}

function deleteSelectedNodes() {
    const selected = [...document.querySelectorAll('.node-check:checked')].map((item) => item.value);
    if (!selected.length) return alert('Выберите узлы для удаления.');
    if (!confirm(`Удалить выбранные узлы (${selected.length})?\nЭто изменит hosts.yml.`)) return;

    selected.reduce(
        (promise, hostname) => promise.then(() => api('/delete_host', {
            project: CURRENT_PROJECT,
            object: CURRENT_OBJECT,
            hostname
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
    document.querySelectorAll('[data-new-key]').forEach((input) => {
        values[input.dataset.newKey] = input.value;
    });

    api('/add_host', {
        project: CURRENT_PROJECT,
        object: CURRENT_OBJECT,
        hostname: name,
        node_type: NEW_TEMPLATE,
        values
    }).then(() => {
        closeAddNodeModal();
        loadMain();
    }).catch((error) => alert(error.message));
}

function runAutodeploy() {
    const hosts = [...document.querySelectorAll('.node-check:checked')].map((item) => item.value);
    RUNNING = true;
    document.getElementById('run_state').textContent = '● Выполняется';
    api('/run_autodeploy', { project: CURRENT_PROJECT, hosts }).catch((error) => alert(error.message));
}

function editPlaybook(name) {
    location.href = `/editor?project=${encodeURIComponent(CURRENT_PROJECT)}${CURRENT_OBJECT ? `&object=${encodeURIComponent(CURRENT_OBJECT)}` : ''}&playbook=${encodeURIComponent(name)}`;
}

function updateRunHint() {
    const playbooks = document.querySelectorAll('.pb:checked').length;
    const hosts = document.querySelectorAll('.node-check:checked').length;
    const element = document.getElementById('run_hint');
    if (!element) return;
    element.textContent = playbooks
        ? `Выбрано: ${playbooks} плейбук${playbooks === 1 ? '' : 'а'}${hosts ? ` · ${hosts} узл${hosts === 1 ? 'ел' : 'а'}` : ' · все узлы'}`
        : 'Выберите плейбук для запуска';
}

function runSelected() {
    const playbooks = [...document.querySelectorAll('.pb:checked')].map((item) => item.value);
    const hosts = [...document.querySelectorAll('.node-check:checked')].map((item) => item.value);

    if (!playbooks.length) return alert('Выберите хотя бы один плейбук');

    RUNNING = true;
    document.getElementById('run_state').textContent = '● Выполняется';
    api('/run', {
        project: CURRENT_PROJECT,
        object: CURRENT_OBJECT,
        playbooks,
        hosts
    }).catch((error) => alert(error.message));
}

function stopExecution() {
    api('/stop', {}).finally(() => {
        RUNNING = false;
        document.getElementById('run_state').textContent = 'Остановлено';
    });
}

function renderGroups(groups) {
    const element = document.getElementById('groups');
    if (!groups?.length) {
        element.innerHTML = '';
        return;
    }
    element.innerHTML = groups.map((group) => `
        <span class="group-chip"><b>${esc(group.name)}</b>${group.hosts.length}</span>
    `).join('');
}

function renderAutodeploy(enabled) {
    const element = document.getElementById('autodeploy_block');
    if (!enabled) {
        element.innerHTML = '';
        return;
    }
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
            const readme = (node.children || []).find(
                (child) => child.type === 'file' && child.name.toLowerCase() === 'readme.md'
            );
            const children = (node.children || []).filter(
                (child) => !(child.type === 'file' && child.name.toLowerCase() === 'readme.md')
            );

            return `
                <div class="role-dir">
                    <button class="role-toggle" onclick="toggleRoleDir(this)">
                        <span class="role-chevron">▸</span> ${esc(node.name)}
                    </button>
                    <div class="role-children" hidden>
                        ${readme ? `
                            <details class="role-readme">
                                <summary>README.md</summary>
                                <pre data-readme-path="${esc(readme.path)}">Загрузка…</pre>
                            </details>
                        ` : ''}
                        ${roleTree(children)}
                    </div>
                </div>
            `;
        }

        return `
            <button class="role-file" onclick="openRoleFile('${esc(node.path)}')">
                ${esc(node.name)}
            </button>
        `;
    }).join('');
}

function renderPlaybooks(items) {
    const element = document.getElementById('playbooks');
    if (!items?.length) {
        element.innerHTML = '<div class="muted">Плейбуков нет.</div>';
        return;
    }

    element.innerHTML = items.map((playbook) => `
        <div class="playbook-card">
            <div class="playbook-row">
                <label>
                    <input type="checkbox" class="pb" value="${esc(playbook.name)}" onchange="updateRunHint()">
                    <span>${esc(playbook.name)}</span>
                </label>
                <div class="playbook-actions">
                    <button onclick="editPlaybook('${esc(playbook.name)}')">Просмотр плейбука</button>
                    <button class="playbook-roles-toggle" onclick="togglePlaybookRoles(this, '${esc(playbook.name)}')">Роли ▸</button>
                </div>
            </div>
            <div class="playbook-roles" data-playbook="${esc(playbook.name)}" hidden></div>
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
        const query = `?project=${encodeURIComponent(CURRENT_PROJECT)}${CURRENT_OBJECT ? `&object=${encodeURIComponent(CURRENT_OBJECT)}` : ''}&playbook=${encodeURIComponent(name)}`;

        fetch(`/roles${query}`)
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
            .catch((error) => {
                panel.innerHTML = `<div class="muted">${esc(error.message)}</div>`;
            });
    }

    panel.hidden = false;
    button.textContent = 'Роли ▾';
}

function toggleRoleDir(button) {
    const children = button.parentElement.querySelector('.role-children');
    const open = !children.hidden;
    children.hidden = open;
    button.querySelector('.role-chevron').textContent = open ? '▸' : '▾';

    if (!open) {
        children.querySelectorAll('pre[data-readme-path]:not([data-loaded])').forEach((pre) => {
            pre.dataset.loaded = '1';
            const query = `?project=${encodeURIComponent(CURRENT_PROJECT)}${CURRENT_OBJECT ? `&object=${encodeURIComponent(CURRENT_OBJECT)}` : ''}&path=${encodeURIComponent(pre.dataset.readmePath)}`;
            fetch(`/role_file${query}`)
                .then((response) => {
                    if (!response.ok) throw Error('Не удалось загрузить README.md');
                    return response.json();
                })
                .then((data) => pre.textContent = data.content)
                .catch((error) => pre.textContent = error.message);
        });
    }
}

function openRoleFile(path) {
    const query = `?project=${encodeURIComponent(CURRENT_PROJECT)}${CURRENT_OBJECT ? `&object=${encodeURIComponent(CURRENT_OBJECT)}` : ''}&path=${encodeURIComponent(path)}`;

    fetch(`/role_file${query}`)
        .then((response) => {
            if (!response.ok) throw Error('Не удалось открыть файл');
            return response.json();
        })
        .then((data) => {
            const windowRef = window.open('', '_blank');
            if (!windowRef) throw Error('Браузер заблокировал новое окно');

            windowRef.document.write(`
                <!doctype html>
                <html lang="ru">
                <head>
                    <meta charset="utf-8">
                    <title>${esc(data.name)}</title>
                    <style>
                        body { margin: 0; background: #171717; color: #eee; font-family: monospace; }
                        header { padding: 12px 20px; border-bottom: 1px solid #333; color: #aaa; }
                        pre { margin: 0; padding: 22px; white-space: pre-wrap; line-height: 1.5; }
                    </style>
                </head>
                <body>
                    <header>${esc(data.name)}</header>
                    <pre>${esc(data.content)}</pre>
                </body>
                </html>
            `);
            windowRef.document.close();
        })
        .catch((error) => alert(error.message));
}

function updateNodeStatuses() {
    if (!CURRENT_PROJECT) return;

    const query = `?project=${encodeURIComponent(CURRENT_PROJECT)}${CURRENT_OBJECT ? `&object=${encodeURIComponent(CURRENT_OBJECT)}` : ''}&_=${Date.now()}`;
    fetch(`/status${query}`)
        .then((response) => response.json())
        .then((status) => {
            if (!DATA) return;
            DATA.status = status;
            const selected = new Set([...document.querySelectorAll('.node-check:checked')].map((item) => item.value));
            document.getElementById('nodes').innerHTML = (DATA.hosts || []).map(renderNode).join('') || '<div class="empty">Узлов нет</div>';
            document.querySelectorAll('.node-check').forEach((item) => item.checked = selected.has(item.value));
            updateRunHint();
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
                if (select) {
                    select.innerHTML = objects.map((object) => `
                        <option value="${esc(object)}" ${object === CURRENT_OBJECT ? 'selected' : ''}>${esc(object)}</option>
                    `).join('');
                }
            }

            injectNav('main', data.projects || [], data.selected_project || '', CURRENT_OBJECT);
            document.getElementById('nodes').innerHTML = (data.hosts || []).map(renderNode).join('') || '<div class="empty">Узлов нет</div>';
            renderGroups(data.groups || []);
            renderAutodeploy(data.autodeploy);
            renderPlaybooks(data.playbooks || []);
            updateRunHint();
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

window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeAddNodeModal();
});

window.addEventListener('click', (event) => {
    const modal = document.getElementById('add_node_modal');
    if (event.target === modal) closeAddNodeModal();
});

loadMain();
refreshLog();
setInterval(refreshLog, 1000);
setInterval(updateNodeStatuses, 15000);
