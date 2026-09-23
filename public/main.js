let CURRENT_PROJECT = getProjectFromURL();
let CURRENT_OBJECT = getObjectFromURL();
let DATA = null;
let logIndex = 0;
let NEW_TEMPLATE = '';
let ACTIVE_GROUP = null;
let CONFIRM_ACTION = null;
let SELECTED_GROUPS = [];
let NEW_GROUPS_CREATED = [];

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
    })
        .catch(() => { throw new Error('Сервер недоступен. Проверьте соединение и попробуйте ещё раз.'); })
        .then(async (response) => {
            let data = {};
            try { data = await response.json(); } catch { /* пустой или нечитаемый ответ — сработает проверка ниже */ }
            if (!response.ok || data.ok === false) throw new Error(data.error || 'Ошибка');
            return data;
        });
}

function selectedHosts() { return [...document.querySelectorAll('.node-check:checked')].map((item) => item.value); }
function selectedPlaybooks() { return [...document.querySelectorAll('.pb:checked')].map((item) => item.value); }

function updateHostSelectionButton() {
    const button = document.getElementById('host_select_toggle');
    const label = button?.querySelector('.selection-button-label');
    if (!button || !label) return;
    const checks = [...document.querySelectorAll('.node-check')];
    const allSelected = checks.length > 0 && checks.every((item) => item.checked);
    const nextText = allSelected ? 'Отменить выбор' : 'Выбрать все узлы';
    if (label.textContent === nextText) return;
    button.classList.add('selection-changing');
    setTimeout(() => { label.textContent = nextText; button.classList.remove('selection-changing'); }, ANIM.LABEL_FADE_MS);
}

function toggleHostSelection() {
    const checks = [...document.querySelectorAll('.node-check')];
    if (!checks.length) return;
    const allSelected = checks.every((item) => item.checked);
    checks.forEach((item) => item.checked = !allSelected);
    updateHostSelectionButton();
}

function templateLabel(node) { return node.template || node.node_type || 'Узел'; }
function nodeGroupNames(hostname) { return (DATA?.groups || []).filter((group) => groupHosts(group).has(hostname)).map((group) => group.name); }

function renderHwtypeField(currentValue, keyAttr = 'data-key', enabled = false) {
    const label = currentValue || (enabled ? 'Выбрать…' : '—');
    return `<div class="hwtype-field">
        <input type="hidden" ${keyAttr}="${esc(HWTYPE_PARAM_NAME)}" value="${esc(currentValue || '')}">
        <button type="button" class="param-value hwtype-toggle" ${enabled ? '' : 'disabled'} onclick="toggleHwtypeDropdown(event, this)"><span class="hwtype-toggle-label">${esc(label)}</span><span class="hwtype-toggle-arrow">▾</span></button>
    </div>`;
}

let HWTYPE_DROPDOWN_TARGET = null;

function ensureHwtypeDropdown() {
    let dropdown = document.getElementById('hwtype_dropdown');
    if (dropdown) return dropdown;
    dropdown = document.createElement('div');
    dropdown.id = 'hwtype_dropdown';
    dropdown.className = 'hwtype-dropdown';
    document.body.appendChild(dropdown);
    dropdown.addEventListener('click', (event) => event.stopPropagation());
    return dropdown;
}

function positionHwtypeDropdown(toggle, dropdown) {
    const rect = toggle.getBoundingClientRect();
    dropdown.style.left = `${rect.left}px`;
    dropdown.style.top = `${rect.bottom + 5}px`;
    dropdown.style.width = `${rect.width}px`;
}

function closeHwtypeDropdown() {
    const dropdown = document.getElementById('hwtype_dropdown');
    if (dropdown) dropdown.classList.remove('is-open');
    HWTYPE_DROPDOWN_TARGET?.toggleButton.classList.remove('is-open');
    HWTYPE_DROPDOWN_TARGET = null;
}

function toggleHwtypeDropdown(event, toggle) {
    event.stopPropagation();
    if (toggle.disabled) return;
    const dropdown = ensureHwtypeDropdown();
    const reopeningSameField = dropdown.classList.contains('is-open') && HWTYPE_DROPDOWN_TARGET?.toggleButton === toggle;
    closeHwtypeDropdown();
    if (reopeningSameField) return;

    const hiddenInput = toggle.closest('.hwtype-field').querySelector('input[type="hidden"]');
    const currentValue = hiddenInput.value;
    const options = new Set(DATA?.hwtype_options || []);
    if (currentValue) options.add(currentValue);
    dropdown.innerHTML = [...options].sort().map((option) => `<button type="button" class="hwtype-option ${option === currentValue ? 'active' : ''}" onclick="selectHwtypeOption(event, '${esc(option)}')">${esc(option)}</button>`).join('')
        || '<div class="muted" style="padding:8px 10px;">Нет доступных значений</div>';

    HWTYPE_DROPDOWN_TARGET = { hiddenInput, toggleButton: toggle };
    positionHwtypeDropdown(toggle, dropdown);
    dropdown.classList.add('is-open');
    toggle.classList.add('is-open');
}

function selectHwtypeOption(event, value) {
    event.stopPropagation();
    if (!HWTYPE_DROPDOWN_TARGET) return;
    const { hiddenInput, toggleButton } = HWTYPE_DROPDOWN_TARGET;
    hiddenInput.value = value;
    toggleButton.querySelector('.hwtype-toggle-label').textContent = value;
    hiddenInput.dispatchEvent(new Event('change', { bubbles: true }));
    closeHwtypeDropdown();
}

