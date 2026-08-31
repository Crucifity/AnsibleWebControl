const P = getProjectFromURL();
let O = getObjectFromURL();
let DATA = null;
let NEW_NODE_TYPE = 'host';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
}[c]));

function changeObject() {
    O = document.getElementById('object_select').value;
    location.href = `/hosts_info?project=${encodeURIComponent(P)}&object=${encodeURIComponent(O)}`;
}

function api(path, body) {
    return fetch(path, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body)
    }).then(async (response) => {
        const data = await response.json();
        if (!response.ok || data.ok === false) {
            throw Error(data.error || 'Ошибка');
        }
        return data;
    });
}

function field(key, value, edit = false) {
    return `
        <div class="param-name" title="${esc(key)}">${esc(key)}</div>
        <input class="param-value" data-key="${esc(key)}" value="${esc(value)}" ${edit ? '' : 'readonly'}>
    `;
}

function nodeType(host) {
    const keys = Object.keys(host.parameters || {});
    const last = keys.length ? keys[keys.length - 1] : '';
    return last === 'uefi' ? 'host' : last === 'Description' ? 'md' : 'unknown';
}

function nodeTypeLabel(type) {
    return type === 'md' ? 'МД' : type === 'host' ? 'Хост' : 'Узел';
}

function card(host) {
    const params = Object.entries(host.parameters || {});
    const type = host.node_type || nodeType(host);
    const status = DATA.status[host.hostname];

    return `
        <div class="host-card" id="host-${encodeURIComponent(host.hostname)}">
            <div class="host-head" onclick="toggleHost(this.parentElement)">
                <span class="chevron">▸</span>
                <span class="title">${esc(host.hostname)}</span>
                <span class="node-badge">${nodeTypeLabel(type)}</span>
                <span class="status-dot ${status ? 'status-up' : 'status-down'}"></span>
                <span class="host-state">${status ? 'доступен' : 'недоступен'}</span>
                <div class="host-actions" onclick="event.stopPropagation()">
                    <button onclick="editHost(this)">Изменить</button>
                    <button class="danger" onclick="deleteHost('${esc(host.hostname)}')">Удалить</button>
                </div>
            </div>

            <div class="host-body" hidden>
                <div class="param-grid">
                    ${params.length
                        ? params.map(([key, value]) => field(key, value)).join('')
                        : '<div class="empty">Параметров нет</div>'}
                </div>
                <div class="host-footer">
                    <span class="edit-note">Изменение применяется к hosts.yml</span>
                    <button class="edit-save primary" onclick="saveHost(event, '${esc(host.hostname)}')">Сохранить</button>
                    <button class="edit-save" onclick="cancelEdit(event)">Отмена</button>
                </div>
            </div>
        </div>
    `;
}

function toggleHost(cardElement) {
    const body = cardElement.querySelector('.host-body');
    body.hidden = !body.hidden;
    cardElement.querySelector('.chevron').textContent = body.hidden ? '▸' : '▾';
}

function editHost(button) {
    const cardElement = button.closest('.host-card');
    cardElement.classList.add('editing');
    cardElement.querySelector('.host-body').hidden = false;
    cardElement.querySelector('.chevron').textContent = '▾';
    cardElement.querySelectorAll('input').forEach((input) => input.readOnly = false);

    const first = cardElement.querySelector('input');
    if (first) first.focus();
}

function cancelEdit(event) {
    event.stopPropagation();
    load();
}

function saveHost(event, oldName) {
    event.stopPropagation();
    const cardElement = document.getElementById(`host-${encodeURIComponent(oldName)}`);
    const values = {};

    cardElement.querySelectorAll('[data-key]').forEach((input) => {
        values[input.dataset.key] = input.value;
    });

    api('/update_host', {
        project: P,
        object: O,
        hostname: oldName,
        new_hostname: oldName,
        values
    }).then(load).catch((error) => alert(error.message));
}