document.addEventListener('click', closeHwtypeDropdown);
window.addEventListener('resize', () => { if (HWTYPE_DROPDOWN_TARGET) positionHwtypeDropdown(HWTYPE_DROPDOWN_TARGET.toggleButton, document.getElementById('hwtype_dropdown')); });
window.addEventListener('scroll', () => { if (HWTYPE_DROPDOWN_TARGET) positionHwtypeDropdown(HWTYPE_DROPDOWN_TARGET.toggleButton, document.getElementById('hwtype_dropdown')); }, true);

function renderNode(node) {
    const hasStatus = Object.prototype.hasOwnProperty.call(DATA.status || {}, node.hostname);
    const available = hasStatus ? DATA.status[node.hostname] === true : null;
    const params = Object.entries(node.parameters || {});
    const id = `node-${encodeURIComponent(node.hostname)}`;
    let state, statusClass;

    if (!hasStatus) { state = '<span class="node-status pending"><span class="status-dot status-pending"></span>проверка</span>'; statusClass = 'node-pending'; }
    else if (available) { state = '<span class="node-status available"><span class="status-dot status-up"></span>доступен</span>'; statusClass = 'node-available'; }
    else { state = '<span class="node-status unavailable"><span class="status-dot status-down"></span>недоступен</span>'; statusClass = 'node-unavailable'; }

    const nameField = `<div class="param-name" title="Имя узла">Имя узла</div><input class="param-value" data-key="hostname" value="${esc(node.hostname)}" readonly>`;
    const fields = params.length
        ? nameField + params.map(([key, value]) => `<div class="param-name" title="${esc(key)}">${esc(key)}</div>${key === HWTYPE_PARAM_NAME ? renderHwtypeField(value) : `<input class="param-value" data-key="${esc(key)}" value="${esc(value)}" readonly>`}`).join('')
        : nameField + '<div class="empty" style="grid-column: 1 / -1;">Дополнительных параметров нет</div>';

    const memberOf = new Set(nodeGroupNames(node.hostname));
    const allGroups = DATA?.groups || [];
    const groupsField = allGroups.length
        ? `<div class="node-groups-field">
            <div class="node-groups-label">Группы</div>
            <div class="node-groups-list">${allGroups.map((group) => `<label class="node-group-checkbox"><input type="checkbox" class="node-group-check" value="${esc(group.name)}" disabled ${memberOf.has(group.name) ? 'checked' : ''}><span>${esc(group.name)}</span></label>`).join('')}</div>
          </div>`
        : '';

    return `
        <div class="host-card node-card ${statusClass}" id="${id}" data-hostname="${esc(node.hostname)}">
            <div class="host-head" onclick="toggleNodeFromHead(event, this.closest('.node-card'))">
                ${state}
                <input class="node-check" type="checkbox" value="${esc(node.hostname)}" onclick="event.stopPropagation()" onchange="updateHostSelectionButton()">
                <span class="node-expand">▸</span>
                <div class="node-main">
                    <span class="node-name">${esc(node.hostname)}</span>
                    <span class="node-ip">${esc(node.ip || '—')}</span>
                    <span class="node-template">${esc(templateLabel(node))}</span>
                </div>
                <button class="node-edit" onclick="toggleNodeEdit(event, '${esc(node.hostname)}')">Изменить</button>
            </div>
            <div class="host-body" hidden>
                <div class="param-grid">${fields}</div>
                ${groupsField}
                <div class="host-footer">
                    <span class="edit-note">${esc(templateLabel(node))} · изменения сохраняются в hosts.yml</span>
                    <button class="edit-save primary" disabled onclick="saveNode(event, '${esc(node.hostname)}')">Сохранить</button>
                </div>
            </div>
        </div>
    `;
}

function animatePanel(body, open) {
    body.style.overflow = 'hidden';
    body.style.transition = 'max-height 220ms ease, opacity 180ms ease';
    if (open) {
        body.hidden = false; body.style.opacity = '0'; body.style.maxHeight = '0px';
        requestAnimationFrame(() => { body.style.maxHeight = `${body.scrollHeight}px`; body.style.opacity = '1'; });
    } else {
        body.style.maxHeight = `${body.scrollHeight}px`; body.style.opacity = '1';
        requestAnimationFrame(() => { body.style.maxHeight = '0px'; body.style.opacity = '0'; });
        setTimeout(() => { body.hidden = true; body.style.maxHeight = ''; body.style.opacity = ''; body.style.overflow = ''; }, ANIM.BODY_COLLAPSE_MS);
    }
}

function toggleNodeFromHead(event, card) {
    if (event.target.closest('button, input, select')) return;
    const checkbox = card.querySelector('.node-check');
    if (!checkbox) return;
    checkbox.checked = !checkbox.checked;
    updateHostSelectionButton();
}

function toggleNodeEdit(event, hostname) {
    event.stopPropagation();
    const card = document.getElementById(`node-${encodeURIComponent(hostname)}`);
    if (card.dataset.animating === '1') return;
    if (card.classList.contains('editing')) closeNodeEdit(card);
    else openNodeEdit(card);
}

function openNodeEdit(card) {
    const body = card.querySelector('.host-body');
    card.classList.add('editing');
    if (body.hidden) {
        card.dataset.animating = '1';
        animatePanel(body, true);
        card.querySelector('.node-expand').textContent = '▾';
        setTimeout(() => card.dataset.animating = '0', ANIM.PANEL_TOGGLE_MS);
    }
    card.querySelectorAll('.param-value').forEach((el) => { el.readOnly = false; el.disabled = false; });
    card.querySelectorAll('.node-group-check').forEach((el) => el.disabled = false);
    card.querySelectorAll('[data-key]').forEach((el) => { el.dataset.original = el.value; });
    card.querySelectorAll('.node-group-check').forEach((el) => { el.dataset.originalChecked = el.checked ? '1' : '0'; });
    card.querySelector('.param-value')?.focus();

    const editBtn = card.querySelector('.node-edit');
    editBtn.textContent = 'Отмена';
    editBtn.classList.remove('has-changes');

    const saveBtn = card.querySelector('.edit-save.primary');
    saveBtn.disabled = true;

    const markChanged = () => { saveBtn.disabled = false; editBtn.classList.add('has-changes'); };
    body.addEventListener('input', markChanged);
    body.addEventListener('change', markChanged);
    card._markChanged = markChanged;
}

function closeNodeEdit(card) {
    const body = card.querySelector('.host-body');

    card.querySelectorAll('[data-key]').forEach((el) => { if (el.dataset.original !== undefined) el.value = el.dataset.original; });
    card.querySelectorAll('.node-group-check').forEach((el) => { el.checked = el.dataset.originalChecked === '1'; });
    card.querySelectorAll('.hwtype-field').forEach((field) => {
        const hidden = field.querySelector('input[type="hidden"]');
        const label = field.querySelector('.hwtype-toggle-label');
        if (hidden && label) label.textContent = hidden.value || '—';
    });

    if (card._markChanged) {
        body.removeEventListener('input', card._markChanged);
        body.removeEventListener('change', card._markChanged);
        card._markChanged = null;
    }

    card.dataset.animating = '1';
    animatePanel(body, false);
    card.querySelector('.node-expand').textContent = '▸';
    setTimeout(() => card.dataset.animating = '0', ANIM.PANEL_TOGGLE_MS);

    card.classList.remove('editing');
    card.querySelectorAll('.param-value').forEach((el) => { el.readOnly = true; el.disabled = true; });
    card.querySelectorAll('.node-group-check').forEach((el) => el.disabled = true);

    const editBtn = card.querySelector('.node-edit');
    editBtn.textContent = 'Изменить';
    editBtn.classList.remove('has-changes');
    card.querySelector('.edit-save.primary').disabled = true;
}

function saveNode(event, hostname) {
    event.stopPropagation();
    const card = document.getElementById(`node-${encodeURIComponent(hostname)}`);
    const values = {};
    let newHostname = hostname;
    const hostnameInput = card.querySelector('[data-key="hostname"]');
    if (hostnameInput) {
        newHostname = hostnameInput.value.trim();
        if (!newHostname) return alert('Имя узла не может быть пустым');
    }
    card.querySelectorAll('[data-key]').forEach((input) => { if (input.dataset.key !== 'hostname') values[input.dataset.key] = input.value; });
    const groups = [...card.querySelectorAll('.node-group-check:checked')].map((input) => input.value);
    api(API.UPDATE_HOST, { project: CURRENT_PROJECT, object: CURRENT_OBJECT, hostname, new_hostname: newHostname, values, groups }).then(loadMain).catch((error) => alert(error.message));
}

function deleteSelectedNodes() {
    const hosts = selectedHosts();
    if (!hosts.length) return alert('Выберите узлы для удаления.');
    showConfirmation('Удалить выбранные узлы?', `<strong>Узлы:</strong><br>${hosts.map(esc).join('<br>')}<br><br>Это изменит hosts.yml.`,
        () => api(API.DELETE_HOSTS, { project: CURRENT_PROJECT, object: CURRENT_OBJECT, hostnames: hosts })
            .then(loadMain).catch((error) => alert(error.message)), 'Удалить', 'danger', 'Подтверждение удаления');
}

function openAddNodeModal() {
    document.getElementById('new_node_name').value = '';
    SELECTED_GROUPS = [];
    NEW_GROUPS_CREATED = [];
    document.getElementById('add_node_modal').hidden = false;
    document.body.classList.add('no-scroll');
    renderTemplateTabs();
    renderGroupButtons();
    document.querySelector('#add_node_modal .node-params-panel')?.scrollTo(0, 0);
    setTimeout(() => document.getElementById('new_node_name').focus(), 0);
}

window.closeAddNodeModal = function() {
    document.getElementById('add_node_modal').hidden = true;
    document.body.classList.remove('no-scroll');
    closeCreateGroupModal();
};

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
    tabs.innerHTML = names.map((name) => `<button type="button" class="node-type-tab ${name === NEW_TEMPLATE ? 'active' : ''}" onclick="selectTemplate('${esc(name)}')"><span class="node-type-title">${esc(name)}</span><span class="node-type-desc">${schemas[name].length}</span></button>`).join('');
    renderTemplateFields();
}

function selectTemplate(name) {
    NEW_TEMPLATE = name;
    renderTemplateTabs();
    document.querySelector('#add_node_modal .node-params-panel')?.scrollTo(0, 0);
}
function renderTemplateFields() {
    const keys = (DATA.template_schemas || {})[NEW_TEMPLATE] || [];
    document.getElementById('new_node_fields').innerHTML = keys.map((key) => key === HWTYPE_PARAM_NAME
        ? `<label class="new-node-field"><span>${esc(key)}</span>${renderHwtypeField('', 'data-new-key', true)}</label>`
        : `<label class="new-node-field"><span>${esc(key)}</span><input data-new-key="${esc(key)}" type="text" placeholder="Значение"></label>`).join('');
}

function createNode() {
    const name = document.getElementById('new_node_name').value.trim();
    const keys = (DATA.template_schemas || {})[NEW_TEMPLATE] || [];
    if (!name) return document.getElementById('new_node_name').focus();
    if (!keys.length) return alert('Выберите шаблон параметров.');
    const values = {};
    document.querySelectorAll('[data-new-key]').forEach((input) => values[input.dataset.newKey] = input.value);
    api(API.ADD_HOST, { project: CURRENT_PROJECT, object: CURRENT_OBJECT, hostname: name, values, groups: SELECTED_GROUPS })
        .then(() => { window.closeAddNodeModal(); loadMain(); })
        .catch((error) => showErrorModal('Не удалось добавить узел', esc(error.message)));
}