function deleteHost(name) {
    if (!confirm(`Удалить узел «${name}»?\nЭто действие изменит hosts.yml.`)) return;

    api('/delete_host', {
        project: P,
        object: O,
        hostname: name
    }).then(load).catch((error) => alert(error.message));
}

function getNodeSchemas() {
    const schemas = {host: [], md: []};

    (DATA.hosts || []).forEach((item) => {
        const type = item.node_type || nodeType(item);
        if (!schemas[type]) return;

        Object.keys(item.parameters || {}).forEach((key) => {
            if (!schemas[type].includes(key)) schemas[type].push(key);
        });
    });

    return schemas;
}

function selectNodeType(type) {
    NEW_NODE_TYPE = type;

    document.querySelectorAll('.node-type-tab').forEach((tab) => {
        tab.classList.toggle('active', tab.dataset.nodeType === type);
    });

    renderNewNodeFields();
}

function renderNewNodeFields() {
    const container = document.getElementById('new_node_fields');
    const schemas = getNodeSchemas();
    const keys = schemas[NEW_NODE_TYPE] || [];

    if (!keys.length) {
        container.innerHTML = `
            <div class="new-node-empty">
                Для типа «${nodeTypeLabel(NEW_NODE_TYPE)}» пока нет примера параметров.
                Сначала должен существовать хотя бы один такой узел в hosts.yml.
            </div>
        `;
        return;
    }

    container.innerHTML = keys.map((key) => `
        <label class="new-node-field">
            <span>${esc(key)}</span>
            <input data-new-key="${esc(key)}" type="text" placeholder="Значение">
        </label>
    `).join('');
}

function openAddNodeModal() {
    NEW_NODE_TYPE = 'host';
    document.getElementById('new_node_name').value = '';
    document.getElementById('add_node_modal').hidden = false;
    selectNodeType('host');
    setTimeout(() => document.getElementById('new_node_name').focus(), 0);
}

function closeAddNodeModal() {
    document.getElementById('add_node_modal').hidden = true;
}

function createNode() {
    const nameInput = document.getElementById('new_node_name');
    const name = nameInput.value.trim();

    if (!name) {
        nameInput.focus();
        return;
    }

    const values = {};
    document.querySelectorAll('[data-new-key]').forEach((input) => {
        values[input.dataset.newKey] = input.value;
    });

    const schemas = getNodeSchemas();
    const requiredKeys = schemas[NEW_NODE_TYPE] || [];

    if (!requiredKeys.length) {
        alert(`Нельзя создать ${nodeTypeLabel(NEW_NODE_TYPE)}: не удалось определить его параметры.`);
        return;
    }

    api('/add_host', {
        project: P,
        object: O,
        hostname: name,
        node_type: NEW_NODE_TYPE,
        values
    })
        .then(() => {
            closeAddNodeModal();
            load();
        })
        .catch((error) => alert(error.message));
}

function load() {
    fetch(`/data?project=${encodeURIComponent(P)}&object=${encodeURIComponent(O)}`)
        .then((response) => response.json())
        .then((data) => {
            DATA = data;

            if (!O && data.objects?.length) {
                O = data.objects[0];
                return changeObject();
            }

            injectNav('hosts', data.projects || [], data.selected_project || '', O);

            document.getElementById('object_select').innerHTML = (data.objects || [])
                .map((object) => `
                    <option value="${esc(object)}" ${object === O ? 'selected' : ''}>
                        ${esc(object)}
                    </option>
                `)
                .join('');

            renderSummary(data.hosts || [], data.status || {});
            document.getElementById('hosts_list').innerHTML = rows(data.hosts || []);
        });
}

function rows(list) {
    return list.length
        ? list.map(card).join('')
        : '<div class="empty">Узлов нет</div>';
}

window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeAddNodeModal();
});

window.addEventListener('click', (event) => {
    const modal = document.getElementById('add_node_modal');
    if (event.target === modal) closeAddNodeModal();
});

load();