function showErrorModal(title, text) {
    let modal = document.getElementById('error_modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'error_modal';
        modal.className = 'modal-backdrop';
        modal.hidden = true;
        modal.innerHTML = `
            <div class="modal-card error-modal-card" role="dialog" aria-modal="true" aria-labelledby="error_modal_title">
                <div class="modal-head"><div><h3 id="error_modal_title"></h3></div><button class="modal-close" type="button">×</button></div>
                <div class="modal-body"><div id="error_modal_text" class="run-confirm-text"></div></div>
                <div class="modal-footer"><button type="button" class="primary" id="error_modal_ok">Понятно</button></div>
            </div>`;
        document.body.appendChild(modal);
        const close = () => { modal.hidden = true; };
        modal.querySelector('.modal-close').onclick = close;
        modal.querySelector('#error_modal_ok').onclick = close;
        modal.addEventListener('click', (event) => { if (event.target === modal) close(); });
    }
    modal.querySelector('#error_modal_title').textContent = title;
    modal.querySelector('#error_modal_text').innerHTML = text;
    modal.hidden = false;
}

// === Фильтр групп ===
function renderGroups(groups) {
    const element = document.getElementById('groups');
    if (!groups?.length) {
        element.innerHTML = '<span class="muted">Групп нет</span>';
        return;
    }
    const wasOpen = element.querySelector('.group-filter-list')?.classList.contains('is-open') || false;
    element.innerHTML = `
        <div class="group-filter-dropdown">
            <div class="group-filter-control">
                <button type="button" class="group-filter-btn" id="group-filter-btn">
                    ${ACTIVE_GROUP ? `<b>Группа:</b> ${esc(ACTIVE_GROUP.name)}` : 'Фильтр по группам'}
                    <span class="group-filter-arrow">▾</span>
                </button>
                ${ACTIVE_GROUP ? '<button type="button" class="group-filter-clear" id="group-filter-clear" title="Сбросить фильтр">×</button>' : ''}
            </div>
            <div class="group-filter-list ${wasOpen ? 'is-open' : ''}" id="group-filter-list">
                ${groups.map(group => `<button type="button" class="group-filter-item ${ACTIVE_GROUP?.name === group.name ? 'active' : ''}" data-group-name="${esc(group.name)}">${esc(group.name)}</button>`).join('')}
            </div>
        </div>
    `;
}

document.getElementById('groups').addEventListener('click', (e) => {
    const clearBtn = e.target.closest('#group-filter-clear');
    if (clearBtn) { e.stopPropagation(); clearGroupFilter(); return; }
    const btn = e.target.closest('#group-filter-btn');
    if (btn) { e.stopPropagation(); toggleGroupFilter(); return; }
    const item = e.target.closest('.group-filter-item');
    if (item) { e.stopPropagation(); selectGroupFilter(item.dataset.groupName); }
});

function toggleGroupFilter() {
    const list = document.getElementById('group-filter-list');
    const btn = document.getElementById('group-filter-btn');
    if (!list) return;
    const isOpen = list.classList.contains('is-open');
    list.classList.toggle('is-open', !isOpen);
    if (btn) btn.querySelector('.group-filter-arrow').textContent = isOpen ? '▾' : '▴';
}

function selectGroupFilter(name) {
    const group = (DATA.groups || []).find((item) => item.name === name);
    ACTIVE_GROUP = ACTIVE_GROUP?.name === name ? null : group || null;
    renderGroups(DATA.groups || []);
    renderNodes();
}

function clearGroupFilter() {
    ACTIVE_GROUP = null;
    renderGroups(DATA.groups || []);
    renderNodes();
}

function requestDeleteSelectedGroups() {
    if (!SELECTED_GROUPS.length) return alert('Сначала выберите группу для удаления — нажмите на неё в списке выше.');
    const groupsData = DATA?.groups || [];
    const targets = SELECTED_GROUPS.map((name) => groupsData.find((group) => group.name === name) || { name, hosts: [] });
    const text = targets.map((group) => `<strong>${esc(group.name)}</strong>: ${group.hosts?.length ? group.hosts.map(esc).join(', ') : 'узлов нет'}`).join('<br>')
        + '<br><br>Сами узлы не будут удалены. Из hosts.yml будет удалён только блок группы.';
    showConfirmation(targets.length > 1 ? 'Удалить группы?' : 'Удалить группу?', text,
        () => Promise.all(targets.map((group) => api(API.DELETE_GROUP, { project: CURRENT_PROJECT, object: CURRENT_OBJECT, group: group.name })))
            .then(() => {
                const deletedNames = new Set(targets.map((group) => group.name));
                if (ACTIVE_GROUP && deletedNames.has(ACTIVE_GROUP.name)) ACTIVE_GROUP = null;
                SELECTED_GROUPS = SELECTED_GROUPS.filter((name) => !deletedNames.has(name));
                NEW_GROUPS_CREATED = NEW_GROUPS_CREATED.filter((name) => !deletedNames.has(name));
                return loadMain();
            })
            .then(() => renderGroupButtons())
            .catch((error) => alert(error.message)),
        targets.length > 1 ? 'Удалить группы' : 'Удалить группу', 'danger', 'Подтверждение удаления группы');
}

// === Выбор групп в модалке добавления узла ===
function renderGroupButtons() {
    const list = document.getElementById('group_selector_list');
    if (!list) return;
    const allGroups = [...new Set([...(DATA?.groups || []).map(g => g.name), ...NEW_GROUPS_CREATED])];
    list.innerHTML = allGroups.length
        ? allGroups.map(name => `<button type="button" class="group-toggle-btn ${SELECTED_GROUPS.includes(name) ? 'active' : ''}" onclick="toggleGroupSelection('${esc(name)}')">${esc(name)}</button>`).join('')
        : '<span class="muted">Нет доступных групп. Создайте первую!</span>';
}

function toggleGroupSelection(name) {
    if (SELECTED_GROUPS.includes(name)) SELECTED_GROUPS = SELECTED_GROUPS.filter(g => g !== name);
    else SELECTED_GROUPS.push(name);
    renderGroupButtons();
}

function openCreateGroupModal() {
    let modal = document.getElementById('create_group_modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'create_group_modal';
        modal.className = 'modal-backdrop';
        modal.hidden = true;
        modal.innerHTML = `
            <div class="modal-card" role="dialog" aria-modal="true">
                <div class="modal-head"><div><div class="modal-kicker">Новая группа</div><h3>Создание группы</h3></div><button class="modal-close" type="button" onclick="closeCreateGroupModal()">×</button></div>
                <div class="modal-body">
                    <label class="modal-label" for="new_group_name">Название группы</label>
                    <input id="new_group_name" class="modal-input" type="text" placeholder="Например, web_servers" autocomplete="off">
                    <div class="muted" style="margin-top: 8px; font-size: 12px;">Допустимы буквы, цифры, дефис и подчёркивание</div>
                </div>
                <div class="modal-footer"><button type="button" class="modal-secondary" onclick="closeCreateGroupModal()">Отмена</button><button type="button" class="primary" onclick="confirmCreateGroup()">Создать</button></div>
            </div>`;
        document.body.appendChild(modal);
        modal.addEventListener('click', (event) => { if (event.target === modal) closeCreateGroupModal(); });
    }
    document.getElementById('new_group_name').value = '';
    modal.hidden = false;
    setTimeout(() => document.getElementById('new_group_name').focus(), 0);
}

function closeCreateGroupModal() { const modal = document.getElementById('create_group_modal'); if (modal) modal.hidden = true; }

function confirmCreateGroup() {
    const name = document.getElementById('new_group_name').value.trim();
    if (!name) return alert('Введите название группы');
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) return alert('Название группы может содержать только буквы, цифры, дефис и подчёркивание');
    const allGroups = [...new Set([...(DATA?.groups || []).map(g => g.name), ...NEW_GROUPS_CREATED])];
    if (allGroups.includes(name)) return alert('Группа с таким названием уже существует');
    NEW_GROUPS_CREATED.push(name);
    SELECTED_GROUPS.push(name);
    closeCreateGroupModal();
    renderGroupButtons();
}

function contextQuery(extra = '') { const object = CURRENT_OBJECT ? `&object=${encodeURIComponent(CURRENT_OBJECT)}` : ''; return `project=${encodeURIComponent(CURRENT_PROJECT)}${object}${extra}`; }

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
    fetch(`${API.PLAYBOOK}?${contextQuery(`&name=${encodeURIComponent(name)}`)}`)
        .then((response) => { if (!response.ok) throw Error('Не удалось открыть плейбук'); return response.json(); })
        .then((data) => { editor.value = data.content || ''; editor.readOnly = false; fitPlaybookEditor(); editor.focus(); })
        .catch((error) => { editor.value = ''; alert(error.message); window.closePlaybookModal(); });
}

window.closePlaybookModal = function() { document.getElementById('playbook_modal').hidden = true; window.CURRENT_EDITING_PLAYBOOK = ''; };

function savePlaybookFromModal() {
    const name = window.CURRENT_EDITING_PLAYBOOK;
    const editor = document.getElementById('playbook_editor');
    if (!name || !editor) return;
    editor.disabled = true;
    fetch(API.SAVE_PLAYBOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: CURRENT_PROJECT, object: CURRENT_OBJECT, name, content: editor.value }) })
        .then(async (response) => {
            const data = await response.json();
            if (!response.ok || data.ok === false) throw Error(data.error || 'Не удалось сохранить плейбук');
            window.closePlaybookModal();
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

function groupHosts(group) { return new Set((group?.hosts || []).map((host) => typeof host === 'string' ? host : host?.hostname || host?.name)); }
function renderNodes() {
    const hosts = ACTIVE_GROUP ? (DATA.hosts || []).filter((node) => groupHosts(ACTIVE_GROUP).has(node.hostname)) : (DATA.hosts || []);
    document.getElementById('nodes').innerHTML = hosts.map(renderNode).join('') || '<div class="empty">Узлов нет</div>';
    updateHostSelectionButton();
}

function renderAutodeploy(enabled) {
    const element = document.getElementById('autodeploy_block');
    if (!enabled) return element.innerHTML = '';
    element.innerHTML = `<div class="block autodeploy-card"><div class="section-head"><h3>Авторазвертывание</h3><div class="autodeploy-action"><span class="autodeploy-file">autodeploy.yml</span><button class="primary" onclick="runAutodeploy()">Запустить</button></div></div></div>`;
}

function roleTree(nodes) {
    return (nodes || []).map((node) => {
        if (node.type === 'dir') {
            const readme = (node.children || []).find((child) => child.type === 'file' && child.name.toLowerCase() === 'readme.md');
            const children = (node.children || []).filter((child) => !(child.type === 'file' && child.name.toLowerCase() === 'readme.md'));
            return `<div class="role-dir"><button class="role-toggle" onclick="toggleRoleDir(this)"><span class="role-chevron">▸</span> ${esc(node.name)}</button><div class="role-children" hidden>${readme ? `<details class="role-readme"><summary>README.md</summary><pre data-readme-path="${esc(readme.path)}">Загрузка…</pre></details>` : ''}${roleTree(children)}</div></div>`;
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
                <label><input type="checkbox" class="pb" value="${esc(playbook.name)}"><span>${esc(playbook.name)}</span></label>
                <div class="playbook-actions">
                    <button onclick="editPlaybook('${esc(playbook.name)}')">Просмотр плейбука</button>
                    <button onclick="togglePlaybookRoles(this, '${esc(playbook.name)}')">Роли ▸</button>
                </div>
            </div>
            <div class="playbook-roles" hidden></div>
        </div>
    `).join('');
}

function openRoleFile(path) {
    fetch(`${API.ROLE_FILE}?${contextQuery(`&path=${encodeURIComponent(path)}`)}`)
        .then((response) => { if (!response.ok) throw Error('Не удалось открыть файл'); return response.json(); })
        .then((data) => {
            const windowRef = window.open('', '_blank');
            if (!windowRef) throw Error('Браузер заблокировал новое окно');
            windowRef.document.write(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${esc(data.name)}</title><style>body{margin:0;background:#171717;color:#eee;font-family:monospace}header{padding:12px 20px;border-bottom:1px solid #333;color:#aaa}pre{margin:0;padding:22px;white-space:pre-wrap;line-height:1.5}</style></head><body><header>${esc(data.name)}</header><pre>${esc(data.content)}</pre></body></html>`);
            windowRef.document.close();
        }).catch((error) => alert(error.message));
}

function runAutodeploy() {
    const hosts = selectedHosts();
    document.getElementById('run_state').textContent = '● Выполняется';
    api(API.RUN_AUTODEPLOY, { project: CURRENT_PROJECT, hosts }).catch((error) => alert(error.message));
}

function runSelected() {
    const playbooks = selectedPlaybooks();
    const hosts = selectedHosts();
    if (!playbooks.length) return alert('Выберите хотя бы один плейбук');
    document.getElementById('run_state').textContent = '● Выполняется';
    api(API.RUN, { project: CURRENT_PROJECT, object: CURRENT_OBJECT, playbooks, hosts }).catch((error) => alert(error.message));
}

function stopExecution() { api(API.STOP, {}).finally(() => { document.getElementById('run_state').textContent = 'Остановлено'; }); }

function showConfirmation(title, text, action, actionLabel = 'Запустить', actionClass = 'primary', kicker = 'Подтверждение запуска') {
    let modal = document.getElementById('run_confirm_modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'run_confirm_modal';
        modal.className = 'modal-backdrop';
        modal.hidden = true;
        modal.innerHTML = `<div class="modal-card run-confirm-card" role="dialog" aria-modal="true"><div class="modal-head"><div><div class="modal-kicker" id="run_confirm_kicker"></div><h3 id="run_confirm_title"></h3></div><button class="modal-close" type="button">×</button></div><div class="modal-body"><div id="run_confirm_text" class="run-confirm-text"></div></div><div class="modal-footer"><button type="button" class="modal-secondary" id="run_confirm_cancel">Отмена</button><button type="button" id="run_confirm_ok"></button></div></div>`;
        document.body.appendChild(modal);
        const close = () => { modal.hidden = true; CONFIRM_ACTION = null; };
        modal.querySelector('.modal-close').onclick = close;
        modal.querySelector('#run_confirm_cancel').onclick = close;
        modal.addEventListener('click', (event) => { if (event.target === modal) close(); });
        modal.querySelector('#run_confirm_ok').onclick = () => { const currentAction = CONFIRM_ACTION; close(); if (currentAction) currentAction(); };
    }
    CONFIRM_ACTION = action;
    modal.querySelector('#run_confirm_kicker').textContent = kicker;
    modal.querySelector('#run_confirm_title').textContent = title;
    modal.querySelector('#run_confirm_text').innerHTML = text;
    const ok = modal.querySelector('#run_confirm_ok');
    ok.textContent = actionLabel;
    ok.className = actionClass;
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
            showConfirmation('Запустить выбранные плейбуки?', `<strong>Плейбуки:</strong><br>${playbooks.map(esc).join('<br>')}<br><br><strong>Узлы:</strong> ${hosts.length ? `${hosts.length} ${hosts.length === 1 ? 'узел' : 'узлов'}` : 'все узлы'}`, runSelected);
        } else {
            showConfirmation('Запустить авторазвертывание?', `<strong>Плейбук:</strong> autodeploy.yml<br><br><strong>Узлы:</strong> ${hosts.length ? `${hosts.length} ${hosts.length === 1 ? 'выбранный узел' : 'выбранных узлов'}` : 'все узлы'}`, runAutodeploy);
        }
    }, true);
}

// === Инфопанель вверху страницы: DHCP, TFTP, ISO-образы ===
let SYSTEM_STATUS_DATA = null;
let ISO_PANEL_OPEN = false;

function formatBytes(bytes) {
    if (!bytes) return '0 Б';
    const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
    const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / Math.pow(1024, exponent);
    return `${exponent === 0 ? value : value.toFixed(1)} ${units[exponent]}`;
}

function serviceStatusItem(label, info) {
    const stateClass = info?.active ? 'is-active' : (info?.state === 'unknown' ? 'is-unknown' : 'is-inactive');
    const stateText = info?.active ? 'активен' : (info?.state === 'unknown' ? 'не удалось проверить' : 'не активен');
    const serviceName = info?.service ? ` (${esc(info.service)})` : '';
    return `<span class="system-status-item ${stateClass}"><span class="status-dot"></span><span class="system-status-label">${esc(label)}</span><span class="system-status-state">${stateText}${serviceName}</span></span>`;
}

function renderSystemStatus() {
    const bar = document.getElementById('system_status_dynamic');
    if (!bar || !SYSTEM_STATUS_DATA) return;
    const { dhcp, tftp, iso } = SYSTEM_STATUS_DATA;
    const isoLabel = iso?.exists
        ? `ISO-образы: ${iso.count} (${formatBytes(iso.total_size)})`
        : 'ISO-образы: папка не найдена';
    bar.innerHTML = `
        ${serviceStatusItem('DHCP', dhcp)}
        ${serviceStatusItem('TFTP', tftp)}
        <button type="button" id="iso_toggle_btn" class="system-status-item iso-toggle ${ISO_PANEL_OPEN ? 'is-open' : ''}" onclick="toggleIsoPanel(event)">${esc(isoLabel)} <span class="iso-toggle-arrow">▾</span></button>
    `;
    renderIsoPanel();
    if (ISO_PANEL_OPEN) positionIsoPanel();
}

function renderIsoPanel() {
    const panel = document.getElementById('iso_panel');
    const iso = SYSTEM_STATUS_DATA?.iso;
    if (!panel || !iso) return;
    panel.innerHTML = !iso.exists
        ? `<div class="muted">Папка ${esc(iso.directory)} не найдена на сервере.</div>`
        : !iso.files.length
            ? `<div class="muted">В ${esc(iso.directory)} и подпапках ISO-образов не найдено.</div>`
            : `<div class="iso-panel-path">${esc(iso.directory)}</div><div class="iso-list">${iso.files.map((file) => `<div class="iso-item"><span class="iso-item-path" title="${esc(file.path)}">${esc(file.path)}</span><span class="iso-item-size">${formatBytes(file.size)}</span><span class="iso-item-date">${esc(file.modified)}</span></div>`).join('')}</div>`;
}

function positionIsoPanel() {
    const button = document.getElementById('iso_toggle_btn');
    const panel = document.getElementById('iso_panel');
    if (!button || !panel) return;
    const rect = button.getBoundingClientRect();
    panel.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - panel.offsetWidth - 8))}px`;
    panel.style.top = `${rect.bottom + 6}px`;
}

function toggleIsoPanel(event) {
    event?.stopPropagation();
    if (ISO_PANEL_OPEN) { closeIsoPanel(); return; }
    ISO_PANEL_OPEN = true;
    document.getElementById('iso_toggle_btn')?.classList.add('is-open');
    const panel = document.getElementById('iso_panel');
    panel?.classList.add('is-open');
    positionIsoPanel();
}

function closeIsoPanel() {
    ISO_PANEL_OPEN = false;
    document.getElementById('iso_panel')?.classList.remove('is-open');
    document.getElementById('iso_toggle_btn')?.classList.remove('is-open');
}

document.addEventListener('click', (event) => {
    if (!ISO_PANEL_OPEN) return;
    if (event.target.closest('#iso_panel, #iso_toggle_btn')) return;
    closeIsoPanel();
});
window.addEventListener('resize', () => { if (ISO_PANEL_OPEN) positionIsoPanel(); });
window.addEventListener('scroll', () => { if (ISO_PANEL_OPEN) positionIsoPanel(); }, true);

function loadSystemStatus() {
    fetch(`${API.SYSTEM_STATUS}?_=${Date.now()}`)
        .then((response) => response.json())
        .then((data) => { SYSTEM_STATUS_DATA = data; renderSystemStatus(); })
        .catch(() => {}); // это вспомогательная инфопанель — не мешаем работе остальной страницы, если она недоступна
}

// === NMAP: обнаружение узлов в сети (режим прослушки) ===
let NMAP_POLL_TIMER = null;

function openNmapModal() {
    document.getElementById('nmap_modal').hidden = false;
    document.body.classList.add('no-scroll');
    refreshNmapStatus();
    NMAP_POLL_TIMER = setInterval(refreshNmapStatus, NMAP_POLL_INTERVAL_MS);
}

function closeNmapModal() {
    document.getElementById('nmap_modal').hidden = true;
    document.body.classList.remove('no-scroll');
    if (NMAP_POLL_TIMER) { clearInterval(NMAP_POLL_TIMER); NMAP_POLL_TIMER = null; }
}

function startNmapListening() {
    document.getElementById('nmap_start_btn').disabled = true;
    api(API.NMAP_START, {}).then(refreshNmapStatus).catch((error) => { document.getElementById('nmap_start_btn').disabled = false; alert(error.message); });
}

function stopNmapListening() {
    document.getElementById('nmap_stop_btn').disabled = true;
    api(API.NMAP_STOP, {}).then(refreshNmapStatus).catch((error) => alert(error.message));
}

function refreshNmapStatus() {
    fetch(`${API.NMAP_STATUS}?_=${Date.now()}`)
        .then((response) => response.json())
        .then(renderNmapStatus)
        .catch(() => {});
}

function renderNmapStatus(data) {
    const startBtn = document.getElementById('nmap_start_btn');
    const stopBtn = document.getElementById('nmap_stop_btn');
    const stateLabel = document.getElementById('nmap_state_label');
    if (!startBtn || !stopBtn || !stateLabel) return; // модалка уже закрыта/не отрисована
    startBtn.disabled = data.running;
    stopBtn.disabled = !data.running;
    stateLabel.textContent = data.running ? 'прослушка включена…' : 'выключено';
    stateLabel.classList.toggle('is-active', data.running);

    const container = document.getElementById('nmap_devices');
    if (container) {
        container.innerHTML = data.devices.length
            ? `<div class="nmap-table-head"><span>DHCP-сервер</span><span>Предлагаемый IP</span><span>Шлюз</span><span>Аренда</span><span>Замечен</span></div>${data.devices.map((device) => `<div class="nmap-row"><span class="nmap-mac">${esc(device.server_ip || '—')}</span><span class="nmap-ip">${esc(device.offered_ip || '—')}</span><span class="nmap-vendor">${esc(device.router || '—')}</span><span class="nmap-vendor">${esc(device.lease || '—')}</span><span class="nmap-seen">${esc(device.last_seen)}</span></div>`).join('')}`
            : '<div class="muted">Ответов от DHCP-серверов пока нет — если это продолжается долго, посмотрите на вывод nmap ниже (там будет видно, если, например, не хватает прав sudo).</div>';
    }

    const rawOutput = document.getElementById('nmap_raw_output');
    if (rawOutput) rawOutput.textContent = data.raw_output || (data.running ? 'Ждём первый результат сканирования…' : '');
}

function updateNodeStatuses() {
    if (!CURRENT_PROJECT) return;
    const query = `?project=${encodeURIComponent(CURRENT_PROJECT)}${CURRENT_OBJECT ? `&object=${encodeURIComponent(CURRENT_OBJECT)}` : ''}&_=${Date.now()}`;
    fetch(`${API.STATUS}${query}`)
        .then((response) => response.json())
        .then((status) => {
            if (!DATA) return;
            DATA.status = status;
            document.querySelectorAll('.node-card').forEach(card => {
                const hostname = card.dataset.hostname;
                if (!hostname) return;
                const hasStatus = Object.prototype.hasOwnProperty.call(status, hostname);
                const isUp = hasStatus ? status[hostname] === true : null;
                card.classList.remove('node-pending', 'node-available', 'node-unavailable');
                if (!hasStatus) card.classList.add('node-pending');
                else if (isUp) card.classList.add('node-available');
                else card.classList.add('node-unavailable');
                const statusEl = card.querySelector('.node-status');
                if (statusEl) {
                    if (!hasStatus) { statusEl.className = 'node-status pending'; statusEl.innerHTML = '<span class="status-dot status-pending"></span>проверка'; }
                    else if (isUp) { statusEl.className = 'node-status available'; statusEl.innerHTML = '<span class="status-dot status-up"></span>доступен'; }
                    else { statusEl.className = 'node-status unavailable'; statusEl.innerHTML = '<span class="status-dot status-down"></span>недоступен'; }
                }
            });
        }).catch(() => {});
}

function loadMain() {
    const objectParam = CURRENT_OBJECT ? `&object=${encodeURIComponent(CURRENT_OBJECT)}` : '';
    return fetch(`${API.DATA}?project=${encodeURIComponent(CURRENT_PROJECT)}${objectParam}&_=${Date.now()}`)
        .then((response) => response.json())
        .then((data) => {
            DATA = data;
            // При открытии панели без query-параметров сервер выбирает первый
            // доступный проект/объект. Сохраняем этот контекст только в памяти:
            // адрес остаётся чистым — / или /main без project/object.
            CURRENT_PROJECT = data.selected_project || CURRENT_PROJECT;
            CURRENT_OBJECT = data.selected_object || '';
            const objectBlock = document.getElementById('object_block');
            if (data.single_object_mode) {
                CURRENT_OBJECT = '';
                if (objectBlock) objectBlock.style.display = 'none';
            } else {
                if (objectBlock) objectBlock.style.display = '';
                const objects = data.objects || [];
                const select = document.getElementById('object_select');
                if (select) select.innerHTML = objects.map((object) => `<option value="${esc(object)}" ${object === CURRENT_OBJECT ? 'selected' : ''}>${esc(object)}</option>`).join('');
            }
            if (ACTIVE_GROUP && !(data.groups || []).some((group) => group.name === ACTIVE_GROUP.name)) ACTIVE_GROUP = null;
            injectNav('main', data.projects || [], data.selected_project || '', CURRENT_OBJECT);
            renderNodes();
            renderGroups(data.groups || []);
            renderAutodeploy(data.autodeploy);
            renderPlaybooks(data.playbooks || []);
        }).catch((error) => {
            console.error(error);
            document.getElementById('nodes').innerHTML = '<div class="empty">Не удалось загрузить данные проекта.</div>';
        });
}

function refreshLog() {
    fetch(`${API.LOG_NEW}?start=${logIndex}`)
        .then((response) => response.json())
        .then((data) => {
            const element = document.getElementById('log');
            if (data.lines.length) {
                element.textContent += (element.textContent ? '\n' : '') + data.lines.join('\n');
                logIndex = data.next;
                element.scrollTop = element.scrollHeight;
            }
        }).catch(() => {});
}

window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    window.closeAddNodeModal();
    window.closePlaybookModal();
    closeCreateGroupModal();
    closeHwtypeDropdown();
    closeIsoPanel();
    const modal = document.getElementById('run_confirm_modal');
    if (modal) { modal.hidden = true; CONFIRM_ACTION = null; }
});

window.addEventListener('click', (event) => {
    const modal = document.getElementById('add_node_modal');
    if (event.target === modal) window.closeAddNodeModal();
});

window.addEventListener('resize', () => {
    const modal = document.getElementById('playbook_modal');
    if (modal && !modal.hidden) fitPlaybookEditor();
});

interceptRunButtons();
loadMain();
refreshLog();
loadSystemStatus();
setInterval(refreshLog, LOG_POLL_INTERVAL_MS);
setInterval(updateNodeStatuses, STATUS_POLL_INTERVAL_MS);
setInterval(loadSystemStatus, SYSTEM_STATUS_POLL_INTERVAL_MS);