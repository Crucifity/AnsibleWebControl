let CURRENT_PROJECT = getProjectFromURL();
let CURRENT_OBJECT = getObjectFromURL();
let DATA = null;
let logIndex = 0;
let NEW_TEMPLATE = '';
let ACTIVE_GROUP = null;
let CONFIRM_ACTION = null;
let SELECTED_GROUPS = [];
let NEW_GROUPS_CREATED = [];

// экранирует HTML-спецсимволы в строке перед вставкой в разметку
function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
}

// всплывающее уведомление в правом нижнем углу вместо системного alert(): не блокирует работу,
// исчезает само (ошибки держатся дольше), закрывается крестиком. type: error | warning | success | info
function notify(message, type = 'error') {
    let box = document.getElementById('toast_box');
    if (!box) {
        box = document.createElement('div');
        box.id = 'toast_box';
        box.className = 'toast-box';
        document.body.appendChild(box);
    }
    const icons = { error: '!', warning: '!', success: '✓', info: 'i' };
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    toast.innerHTML = `<span class="toast-icon">${icons[type] || 'i'}</span><span class="toast-text">${esc(message)}</span><button type="button" class="toast-close" aria-label="Закрыть">×</button>`;
    box.appendChild(toast);
    while (box.children.length > 4) box.firstElementChild.remove();
    requestAnimationFrame(() => toast.classList.add('is-visible'));
    const hide = () => { toast.classList.remove('is-visible'); setTimeout(() => toast.remove(), 250); };
    toast.querySelector('.toast-close').addEventListener('click', hide);
    setTimeout(hide, type === 'error' ? 8000 : 4000);
}

// отправляет POST-запрос на бэкенд, возвращает JSON или бросает понятную ошибку
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

// список hostname отмеченных чекбоксами узлов
function selectedHosts() { return [...document.querySelectorAll('.node-check:checked')].map((item) => item.value); }
// список отмеченных чекбоксами плейбуков
// плейбуки к запуску: отмеченные целиком и те, у которых отмечена часть ролей
function selectedPlaybooks() { return [...document.querySelectorAll('#playbooks .pb')].filter((item) => item.checked || item.indeterminate).map((item) => item.value); }
// плейбук → отмеченные роли (только у плейбуков, выбранных частично)
function selectedRoleMap() {
    const map = {};
    document.querySelectorAll('#playbooks .pb').forEach((box) => {
        if (box.indeterminate) map[box.value] = playbookRoleBoxes(box.value).filter((role) => role.checked).map((role) => role.value);
    });
    return map;
}
function playbookRoleBoxes(name) { return [...document.querySelectorAll('#playbooks .pb-role')].filter((box) => box.dataset.playbook === name); }
// отметка плейбука целиком отмечает (или снимает) все его роли
function setPlaybookChecked(box, value) {
    box.checked = value;
    box.indeterminate = false;
    playbookRoleBoxes(box.value).forEach((role) => { role.checked = value; role.closest('.pb-role-row')?.classList.toggle('is-checked', value); });
    box.closest('.playbook-card')?.classList.remove('is-partial');
}
window.setPlaybookChecked = setPlaybookChecked;
// отмечены все роли — плейбук целиком; часть — частично (будут выполнены только они); ни одной — не выбран
function syncPlaybookFromRoles(name) {
    if (name === '@autodeploy') {
        const roles = playbookRoleBoxes(name), checked = roles.filter((role) => role.checked).length;
        roles.forEach((role) => role.closest('.pb-role-row')?.classList.toggle('is-checked', role.checked));
        document.querySelector('#playbooks .autodeploy-card')?.classList.toggle('is-partial', checked > 0 && checked < roles.length);
        return;
    }
    playbookRoleBoxes(name).forEach((role) => role.closest('.pb-role-row')?.classList.toggle('is-checked', role.checked));
    const box = [...document.querySelectorAll('#playbooks .pb')].find((item) => item.value === name);
    if (!box) return;
    const roles = playbookRoleBoxes(name), checked = roles.filter((role) => role.checked).length;
    box.checked = checked === roles.length;
    box.indeterminate = checked > 0 && checked < roles.length;
    box.closest('.playbook-card')?.classList.toggle('is-partial', box.indeterminate);
}
document.addEventListener('change', (event) => {
    if (event.target.matches?.('#playbooks .pb')) setPlaybookChecked(event.target, event.target.checked);
    else if (event.target.matches?.('#playbooks .pb-role')) syncPlaybookFromRoles(event.target.dataset.playbook);
    else return;
    updateSelectionSummary();
    window.updatePlaybookSelectionButton?.();
});

// обновляет подпись кнопки массового выбора узлов по числу отмеченных
function updateHostSelectionButton() {
    const button = document.getElementById('host_select_toggle');
    const label = button?.querySelector('.selection-button-label');
    if (!button || !label) return;
    updateSelectionSummary();
    const checks = [...document.querySelectorAll('.node-check')].filter((item) => !item.closest('.host-card')?.classList.contains('is-filtered-out'));
    const allSelected = checks.length > 0 && checks.every((item) => item.checked);
    const nextText = allSelected ? 'Отменить выбор' : 'Выбрать все узлы';
    if (label.textContent === nextText) return;
    button.classList.add('selection-changing');
    setTimeout(() => { label.textContent = nextText; button.classList.remove('selection-changing'); }, ANIM.LABEL_FADE_MS);
}

// отмечает или снимает чекбоксы всех узлов сразу
function toggleHostSelection() {
    const checks = [...document.querySelectorAll('.node-check')].filter((item) => !item.closest('.host-card')?.classList.contains('is-filtered-out'));
    if (!checks.length) return;
    const allSelected = checks.every((item) => item.checked);
    checks.forEach((item) => item.checked = !allSelected);
    updateHostSelectionButton();
}

// читаемое название шаблона узла для подписи в карточке
function templateLabel(node) { return node.template || node.node_type || 'Узел'; }
// имена групп, в которых состоит узел с этим hostname
function nodeGroupNames(hostname) { return (DATA?.groups || []).filter((group) => groupHosts(group).has(hostname)).map((group) => group.name); }

// строит разметку поля hwtype: скрытое значение + кнопка выпадающего списка
function renderHwtypeField(currentValue, keyAttr = 'data-key', enabled = false) {
    const label = currentValue || (enabled ? 'Выбрать…' : '—');
    return `<div class="hwtype-field">
        <input type="hidden" ${keyAttr}="${esc(HWTYPE_PARAM_NAME)}" value="${esc(currentValue || '')}">
        <button type="button" class="param-value hwtype-toggle" title="Выбрать значение hwtype из списка шаблонов" ${enabled ? '' : 'disabled'} onclick="toggleHwtypeDropdown(event, this)"><span class="hwtype-toggle-label" title="${esc(label)}">${esc(label)}</span><span class="hwtype-toggle-arrow">▾</span></button>
    </div>`;
}

let HWTYPE_DROPDOWN_TARGET = null;

// создаёт (один раз на всю страницу) плавающий контейнер списка hwtype
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

// ставит список hwtype точно под кнопкой, по которой кликнули
function positionHwtypeDropdown(toggle, dropdown) {
    const rect = toggle.getBoundingClientRect();
    dropdown.style.left = `${rect.left}px`;
    dropdown.style.top = `${rect.bottom + 5}px`;
    dropdown.style.width = `${rect.width}px`;
}

// закрывает открытый список hwtype
function closeHwtypeDropdown() {
    const dropdown = document.getElementById('hwtype_dropdown');
    if (dropdown) dropdown.classList.remove('is-open');
    HWTYPE_DROPDOWN_TARGET?.toggleButton.classList.remove('is-open');
    HWTYPE_DROPDOWN_TARGET = null;
}

// открывает/закрывает список hwtype по клику на кнопку поля
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
    dropdown.innerHTML = [...options].sort().map((option) => `<button type="button" class="hwtype-option ${option === currentValue ? 'active' : ''}" title="${esc(option)}" onclick="selectHwtypeOption(event, '${esc(option)}')">${esc(option)}</button>`).join('')
        || '<div class="muted" style="padding:8px 10px;">Нет доступных значений</div>';

    HWTYPE_DROPDOWN_TARGET = { hiddenInput, toggleButton: toggle };
    positionHwtypeDropdown(toggle, dropdown);
    dropdown.classList.add('is-open');
    toggle.classList.add('is-open');
}

// применяет выбранное значение hwtype и помечает форму изменённой
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

// строит HTML-карточку одного узла: заголовок + сворачиваемые параметры
function renderNode(node) {
    const hasStatus = Object.prototype.hasOwnProperty.call(DATA.status || {}, node.hostname);
    const available = hasStatus ? DATA.status[node.hostname] === true : null;
    const params = Object.entries(node.parameters || {});
    const id = `node-${encodeURIComponent(node.hostname)}`;
    let state, statusClass;

    if (!hasStatus) { state = '<span class="node-status pending"><span class="status-dot status-pending"></span>проверка</span>'; statusClass = 'node-pending'; }
    else if (available) { state = '<span class="node-status available"><span class="status-dot status-up"></span>доступен</span>'; statusClass = 'node-available'; }
    else { state = '<span class="node-status unavailable"><span class="status-dot status-down"></span>недоступен</span>'; statusClass = 'node-unavailable'; }

    const nameField = `<div class="param-name" title="Имя узла">Имя узла</div><input class="param-value" data-key="hostname" value="${esc(node.hostname)}" readonly>`
        + `<div class="param-name node-template-name" title="Шаблон — набор параметров узла">Шаблон</div><div class="node-template-cell"><div class="ui-select node-template-pick"></div><div class="node-template-note"></div></div>`;
    const fields = params.length
        ? nameField + params.map(([key, value]) => paramFieldHTML(key, value)).join('')
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
                <input class="node-check" title="Отметить узел для запуска плейбуков или удаления" type="checkbox" value="${esc(node.hostname)}" onclick="event.stopPropagation()" onchange="updateHostSelectionButton()">
                <span class="node-expand">▸</span>
                <div class="node-main">
                    <span class="node-name" title="${esc(node.hostname)}">${esc(node.hostname)}</span>
                    <span class="node-ip" title="${esc(node.ip || '—')}">${esc(node.ip || '—')}</span>
                    <span class="node-template" title="${esc(templateLabel(node))}">${esc(templateLabel(node))}</span>
                    <span class="node-groups" title="${esc(nodeGroupNames(node.hostname).join(', ') || 'не входит ни в одну группу')}">${esc(nodeGroupNames(node.hostname).join(', ') || '—')}</span>
                </div>
                <button class="node-edit" title="Раскрыть параметры узла для правки; в режиме правки работает как «Отмена»" onclick="toggleNodeEdit(event, '${esc(node.hostname)}')">Изменить</button>
            </div>
            <div class="host-body" hidden>
                <div class="param-grid">${fields}</div>
                ${groupsField}
                <div class="host-footer">
                    <span class="edit-note">${esc(templateLabel(node))} · изменения сохраняются в hosts.yml</span>
                    <button class="edit-save primary" disabled title="Сохранить изменения узла в hosts.yml (активна после правок)" onclick="saveNode(event, '${esc(node.hostname)}')">Сохранить</button>
                </div>
            </div>
        </div>
    `;
}

// плавно разворачивает/сворачивает блок через max-height и opacity
// плавно раскрывает/сворачивает панель параметров узла — через Web Animations API (element.animate):
// начальные и конечные значения задаются явно, поэтому анимация не зависит от того, когда браузер
// пересчитает стили (на CSS-переходах в Firefox при раскрытии бывала «ступенька»). Вместе с высотой
// меняются вертикальные отступы и рамка панели. Если за время раскрытия высота содержимого изменилась
// (например, появилась полоса прокрутки), панель плавно добирает разницу, а не прыгает в конце.
const NODE_PANEL_PROPS = ['paddingTop', 'paddingBottom', 'marginTop', 'marginBottom', 'borderTopWidth', 'borderBottomWidth'];
function animatePanel(body, open) {
    const ms = ANIM.BODY_COLLAPSE_MS || 220;
    if (body._anim) { body._anim.onfinish = null; body._anim.cancel(); body._anim = null; }
    if (open) body.hidden = false;
    const style = getComputedStyle(body);
    const full = { height: `${body.offsetHeight}px`, opacity: 1 };
    const zero = { height: '0px', opacity: 0 };
    NODE_PANEL_PROPS.forEach((prop) => { full[prop] = style[prop]; zero[prop] = '0px'; });
    body.style.overflow = 'hidden';
    body.style.boxSizing = 'border-box';                     // высота — вместе с отступами (как и измеренная)
    const finish = () => { body._anim = null; body.style.overflow = ''; body.style.boxSizing = ''; };
    const anim = body.animate(open ? [zero, full] : [full, zero], { duration: ms, easing: 'ease', fill: open ? 'none' : 'forwards' });
    body._anim = anim;
    anim.onfinish = () => {
        if (!open) { body.hidden = true; anim.cancel(); return finish(); }
        // высота содержимого изменилась за время раскрытия — плавно добрать разницу
        const natural = body.offsetHeight, target = parseFloat(full.height);
        if (Math.abs(natural - target) > 2) {
            const tail = body.animate([{ height: full.height }, { height: `${natural}px` }], { duration: 120, easing: 'ease-out' });
            body._anim = tail;
            tail.onfinish = finish;
        } else finish();
    };
}

// клик по строке узла отмечает его чекбокс (не раскрывает карточку)
function toggleNodeFromHead(event, card) {
    if (event.target.closest('button, input, select')) return;
    const checkbox = card.querySelector('.node-check');
    if (!checkbox) return;
    checkbox.checked = !checkbox.checked;
    updateHostSelectionButton();
}

// переключает карточку узла между просмотром и редактированием
function toggleNodeEdit(event, hostname) {
    event.stopPropagation();
    const card = document.getElementById(`node-${encodeURIComponent(hostname)}`);
    if (card.dataset.animating === '1') return;
    if (card.classList.contains('editing')) closeNodeEdit(card);
    else openNodeEdit(card);
}

// раскрывает форму параметров узла и включает поля для правки
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
    mountNodeTemplatePick(card);
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

// сворачивает форму, откатывая несохранённые правки к исходным значениям
function closeNodeEdit(card) {
    const body = card.querySelector('.host-body');
    if (card.dataset.templateChanged === '1') {
        card.dataset.templateChanged = '0';
        setTimeout(loadMain, (ANIM.BODY_COLLAPSE_MS || 220) + 60);   // исходные поля шаблона — перерисовкой
    }

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

    // признак «правка» снимается после анимации: иначе кнопка «Сохранить» в подвале исчезает сразу
    // и панель в первый же кадр уменьшается рывком
    // (если за это время форму открыли снова — панель видима, и признак остаётся)
    setTimeout(() => { if (body.hidden) card.classList.remove('editing'); }, (ANIM.BODY_COLLAPSE_MS || 220) + 40);
    card.querySelectorAll('.param-value').forEach((el) => { el.readOnly = true; el.disabled = true; });
    card.querySelectorAll('.node-group-check').forEach((el) => el.disabled = true);

    const editBtn = card.querySelector('.node-edit');
    editBtn.textContent = 'Изменить';
    editBtn.classList.remove('has-changes');
    card.querySelector('.edit-save.primary').disabled = true;
}

// отправляет изменённые параметры узла на сервер
function saveNode(event, hostname) {
    event.stopPropagation();
    const card = document.getElementById(`node-${encodeURIComponent(hostname)}`);
    const values = {};
    let newHostname = hostname;
    const hostnameInput = card.querySelector('[data-key="hostname"]');
    if (hostnameInput) {
        newHostname = hostnameInput.value.trim();
        if (!newHostname) return notify('Имя узла не может быть пустым', 'warning');
    }
    card.querySelectorAll('[data-key]').forEach((input) => { if (input.dataset.key !== 'hostname') values[input.dataset.key] = input.value; });
    const groups = [...card.querySelectorAll('.node-group-check:checked')].map((input) => input.value);
    const renamed = newHostname !== hostname;
    const save = (close) => api(API.UPDATE_HOST, { project: CURRENT_PROJECT, object: CURRENT_OBJECT, hostname, new_hostname: newHostname, values, groups })
        .then(() => {
            notify(`Узел «${newHostname}» сохранён`, 'success');
            commitNodeOriginals(card);
            if (close || renamed) {
                // свернуть форму с анимацией, затем обновить список (при переименовании — обязательно)
                closeNodeEdit(card);
                setTimeout(loadMain, ANIM.PANEL_TOGGLE_MS + 40);
                return;
            }
            // форма остаётся открытой: сохранённое становится «исходным», признак изменений снимается
            const node = (DATA.hosts || []).find((item) => item.hostname === hostname);
            if (node) { node.parameters = { ...(node.parameters || {}), ...values }; node.ip = values.ansible_host ?? values.ip ?? node.ip; }
            applyIpHints();
        })
        .catch((error) => notify(error.message, 'error'));
    showChoice('Сохранить изменения узла?', `Узел <strong>${esc(newHostname)}</strong>${renamed ? ` (новое имя; было ${esc(hostname)})` : ''} — изменения будут записаны в hosts.yml.${renamed ? '<br><br>Имя изменено — после сохранения форма закроется.' : ''}`,
        [{ label: 'Сохранить', className: 'primary', action: () => save(false), hidden: renamed }, { label: 'Сохранить и закрыть', className: 'save-close is-main', action: () => save(true) }],
        'Редактирование узла', 'danger');
}

// запрашивает подтверждение и удаляет отмеченные узлы одним запросом
function deleteSelectedNodes() {
    const hosts = selectedHosts();
    if (!hosts.length) return notify('Выберите узлы для удаления.', 'warning');
    showConfirmation('Удалить выбранные узлы?', `<strong>Узлы:</strong><br>${hosts.map(esc).join('<br>')}<br><br>Это изменит hosts.yml.`,
        () => api(API.DELETE_HOSTS, { project: CURRENT_PROJECT, object: CURRENT_OBJECT, hostnames: hosts })
            .then(() => { notify(`Удалено узлов: ${hosts.length}`, 'success'); loadMain(); }).catch((error) => notify(error.message, 'error')), 'Удалить', 'danger', 'Подтверждение удаления');
}

// открывает модалку добавления нового узла и сбрасывает её поля
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

// перерисовывает кнопки выбора шаблона параметров в модалке добавления
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
    tabs.innerHTML = names.map((name) => `<button type="button" class="node-type-tab ${name === NEW_TEMPLATE ? 'active' : ''}" title="Выбрать этот шаблон параметров" onclick="selectTemplate('${esc(name)}')"><span class="node-type-title">${esc(name)}</span><span class="node-type-desc">${schemas[name].length}</span></button>`).join('');
    renderTemplateFields();
}

// выбирает шаблон параметров для нового узла
function selectTemplate(name) {
    NEW_TEMPLATE = name;
    renderTemplateTabs();
    document.querySelector('#add_node_modal .node-params-panel')?.scrollTo(0, 0);
}
// строит поля ввода параметров под выбранный шаблон
function renderTemplateFields() {
    const keys = (DATA.template_schemas || {})[NEW_TEMPLATE] || [];
    document.getElementById('new_node_fields').innerHTML = keys.map((key) => key === HWTYPE_PARAM_NAME
        ? `<label class="new-node-field"><span title="${esc(key)}">${esc(key)}</span>${renderHwtypeField('', 'data-new-key', true)}</label>`
        : `<label class="new-node-field"><span title="${esc(key)}">${esc(key)}</span><input data-new-key="${esc(key)}" type="text" placeholder="Значение"></label>`).join('');
    applyIpHints();
}

// собирает введённые параметры и отправляет запрос на создание узла
function createNode() {
    const name = document.getElementById('new_node_name').value.trim();
    const keys = (DATA.template_schemas || {})[NEW_TEMPLATE] || [];
    if (!name) return document.getElementById('new_node_name').focus();
    if (!keys.length) return notify('Выберите шаблон параметров.', 'warning');
    const values = {};
    document.querySelectorAll('[data-new-key]').forEach((input) => values[input.dataset.newKey] = input.value);
    const add = () => api(API.ADD_HOST, { project: CURRENT_PROJECT, object: CURRENT_OBJECT, hostname: name, values, groups: SELECTED_GROUPS })
        .then(() => { window.closeAddNodeModal(); notify(`Узел «${name}» добавлен`, 'success'); loadMain(); })
        .catch((error) => showErrorModal('Не удалось добавить узел', esc(error.message)));
    // не все параметры заполнены — спросить: да / нет
    const empty = Object.keys(values).filter((key) => !String(values[key] ?? '').trim());
    if (!empty.length) return add();
    showChoice('Не все параметры назначены', `У узла <strong>${esc(name)}</strong> не заполнены параметры: <strong>${empty.map(esc).join(', ')}</strong>.<br><br>Вы действительно хотите добавить узел?`,
        [{ label: 'Да', className: 'primary is-main', action: add }], 'Добавление узла', 'danger', 'Нет');
}

// показывает одноразовое окно с текстом ошибки и кнопкой «Понятно»
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

// открывает/закрывает панель фильтра по группам
function toggleGroupFilter() {
    const list = document.getElementById('group-filter-list');
    const btn = document.getElementById('group-filter-btn');
    if (!list) return;
    const isOpen = list.classList.contains('is-open');
    list.classList.toggle('is-open', !isOpen);
    if (btn) btn.querySelector('.group-filter-arrow').textContent = isOpen ? '▾' : '▴';
}

// закрывает панель фильтра по группам
function closeGroupFilter() {
    const list = document.getElementById('group-filter-list');
    if (!list?.classList.contains('is-open')) return;
    list.classList.remove('is-open');
    const arrow = document.querySelector('#group-filter-btn .group-filter-arrow');
    if (arrow) arrow.textContent = '▾';
}
// щелчок в любом месте вне фильтра или Esc — закрыть список групп
document.addEventListener('pointerdown', (event) => { if (!event.target.closest('.group-filter-dropdown')) closeGroupFilter(); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeGroupFilter(); });

// применяет фильтр узлов по выбранной группе
function selectGroupFilter(name) {
    const group = (DATA.groups || []).find((item) => item.name === name);
    ACTIVE_GROUP = ACTIVE_GROUP?.name === name ? null : group || null;
    renderGroups(DATA.groups || []);
    renderNodes();
}

// сбрасывает фильтр по группам, показывая все узлы
function clearGroupFilter() {
    ACTIVE_GROUP = null;
    renderGroups(DATA.groups || []);
    renderNodes();
}

// запрашивает подтверждение и удаляет отмеченные группы
function requestDeleteSelectedGroups() {
    if (!SELECTED_GROUPS.length) return notify('Сначала выберите группу для удаления — нажмите на неё в списке выше.', 'warning');
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
                notify(targets.length > 1 ? `Удалено групп: ${targets.length}` : `Группа «${targets[0].name}» удалена`, 'success');
                return loadMain();
            })
            .then(() => renderGroupButtons())
            .catch((error) => notify(error.message, 'error')),
        targets.length > 1 ? 'Удалить группы' : 'Удалить группу', 'danger', 'Подтверждение удаления группы');
}

// === Выбор групп в модалке добавления узла ===
function renderGroupButtons() {
    const list = document.getElementById('group_selector_list');
    if (!list) return;
    const allGroups = [...new Set([...(DATA?.groups || []).map(g => g.name), ...NEW_GROUPS_CREATED])];
    list.innerHTML = allGroups.length
        ? allGroups.map(name => `<button type="button" class="group-toggle-btn ${SELECTED_GROUPS.includes(name) ? 'active' : ''}" title="Добавить/убрать эту группу у нового узла" onclick="toggleGroupSelection('${esc(name)}')">${esc(name)}</button>`).join('')
        : '<span class="muted">Нет доступных групп. Создайте первую!</span>';
}

// отмечает/снимает группу для назначения новому узлу
function toggleGroupSelection(name) {
    if (SELECTED_GROUPS.includes(name)) SELECTED_GROUPS = SELECTED_GROUPS.filter(g => g !== name);
    else SELECTED_GROUPS.push(name);
    renderGroupButtons();
}

// открывает модалку создания новой группы
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

// закрывает модалку создания группы
function closeCreateGroupModal() { const modal = document.getElementById('create_group_modal'); if (modal) modal.hidden = true; }

// создаёт новую группу и сразу выбирает её для нового узла
function confirmCreateGroup() {
    const name = document.getElementById('new_group_name').value.trim();
    if (!name) return notify('Введите название группы', 'warning');
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) return notify('Название группы может содержать только буквы, цифры, дефис и подчёркивание', 'warning');
    const allGroups = [...new Set([...(DATA?.groups || []).map(g => g.name), ...NEW_GROUPS_CREATED])];
    if (allGroups.includes(name)) return notify('Группа с таким названием уже существует', 'warning');
    NEW_GROUPS_CREATED.push(name);
    SELECTED_GROUPS.push(name);
    closeCreateGroupModal();
    renderGroupButtons();
}

// собирает строку query-параметров текущего проекта/объекта
function contextQuery(extra = '') { const object = CURRENT_OBJECT ? `&object=${encodeURIComponent(CURRENT_OBJECT)}` : ''; return `project=${encodeURIComponent(CURRENT_PROJECT)}${object}${extra}`; }

// открывает выбранный плейбук в модалке редактирования
function editPlaybook(name, scope = '') {
    const modal = document.getElementById('playbook_modal');
    const editor = document.getElementById('playbook_editor');
    const title = document.getElementById('playbook_modal_title');
    if (!modal || !editor || !title) return;
    window.CURRENT_EDITING_PLAYBOOK = name;
    window.CURRENT_EDITING_SCOPE = scope;
    title.textContent = scope === 'autodeploy' ? `${name} · Autodeploy` : name;
    editor.value = 'Загрузка…';
    editor.readOnly = true;
    modal.hidden = false;
    fetch(`${API.PLAYBOOK}?${contextQuery(`&name=${encodeURIComponent(name)}${scope ? `&scope=${scope}` : ''}`)}`)
        .then((response) => { if (!response.ok) throw Error('Не удалось открыть плейбук'); return response.json(); })
        .then((data) => { editor.value = data.content || ''; editor.readOnly = false; playbookErrorBox().hidden = true; const code = enhanceCodeEditor(editor, { onSave: () => savePlaybookFromModal() }); code.ctx = { kind: 'playbook', path: name, scope }; prepareCompletion(code); code.refresh(); fitPlaybookEditor(); editor.focus(); editor.setSelectionRange(0, 0); editor.scrollTop = 0; code.refresh(); window.PLAYBOOK_ORIGINAL = editor.value; updatePlaybookSaveState(); })
        .catch((error) => { editor.value = ''; notify(error.message, 'error'); window.closePlaybookModal(); });
}

window.closePlaybookModal = function() { hideModalSmooth('playbook_modal'); window.CURRENT_EDITING_PLAYBOOK = ''; };   // плавно, как остальные окна

// сохраняет отредактированный текст плейбука на сервере
function savePlaybookFromModal(force = false) {
    const name = window.CURRENT_EDITING_PLAYBOOK;
    const editor = document.getElementById('playbook_editor');
    if (!name || !editor) return;
    if (!force) {
        if (editor.value === window.PLAYBOOK_ORIGINAL) return;   // изменений нет — сохранять нечего
        return confirmAction('Сохранить изменения?', `Плейбук <strong>${esc(name)}</strong> будет перезаписан. Предыдущая версия сохранится в backups/.`, 'Сохранить', () => savePlaybookFromModal('confirmed'), 'primary', 'Редактор плейбука');
    }
    force = force === true;
    editor.disabled = true;
    const errorBox = playbookErrorBox();
    fetch(API.SAVE_PLAYBOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: CURRENT_PROJECT, object: CURRENT_OBJECT, name, content: editor.value, force, scope: window.CURRENT_EDITING_SCOPE || '' }) })
        .then(async (response) => {
            const data = await response.json();
            if (data.yaml_error) { showYamlError(errorBox, editor, data.yaml_error, () => savePlaybookFromModal(true)); return; }
            if (!response.ok || data.ok === false) throw Error(data.error || 'Не удалось сохранить плейбук');
            errorBox.hidden = true;
            window.closePlaybookModal();
            notify(`Плейбук «${name}» сохранён`, 'success');
            loadMain();
        }).catch((error) => notify(error.message, 'error')).finally(() => editor.disabled = false);
}

// подгоняет размер текстового редактора плейбука под окно
function fitPlaybookEditor() {
    const editor = document.getElementById('playbook_editor');
    const card = document.getElementById('playbook_editor_card');
    if (!editor || !card) return;
    const longestLine = editor.value.split('\n').reduce((max, line) => Math.max(max, line.length), 0);
    const width = Math.min(1100, Math.max(620, longestLine * 7.2 + 70));
    card.style.width = `${Math.min(width + 42 + 48, window.innerWidth - 40)}px`;   // + столбец номеров строк; поле ввода — по ширине окна
}

// Set имён хостов, состоящих в группе
function groupHosts(group) { return new Set((group?.hosts || []).map((host) => typeof host === 'string' ? host : host?.hostname || host?.name)); }
// перерисовывает список карточек узлов текущего проекта/объекта
function renderNodes() {
    const hosts = ACTIVE_GROUP ? (DATA.hosts || []).filter((node) => groupHosts(ACTIVE_GROUP).has(node.hostname)) : (DATA.hosts || []);
    document.getElementById('nodes').innerHTML = hosts.map(renderNode).join('') || (ACTIVE_GROUP
        ? `<div class="empty-state"><b>В группе «${esc(ACTIVE_GROUP.name)}» нет узлов</b><span>Сбросьте фильтр по группам, чтобы увидеть все узлы.</span></div>`
        : '<div class="empty-state"><b>Узлов пока нет</b><span>Нажмите «Добавить узел», чтобы создать первый, — он появится в hosts.yml.</span></div>');
    applyListSearch('nodes');
    updateHostSelectionButton();
    applyIpHints();
}

// показывает/скрывает блок кнопки автодеплоя
// есть ли у проекта Autodeploy — строка в списке плейбуков рисуется только тогда
let HAS_AUTODEPLOY = false;
function renderAutodeploy(enabled) { HAS_AUTODEPLOY = Boolean(enabled); }

// строка Autodeploy в списке плейбуков: запуск (с подтверждением), просмотр и файлы — как у плейбука
function autodeployRowHTML() {
    return `<div class="playbook-card autodeploy-card" data-name="autodeploy.yml">
        <div class="playbook-row">
            <span class="autodeploy-label" title="Autodeploy проекта"><span class="autodeploy-mark" aria-hidden="true"><svg viewBox="0 0 16 16" width="10" height="10"><path d="M4 2.5v11l9-5.5z" fill="currentColor"/></svg></span><span class="autodeploy-file">autodeploy.yml</span></span>
            <div class="playbook-actions">
                <button type="button" class="autodeploy-run" onclick="runAutodeploy()" title="Запустить autodeploy.yml проекта на отмеченных узлах (с подтверждением); отмечены роли — только они">▶ Запустить</button>
                ${tagsButtonHTML('@autodeploy', DATA.autodeploy_tags || [])}
                <button onclick="editPlaybook('autodeploy.yml', 'autodeploy')" title="Открыть autodeploy.yml в редакторе">Просмотр плейбука</button>
                <button onclick="openPlaybookFiles('autodeploy.yml', 'autodeploy')" title="Роли и файлы Autodeploy">Файлы плейбука</button>
            </div>
        </div>${roleStepsHTML('@autodeploy', DATA.autodeploy_roles || [], 'Выполнить только эту роль Autodeploy (можно отметить несколько; ничего не отмечено — все роли)')}
    </div>`;
}

// строит вложенное дерево директорий и файлов роли плейбука
function roleTree(nodes) {
    return (nodes || []).map((node) => {
        if (node.type === 'dir') {
            const readme = (node.children || []).find((child) => child.type === 'file' && child.name.toLowerCase() === 'readme.md');
            const children = (node.children || []).filter((child) => !(child.type === 'file' && child.name.toLowerCase() === 'readme.md'));
            const addFile = `<button type="button" class="role-add-file" onclick="promptRoleFile('${esc(node.path)}')" title="Создать файл в папке ${esc(node.path)}">＋ Новый файл…</button>`;
            return `<div class="role-dir"><button class="role-toggle" onclick="toggleRoleDir(this)"><span class="role-chevron">▸</span> ${esc(node.name)}</button><div class="role-children" hidden>${readme ? `<details class="role-readme"><summary>README.md</summary><pre data-readme-path="${esc(readme.path)}">Загрузка…</pre></details>` : ''}${roleTree(children)}${addFile}</div></div>`;
        }
        return `<div class="role-file-row"><button class="role-file" onclick="openRoleFile('${esc(node.path)}')" title="Открыть в редакторе">${esc(node.name)}</button><button type="button" class="role-file-delete" onclick="deleteRoleFile('${esc(node.path)}')" title="Удалить файл (в корзину backups/deleted)" aria-label="Удалить ${esc(node.name)}">×</button></div>`;
    }).join('');
}

// перерисовывает список плейбуков и чекбоксов выбора
function renderPlaybooks(items) {
    const element = document.getElementById('playbooks');
    // выбор переживает перерисовку списка (после добавления роли, импорта и т.п.): отмеченные плейбуки и роли
    const keptPlaybooks = new Set([...element.querySelectorAll('.pb:checked')].map((box) => box.value));
    const keptRoles = new Set([...element.querySelectorAll('.pb-role:checked')].map((box) => `${box.dataset.playbook}\n${box.value}`));
    if (PLAYBOOK_RENDER_KEPT.project !== CURRENT_PROJECT || PLAYBOOK_RENDER_KEPT.object !== CURRENT_OBJECT) { keptPlaybooks.clear(); keptRoles.clear(); TAG_SELECTION.clear(); }
    PLAYBOOK_RENDER_KEPT = { project: CURRENT_PROJECT, object: CURRENT_OBJECT };
    requestAnimationFrame(() => restorePlaybookSelection(keptPlaybooks, keptRoles));
    const autodeployRow = HAS_AUTODEPLOY ? autodeployRowHTML() : '';
    if (!items?.length) return element.innerHTML = autodeployRow + `<div class="empty-state"><b>Плейбуков нет</b><span>Создайте плейбук кнопкой «Новый плейбук» или положите файлы *.yml в папку ${CURRENT_OBJECT ? 'объекта' : 'плейбуков проекта'}.</span></div>`;
    element.innerHTML = autodeployRow + items.map((playbook) => `
        <div class="playbook-card">
            <div class="playbook-row">
                <label><input type="checkbox" class="pb" value="${esc(playbook.name)}"><span title="${esc(playbook.name)}">${esc(playbook.name)}</span></label>
                <div class="playbook-actions">
                    ${tagsButtonHTML(playbook.name, playbook.tags || [])}
                    <button onclick="editPlaybook('${esc(playbook.name)}')">Просмотр плейбука</button>
                    <button onclick="openPlaybookFiles('${esc(playbook.name)}')" title="Роли и файлы плейбука: открыть, добавить, удалить">Файлы плейбука</button>
                </div>
            </div>${roleStepsHTML(playbook.name, playbook.roles || [], 'Выполнить только эту роль плейбука (можно отметить несколько)')}
        </div>
    `).join('');
    applyListSearch('playbooks');
    updateSelectionSummary();
}

// подгружает и показывает содержимое файла роли (например README)
// путь файла роли для показа: «роль|путь» → «роль/путь» («|» — служебный разделитель роли и пути внутри неё)
function shownPath(path) { return String(path || '').replace('|', '/'); }

function openRoleFile(path) { openFileEditor(path, { scope: PLAYBOOK_FILES.scope }); }

// запускает плейбук автодеплоя для текущего проекта
// роли Autodeploy к запуску: отмечена часть — только они; ничего или все — весь autodeploy.yml
function autodeployRoles() {
    const roles = playbookRoleBoxes('@autodeploy'), checked = roles.filter((role) => role.checked).map((role) => role.value);
    return checked.length && checked.length < roles.length ? checked : null;
}
function runAutodeploy() {
    const hosts = selectedHosts();
    api(API.RUN_AUTODEPLOY, { project: CURRENT_PROJECT, object: CURRENT_OBJECT, hosts, verbosity: selectedVerbosity(), roles: autodeployRoles(), tags: [...(TAG_SELECTION.get('@autodeploy') || [])] })
        .then(() => { setRunState('Выполняется', 'running'); notify('Autodeploy запущен', 'info'); })
        .catch((error) => notify(error.message, 'error'));
}

// выбранная подробность вывода ansible-playbook: '', '-v', '-vv' или '-vvv'
function selectedVerbosity() {
    return document.querySelector('input[name="verbosity"]:checked')?.value || '';
}

// запускает отмеченные плейбуки на отмеченных узлах
function runSelected() {
    const playbooks = selectedPlaybooks();
    const hosts = selectedHosts();
    if (!playbooks.length) return notify('Выберите хотя бы один плейбук', 'warning');
    api(API.RUN, { project: CURRENT_PROJECT, object: CURRENT_OBJECT, playbooks, hosts, verbosity: selectedVerbosity(), roles: selectedRoleMap(), tags: selectedTagMap(playbooks) })
        .then(() => setRunState('Выполняется', 'running'))
        .then(() => notify(`Запущено плейбуков: ${playbooks.length}${hosts.length ? ` на узлах: ${hosts.length}` : ' на всех узлах'}`, 'info'))
        .catch((error) => notify(error.message, 'error'));
}

// прогоняет отмеченные плейбуки с --check (без изменений на узлах, поэтому без окна подтверждения)
function runCheck() {
    const playbooks = selectedPlaybooks();
    const hosts = selectedHosts();
    if (!playbooks.length) return notify('Выберите хотя бы один плейбук', 'warning');
    api(API.RUN, { project: CURRENT_PROJECT, object: CURRENT_OBJECT, playbooks, hosts, verbosity: selectedVerbosity(), check: true, roles: selectedRoleMap(), tags: selectedTagMap(playbooks) })
        .then(() => { setRunState('Проверка (--check)', 'check'); notify('Проверка запущена: изменения на узлах не вносятся', 'info'); })
        .catch((error) => notify(error.message, 'error'));
}

// останавливает текущий запущенный процесс ansible-playbook
function stopExecution() {
    confirmAction('Завершить выполнение?', 'Запущенный ansible-playbook будет остановлен — задачи, которые выполнялись в этот момент, могут остаться незавершёнными на узлах.', 'Завершить', doStopExecution, 'danger', 'Выполнение');
}
function doStopExecution() { api(API.STOP, {}).then(() => notify('Выполнение остановлено', 'info')).finally(() => setRunState('Остановлено', 'stopped')); }

// показывает общее модальное окно подтверждения действия
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
    // действие красное (удалить, убрать…) — «Отмена» серая, чтобы рядом не стояли две красные кнопки
    modal.querySelector('#run_confirm_cancel').classList.toggle('is-neutral', actionClass === 'danger');
    const ok = modal.querySelector('#run_confirm_ok');
    ok.textContent = actionLabel;
    ok.className = actionClass;
    modal.hidden = false;
}

// перехватывает клики по кнопкам запуска, подставляя окно подтверждения
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
            if (!playbooks.length) return notify('Выберите хотя бы один плейбук', 'warning');
            const partial = selectedRoleMap();
            const tagMap = selectedTagMap(playbooks);
            showConfirmation('Запустить выбранные плейбуки?', `<strong>Плейбуки:</strong><br>${playbooks.map((name) => `${esc(name)}${partial[name] ? ` — <span class="confirm-roles">только роли: ${partial[name].map(esc).join(', ')}</span>` : ''}${tagMap[name] ? ` — <span class="confirm-tags">теги: ${tagMap[name].map(esc).join(', ')}</span>` : ''}`).join('<br>')}<br><br><strong>Узлы:</strong> ${hosts.length ? `${hosts.length} ${hosts.length === 1 ? 'узел' : 'узлов'}` : 'все узлы'}`, runSelected);
        } else {
            const adRoles = autodeployRoles(), adTags = [...(TAG_SELECTION.get('@autodeploy') || [])];
            showConfirmation('Запустить Autodeploy?', `<strong>Плейбук:</strong> autodeploy.yml${adRoles ? ` — <span class="confirm-roles">только роли: ${adRoles.map(esc).join(', ')}</span>` : ''}${adTags.length ? ` — <span class="confirm-tags">теги: ${adTags.map(esc).join(', ')}</span>` : ''}<br><br><strong>Узлы:</strong> ${hosts.length ? `${hosts.length} ${hosts.length === 1 ? 'выбранный узел' : 'выбранных узлов'}` : 'все узлы'}`, runAutodeploy);
        }
    }, true);
}

// === Инфопанель вверху страницы: DHCP, TFTP, ISO-образы ===
let SYSTEM_STATUS_DATA = null;
let ISO_PANEL_OPEN = false;

// форматирует размер в байтах в читаемую строку (КБ/МБ/ГБ)
function formatBytes(bytes) {
    if (!bytes) return '0 Б';
    const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
    const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / Math.pow(1024, exponent);
    return `${exponent === 0 ? value : value.toFixed(1)} ${units[exponent]}`;
}

// строит бейдж статуса сервиса (DHCP/TFTP) для инфопанели
function serviceStatusItem(label, info) {
    const stateClass = info?.active ? 'is-active' : (info?.state === 'unknown' ? 'is-unknown' : 'is-inactive');
    const stateText = info?.active ? 'активен' : (info?.state === 'unknown' ? 'не удалось проверить' : 'не активен');
    const tip = `${label}: ${stateText}${info?.service ? ` · служба ${info.service}` : ''}`;
    return `<span class="system-status-item ${stateClass}" title="${esc(tip)}"><span class="status-dot"></span><span class="system-status-label">${esc(label)}</span><span class="system-status-state">${stateText}</span></span>`;
}

// перерисовывает инфопанель DHCP/TFTP/ISO вверху страницы
function renderSystemStatus() {
    const services = document.getElementById('system_status_services');
    const isoSlot = document.getElementById('system_status_iso');
    if (!services || !isoSlot || !SYSTEM_STATUS_DATA) return;
    const { dhcp, tftp, iso } = SYSTEM_STATUS_DATA;
    // в шапке — коротко («ISO: 9 · 37.3 ГБ»), полностью — во всплывающей подсказке
    const isoLabel = iso?.exists ? `ISO: ${iso.count} · ${formatBytes(iso.total_size)}` : 'ISO: нет папки';
    const isoTitle = iso?.exists ? `ISO-образы: ${iso.count} шт., ${formatBytes(iso.total_size)} — показать список` : `Папка ISO-образов ${iso?.directory || ''} не найдена`;
    // Порядок в верхнем ряду: Проект · DHCP · TFTP · Прослушка · ISO-образы —
    // поэтому сервисы и ISO рисуются в разные слоты по обе стороны от кнопки «Прослушка».
    services.innerHTML = `${serviceStatusItem('DHCP', dhcp)}${serviceStatusItem('TFTP', tftp)}`;
    isoSlot.innerHTML = `<button type="button" id="iso_toggle_btn" class="system-status-item iso-toggle ${ISO_PANEL_OPEN ? 'is-open' : ''}" title="${esc(isoTitle)}" onclick="toggleIsoPanel(event)">${esc(isoLabel)} <span class="iso-toggle-arrow">▾</span></button>`;
    renderIsoPanel();
    if (ISO_PANEL_OPEN) positionIsoPanel();
}


// заполняет содержимое всплывающей панели со списком ISO-образов
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

// ставит панель ISO-образов точно под кнопкой-переключателем
function positionIsoPanel() {
    const button = document.getElementById('iso_toggle_btn');
    const panel = document.getElementById('iso_panel');
    if (!button || !panel) return;
    const rect = button.getBoundingClientRect();
    panel.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - panel.offsetWidth - 8))}px`;
    panel.style.top = `${rect.bottom + 6}px`;
}

// открывает/закрывает панель со списком ISO-образов
function toggleIsoPanel(event) {
    event?.stopPropagation();
    if (ISO_PANEL_OPEN) { closeIsoPanel(); return; }
    ISO_PANEL_OPEN = true;
    document.getElementById('iso_toggle_btn')?.classList.add('is-open');
    const panel = document.getElementById('iso_panel');
    panel?.classList.add('is-open');
    positionIsoPanel();
}

// закрывает панель ISO-образов
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

// запрашивает у сервера статус DHCP/TFTP/ISO и обновляет инфопанель
function loadSystemStatus() {
    fetch(`${API.SYSTEM_STATUS}?_=${Date.now()}`)
        .then((response) => response.json())
        .then((data) => { SYSTEM_STATUS_DATA = data; renderSystemStatus(); })
        .catch(() => {}); // это вспомогательная инфопанель — не мешаем работе остальной страницы, если она недоступна
}

// === Выпадающий список в общем стиле приложения (вместо нативного <select>) ===
// container — пустой div.ui-select; options — [{ value, label, sub }]; выбранное значение — container.dataset.value.
let UI_SELECT = null;

// рисует кнопку списка с выбранным пунктом
function mountUiSelect(container, options, value, onChange) {
    container._options = options;
    container._onChange = onChange;
    const option = options.find((item) => item.value === value) || options[0];
    container.dataset.value = option ? option.value : '';
    container.innerHTML = `<button type="button" class="ui-select-btn"${container.classList.contains('is-disabled') ? ' disabled' : ''}>
        <span class="ui-select-label">${option ? esc(option.label) : '—'}</span>${option?.sub ? `<span class="ui-select-sub">${esc(option.sub)}</span>` : ''}<span class="ui-select-arrow">▾</span></button>`;
    container.querySelector('button').addEventListener('click', (event) => { event.stopPropagation(); toggleUiSelectList(container); });
}

// открывает плавающий список под кнопкой (над ней — если внизу мало места)
function toggleUiSelectList(container) {
    let list = document.getElementById('ui_select_list');
    if (!list) {
        list = document.createElement('div');
        list.id = 'ui_select_list';
        list.className = 'ui-select-list';
        list.setAttribute('role', 'listbox');
        document.body.appendChild(list);
        ['click', 'pointerdown'].forEach((name) => list.addEventListener(name, (event) => event.stopPropagation()));
    }
    if (list.classList.contains('is-open') && UI_SELECT === container) return closeUiSelectList();
    closeUiSelectList();
    UI_SELECT = container;
    list.innerHTML = container._options.map((option) => `
        <button type="button" class="ui-select-option${option.value === container.dataset.value ? ' active' : ''}" data-value="${esc(option.value)}">
            <span class="ui-select-label">${esc(option.label)}</span>${option.sub ? `<span class="ui-select-sub">${esc(option.sub)}</span>` : ''}
        </button>`).join('') || '<div class="muted ui-select-empty">Нет вариантов</div>';
    list.querySelectorAll('.ui-select-option').forEach((button) => button.addEventListener('click', () => {
        const value = button.dataset.value;
        closeUiSelectList();
        mountUiSelect(container, container._options, value, container._onChange);
        container._onChange?.(value);
    }));
    const rect = container.getBoundingClientRect(), height = Math.min(300, list.scrollHeight + 10);
    list.style.left = `${rect.left}px`;
    list.style.width = `${rect.width}px`;
    list.style.top = rect.bottom + 6 + height > window.innerHeight ? `${Math.max(8, rect.top - 6 - height)}px` : `${rect.bottom + 6}px`;
    list.classList.add('is-open');
    container.classList.add('is-open');
}

// закрывает открытый выпадающий список
function closeUiSelectList() {
    document.getElementById('ui_select_list')?.classList.remove('is-open');
    UI_SELECT?.classList.remove('is-open');
    UI_SELECT = null;
}

// блокирует/разблокирует список (например, пока идёт прослушка)
function setUiSelectDisabled(container, disabled) {
    container.classList.toggle('is-disabled', disabled);
    const button = container.querySelector('button');
    if (button) button.disabled = disabled;
    if (disabled && UI_SELECT === container) closeUiSelectList();
}

document.addEventListener('pointerdown', (event) => { if (UI_SELECT && !event.target.closest('.ui-select')) closeUiSelectList(); });
window.addEventListener('resize', closeUiSelectList);
document.addEventListener('scroll', closeUiSelectList, true);
// Esc при раскрытом общем списке закрывает только список — событие дальше не идёт, окно остаётся открытым
// (раньше список закрывался, но событие доходило и до обработчика окон — закрывалось и окно)
window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !document.getElementById('ui_select_list')?.classList.contains('is-open')) return;
    event.stopImmediatePropagation();
    event.preventDefault();
    closeUiSelectList();
}, true);

// === Режим прослушки: обнаружение MAC-адресов в сети ===
// Два независимых варианта — переключаются радиокнопками в самой модалке:
// 1) tcpdump на сервере (ничего вводить не нужно);
// 2) SSH на коммутатор MikroTik — нужен его IP-адрес.
let NMAP_POLL_TIMER = null;
let NMAP_CLOSE_TIMER = null;

// открывает окно режима прослушки, подгружает список интерфейсов и запускает опрос статуса
function openNmapModal() {
    const modal = document.getElementById('nmap_modal');
    clearTimeout(NMAP_CLOSE_TIMER);
    modal.classList.remove('modal-closing');
    modal.hidden = false;
    document.body.classList.add('no-scroll');
    syncNmapModeUi();
    loadNmapInterfaces();
    refreshNmapStatus();
    clearInterval(NMAP_POLL_TIMER);
    NMAP_POLL_TIMER = setInterval(refreshNmapStatus, NMAP_POLL_INTERVAL_MS);
}

// запрашивает у сервера список поднятых интерфейсов и выбирает активный по умолчанию
function loadNmapInterfaces() {
    const picker = document.getElementById('nmap_interface_select');
    if (!picker) return;
    fetch(`${API.NMAP_INTERFACES}?_=${Date.now()}`)
        .then((response) => response.json())
        .then((data) => {
            const interfaces = (data.interfaces || []).map((item) => ({ value: item.name, label: item.name, sub: item.ip }));
            mountUiSelect(picker, interfaces.length ? interfaces : [{ value: '', label: 'Интерфейсы не найдены' }], data.default);
        })
        .catch(() => mountUiSelect(picker, [{ value: '', label: 'Не удалось получить список интерфейсов' }], ''));
}

// закрывает окно режима прослушки и останавливает опрос статуса
function closeNmapModal() {
    const modal = document.getElementById('nmap_modal');
    if (!modal || modal.hidden || modal.classList.contains('modal-closing')) return;
    if (NMAP_POLL_TIMER) { clearInterval(NMAP_POLL_TIMER); NMAP_POLL_TIMER = null; }
    closeUiSelectList();
    // Сначала проигрывается анимация закрытия (CSS .modal-closing), потом окно прячется.
    modal.classList.add('modal-closing');
    NMAP_CLOSE_TIMER = setTimeout(() => {
        modal.classList.remove('modal-closing');
        modal.hidden = true;
        document.body.classList.remove('no-scroll');
    }, ANIM.MODAL_MOTION_MS);
}

// выбранный сейчас вариант прослушки (tcpdump/switch)
function getSelectedNmapMode() {
    return document.querySelector('input[name="nmap_mode"]:checked')?.value || 'tcpdump';
}

// показывает/скрывает поля коммутатора (IP, пользователь, пароль) при смене варианта прослушки
// пользователь сменил способ прослушки: обновить окно и один раз запросить статус для нового режима
function onNmapModeChange() {
    syncNmapModeUi();
    refreshNmapStatus();
}

// приводит окно к выбранному способу прослушки — БЕЗ запросов к серверу. Её вызывает и отрисовка
// статуса: если бы отсюда запрашивался статус, получилось бы кольцо «запрос → отрисовка → запрос»
// (в 0.0.31 так и было — /nmap_status запрашивался непрерывно)
function syncNmapModeUi() {
    const field = document.getElementById('nmap_switch_fields');
    if (!field) return;
    // Поля SSH раскрываются плавно (max-height/opacity в CSS), а не прыжком;
    // inert — чтобы свёрнутые поля не ловили фокус по Tab.
    const mode = getSelectedNmapMode();
    const open = mode === 'switch';
    field.classList.toggle('is-open', open);
    field.inert = !open;
    const subnet = document.getElementById('nmap_subnet_fields');
    subnet.classList.toggle('is-open', mode === 'subnet');
    subnet.inert = mode !== 'subnet';
    if (mode === 'subnet') fillSubnetFields();
    // кнопка запуска подписана по режиму: прослушка или сканирование подсети
    const start = document.getElementById('nmap_start_btn');
    start.textContent = mode === 'subnet' ? 'Сканировать подсеть' : 'Включить режим прослушки';
    start.title = mode === 'subnet' ? 'Проверить все адреса подсети и запомнить занятые для этого проекта' : 'Начать поиск устройств выбранным способом';
    document.getElementById('nmap_stop_btn').hidden = mode === 'subnet';
}

// включает режим прослушки с выбранным вариантом, интерфейсом и (для SSH) данными коммутатора
function startNmapListening() {
    const mode = getSelectedNmapMode();
    if (mode === 'subnet') return startSubnetScan();
    const interface_ = document.getElementById('nmap_interface_select').dataset.value || '';
    const switchAddress = document.getElementById('nmap_switch_address').value.trim();
    const switchUser = document.getElementById('nmap_switch_user').value.trim();
    const switchPassword = document.getElementById('nmap_switch_password').value;
    if (mode === 'switch' && !switchAddress) {
        document.getElementById('nmap_switch_address').focus();
        return notify('Укажите IP-адрес коммутатора.', 'warning');
    }
    const begin = () => {
        document.getElementById('nmap_start_btn').disabled = true;
        api(API.NMAP_START, { mode, interface: interface_, switch_address: switchAddress, switch_user: switchUser, switch_password: switchPassword })
            .then(refreshNmapStatus)
            .catch((error) => { document.getElementById('nmap_start_btn').disabled = false; notify(error.message, 'error'); });
    };
    if (mode !== 'switch') return begin();
    // Сначала — ключ SSH коммутатора: при первом подключении ssh спрашивает «доверять ли» (yes/no).
    // В консоли на это отвечают вручную, здесь — показываем отпечаток и спрашиваем в окне.
    api(API.NMAP_SWITCH_HOSTKEY, { switch_address: switchAddress })
        .then((data) => {
            if (data.known) return begin();
            const prints = (data.fingerprints || []).map((item) => `<div class="hostkey-print"><span>${esc(item.type)}</span><code>${esc(item.fingerprint)}</code></div>`).join('');
            showConfirmation('Подтвердите ключ коммутатора',
                `Сервер подключается к <strong>${esc(switchAddress)}</strong> впервые, и его ключ SSH ещё не известен — в консоли в этот момент ssh спросил бы «yes/no».${prints ? `<div class="hostkey-prints">${prints}</div>` : ''}Сверьте отпечаток с тем, что показывает сам коммутатор, и подтвердите. Ключ запомнится, и при следующих подключениях вопроса не будет; если ключ коммутатора потом изменится, подключение будет остановлено.`,
                () => api(API.NMAP_SWITCH_TRUST, { switch_address: switchAddress }).then(() => { notify(`Ключ коммутатора ${switchAddress} сохранён`, 'success'); begin(); }).catch((error) => notify(error.message, 'error')),
                'Доверять и подключиться', 'primary', 'Первое подключение по SSH');
        })
        .catch((error) => notify(error.message, 'error'));
}

// сбрасывает сохранённый ключ коммутатора (после его замены/сброса), чтобы подтвердить новый
function forgetSwitchHostKey() {
    const address = document.getElementById('nmap_switch_address').value.trim();
    showConfirmation('Сбросить сохранённый ключ?', `Сохранённый ключ SSH коммутатора <strong>${esc(address)}</strong> будет удалён. При следующем подключении вы увидите новый отпечаток и сможете его подтвердить.<br><br>Делайте это, только если коммутатор действительно меняли или сбрасывали.`,
        () => api(API.NMAP_STOP, {}).then(() => api(API.NMAP_SWITCH_FORGET, { switch_address: address }))
            .then(() => { notify('Старый ключ удалён — включите режим прослушки ещё раз', 'success'); refreshNmapStatus(); })
            .catch((error) => notify(error.message, 'error')),
        'Сбросить ключ', 'danger', 'Ключ SSH коммутатора');
}

// выключает режим прослушки
function stopNmapListening() {
    document.getElementById('nmap_stop_btn').disabled = true;
    api(API.NMAP_STOP, {}).then(refreshNmapStatus).catch((error) => notify(error.message, 'error'));
}

// запрашивает у сервера статус и список найденных устройств
function refreshNmapStatus() {
    if (getSelectedNmapMode() === 'subnet') return refreshSubnetScan();
    fetch(`${API.NMAP_STATUS}?_=${Date.now()}`)
        .then((response) => response.json())
        .then(renderNmapStatus)
        .catch(() => {});
}

// перерисовывает кнопки и таблицу найденных устройств режима прослушки
function renderNmapStatus(data) {
    const startBtn = document.getElementById('nmap_start_btn');
    const stopBtn = document.getElementById('nmap_stop_btn');
    const stateLabel = document.getElementById('nmap_state_label');
    if (!startBtn || !stopBtn || !stateLabel) return; // модалка уже закрыта/не отрисована
    startBtn.disabled = data.running;
    stopBtn.disabled = !data.running;
    stateLabel.textContent = data.running ? 'прослушка включена…' : 'выключено';
    stateLabel.classList.toggle('is-active', data.running);

    // Пока прослушка идёт, менять способ, интерфейс и данные коммутатора
    // нельзя — сначала нужно отключить. Заодно выставляем radio на реально
    // работающий режим (например, если окно открыли заново).
    document.querySelectorAll('input[name="nmap_mode"]').forEach((input) => {
        input.disabled = data.running;
        if (data.running && data.mode) input.checked = (input.value === data.mode);
    });
    setUiSelectDisabled(document.getElementById('nmap_interface_select'), data.running);
    document.getElementById('nmap_switch_address').disabled = data.running;
    document.getElementById('nmap_switch_user').disabled = data.running;
    document.getElementById('nmap_switch_password').disabled = data.running;
    syncNmapModeUi();

    const mode = data.mode || getSelectedNmapMode();
    const container = document.getElementById('nmap_devices');
    if (container) {
        if (!data.devices.length) {
            container.innerHTML = '<div class="muted">Список пуст — включите режим прослушки, чтобы начать поиск устройств.</div>';
        } else if (mode === 'switch') {
            container.innerHTML = `<div class="nmap-table-head nmap-table-head--switch"><span>MAC-адрес</span><span>Порт</span><span>Мост</span><span>VLAN</span><span>Флаги</span></div>${data.devices.map((device) => `<div class="nmap-row nmap-row--switch"><span class="nmap-mac" title="${esc(device.mac)}">${esc(device.mac)}</span><span class="nmap-ip" title="${esc(device.port || '—')}">${esc(device.port || '—')}</span><span class="nmap-vendor" title="${esc(device.bridge || '—')}">${esc(device.bridge || '—')}</span><span class="nmap-vendor" title="${esc(device.vlan || '—')}">${esc(device.vlan || '—')}</span><span class="nmap-seen">${esc(device.flags || '—')}</span></div>`).join('')}`;
        } else {
            // TCPdump: № · IP-адрес · MAC-адрес · время обнаружения (первого появления в эфире)
            container.innerHTML = `<div class="nmap-table-head nmap-table-head--tcpdump"><span>№</span><span>IP-адрес</span><span>MAC-адрес</span><span>Время обнаружения</span></div>${data.devices.map((device, index) => `<div class="nmap-row nmap-row--tcpdump"><span class="nmap-num">${index + 1}</span><span class="nmap-ip" title="${esc(device.ip || '—')}">${esc(device.ip || '—')}</span><span class="nmap-mac" title="${esc(device.mac)}">${esc(device.mac)}</span><span class="nmap-seen" title="Последний раз: ${esc(device.last_seen || '—')}">${esc(device.first_seen || device.last_seen || '—')}</span></div>`).join('')}`;
        }
    }

    // понятное пояснение к ошибке SSH; при сменившемся ключе — кнопка «Сбросить сохранённый ключ»
    const notice = document.getElementById('nmap_notice');
    if (notice) {
        notice.hidden = !data.hint;
        notice.innerHTML = data.hint ? `<span>${esc(data.hint)}</span>${data.hostkey_changed ? '<button type="button" class="danger" onclick="forgetSwitchHostKey()">Сбросить сохранённый ключ</button>' : ''}` : '';
    }

}

// точечно обновляет индикаторы доступности уже отрисованных карточек узлов
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

// загружает данные текущего проекта/объекта и перерисовывает всю страницу
// --- Состояние выполнения (пометка рядом с заголовком «Выполнение») ---
// state: idle | running | check | done | failed | stopped — от него зависит цвет пометки
function setRunState(text, state) {
    const element = document.getElementById('run_state');
    if (!element) return;
    element.textContent = text;
    element.dataset.state = state;
}

// по данным сервера: идёт ли выполнение; когда закончилось — итог и уведомление
function syncRunState(running, failed) {
    const element = document.getElementById('run_state');
    if (!element) return;
    const state = element.dataset.state;
    if (running) {
        if (state !== 'running' && state !== 'check') setRunState('Выполняется', 'running');
        return;
    }
    if (state !== 'running' && state !== 'check') return;
    if (failed) {
        setRunState('Завершено с ошибками', 'failed');
        notify('Выполнение завершено с ошибками — подробности в журнале', 'error');
    } else {
        setRunState(state === 'check' ? 'Проверка завершена' : 'Готово', 'done');
        notify(state === 'check' ? 'Проверка завершена' : 'Выполнение завершено успешно', 'success');
    }
}

// --- Высота журнала: перетаскивание за верхний край панели «Выполнение» (запоминается) ---
const CONSOLE_HEIGHT_KEY = 'awc-console-h';
const CONSOLE_HEIGHT_DEFAULT = 260;
(function initConsoleResizer() {
    const handle = document.getElementById('console_resizer');
    if (!handle) return;
    const apply = (height) => {
        const value = Math.round(Math.min(Math.max(height, 140), window.innerHeight * 0.7));
        document.documentElement.style.setProperty('--console-h', `${value}px`);
        return value;
    };
    try { const saved = Number(localStorage.getItem(CONSOLE_HEIGHT_KEY)); if (saved) apply(saved); } catch (error) { /* без хранилища — высота по умолчанию */ }
    let drag = null;
    handle.addEventListener('pointerdown', (event) => {
        drag = { startY: event.clientY, startHeight: handle.closest('.execution-panel').getBoundingClientRect().height };
        handle.setPointerCapture(event.pointerId);
        document.body.classList.add('is-resizing');
    });
    handle.addEventListener('pointermove', (event) => { if (drag) apply(drag.startHeight - (event.clientY - drag.startY)); });
    const finish = () => {
        if (!drag) return;
        drag = null;
        document.body.classList.remove('is-resizing');
        try { localStorage.setItem(CONSOLE_HEIGHT_KEY, String(parseInt(getComputedStyle(document.documentElement).getPropertyValue('--console-h'), 10))); } catch (error) { /* не страшно */ }
    };
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
    handle.addEventListener('dblclick', () => { apply(CONSOLE_HEIGHT_DEFAULT); try { localStorage.removeItem(CONSOLE_HEIGHT_KEY); } catch (error) { /* не страшно */ } });
})();

// --- Счётчики, сводка запуска и поиск по спискам ---

// русское склонение: plural(3, 'узел', 'узла', 'узлов') → «узла»
function plural(count, one, few, many) {
    const mod10 = count % 10, mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
    return many;
}

// счётчики в заголовках, доступность «Удалить выбранные» и строка «что будет запущено»
function updateSelectionSummary() {
    updatePlaybookDeleteButton();
    const nodes = document.querySelectorAll('#nodes .node-check').length, nodesChecked = selectedHosts().length;
    const books = document.querySelectorAll('#playbooks .pb').length, booksChecked = selectedPlaybooks().length;
    const count = (id, total, checked) => {
        const element = document.getElementById(id);
        if (element) element.textContent = total ? (checked ? `${checked} из ${total}` : String(total)) : '';
    };
    count('nodes_count', nodes, nodesChecked);
    count('playbooks_count', books, booksChecked);
    document.querySelectorAll('#nodes .host-card').forEach((card) => card.classList.toggle('is-selected', Boolean(card.querySelector('.node-check')?.checked)));
    document.querySelectorAll('#playbooks .playbook-card').forEach((card) => { const box = card.querySelector('.pb'); card.classList.toggle('is-selected', Boolean(box?.checked || box?.indeterminate)); });
    const deleteButton = document.getElementById('delete_nodes_btn');
    if (deleteButton) {
        deleteButton.disabled = !nodesChecked;
        deleteButton.title = nodesChecked ? `Удалить отмеченные узлы (${nodesChecked}) из hosts.yml — с подтверждением` : 'Отметьте узлы, которые нужно удалить';
    }
    const summary = document.getElementById('run_summary');
    if (!summary) return;
    if (!booksChecked) {
        summary.textContent = 'Отметьте плейбуки для запуска';
        summary.className = 'run-summary is-muted';
        return;
    }
    summary.className = 'run-summary';
    summary.textContent = `${booksChecked} ${plural(booksChecked, 'плейбук', 'плейбука', 'плейбуков')} → ${nodesChecked ? `${nodesChecked} ${plural(nodesChecked, 'узел', 'узла', 'узлов')}` : 'все узлы инвентаря'}`;
    summary.title = nodesChecked ? 'Плейбуки будут запущены только на отмеченных узлах' : 'Узлы не отмечены — плейбуки будут запущены на всех узлах из hosts.yml';
}
window.updateSelectionSummary = updateSelectionSummary;
document.addEventListener('change', (event) => { if (event.target.matches?.('.node-check, .pb')) updateSelectionSummary(); });

// поиск по списку узлов / плейбуков: прячет неподходящие карточки, не трогая отметки и открытые формы
function applyListSearch(kind) {
    const input = document.getElementById(kind === 'nodes' ? 'nodes_search' : 'playbooks_search');
    const list = document.getElementById(kind);
    if (!input || !list) return;
    const query = input.value.trim().toLowerCase();
    const cards = [...list.querySelectorAll(kind === 'nodes' ? '.host-card' : '.playbook-card')];
    let shown = 0;
    cards.forEach((card) => {
        const text = kind === 'nodes'
            ? `${card.dataset.hostname || ''} ${card.querySelector('.node-ip')?.textContent || ''} ${card.querySelector('.node-template')?.textContent || ''}`
            : (card.querySelector('.pb')?.value || card.dataset.name || '');
        const match = !query || text.toLowerCase().includes(query);
        card.classList.toggle('is-filtered-out', !match);
        if (match) shown += 1;
    });
    list.querySelector('.search-empty')?.remove();
    if (query && cards.length && !shown) {
        list.insertAdjacentHTML('beforeend', `<div class="empty-state search-empty"><b>Ничего не найдено</b><span>По запросу «${esc(input.value.trim())}» — измените запрос или очистите поле поиска.</span></div>`);
    }
    if (kind === 'nodes') updateHostSelectionButton(); else window.updatePlaybookSelectionButton?.();
}
['nodes', 'playbooks'].forEach((kind) => {
    document.getElementById(kind === 'nodes' ? 'nodes_search' : 'playbooks_search')?.addEventListener('input', () => applyListSearch(kind));
});

// --- Карта: справка и сброс ---

// показывает/прячет справку по управлению картой (кнопка «?»)
function toggleNetmapHelp(event, force) {
    event?.stopPropagation();
    const help = document.getElementById('netmap_help'), button = document.getElementById('netmap_help_btn');
    const open = typeof force === 'boolean' ? force : !help.classList.contains('is-open');
    help.classList.toggle('is-open', open);
    button.setAttribute('aria-expanded', String(open));
}
document.addEventListener('pointerdown', (event) => { if (!event.target.closest('.netmap-help-wrap')) document.getElementById('netmap_help')?.classList.remove('is-open'); });

// «Сбросить карту»: удалить добавленные устройства и соединения, вернуть узлы из hosts.yml в исходную раскладку
function resetNetmap() {
    const added = NETMAP.nodes.filter((node) => node.custom).length;
    showConfirmation('Сбросить карту?',
        `На карте останутся только <strong>Autodeploy и узлы из hosts.yml</strong> — в исходной раскладке.<br><br>Будут удалены: ${added ? `<strong>${added}</strong> ${plural(added, 'добавленное устройство', 'добавленных устройства', 'добавленных устройств')} (вручную, автопостроением, найденные прослушкой), ` : ''}все соединения и подписи VLAN/портов, расположение устройств.<br><br>Найденное прослушкой не удаляется — карту можно снова построить автопостроением.`,
        () => {
            clearTimeout(NETMAP.saveTimer);
            NETMAP.saveTimer = null;
            api(API.NETMAP_RESET, { project: CURRENT_PROJECT, object: CURRENT_OBJECT })
                .then(() => { closeNetmapPopover(); toggleNetmapLinkTool(false); NETMAP.view = { tx: 0, ty: 0, z: 1 }; applyNetmapView(); loadNetmap(); notify('Карта сброшена: остались Autodeploy и узлы из hosts.yml', 'success'); })
                .catch((error) => notify(error.message, 'error'));
        }, 'Сбросить карту', 'danger', 'Карта сети');
}

// адрес кнопки «Репозиторий»: {host} → адрес, по которому открыт интерфейс; принимаются только http(s)
function updateRepoButton(template) {
    const button = document.getElementById('repo_btn');
    if (!button) return;
    const url = String(template || '').replace(/\{host\}/g, location.hostname);
    const valid = /^https?:\/\//i.test(url);
    button.href = valid ? url : '#';
    button.hidden = !valid;
    button.title = valid ? `Открыть HTTP-репозиторий Autodeploy: ${url}` : '';
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
                const objects = data.objects || [];
                const select = document.getElementById('object_select');
                if (select) {
                    select.innerHTML = objects.map((object) => `<option value="${esc(object)}" ${object === CURRENT_OBJECT ? 'selected' : ''}>${esc(object)}</option>`).join('');
                    select.value = CURRENT_OBJECT;
                }
                enhanceObjectSelector();
                select?.syncCustomList?.();
                // Кнопка «Объект» показывается только когда список уже заполнен,
                // иначе при медленном ответе сервера она открывалась пустой.
                if (objectBlock) objectBlock.style.display = '';
                // Если сервер заменил несуществующий объект из адреса на реальный — поправляем адрес.
                const urlObject = getObjectFromURL();
                if (urlObject && urlObject !== CURRENT_OBJECT) {
                    history.replaceState(null, '', `${location.pathname}?project=${encodeURIComponent(CURRENT_PROJECT)}&object=${encodeURIComponent(CURRENT_OBJECT)}`);
                }
            }
            if (ACTIVE_GROUP && !(data.groups || []).some((group) => group.name === ACTIVE_GROUP.name)) ACTIVE_GROUP = null;
            injectNav('main', data.projects || [], data.selected_project || '', CURRENT_OBJECT);
            updateRepoButton(data.repo_url);
            if (data.version !== APP_VERSION && !window.VERSION_WARNED) {
                window.VERSION_WARNED = true;
                notify(`Интерфейс обновлён до версии ${APP_VERSION}, а сервер работает на ${data.version ? `версии ${data.version}` : 'старой версии'}. Перезапустите web1x.py, иначе часть функций не будет работать.`, 'warning');
            }
            renderNodes();
            renderGroups(data.groups || []);
            renderAutodeploy(data.autodeploy);
            if (CURRENT_PROJECT !== SUBNET_SCAN_PROJECT) { SUBNET_SCAN_PROJECT = CURRENT_PROJECT; loadSubnetScan(); }
            renderPlaybooks(data.playbooks || []);
        }).catch((error) => {
            console.error(error);
            document.getElementById('nodes').innerHTML = '<div class="empty-state is-error"><b>Не удалось загрузить данные проекта</b><span>Проверьте, что сервер запущен, и обновите страницу.</span></div>';
        });
}

// подгружает новые строки журнала выполнения и прокручивает его вниз
function refreshLog() {
    fetch(`${API.LOG_NEW}?start=${logIndex}`)
        .then((response) => response.json())
        .then((data) => {
            const element = document.getElementById('log');
            if (data.lines.length) {
                const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
                element.textContent += (element.textContent ? '\n' : '') + data.lines.join('\n');
                logIndex = data.next;
                if (atBottom) element.scrollTop = element.scrollHeight;   // не дёргаем журнал, если его листают вверх
            }
            if (typeof data.running === 'boolean') syncRunState(data.running, data.failed);
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
// ============================================================================
// Меню дополнительных параметров (кнопка-шестерёнка справа в верхнем ряду)
// ============================================================================

// плавно открывает модальное окно (появление — анимация .modal-backdrop:not([hidden]) в CSS)
function showModalSmooth(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    clearTimeout(modal._closeTimer);
    modal.classList.remove('modal-closing');
    modal.hidden = false;
    document.body.classList.add('no-scroll');
}

// плавно закрывает модальное окно: сначала анимация .modal-closing, затем hidden
function hideModalSmooth(id) {
    const modal = document.getElementById(id);
    if (!modal || modal.hidden || modal.classList.contains('modal-closing')) return;
    modal.classList.add('modal-closing');
    modal._closeTimer = setTimeout(() => {
        modal.classList.remove('modal-closing');
        modal.hidden = true;
        if (!document.querySelector('.modal-backdrop:not([hidden])')) document.body.classList.remove('no-scroll');
    }, ANIM.MODAL_MOTION_MS);
}

// открывает/закрывает выпадающее меню дополнительных параметров
function toggleSettingsMenu(event) {
    event?.stopPropagation();
    const open = document.getElementById('settings_menu').classList.toggle('is-open');
    document.getElementById('settings_btn').setAttribute('aria-expanded', String(open));
}

// закрывает меню дополнительных параметров
function closeSettingsMenu() {
    document.getElementById('settings_menu')?.classList.remove('is-open');
    document.getElementById('settings_btn')?.setAttribute('aria-expanded', 'false');
}

// --- Тема -------------------------------------------------------------------

// подпись пункта меню — та тема, на которую переключит клик
function updateThemeLabel() {
    const label = document.getElementById('theme_toggle_label');
    if (label) label.textContent = document.documentElement.dataset.theme === 'light' ? 'Тёмная тема' : 'Светлая тема';
}

// переключает светлую/тёмную тему с плавным переходом цветов и запоминает выбор
function toggleTheme() {
    const root = document.documentElement;
    const next = root.dataset.theme === 'light' ? 'dark' : 'light';
    root.classList.add('theme-switching');            // временно включает transition цветов у всех элементов
    clearTimeout(toggleTheme._timer);
    toggleTheme._timer = setTimeout(() => root.classList.remove('theme-switching'), 450);
    if (next === 'light') root.dataset.theme = 'light'; else delete root.dataset.theme;
    try { localStorage.setItem(THEME_STORAGE_KEY, next); } catch (error) { /* браузер запретил хранилище — тема просто не запомнится */ }
    updateThemeLabel();
}

// --- Редактор констант ---------------------------------------------------------
// Значения редактируются как обычные поля: строка — текстом, число — числом с единицей,
// список — по одному значению в строке. Кавычки и скобки для constants.py расставляет сервер.
let CONSTANTS_SECTIONS = [];

// открывает окно констант и подгружает актуальные значения прямо из файла
function openConstantsModal() {
    closeSettingsMenu();
    showModalSmooth('constants_modal');
    loadConstants();
}

// закрывает окно констант
function closeConstantsModal() { hideModalSmooth('constants_modal'); }

// описание настройки по имени
function constantItem(name) {
    for (const section of CONSTANTS_SECTIONS) {
        const item = section.items.find((entry) => entry.name === name);
        if (item) return item;
    }
    return null;
}

// читает настройки с сервера и перерисовывает окно; message — текст в строке состояния
function loadConstants(message = '', type = 'info') {
    fetch(`${API.CONSTANTS}?_=${Date.now()}`)
        .then(async (response) => {
            let data = null;
            try { data = await response.json(); } catch (error) { /* не JSON — разберём по коду ответа */ }
            if (response.status === 404 || (response.ok && !data?.sections)) throw new Error('Сервер не знает запрос настроек — похоже, файлы обновили, а web1x.py не перезапустили. Перезапустите сервис.');
            if (!response.ok || !data) throw new Error(data?.error || `Сервер ответил с ошибкой ${response.status}`);
            return data;
        }, () => { throw new Error('Сервер недоступен — проверьте, что web1x.py запущен'); })
        .then((data) => { CONSTANTS_SECTIONS = data.sections || []; renderConstants(); setConstantsStatus(message, type); })
        .catch((error) => {
            // показываем настоящую причину, а не общее «не удалось»
            document.getElementById('constants_list').innerHTML = `<div class="empty-state is-error"><b>Не удалось прочитать настройки</b><span>${esc(error.message)}</span></div>`;
        });
}

// поле значения по типу настройки
function constantFieldHTML(item) {
    if (item.kind === 'list') {
        return `<div class="constant-list">${item.value.map((value) => constantListItemHTML(value)).join('')}
            <button type="button" class="constant-list-add" title="Добавить значение в список">+ Добавить</button></div>`;
    }
    if (item.kind === 'number') {
        return `<div class="constant-number"><input type="number" class="modal-input constant-input" step="1" ${item.min != null ? `min="${item.min}"` : ''} ${item.max != null ? `max="${item.max}"` : ''} value="${esc(item.value)}">${item.unit ? `<span class="constant-unit">${esc(item.unit)}</span>` : ''}</div>`;
    }
    return `<input type="text" class="modal-input constant-input" value="${esc(item.value)}" spellcheck="false">`;
}

// одна строка списка значений
function constantListItemHTML(value) {
    return `<div class="constant-list-item"><input type="text" class="modal-input constant-input" value="${esc(value)}" spellcheck="false"><button type="button" class="constant-list-remove" title="Убрать из списка" aria-label="Убрать">×</button></div>`;
}

// строит окно: разделы, понятные подписи, пояснения и поля
function renderConstants() {
    document.getElementById('constants_list').innerHTML = CONSTANTS_SECTIONS.map((section) => `
        <div class="constants-section">
            <div class="constants-section-title">${esc(section.title)}</div>
            ${section.items.map((item) => `
                <div class="constant-row" data-name="${esc(item.name)}" data-kind="${esc(item.kind)}">
                    <div class="constant-meta">
                        <div class="constant-label">${esc(item.label)}${item.restart_required ? ' <span class="constant-badge" title="Новое значение начнёт действовать после перезапуска web1x.py">после перезапуска</span>' : ''}</div>
                        ${item.hint ? `<div class="constant-desc">${esc(item.hint)}</div>` : ''}
                        <code class="constant-name" title="Имя в constants.py">${esc(item.name)}</code>
                    </div>
                    <div class="constant-value-wrap">
                        ${constantFieldHTML(item)}
                        <div class="constant-row-footer"><div class="constant-error"></div><button type="button" class="constant-revert" title="Вернуть значение из файла">↺ Вернуть</button></div>
                    </div>
                </div>`).join('')}
        </div>`).join('') || '<div class="muted">Нет настроек</div>';
    updateConstantsApplyButton();
}

// текущее значение поля в форме (строка / число / список строк)
function constantRowValue(row) {
    const inputs = [...row.querySelectorAll('.constant-input')];
    if (row.dataset.kind === 'list') return inputs.map((input) => input.value.trim()).filter(Boolean);
    if (row.dataset.kind === 'number') return inputs[0].value.trim() === '' ? '' : Number(inputs[0].value);
    return inputs[0].value.trim();
}

// проверка значения ещё до отправки на сервер; возвращает текст ошибки или ''
function constantRowError(row, item) {
    const value = constantRowValue(row);
    if (item.kind === 'list') return value.length ? '' : 'Нужно хотя бы одно значение';
    if (item.kind === 'number') {
        if (value === '' || !Number.isInteger(value)) return 'Нужно целое число';
        if ((item.min != null && value < item.min) || (item.max != null && value > item.max)) return `Допустимо от ${item.min} до ${item.max}`;
        return '';
    }
    return value ? '' : 'Поле не может быть пустым';
}

// после любой правки: подсветка изменённого поля, ошибка, кнопки «Вернуть» и «Применить»
function refreshConstantRow(row) {
    const item = constantItem(row.dataset.name);
    if (!item) return;
    const changed = JSON.stringify(constantRowValue(row)) !== JSON.stringify(item.kind === 'list' ? item.value.map((v) => String(v).trim()).filter(Boolean) : item.value);
    const error = changed ? constantRowError(row, item) : '';
    row.classList.toggle('is-changed', changed);
    row.classList.toggle('is-error', Boolean(error));
    row.querySelector('.constant-error').textContent = error;
    updateConstantsApplyButton();
}

// включает «Применить», только если есть изменения и нет ошибок в полях
function updateConstantsApplyButton() {
    const changed = document.querySelectorAll('#constants_list .constant-row.is-changed').length;
    const invalid = document.querySelectorAll('#constants_list .constant-row.is-error').length;
    document.getElementById('constants_apply_btn').disabled = !changed || invalid > 0;
    setConstantsStatus(invalid ? 'Исправьте выделенные поля' : changed ? `Изменено настроек: ${changed}` : '', invalid ? 'error' : 'info');
}

// текст в строке состояния окна констант
function setConstantsStatus(text, type = 'info') {
    const status = document.getElementById('constants_status');
    status.textContent = text;
    status.classList.toggle('is-error', type === 'error');
    status.classList.toggle('is-success', type === 'success');
}

// «Отмена»: отбрасывает несохранённые правки и закрывает окно
function cancelConstants() {
    renderConstants();
    closeConstantsModal();
}

// «Применить»: отправляет изменённые значения; при ошибках подсвечивает поля, правки не теряются
function applyConstants() {
    const changed = [...document.querySelectorAll('#constants_list .constant-row.is-changed')];
    if (!changed.length) return;
    const names = changed.map((row) => constantItem(row.dataset.name)?.label || row.dataset.name);
    confirmAction('Применить изменения настроек?', `Будет изменено в constants.py: <strong>${names.map(esc).join(', ')}</strong>.<br><br>Предыдущая версия сохранится в constants.py.bak.`, 'Применить', doApplyConstants, 'primary', 'Настройки');
}
function doApplyConstants() {
    const changes = {};
    document.querySelectorAll('#constants_list .constant-row.is-changed').forEach((row) => { changes[row.dataset.name] = constantRowValue(row); });
    if (!Object.keys(changes).length) return;
    const button = document.getElementById('constants_apply_btn');
    button.disabled = true;
    setConstantsStatus('Сохранение…');
    fetch(API.CONSTANTS, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ changes }) })
        .then((response) => response.json().then((data) => ({ ok: response.ok && data.ok !== false, data })))
        .then(({ ok, data }) => {
            if (ok) {
                const restart = (data.restart_required || []).map((name) => constantItem(name)?.label || name);
                notify(restart.length ? `Настройки сохранены. После перезапуска сервера начнут действовать: ${restart.join(', ')}` : 'Настройки сохранены и уже действуют', 'success');
                return loadConstants('Сохранено', 'success');
            }
            Object.entries(data.errors || {}).forEach(([name, message]) => {
                const row = document.querySelector(`#constants_list .constant-row[data-name="${CSS.escape(name)}"]`);
                if (!row) return;
                row.classList.add('is-error');
                row.querySelector('.constant-error').textContent = message;
            });
            button.disabled = false;
            setConstantsStatus(data.error || 'Ошибка сохранения', 'error');
        })
        .catch(() => { button.disabled = false; setConstantsStatus('Сервер недоступен', 'error'); });
}

// правки в полях, «+ Добавить», «×», «↺ Вернуть» — одним обработчиком на всё окно
(function initConstantsEditor() {
    const list = document.getElementById('constants_list');
    list.addEventListener('input', (event) => { const row = event.target.closest('.constant-row'); if (row) refreshConstantRow(row); });
    list.addEventListener('click', (event) => {
        const row = event.target.closest('.constant-row');
        if (!row) return;
        if (event.target.closest('.constant-list-add')) {
            event.target.closest('.constant-list-add').insertAdjacentHTML('beforebegin', constantListItemHTML(''));
            row.querySelector('.constant-list-item:last-of-type .constant-input')?.focus();
        } else if (event.target.closest('.constant-list-remove')) {
            event.target.closest('.constant-list-item').remove();
        } else if (event.target.closest('.constant-revert')) {
            const item = constantItem(row.dataset.name);
            row.querySelector('.constant-value-wrap').firstElementChild.outerHTML = constantFieldHTML(item);
        } else {
            return;
        }
        refreshConstantRow(row);
    });
    // Enter в поле — как «Применить» (если есть что применять)
    list.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && event.target.classList.contains('constant-input')) {
            event.preventDefault();
            if (!document.getElementById('constants_apply_btn').disabled) applyConstants();
        }
    });
})();

// --- Карта сети ---------------------------------------------------------------
// Типы устройств: подпись, назначение и простой линейный SVG-значок (цвет — currentColor, задаётся в CSS по типу).
// selfOnly — тип только для узла этой машины (в списке выбора не показывается).
const NETMAP_TYPES = {
    pc:            { label: 'Компьютер',           description: 'Рабочая станция',
                     icon: '<rect x="6" y="8" width="36" height="24" rx="2"/><path d="M18 40h12M24 32v8"/>' },
    server:        { label: 'Сервер',              description: 'Сервер',
                     icon: '<rect x="10" y="6" width="28" height="10" rx="2"/><rect x="10" y="19" width="28" height="10" rx="2"/><rect x="10" y="32" width="28" height="10" rx="2"/><path d="M15 11h2M15 24h2M15 37h2M24 11h9M24 24h9M24 37h9"/>' },
    router:        { label: 'Маршрутизатор',       description: 'Маршрутизатор (МД) — связь между сетями',
                     icon: '<rect x="6" y="22" width="36" height="14" rx="3"/><path d="M14 22l-4-12M34 22l4-12M12 29h2M18 29h2M28 29h8"/>' },
    switch:        { label: 'Коммутатор',          description: 'Соединяет устройства одной сети',
                     icon: '<rect x="4" y="16" width="40" height="16" rx="2"/><path d="M9 22h4v5H9zM16 22h4v5h-4zM23 22h4v5h-4zM30 22h4v5h-4zM38 24h1"/>' },
    ups:           { label: 'ИБП (UPS)',           description: 'Источник бесперебойного питания',
                     icon: '<rect x="10" y="6" width="28" height="36" rx="3"/><path d="M26 13l-6 11h7l-5 11"/>' },
    supervisor:    { label: 'Супервизор',          description: 'Управление датчиками: контроль входа, протечка воды и т.п.',
                     icon: '<rect x="8" y="6" width="32" height="36" rx="2"/><path d="M8 18h32M13 12h2M21 12h14M13 30s4.5-6 11-6 11 6 11 6-4.5 6-11 6-11-6-11-6z"/><circle cx="24" cy="30" r="2.5"/>' },
    crypto_router: { label: 'Криптомаршрутизатор', description: 'Маршрутизатор с шифрованием каналов связи',
                     icon: '<rect x="6" y="26" width="36" height="14" rx="3"/><rect x="18" y="11" width="12" height="9" rx="1.5"/><path d="M20.5 11V8a3.5 3.5 0 0 1 7 0v3M12 33h2M18 33h2M28 33h8"/>' },
    netping:       { label: 'NetPing',             description: 'Экстренное отключение питания подключённых устройств',
                     icon: '<rect x="8" y="14" width="32" height="28" rx="3"/><path d="M20 14v-4h8v4M28.6 23.4a6.5 6.5 0 1 1-9.2 0M24 20.5v7"/>' },
    autodeploy:    { label: 'Autodeploy',          description: 'Эта машина: запускает плейбуки, на ней работает это приложение', selfOnly: true,
                     icon: '<rect x="6" y="7" width="36" height="28" rx="3"/><path d="M20 15.5l10 5.5-10 5.5zM18 41h12M24 35v6"/>' },
};
// Заголовок списка соединений в «Сведениях» — по смыслу устройства
const NETMAP_LINK_TITLES = { netping: 'Отключает питание устройств', supervisor: 'Подключённые датчики и устройства', ups: 'Питает устройства', autodeploy: 'Управляет устройствами' };
// Сетка привязки: центр значка «прилипает» к точке сетки с шагом 20px (точки видны на холсте)
const NETMAP_SNAP = 20;
const NETMAP_CENTER = { x: 60, y: 40 };   // центр значка относительно левого верхнего угла карточки устройства
const NETMAP_GRID = { left: 40, top: 40, stepX: 160, stepY: 140, columns: 7 };
const NETMAP_STAGE = 6000;                // размер холста (сервер принимает координаты 0…6000)
const NETMAP_ZOOM = { min: 0.25, max: 2.5, step: 1.2 };
let NETMAP = { nodes: [], links: [], status: {}, saveTimer: null, statusTimer: null, openId: null, anchor: null, linkFrom: null,
               view: { tx: 0, ty: 0, z: 1 }, suppressClick: false };
let NETMAP_PICKER = null;

// SVG-значок устройства заданного типа
function netmapIcon(type) {
    return `<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${(NETMAP_TYPES[type] || NETMAP_TYPES.pc).icon}</svg>`;
}

// округление координаты до ближайшей точки сетки (в пределах холста)
function netmapSnap(value) { return Math.min(NETMAP_STAGE - 140, Math.max(0, Math.round(value / NETMAP_SNAP) * NETMAP_SNAP)); }

// центр значка устройства — сюда крепятся линии соединений
function netmapCenter(node) { return { x: node.x + NETMAP_CENTER.x, y: node.y + NETMAP_CENTER.y }; }

// устройство по id
function netmapNode(id) { return NETMAP.nodes.find((node) => node.id === id); }

// устройства, соединённые с данным
function netmapPeers(node) {
    return NETMAP.links.filter((link) => link.a === node.id || link.b === node.id)
        .map((link) => netmapNode(link.a === node.id ? link.b : link.a)).filter(Boolean);
}

// --- Масштаб и перемещение холста ---

// экранные координаты (внутри окна карты) → координаты холста
function netmapToStage(clientX, clientY) {
    const rect = document.getElementById('netmap_canvas').getBoundingClientRect(), { tx, ty, z } = NETMAP.view;
    return { x: (clientX - rect.left - tx) / z, y: (clientY - rect.top - ty) / z };
}

// координаты холста → координаты внутри окна карты (для карточек поверх холста)
function netmapToScreen(x, y) {
    const { tx, ty, z } = NETMAP.view;
    return { x: tx + x * z, y: ty + y * z };
}

// применяет сдвиг/масштаб; холст нельзя «утащить» за его края
function applyNetmapView() {
    const canvas = document.getElementById('netmap_canvas'), view = NETMAP.view;
    view.tx = Math.min(0, Math.max(canvas.clientWidth - NETMAP_STAGE * view.z, view.tx));
    view.ty = Math.min(0, Math.max(canvas.clientHeight - NETMAP_STAGE * view.z, view.ty));
    document.getElementById('netmap_stage').style.transform = `translate(${view.tx}px, ${view.ty}px) scale(${view.z})`;
    document.getElementById('netmap_zoom_label').textContent = `${Math.round(view.z * 100)}%`;
    positionNetmapPopover();
}

// масштабирует относительно точки (по умолчанию — центр окна), сохраняя её на месте
function zoomNetmap(factor, clientX, clientY) {
    const canvas = document.getElementById('netmap_canvas'), rect = canvas.getBoundingClientRect(), view = NETMAP.view;
    const z = Math.min(NETMAP_ZOOM.max, Math.max(NETMAP_ZOOM.min, view.z * factor));
    const px = (clientX ?? rect.left + rect.width / 2) - rect.left, py = (clientY ?? rect.top + rect.height / 2) - rect.top;
    view.tx = px - (px - view.tx) * (z / view.z);
    view.ty = py - (py - view.ty) * (z / view.z);
    view.z = z;
    applyNetmapView();
}

// подбирает масштаб и сдвиг так, чтобы были видны все устройства
function fitNetmap() {
    const canvas = document.getElementById('netmap_canvas'), view = NETMAP.view;
    if (!NETMAP.nodes.length) { view.tx = 0; view.ty = 0; view.z = 1; return applyNetmapView(); }
    const minX = Math.min(...NETMAP.nodes.map((n) => n.x)) - 40, minY = Math.min(...NETMAP.nodes.map((n) => n.y)) - 40;
    const maxX = Math.max(...NETMAP.nodes.map((n) => n.x)) + 160, maxY = Math.max(...NETMAP.nodes.map((n) => n.y)) + 150;
    view.z = Math.min(1.5, Math.max(NETMAP_ZOOM.min, Math.min(canvas.clientWidth / (maxX - minX), canvas.clientHeight / (maxY - minY))));
    view.tx = (canvas.clientWidth - (maxX - minX) * view.z) / 2 - minX * view.z;
    view.ty = (canvas.clientHeight - (maxY - minY) * view.z) / 2 - minY * view.z;
    applyNetmapView();
}

// --- Открытие, загрузка, сохранение ---

// открывает карту сети текущего проекта/объекта
function openNetmapModal() {
    closeSettingsMenu();
    document.getElementById('netmap_context').textContent = CURRENT_OBJECT ? `${CURRENT_PROJECT} · ${CURRENT_OBJECT}` : CURRENT_PROJECT;
    mountNetmapTypePicker(document.getElementById('netmap_add_type'), 'switch', onNetmapAddTypeChange);
    toggleNetmapAddForm(false);
    toggleNetmapLinkTool(false);
    setNetmapStatus('');
    NETMAP.view = { tx: 0, ty: 0, z: 1 };
    NETMAP.status = {};
    showModalSmooth('netmap_modal');
    applyNetmapView();
    loadNetmap();
    clearInterval(NETMAP.statusTimer);
    NETMAP.statusTimer = setInterval(loadNetmapStatus, STATUS_POLL_INTERVAL_MS);
}

// закрывает карту сети (несохранённое сохраняется сразу)
function closeNetmapModal() {
    if (NETMAP.saveTimer) { clearTimeout(NETMAP.saveTimer); saveNetmap(); }
    clearInterval(NETMAP.statusTimer);
    NETMAP.statusTimer = null;
    toggleNetmapLinkTool(false);
    closeNetmapPopover();
    closeNetmapTypeList();
    hideModalSmooth('netmap_modal');
}

// параметры проекта/объекта для запросов карты
function netmapQuery() {
    return `project=${encodeURIComponent(CURRENT_PROJECT)}${CURRENT_OBJECT ? `&object=${encodeURIComponent(CURRENT_OBJECT)}` : ''}&_=${Date.now()}`;
}

// загружает устройства и соединения; устройствам без сохранённого места назначает позицию по сетке
function loadNetmap() {
    const stage = document.getElementById('netmap_stage');
    stage.innerHTML = '<div class="muted netmap-loading">Загрузка…</div>';
    fetch(`${API.NETMAP}?${netmapQuery()}`)
        .then((response) => response.json())
        .then((data) => {
            NETMAP.nodes = data.nodes || [];
            NETMAP.links = data.links || [];
            let free = 0;
            NETMAP.nodes.forEach((node) => {
                if (Number.isFinite(node.x) && Number.isFinite(node.y)) { node.x = netmapSnap(node.x); node.y = netmapSnap(node.y); return; }
                node.x = NETMAP_GRID.left + (free % NETMAP_GRID.columns) * NETMAP_GRID.stepX;
                node.y = NETMAP_GRID.top + Math.floor(free / NETMAP_GRID.columns) * NETMAP_GRID.stepY;
                free += 1;
            });
            renderNetmap();
            loadNetmapStatus();
        })
        .catch(() => { stage.innerHTML = '<div class="muted netmap-loading">Не удалось загрузить карту</div>'; });
}

// запрашивает доступность устройств и перекрашивает линии соединений
function loadNetmapStatus() {
    fetch(`${API.NETMAP_STATUS}?${netmapQuery()}`)
        .then((response) => response.json())
        .then((data) => { NETMAP.status = data.status || {}; renderNetmapLinks(); })
        .catch(() => {});
}

// разметка одного устройства на карте
function netmapNodeHTML(node) {
    const classes = ['netmap-node', `type-${node.type}`, node.custom ? 'is-custom' : '', node.self ? 'is-self' : '', NETMAP.linkFrom === node.id ? 'is-link-source' : ''].filter(Boolean).join(' ');
    return `<div class="${esc(classes)}" data-id="${esc(node.id)}" style="left:${node.x}px;top:${node.y}px" title="${esc(node.name)}${node.ip ? ` — ${esc(node.ip)}` : ''}">
        <div class="netmap-icon">${netmapIcon(node.type)}</div>
        <div class="netmap-name">${esc(node.name || '—')}</div>
        <div class="netmap-ip">${esc(node.ip || 'без IP')}</div>
    </div>`;
}

// перерисовывает слой соединений и все устройства
function renderNetmap() {
    const stage = document.getElementById('netmap_stage');
    if (!NETMAP.nodes.length) {
        stage.innerHTML = '<div class="muted netmap-loading">На карте нет устройств</div>';
        return;
    }
    stage.innerHTML = `<svg class="netmap-links" id="netmap_links"></svg>${NETMAP.nodes.map(netmapNodeHTML).join('')}`;
    renderNetmapLinks();
}

// цвет соединения по пингу: красный — если не отвечает хотя бы один конец, зелёный — если отвечает
// хотя бы один (у второго может не быть IP, например у коммутатора), иначе — нейтральный
function netmapLinkState(link) {
    const a = NETMAP.status[link.a], b = NETMAP.status[link.b];
    if (a === false || b === false) return 'is-down';
    if (a === true || b === true) return 'is-up';
    return '';
}

// рисует линии соединений (под устройствами); широкая прозрачная линия — чтобы по ней было легко попасть мышью
function renderNetmapLinks() {
    const svg = document.getElementById('netmap_links');
    if (!svg) return;
    svg.innerHTML = NETMAP.links.map((link, index) => {
        const a = netmapNode(link.a), b = netmapNode(link.b);
        if (!a || !b) return '';
        const p = netmapCenter(a), q = netmapCenter(b);
        // подпись VLAN — посередине линии, только если VLAN известен
        const caption = [link.port, link.vlan ? `VLAN ${link.vlan}` : ''].filter(Boolean).join(' · ');
        const label = caption ? `<text class="netmap-link-label" x="${(p.x + q.x) / 2}" y="${(p.y + q.y) / 2}" dy="-6" text-anchor="middle">${esc(caption)}</text>` : '';
        return `<g class="netmap-link ${netmapLinkState(link)}" data-index="${index}"><line class="netmap-link-line" x1="${p.x}" y1="${p.y}" x2="${q.x}" y2="${q.y}"/><line class="netmap-link-hit" x1="${p.x}" y1="${p.y}" x2="${q.x}" y2="${q.y}"><title>${esc(a.name)} — ${esc(b.name)}${caption ? ` (${esc(caption)})` : ''}</title></line>${label}</g>`;
    }).join('') + '<line class="netmap-link-preview" id="netmap_link_preview" x1="0" y1="0" x2="0" y2="0"/>';
}

// строка состояния карты («Сохранение…», «Сохранено»)
function setNetmapStatus(text, isError = false) {
    const status = document.getElementById('netmap_status');
    status.textContent = text;
    status.classList.toggle('is-error', isError);
    status.classList.toggle('is-visible', Boolean(text));
}

// подсказка в панели инструментов; без текста — возвращается стандартная
function setNetmapHint(text) {
    const hint = document.getElementById('netmap_hint');
    hint.textContent = text || '';
    hint.classList.toggle('is-accent', Boolean(text));
}

// откладывает сохранение: несколько быстрых правок уходят одним запросом
function scheduleNetmapSave() {
    setNetmapStatus('Сохранение…');
    clearTimeout(NETMAP.saveTimer);
    NETMAP.saveTimer = setTimeout(saveNetmap, 400);
}

// сохраняет значки, расположение и соединения на сервере
function saveNetmap() {
    NETMAP.saveTimer = null;
    const items = NETMAP.nodes.map(({ id, name, ip, mac, type, x, y }) => ({ id, name, ip, mac, type, x, y }));
    api(API.NETMAP, { project: CURRENT_PROJECT, object: CURRENT_OBJECT, items, links: NETMAP.links })
        .then(() => setNetmapStatus('Сохранено'))
        .catch((error) => setNetmapStatus(`Не сохранено: ${error.message}`, true));
}

// --- Список выбора оборудования (в общем стиле выпадающих списков) ---

// кнопка выбора типа устройства: значок + название + стрелка
function mountNetmapTypePicker(container, value, onChange) {
    const info = NETMAP_TYPES[value] || NETMAP_TYPES.pc;
    container.innerHTML = `<button type="button" class="netmap-picker-btn" data-value="${esc(value)}"><span class="netmap-picker-icon type-${esc(value)}">${netmapIcon(value)}</span><span class="netmap-picker-label">${esc(info.label)}</span><span class="netmap-picker-arrow">▾</span></button>`;
    const button = container.querySelector('button');
    button.addEventListener('click', (event) => { event.stopPropagation(); toggleNetmapTypeList(button, onChange); });
}

// открывает плавающий список типов под кнопкой (или над ней, если внизу мало места)
function toggleNetmapTypeList(button, onChange) {
    let list = document.getElementById('netmap_type_list');
    if (!list) {
        list = document.createElement('div');
        list.id = 'netmap_type_list';
        list.className = 'netmap-type-list';
        list.setAttribute('role', 'listbox');
        document.body.appendChild(list);
        ['click', 'pointerdown', 'wheel'].forEach((name) => list.addEventListener(name, (event) => event.stopPropagation()));
    }
    if (list.classList.contains('is-open') && NETMAP_PICKER?.button === button) return closeNetmapTypeList();
    closeNetmapTypeList();
    NETMAP_PICKER = { button, onChange };
    const current = button.dataset.value;
    list.innerHTML = Object.entries(NETMAP_TYPES).filter(([, info]) => !info.selfOnly).map(([type, info]) => `
        <button type="button" class="netmap-type-option${type === current ? ' active' : ''}" data-type="${type}">
            <span class="netmap-picker-icon type-${type}">${netmapIcon(type)}</span>
            <span class="netmap-type-option-text"><span class="netmap-type-option-label">${esc(info.label)}</span><span class="netmap-type-option-desc">${esc(info.description)}</span></span>
        </button>`).join('');
    list.querySelectorAll('.netmap-type-option').forEach((option) => option.addEventListener('click', () => {
        const type = option.dataset.type;
        const picker = NETMAP_PICKER;
        mountNetmapTypePicker(picker.button.parentElement, type, picker.onChange);
        closeNetmapTypeList();
        picker.onChange(type);
    }));
    const rect = button.getBoundingClientRect();
    const height = Math.min(380, list.scrollHeight + 10);
    list.style.left = `${rect.left}px`;
    list.style.minWidth = `${Math.max(rect.width, 320)}px`;
    list.style.top = rect.bottom + 6 + height > window.innerHeight ? `${Math.max(8, rect.top - 6 - height)}px` : `${rect.bottom + 6}px`;
    list.classList.add('is-open');
    button.classList.add('is-open');
}

// закрывает список типов
function closeNetmapTypeList() {
    document.getElementById('netmap_type_list')?.classList.remove('is-open');
    NETMAP_PICKER?.button?.classList.remove('is-open');
    NETMAP_PICKER = null;
}

// --- Автопостроение сети по числу хопов ---
// Сервер трассирует маршрут (traceroute/tracepath) до каждого устройства с IP; по маршрутам строятся
// соединения Autodeploy → маршрутизаторы → устройство, а раскладка — по числу хопов: Autodeploy слева,
// каждый следующий хоп — следующий столбец. Результат — обычная схема, её можно править дальше.
const NETMAP_AUTOBUILD_STEP = { x: 240, y: 140 };

// окно автопостроения: выбор источника устройств (карта / найденные прослушкой) и подтверждение
function autobuildNetmap() {
    fetch(`${API.DISCOVERED_SUMMARY}?_=${Date.now()}`)
        .then((response) => response.json())
        .catch(() => ({ total: 0, with_ip: 0, on_switch: 0 }))
        .then((found) => {
            const onMap = NETMAP.nodes.filter((node) => !node.self && node.ip).length;
            const foundText = found.total
                ? `${found.total} устройств${found.with_ip ? `, с IP: ${found.with_ip}` : ''}${found.on_switch ? `, в таблице коммутатора: ${found.on_switch}` : ''}${found.last_seen ? ` · последнее — ${esc(found.last_seen)}` : ''}`
                : 'пока ничего — включите режим прослушки и дайте ему поработать';
            const source = found.total ? 'discovered' : 'hosts';
            showConfirmation('Автопостроение сети', `
                <div class="autobuild-sources" role="radiogroup">
                    <label class="autobuild-source${source === 'discovered' ? ' is-checked' : ''}${found.total ? '' : ' is-disabled'}"><input type="radio" name="autobuild_source" value="discovered" ${source === 'discovered' ? 'checked' : ''} ${found.total ? '' : 'disabled'}>
                        <span><b>Устройства, найденные прослушкой</b><small>${foundText}</small></span></label>
                    <label class="autobuild-source${source === 'hosts' ? ' is-checked' : ''}${onMap ? '' : ' is-disabled'}"><input type="radio" name="autobuild_source" value="hosts" ${source === 'hosts' ? 'checked' : ''} ${onMap ? '' : 'disabled'}>
                        <span><b>Устройства на карте (из hosts.yml и добавленные)</b><small>${onMap ? `с IP: ${onMap}` : 'на карте нет устройств с IP'}</small></span></label>
                </div>
                Сервер проследит маршрут до каждого устройства (traceroute) и построит схему по числу хопов: Autodeploy слева, дальше — по удалённости. Найденные прослушкой устройства, которых нет на карте, будут добавлены; устройства из таблицы коммутатора подключаются к коммутатору с подписью порта и VLAN.<br><br>
                <strong>Текущие соединения будут заменены, устройства — переставлены.</strong> Схему потом можно править как обычно.
                ${found.total ? '<div class="autobuild-clear"><button type="button" class="autobuild-clear-btn" onclick="clearDiscoveredDevices(this)">Очистить список найденных устройств</button></div>' : ''}`,
                () => {
                    const chosen = document.querySelector('input[name="autobuild_source"]:checked')?.value;
                    if (!chosen) return notify('Нет устройств для автопостроения: включите прослушку или добавьте устройства с IP', 'warning');
                    startNetmapAutobuild(chosen);
                }, 'Построить', 'primary', 'Карта сети');
        });
}

// забывает найденное прослушкой (например, после переезда оборудования) — прямо из окна автопостроения
function clearDiscoveredDevices(button) {
    confirmAction('Очистить список найденных устройств?', 'Все устройства, найденные прослушкой и в таблице коммутатора, будут забыты. Чтобы построить карту по ним снова, прослушку придётся запустить заново.',
        'Очистить', () => doClearDiscoveredDevices(button));
}
function doClearDiscoveredDevices(button) {
    button.disabled = true;
    api(API.DISCOVERED_CLEAR, {})
        .then(() => {
            notify('Список найденных устройств очищен', 'success');
            const option = document.querySelector('input[name="autobuild_source"][value="discovered"]');
            if (option) {
                option.disabled = true;
                option.closest('.autobuild-source').querySelector('small').textContent = 'пока ничего — включите режим прослушки и дайте ему поработать';
                const hosts = document.querySelector('input[name="autobuild_source"][value="hosts"]');
                if (option.checked) { option.checked = false; if (hosts && !hosts.disabled) hosts.checked = true; }
            }
            button.closest('.autobuild-clear')?.remove();
        })
        .catch((error) => { button.disabled = false; notify(error.message, 'error'); });
}

// запускает трассировку на сервере и ждёт результата; source — 'hosts' | 'discovered'
function startNetmapAutobuild(source = 'hosts') {
    const button = document.getElementById('netmap_autobuild_btn');
    button.disabled = true;
    button.classList.add('is-busy');
    setNetmapHint('Идёт трассировка маршрутов — это может занять до пары минут…');
    api(API.NETMAP_AUTOBUILD, { project: CURRENT_PROJECT, object: CURRENT_OBJECT, source })
        .then(pollNetmapAutobuild)
        .catch((error) => finishNetmapAutobuild(error.message));
}

// опрашивает ход автопостроения раз в секунду
function pollNetmapAutobuild() {
    fetch(`${API.NETMAP_AUTOBUILD}?${netmapQuery()}`)
        .then((response) => response.json())
        .then((state) => {
            if (state.running) return setTimeout(pollNetmapAutobuild, 1000);
            if (state.error) return finishNetmapAutobuild(state.error);
            applyNetmapAutobuild(state.result || { paths: {} });
            finishNetmapAutobuild();
        })
        .catch(() => finishNetmapAutobuild('Сервер недоступен'));
}

// возвращает кнопку в обычное состояние; error — текст ошибки для уведомления
function finishNetmapAutobuild(error) {
    const button = document.getElementById('netmap_autobuild_btn');
    button.disabled = false;
    button.classList.remove('is-busy');
    setNetmapHint('');
    if (error) notify(error, 'error');
}

// строит соединения и раскладку по маршрутам (и таблице коммутатора), затем сохраняет — как обычную правку схемы
function applyNetmapAutobuild(result) {
    const self = NETMAP.nodes.find((node) => node.self);
    if (!self) return;
    closeNetmapPopover();
    toggleNetmapLinkTool(false);
    const newId = () => `custom:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const byIp = new Map(NETMAP.nodes.filter((node) => node.ip).map((node) => [node.ip, node]));
    const byMac = new Map(NETMAP.nodes.filter((node) => node.mac).map((node) => [node.mac, node]));
    const links = new Map(), level = new Map([[self.id, 0]]), parent = new Map();
    const unreachable = [];
    let addedGateways = 0, addedDevices = 0;
    const addNode = (fields) => {
        const node = { id: newId(), x: 0, y: 0, custom: true, ...fields };
        NETMAP.nodes.push(node);
        if (node.ip) byIp.set(node.ip, node);
        if (node.mac) byMac.set(node.mac, node);
        return node;
    };
    const autoAdded = new Set();   // устройства, добавленные этим автопостроением
    const routerFor = (ip) => {
        if (byIp.has(ip)) {
            const node = byIp.get(ip);
            // найденное прослушкой «Устройство» оказалось промежуточным хопом — значит, это шлюз
            if (autoAdded.has(node.id) && node.type === 'pc') { node.type = 'router'; node.name = 'Шлюз'; }
            return node;
        }
        addedGateways += 1;
        return addNode({ name: 'Шлюз', ip, type: 'router' });
    };
    const vlans = result.vlans || {};
    // соединение a → b (b — дальше от Autodeploy); подпись: порт коммутатора и/или VLAN, если известны
    const connect = (a, b, depth, label = {}) => {
        if (a.id === b.id) return;
        const link = { a: a.id, b: b.id };
        const vlan = label.vlan || vlans[b.ip];
        if (vlan) link.vlan = vlan;
        if (label.port) link.port = label.port;
        links.set([a.id, b.id].sort().join('|'), link);
        if (!level.has(b.id) || depth < level.get(b.id)) { level.set(b.id, depth); parent.set(b.id, a.id); }
    };

    // кто есть кто: ключ результата трассировки → устройство на карте
    const nodeFor = new Map();
    const l2 = new Map();   // устройство → {switch, port, vlan} из таблицы коммутатора
    if (result.mode === 'discovered') {
        (result.switches || []).forEach((ip) => nodeFor.set(`switch:${ip}`, byIp.get(ip) || addNode({ name: 'Коммутатор', ip, type: 'switch' })));
        (result.devices || []).forEach((device) => {
            let node = (device.ip && byIp.get(device.ip)) || byMac.get(device.mac);
            if (!node) { node = addNode({ name: 'Устройство', ip: device.ip || '', mac: device.mac, type: 'pc' }); autoAdded.add(node.id); addedDevices += 1; }
            else if (node.custom && !node.mac) node.mac = device.mac;
            nodeFor.set(`disc:${device.mac}`, node);
            if (device.switch && device.port) l2.set(node.id, { switch: device.switch, port: device.port, vlan: device.vlan });
        });
    }
    const targetOf = (key) => nodeFor.get(key) || netmapNode(key);

    // 1) маршруты (L3): сначала коммутаторы — к ним потом подключаются устройства из их таблицы
    const keys = Object.keys(result.paths || {}).sort((a, b) => Number(b.startsWith('switch:')) - Number(a.startsWith('switch:')));
    keys.forEach((key) => {
        const target = targetOf(key), path = result.paths[key];
        if (!target || l2.has(target.id)) return;   // устройство из таблицы коммутатора — подключим к коммутатору ниже
        if (!path.reached) {
            if (key.startsWith('switch:')) connect(self, target, 1);   // к коммутатору подключались по SSH — значит, он доступен
            else unreachable.push(target);
            return;
        }
        let previous = self, depth = 0;
        (path.hops || []).filter((ip) => ip && ip !== self.ip && ip !== target.ip).forEach((ip) => {
            const hop = routerFor(ip);
            depth += 1;
            connect(previous, hop, depth);
            previous = hop;
        });
        connect(previous, target, depth + 1);
    });
    // 2) таблица коммутатора (L2): устройство — к своему порту коммутатора
    l2.forEach((info, nodeId) => {
        const node = netmapNode(nodeId), sw = nodeFor.get(`switch:${info.switch}`) || byIp.get(info.switch);
        if (!node || !sw) return;
        if (!level.has(sw.id)) connect(self, sw, 1);
        connect(sw, node, level.get(sw.id) + 1, { port: info.port, vlan: info.vlan });
    });
    // 3) порт коммутатора, к которому подключён сам Autodeploy, — подписью на соединении Autodeploy ↔ коммутатор
    (result.self_ports || []).forEach((info) => {
        const sw = nodeFor.get(`switch:${info.switch}`);
        const link = sw && links.get([self.id, sw.id].sort().join('|'));
        if (!link) return;
        if (info.port) link.port = info.port;
        if (info.vlan) link.vlan = info.vlan;
    });
    NETMAP.links = [...links.values()];

    // Раскладка «деревом»: столбец — число хопов, строки — по порядку ветвей (родитель — по центру своих потомков)
    const children = new Map();
    parent.forEach((parentId, childId) => { if (!children.has(parentId)) children.set(parentId, []); children.get(parentId).push(childId); });
    const sortKey = (id) => { const node = netmapNode(id); return `${node.type === 'switch' || node.type === 'router' ? 0 : 1}${(node.ip || '').split('.').map((part) => part.padStart(3, '0')).join('.')}${node.name}`; };
    children.forEach((list) => list.sort((a, b) => sortKey(a).localeCompare(sortKey(b))));
    let row = 0;
    const place = (id) => {
        const node = netmapNode(id), kids = children.get(id) || [];
        node.x = netmapSnap(NETMAP_GRID.left + level.get(id) * NETMAP_AUTOBUILD_STEP.x);
        if (!kids.length) { node.y = netmapSnap(NETMAP_GRID.top + row * NETMAP_AUTOBUILD_STEP.y); row += 1; return node.y; }
        const ys = kids.map(place);
        node.y = netmapSnap((Math.min(...ys) + Math.max(...ys)) / 2);
        return node.y;
    };
    place(self.id);
    // устройства, до которых маршрут не построился, и устройства без IP — отдельными столбцами справа
    const rest = NETMAP.nodes.filter((node) => !level.has(node.id));
    const restX = NETMAP_GRID.left + (Math.max(...level.values()) + 1) * NETMAP_AUTOBUILD_STEP.x + 80;
    rest.forEach((node, index) => {
        node.x = netmapSnap(restX + Math.floor(index / 8) * 160);
        node.y = netmapSnap(NETMAP_GRID.top + (index % 8) * NETMAP_AUTOBUILD_STEP.y);
    });

    renderNetmap();
    fitNetmap();
    scheduleNetmapSave();
    loadNetmapStatus();
    const parts = [`соединений: ${NETMAP.links.length}`];
    const withVlan = NETMAP.links.filter((link) => link.vlan).length;
    if (withVlan) parts.push(`с VLAN: ${withVlan}`);
    if (addedDevices) parts.push(`добавлено устройств: ${addedDevices}`);
    if (addedGateways) parts.push(`добавлено шлюзов: ${addedGateways}`);
    notify(`Схема построена — ${parts.join(', ')}. Её можно править как обычно.`, 'success');
    if (unreachable.length) notify(`Маршрут не построен до: ${unreachable.slice(0, 8).map((node) => node.ip || node.name).join(', ')}${unreachable.length > 8 ? ` и ещё ${unreachable.length - 8}` : ''} — они справа, без соединений`, 'warning');
}

// --- Добавление устройства ---

// показывает/прячет форму добавления устройства, которого нет в hosts.yml
function toggleNetmapAddForm(force) {
    const form = document.getElementById('netmap_add_form');
    const open = typeof force === 'boolean' ? force : !form.classList.contains('is-open');
    form.classList.toggle('is-open', open);
    if (!open) return closeNetmapTypeList();
    const nameInput = document.getElementById('netmap_add_name');
    mountNetmapTypePicker(document.getElementById('netmap_add_type'), 'switch', onNetmapAddTypeChange);
    nameInput.dataset.auto = '1';
    nameInput.oninput = () => { nameInput.dataset.auto = '0'; };
    onNetmapAddTypeChange('switch');
    document.getElementById('netmap_add_ip').value = '';
    setTimeout(() => nameInput.select(), 50);
}

// пока название не меняли вручную — подставляет «<Тип> N» под выбранный тип
function onNetmapAddTypeChange(type) {
    const nameInput = document.getElementById('netmap_add_name');
    if (nameInput.dataset.auto === '0') return;
    const count = NETMAP.nodes.filter((node) => node.custom && node.type === type).length;
    nameInput.value = `${NETMAP_TYPES[type].label.replace(/\s*\(.*\)/, '')} ${count + 1}`;
}

// первая свободная клетка сетки в видимой части карты — новое устройство не ложится поверх существующего
function findFreeNetmapSpot() {
    const topLeft = netmapToStage(document.getElementById('netmap_canvas').getBoundingClientRect().left, document.getElementById('netmap_canvas').getBoundingClientRect().top);
    const startRow = Math.max(0, Math.ceil((topLeft.y - NETMAP_GRID.top) / NETMAP_GRID.stepY));
    const startCol = Math.max(0, Math.ceil((topLeft.x - NETMAP_GRID.left) / NETMAP_GRID.stepX));
    for (let row = startRow; row < startRow + 200; row += 1) {
        for (let col = startCol; col < startCol + NETMAP_GRID.columns; col += 1) {
            const x = NETMAP_GRID.left + col * NETMAP_GRID.stepX, y = NETMAP_GRID.top + row * NETMAP_GRID.stepY;
            if (!NETMAP.nodes.some((node) => Math.abs(node.x - x) < 130 && Math.abs(node.y - y) < 120)) return { x, y };
        }
    }
    return { x: NETMAP_GRID.left, y: NETMAP_GRID.top };
}

// добавляет устройство в свободное место видимой части карты
function addNetmapNode() {
    const name = document.getElementById('netmap_add_name').value.trim();
    if (!name) return document.getElementById('netmap_add_name').focus();
    const spot = findFreeNetmapSpot();
    NETMAP.nodes.push({
        id: `custom:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        name, ip: document.getElementById('netmap_add_ip').value.trim(),
        type: document.querySelector('#netmap_add_type .netmap-picker-btn')?.dataset.value || 'switch',
        x: spot.x, y: spot.y, custom: true,
    });
    toggleNetmapAddForm(false);
    renderNetmap();
    scheduleNetmapSave();
    loadNetmapStatus();
}

// --- Карточки поверх холста: устройство («Сведения» / «Изменить») и соединение ---
// Карточки лежат в окне карты, а не на холсте, — поэтому не уменьшаются вместе с масштабом.

// ставит открытую карточку под точкой привязки (или над ней, если внизу не хватает места)
function positionNetmapPopover() {
    const popover = document.getElementById('netmap_popover');
    if (!popover || !NETMAP.anchor) return;
    const canvas = document.getElementById('netmap_canvas');
    const below = netmapToScreen(NETMAP.anchor.x, NETMAP.anchor.bottom), above = netmapToScreen(NETMAP.anchor.x, NETMAP.anchor.top);
    const width = popover.offsetWidth, height = popover.offsetHeight;
    popover.style.left = `${Math.max(8, Math.min(below.x - width / 2, canvas.clientWidth - width - 8))}px`;
    const fitsBelow = below.y + 8 + height <= canvas.clientHeight - 8;
    popover.style.top = `${fitsBelow ? below.y + 8 : Math.max(8, above.y - 8 - height)}px`;
}

// создаёт пустую карточку в окне карты
function createNetmapPopover(className) {
    closeNetmapPopover();
    const popover = document.createElement('div');
    popover.className = className;
    popover.id = 'netmap_popover';
    ['pointerdown', 'wheel'].forEach((name) => popover.addEventListener(name, (event) => event.stopPropagation()));
    document.getElementById('netmap_canvas').appendChild(popover);
    return popover;
}

// открывает карточку устройства; view — 'menu' | 'info' | 'edit'
function openNetmapPopover(node, view = 'menu') {
    const popover = createNetmapPopover('netmap-popover');
    NETMAP.openId = node.id;
    NETMAP.anchor = { x: node.x + NETMAP_CENTER.x, top: node.y, bottom: node.y + 108 };
    popover.addEventListener('click', (event) => onNetmapPopoverAction(event, node));
    renderNetmapPopover(node, view);
    requestAnimationFrame(() => popover.classList.add('is-open'));
}

// содержимое карточки для выбранного вида
function renderNetmapPopover(node, view) {
    const popover = document.getElementById('netmap_popover');
    if (!popover) return;
    const info = NETMAP_TYPES[node.type] || NETMAP_TYPES.pc;
    const head = `
        <div class="netmap-popover-head">
            ${view !== 'menu' ? '<button type="button" class="netmap-back" data-action="menu" title="Назад">‹</button>' : ''}
            <span class="netmap-picker-icon type-${esc(node.type)}">${netmapIcon(node.type)}</span>
            <div class="netmap-popover-titles"><div class="netmap-popover-title">${esc(node.name)}</div><div class="netmap-popover-sub">${esc(node.ip || 'без IP')} · ${esc(info.label)}</div></div>
        </div>`;
    let body;
    if (view === 'menu') {
        body = `<div class="netmap-popover-actions">
            <button type="button" data-action="info">Сведения об устройстве</button>
            <button type="button" class="netmap-edit-action" data-action="edit">Изменить</button>
        </div>`;
    } else {
        body = view === 'info' ? netmapInfoHTML(node, info) : netmapEditHTML(node);
    }
    popover.innerHTML = head + `<div class="netmap-popover-body view-${view}">${body}</div>`;
    popover.dataset.view = view;
    if (view === 'edit' && !node.self) {
        mountNetmapTypePicker(popover.querySelector('[data-picker]'), node.type, (type) => {
            node.type = type;
            updateNetmapNode(node);
            renderNetmapPopover(node, 'edit');
            scheduleNetmapSave();
        });
        popover.querySelectorAll('[data-field]').forEach((input) => input.addEventListener('input', () => {
            node[input.dataset.field] = input.value.trim();
            updateNetmapNode(node);
            popover.querySelector('.netmap-popover-title').textContent = node.name;
            scheduleNetmapSave();
        }));
    }
    positionNetmapPopover();
}

// текст статуса доступности устройства
function netmapStatusText(node) {
    const state = NETMAP.status[node.id];
    if (state === true) return 'доступен (есть пинг)';
    if (state === false) return 'недоступен (нет пинга)';
    return node.ip ? 'проверяется' : 'нет IP — не проверяется';
}

// «Сведения об устройстве»: тип и назначение, данные из hosts.yml, соединения
function netmapInfoHTML(node, info) {
    const rows = [['Тип', info.label], ['Назначение', info.description], ['IP-адрес', node.ip || 'нет'], ['Статус', netmapStatusText(node)]];
    let params = '';
    if (node.self) {
        if (node.hostname) rows.push(['Имя хоста', node.hostname]);
        rows.push(['Источник', 'эта машина — добавлена автоматически']);
    } else if (node.custom) {
        if (node.mac) rows.push(['MAC-адрес', node.mac]);
        rows.push(['Источник', node.mac ? 'найдено прослушкой (нет в hosts.yml)' : 'добавлено на карте (нет в hosts.yml)']);
    } else {
        const host = (DATA?.hosts || []).find((item) => item.hostname === node.name);
        if (host) {
            rows.push(['Шаблон', host.template]);
            const groups = nodeGroupNames(host.hostname);
            if (groups.length) rows.push(['Группы', groups.join(', ')]);
            const entries = Object.entries(host.parameters || {});
            if (entries.length) params = `<details class="netmap-params"><summary>Параметры из hosts.yml (${entries.length})</summary><div class="netmap-params-list">${entries.map(([key, value]) => `<span title="${esc(key)}">${esc(key)}</span><span title="${esc(value)}">${esc(value)}</span>`).join('')}</div></details>`;
        }
    }
    const peers = netmapPeers(node);
    return `
        <div class="netmap-info">${rows.map(([key, value]) => `<span class="netmap-info-key">${esc(key)}</span><span class="netmap-info-value">${esc(value)}</span>`).join('')}</div>
        <div class="netmap-section-title">${esc(NETMAP_LINK_TITLES[node.type] || 'Соединения')}</div>
        ${peers.length ? `<div class="netmap-peer-list">${peers.map((peer) => `<div class="netmap-peer"><span class="netmap-picker-icon type-${esc(peer.type)}">${netmapIcon(peer.type)}</span><span class="netmap-peer-name">${esc(peer.name)}</span><span class="netmap-peer-ip">${esc(peer.ip || '')}</span></div>`).join('')}</div>` : '<div class="netmap-empty-note">Нет соединений</div>'}
        ${params}`;
}

// «Изменить»: тип устройства, имя/IP (для добавленных вручную), соединения, удаление
function netmapEditHTML(node) {
    const peers = netmapPeers(node);
    const typeBlock = node.self
        ? '<div class="netmap-empty-note">Это машина Autodeploy: тип, название и IP определяются автоматически</div>'
        : '<label class="modal-label">Тип устройства</label><div class="netmap-type-picker" data-picker></div>';
    return `
        ${typeBlock}
        ${node.custom ? `
            <div class="netmap-popover-fields">
                <div><label class="modal-label">Название</label><input class="modal-input" data-field="name" value="${esc(node.name)}" placeholder="Название"></div>
                <div><label class="modal-label">IP-адрес</label><input class="modal-input" data-field="ip" value="${esc(node.ip || '')}" placeholder="необязательно"></div>
            </div>` : (node.self ? '' : '<div class="netmap-empty-note">Название и IP берутся из hosts.yml</div>')}
        <div class="netmap-section-title netmap-links-head"><span>Соединения</span><button type="button" class="netmap-link-btn" data-action="link" title="Затем щёлкните устройство, с которым нужно соединить">+ Соединить…</button></div>
        ${peers.length ? `<div class="netmap-peer-list">${peers.map((peer) => `<div class="netmap-peer"><span class="netmap-picker-icon type-${esc(peer.type)}">${netmapIcon(peer.type)}</span><span class="netmap-peer-name">${esc(peer.name)}</span><button type="button" class="netmap-unlink" data-action="unlink" data-peer="${esc(peer.id)}" title="Удалить соединение">×</button></div>`).join('')}</div>` : '<div class="netmap-empty-note">Нет соединений</div>'}
        ${node.custom ? '<button type="button" class="danger netmap-delete-btn" data-action="delete">Удалить с карты</button>' : ''}`;
}

// кнопки внутри карточки устройства
function onNetmapPopoverAction(event, node) {
    const target = event.target.closest('[data-action]');
    if (!target) return;
    const action = target.dataset.action;
    if (action === 'menu' || action === 'info' || action === 'edit') return renderNetmapPopover(node, action);
    if (action === 'link') return startNetmapLink(node);
    if (action === 'unlink') {
        const peer = NETMAP.nodes.find((item) => item.id === target.dataset.peer);
        return confirmAction('Удалить соединение?', `Соединение <strong>${esc(node.name)}</strong> — <strong>${esc(peer?.name || target.dataset.peer)}</strong> будет удалено с карты.`, 'Удалить', () => {
            NETMAP.links = NETMAP.links.filter((link) => !((link.a === node.id && link.b === target.dataset.peer) || (link.b === node.id && link.a === target.dataset.peer)));
            renderNetmapLinks();
            renderNetmapPopover(node, 'edit');
            scheduleNetmapSave();
        }, 'danger', 'Карта сети');
    }
    if (action === 'delete') {
        confirmAction('Удалить устройство с карты?', `Устройство <strong>${esc(node.name)}</strong> и все его соединения будут удалены с карты.`, 'Удалить', () => {
            NETMAP.nodes = NETMAP.nodes.filter((item) => item !== node);
            NETMAP.links = NETMAP.links.filter((link) => link.a !== node.id && link.b !== node.id);
            closeNetmapPopover();
            renderNetmap();
            scheduleNetmapSave();
        }, 'danger', 'Карта сети');
    }
}

// закрывает карточку устройства / соединения
function closeNetmapPopover() {
    closeNetmapTypeList();
    document.getElementById('netmap_popover')?.remove();
    NETMAP.openId = null;
    NETMAP.anchor = null;
}

// обновляет на карте одно устройство (значок/подписи), не перерисовывая остальные
function updateNetmapNode(node) {
    const element = document.querySelector(`#netmap_stage .netmap-node[data-id="${CSS.escape(node.id)}"]`);
    if (element) element.outerHTML = netmapNodeHTML(node);
}

// --- Соединения ---

const NETMAP_LINK_TOOL_HINT = 'Соединение: щёлкните первое устройство, затем второе — и так сколько нужно. Esc или повторное нажатие «Соединить» — выход';

// инструмент «Соединить» на панели: включает/выключает режим, в котором пары устройств соединяются двумя щелчками
function toggleNetmapLinkTool(force) {
    const on = typeof force === 'boolean' ? force : !NETMAP.linkTool;
    NETMAP.linkTool = on;
    const button = document.getElementById('netmap_link_tool_btn');
    button?.classList.toggle('is-active', on);
    button?.setAttribute('aria-pressed', String(on));
    if (on) closeNetmapPopover();
    cancelNetmapLink();
}

// режим соединения: следующий щелчок по устройству соединит его с node
function startNetmapLink(node) {
    closeNetmapPopover();
    NETMAP.linkFrom = node.id;
    document.getElementById('netmap_stage').classList.add('is-linking');
    updateNetmapNode(node);
    setNetmapHint(`Щёлкните устройство, которое нужно соединить с «${node.name}». Esc — ${NETMAP.linkTool ? 'выбрать другое первое устройство' : 'отмена'}`);
}

// выходит из режима соединения
function cancelNetmapLink() {
    const source = NETMAP.linkFrom && netmapNode(NETMAP.linkFrom);
    NETMAP.linkFrom = null;
    document.getElementById('netmap_stage')?.classList.toggle('is-linking', Boolean(NETMAP.linkTool));
    document.getElementById('netmap_link_preview')?.classList.remove('is-visible');
    if (source) updateNetmapNode(source);
    setNetmapHint(NETMAP.linkTool ? NETMAP_LINK_TOOL_HINT : '');
}

// создаёт соединение между устройством-источником и target
function finishNetmapLink(target) {
    const from = NETMAP.linkFrom;
    cancelNetmapLink();
    if (!from || from === target.id) return;
    if (NETMAP.links.some((link) => (link.a === from && link.b === target.id) || (link.b === from && link.a === target.id))) {
        return setNetmapStatus('Такое соединение уже есть');
    }
    NETMAP.links.push({ a: from, b: target.id });
    renderNetmapLinks();
    scheduleNetmapSave();
}

// карточка соединения по щелчку на линию: что с чем соединено + удаление
function openNetmapLinkPopover(index, clientX, clientY) {
    const link = NETMAP.links[index];
    const a = link && netmapNode(link.a), b = link && netmapNode(link.b);
    if (!a || !b) return;
    const popover = createNetmapPopover('netmap-popover is-small');
    const point = netmapToStage(clientX, clientY);
    NETMAP.openId = `link:${index}`;   // по этому признаку карточка закрывается щелчком по фону
    NETMAP.anchor = { x: point.x, top: point.y, bottom: point.y };
    const state = netmapLinkState(link);
    popover.innerHTML = `<div class="netmap-section-title">Соединение</div>
        <div class="netmap-link-pair">${esc(a.name)} — ${esc(b.name)}</div>
        <div class="netmap-link-state ${state}">${state === 'is-up' ? 'есть пинг' : state === 'is-down' ? 'нет пинга' : 'пинг не проверяется (нет IP)'}</div>
        <div class="netmap-link-fields">
            <div><label class="modal-label netmap-vlan-label">Порт</label>
                <input class="modal-input netmap-port-input" value="${esc(link.port || '')}" placeholder="нет" title="Порт коммутатора (например ether3); пусто — без подписи"></div>
            <div><label class="modal-label netmap-vlan-label">VLAN</label>
                <input class="modal-input netmap-vlan-input" value="${esc(link.vlan || '')}" placeholder="нет" title="Номер VLAN (например 10 или 10,20); пусто — без подписи"></div>
        </div>
        <div class="netmap-vlan-error"></div>
        <button type="button" class="danger netmap-delete-btn">Удалить соединение</button>`;
    const vlanInput = popover.querySelector('.netmap-vlan-input');
    vlanInput.addEventListener('input', () => {
        const value = vlanInput.value.trim();
        const valid = !value || /^\d{1,4}(?:[,-]\d{1,4}){0,9}$/.test(value);
        vlanInput.classList.toggle('is-invalid', !valid);
        popover.querySelector('.netmap-vlan-error').textContent = valid ? '' : 'Номер VLAN — числа, через запятую или дефис';
        if (!valid) return;
        if (value) link.vlan = value; else delete link.vlan;
        renderNetmapLinks();
        scheduleNetmapSave();
    });
    const portInput = popover.querySelector('.netmap-port-input');
    portInput.addEventListener('input', () => {
        const value = portInput.value.trim();
        const valid = !value || /^[A-Za-z0-9._:\/+-]{1,32}$/.test(value);
        portInput.classList.toggle('is-invalid', !valid);
        popover.querySelector('.netmap-vlan-error').textContent = valid ? '' : 'Порт — латиница, цифры и . _ : / + -';
        if (!valid) return;
        if (value) link.port = value; else delete link.port;
        renderNetmapLinks();
        scheduleNetmapSave();
    });
    popover.querySelector('.netmap-delete-btn').addEventListener('click', () => {
        confirmAction('Удалить соединение?', 'Соединение будет удалено с карты.', 'Удалить', () => {
            NETMAP.links.splice(index, 1);
            closeNetmapPopover();
            renderNetmapLinks();
            scheduleNetmapSave();
        }, 'danger', 'Карта сети');
    });
    positionNetmapPopover();
    requestAnimationFrame(() => popover.classList.add('is-open'));
}

// мышь: перетаскивание устройств (с привязкой к сетке), перемещение холста левой кнопкой по фону,
// масштаб колесом; щелчок без движения — карточка устройства/соединения или завершение соединения
(function initNetmapPointer() {
    let drag = null, pan = null;
    const canvas = document.getElementById('netmap_canvas');
    document.addEventListener('pointerdown', (event) => {
        if (NETMAP.openId && !event.target.closest('#netmap_popover, #netmap_stage .netmap-node')) closeNetmapPopover();
        if (NETMAP_PICKER && !event.target.closest('.netmap-type-picker')) closeNetmapTypeList();
        if (event.button !== 0 || !event.target.closest('#netmap_canvas') || event.target.closest('#netmap_popover, #netmap_zoom')) return;
        const element = event.target.closest('#netmap_stage .netmap-node');
        const node = element && netmapNode(element.dataset.id);
        if (node) {
            drag = { node, element, startX: event.clientX, startY: event.clientY, originX: node.x, originY: node.y, moved: false };
            element.setPointerCapture(event.pointerId);
            return;
        }
        // захват указателя — только когда холст действительно начали двигать: иначе обычный щелчок
        // (например, по линии соединения) достался бы холсту, а не линии
        pan = { startX: event.clientX, startY: event.clientY, tx: NETMAP.view.tx, ty: NETMAP.view.ty, moved: false, pointerId: event.pointerId };
    });
    document.addEventListener('pointermove', (event) => {
        if (NETMAP.linkFrom && !drag) {
            const source = netmapNode(NETMAP.linkFrom), preview = document.getElementById('netmap_link_preview');
            if (source && preview) {
                const p = netmapCenter(source), q = netmapToStage(event.clientX, event.clientY);
                preview.setAttribute('x1', p.x); preview.setAttribute('y1', p.y);
                preview.setAttribute('x2', q.x); preview.setAttribute('y2', q.y);
                preview.classList.add('is-visible');
            }
        }
        if (pan) {
            const dx = event.clientX - pan.startX, dy = event.clientY - pan.startY;
            if (!pan.moved && Math.hypot(dx, dy) < 4) return;
            if (!pan.moved) { pan.moved = true; canvas.classList.add('is-panning'); canvas.setPointerCapture(pan.pointerId); }
            NETMAP.view.tx = pan.tx + dx;
            NETMAP.view.ty = pan.ty + dy;
            return applyNetmapView();
        }
        if (!drag) return;
        const dx = (event.clientX - drag.startX) / NETMAP.view.z, dy = (event.clientY - drag.startY) / NETMAP.view.z;
        if (!drag.moved && Math.hypot(dx, dy) * NETMAP.view.z < 4) return;
        if (!drag.moved) { drag.moved = true; drag.element.classList.add('is-dragging'); closeNetmapPopover(); }
        const x = netmapSnap(drag.originX + dx), y = netmapSnap(drag.originY + dy);
        if (x === drag.node.x && y === drag.node.y) return;
        drag.node.x = x; drag.node.y = y;
        drag.element.style.left = `${x}px`;
        drag.element.style.top = `${y}px`;
        renderNetmapLinks();
    });
    document.addEventListener('pointerup', () => {
        if (pan) {
            NETMAP.suppressClick = pan.moved;   // после перемещения холста щелчок по линии не открывает карточку
            if (!pan.moved && NETMAP.linkFrom && !document.elementFromPoint(pan.startX, pan.startY)?.closest('.netmap-link')) cancelNetmapLink();   // щелчок по пустому месту — отменить выбранное первое устройство
            canvas.classList.remove('is-panning');
            pan = null;
            return;
        }
        if (!drag) return;
        const { node, element, moved } = drag;
        drag = null;
        element.classList.remove('is-dragging');
        if (moved) return scheduleNetmapSave();
        if (NETMAP.linkFrom) return finishNetmapLink(node);
        if (NETMAP.linkTool) return startNetmapLink(node);   // инструмент «Соединить»: первое устройство пары
        if (NETMAP.openId === node.id) closeNetmapPopover(); else openNetmapPopover(node);
    });
    document.addEventListener('click', (event) => {
        if (NETMAP.suppressClick) { NETMAP.suppressClick = false; return; }
        const hit = event.target.closest('#netmap_links .netmap-link');
        if (hit && !NETMAP.linkFrom) openNetmapLinkPopover(Number(hit.dataset.index), event.clientX, event.clientY);
    });
    canvas.addEventListener('wheel', (event) => {
        event.preventDefault();
        zoomNetmap(Math.exp(-event.deltaY * 0.0015), event.clientX, event.clientY);
    }, { passive: false });
    document.getElementById('netmap_zoom').addEventListener('click', (event) => {
        const action = event.target.closest('[data-zoom]')?.dataset.zoom;
        if (action === 'in') zoomNetmap(NETMAP_ZOOM.step);
        if (action === 'out') zoomNetmap(1 / NETMAP_ZOOM.step);
        if (action === 'reset') zoomNetmap(1 / NETMAP.view.z);
        if (action === 'fit') fitNetmap();
    });
    window.addEventListener('resize', () => { if (!document.getElementById('netmap_modal').hidden) applyNetmapView(); });
})();

// клик вне меню — закрыть; клик по фону окна — закрыть окно; Esc — закрыть верхнее открытое
document.addEventListener('click', (event) => {
    if (!event.target.closest('#settings_wrap')) closeSettingsMenu();
    if (event.target.id === 'constants_modal') cancelConstants();
    if (event.target.id === 'netmap_modal') closeNetmapModal();
});
window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    closeSettingsMenu();
    if (document.getElementById('netmap_help')?.classList.contains('is-open')) return toggleNetmapHelp(null, false);
    if (NETMAP_PICKER) return closeNetmapTypeList();
    if (NETMAP.linkFrom) return cancelNetmapLink();
    if (NETMAP.linkTool) return toggleNetmapLinkTool(false);
    if (document.getElementById('netmap_popover')) return closeNetmapPopover();
    if (!document.getElementById('netmap_modal').hidden) closeNetmapModal();
    if (!document.getElementById('constants_modal').hidden) cancelConstants();
});
updateThemeLabel();


// ============================================================================
// Редактор кода: номера строк, отступы пробелами, сохранение по Ctrl+S
// (основа для подсказок при наборе — следующий этап)
// ============================================================================

// вставка текста с сохранением истории отмены (Ctrl+Z)
function insertCodeText(textarea, text) {
    textarea.focus();
    if (!document.execCommand || !document.execCommand('insertText', false, text)) {
        textarea.setRangeText(text, textarea.selectionStart, textarea.selectionEnd, 'end');
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }
}

// превращает textarea в редактор кода; повторный вызов возвращает тот же редактор
function enhanceCodeEditor(textarea, options = {}) {
    if (textarea._code) { if (options.onSave) textarea._code.onSave = options.onSave; return textarea._code; }
    const wrap = document.createElement('div');
    wrap.className = 'code-editor';
    const gutter = document.createElement('div');
    gutter.className = 'code-gutter';
    gutter.setAttribute('aria-hidden', 'true');
    // слой подсветки: тот же текст, раскрашенный по токенам, лежит под прозрачным текстом поля ввода
    const stack = document.createElement('div');
    stack.className = 'code-stack';
    const layer = document.createElement('pre');
    layer.className = 'code-highlight';
    layer.setAttribute('aria-hidden', 'true');
    textarea.parentNode.insertBefore(wrap, textarea);
    wrap.append(gutter, stack);
    stack.append(layer, textarea);
    textarea.classList.add('code-area');
    textarea.setAttribute('wrap', 'off');
    wrap.classList.add('has-highlight');
    const editor = { onSave: options.onSave, marked: null };
    // язык подсветки — по открытому файлу (ctx задаётся при открытии)
    editor.highlight = () => {
        layer.innerHTML = highlightCode(textarea.value, codeLanguage(editor.ctx));
        layer.scrollTop = textarea.scrollTop;
        layer.scrollLeft = textarea.scrollLeft;
    };
    // номера строк; marked — строка с ошибкой (подсвечена до следующей правки)
    editor.refresh = () => {
        const count = textarea.value.split('\n').length;
        gutter.innerHTML = Array.from({ length: count }, (_, index) => index + 1 === editor.marked ? `<span class="code-line-error">${index + 1}</span>` : String(index + 1)).join('\n');
        gutter.scrollTop = textarea.scrollTop;
        editor.highlight();
    };
    // выделяет строку и прокручивает к ней
    editor.goToLine = (line, column = 1) => {
        const lines = textarea.value.split('\n');
        const target = Math.max(1, Math.min(line, lines.length));
        const start = lines.slice(0, target - 1).reduce((sum, text) => sum + text.length + 1, 0);
        textarea.focus();
        textarea.setSelectionRange(start + Math.max(0, column - 1), start + lines[target - 1].length);
        const lineHeight = parseFloat(getComputedStyle(textarea).lineHeight) || 20;
        textarea.scrollTop = Math.max(0, (target - 1) * lineHeight - textarea.clientHeight / 3);
        gutter.scrollTop = textarea.scrollTop;
    };
    editor.markLine = (line) => { editor.marked = line; editor.refresh(); };
    textarea.addEventListener('input', (event) => { editor.marked = null; editor.refresh(); scheduleCompletion(editor, textarea, event); });
    textarea.addEventListener('scroll', () => { gutter.scrollTop = layer.scrollTop = textarea.scrollTop; layer.scrollLeft = textarea.scrollLeft; positionCompletion(); });
    textarea.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== textarea) closeCompletion(); }, 120));
    textarea.addEventListener('mousedown', () => closeCompletion());
    textarea.addEventListener('keydown', (event) => {
        if (handleCompletionKey(event, editor, textarea)) return;
        if ((event.ctrlKey || event.metaKey) && (event.code === 'Space' || event.key === ' ')) { event.preventDefault(); openCompletion(editor, textarea, true); return; }
        if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) closeCompletion();
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); editor.onSave?.(); return; }
        if (event.key === 'Tab') {
            event.preventDefault();
            const { value, selectionStart: from, selectionEnd: to } = textarea;
            const lineStart = value.lastIndexOf('\n', from - 1) + 1;
            if (event.shiftKey || value.slice(from, to).includes('\n')) {
                // несколько строк (или Shift+Tab): сдвиг выделенных строк на 2 пробела вправо/влево
                const lineEnd = value.indexOf('\n', to - (to > from && value[to - 1] === '\n' ? 1 : 0));
                const blockEnd = lineEnd === -1 ? value.length : lineEnd;
                const block = value.slice(lineStart, blockEnd).split('\n').map((line) => event.shiftKey ? line.replace(/^ {1,2}/, '') : `  ${line}`).join('\n');
                const hadSelection = from !== to;
                textarea.setSelectionRange(lineStart, blockEnd);
                insertCodeText(textarea, block);
                // с выделением — оставляем выделенными сдвинутые строки; без него — курсор в конец строки
                if (hadSelection) textarea.setSelectionRange(lineStart, lineStart + block.length);
                else textarea.setSelectionRange(lineStart + block.length, lineStart + block.length);
            } else {
                insertCodeText(textarea, '  ');
            }
            return;
        }
        if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.altKey) {
            // новая строка с тем же отступом; после «ключ:» и в элементе списка «- …» — на уровень глубже
            event.preventDefault();
            const { value, selectionStart: from } = textarea;
            const line = value.slice(value.lastIndexOf('\n', from - 1) + 1, from);
            let indent = (line.match(/^ */) || [''])[0].length;
            const trimmed = line.trimEnd();
            if (/:\s*([|>][-+]?)?$/.test(trimmed) || /^\s*- /.test(line)) indent += 2;
            insertCodeText(textarea, `\n${' '.repeat(indent)}`);
        }
    });
    textarea._code = editor;
    editor.refresh();
    return editor;
}

// ошибка YAML над редактором: строка, пояснение, «Перейти к строке», «Сохранить всё равно»
function showYamlError(box, textarea, problem, onForce, format = 'YAML') {
    const where = problem.line ? `Строка ${problem.line}${problem.column ? `, столбец ${problem.column}` : ''}: ` : '';
    box.innerHTML = `<div class="editor-error-text"><b>Ошибка ${esc(format)} — файл не сохранён.</b> ${esc(where + problem.message)}</div>
        <div class="editor-error-actions">${problem.line ? '<button type="button" data-act="go">Перейти к строке</button>' : ''}<button type="button" class="danger" data-act="force" title="Сохранить как есть — при запуске Ansible сообщит ту же ошибку">Сохранить всё равно</button></div>`;
    box.hidden = false;
    box.querySelector('[data-act="go"]')?.addEventListener('click', () => textarea._code?.goToLine(problem.line, problem.column));
    box.querySelector('[data-act="force"]').addEventListener('click', () => { box.hidden = true; onForce(); });
    if (problem.line && textarea._code) { textarea._code.markLine(problem.line); textarea._code.goToLine(problem.line, problem.column); }
}

// блок ошибки в окне редактора плейбука (создаётся один раз)
function playbookErrorBox() {
    let box = document.getElementById('playbook_editor_error');
    if (!box) {
        box = document.createElement('div');
        box.id = 'playbook_editor_error';
        box.className = 'editor-error';
        box.hidden = true;
        document.querySelector('.playbook-editor-body')?.prepend(box);
    }
    return box;
}

// ============================================================================
// Редактор файлов роли
// ============================================================================
let FILE_EDITOR = { path: null, original: '' };

// открывает файл роли в редакторе
// открывает файл в редакторе: файл роли (path — «роль/…») или файл объекта
// (options.kind = 'defaults' | 'cfg', options.content — уже полученное содержимое)
function openFileEditor(path, options = {}) {
    const kind = options.kind || 'role';
    const scope = options.scope ?? (kind === 'role' ? PLAYBOOK_FILES.scope : '') ?? '';
    const textarea = document.getElementById('file_editor');
    const code = enhanceCodeEditor(textarea, { onSave: () => saveFileEditor() });
    code.ctx = kind === 'role' ? { kind: 'role', path, scope } : { kind: 'object', path };
    prepareCompletion(code);
    FILE_EDITOR = { path, kind, scope, original: '' };
    // «Синтаксис» — только там, где есть что проверять: YAML, шаблоны .j2, ansible.cfg
    const checkable = kind !== 'role' || /\.(ya?ml|j2)$/i.test(path);
    const checkButton = document.getElementById('file_check_btn');
    checkButton.disabled = !checkable;
    checkButton.title = checkable ? 'Проверить синтаксис — проверяется текст в редакторе, в том числе несохранённый' : 'Для этого файла проверка синтаксиса не нужна';
    const where = `${CURRENT_OBJECT ? `${CURRENT_PROJECT} / ${CURRENT_OBJECT}` : CURRENT_PROJECT}${scope === 'autodeploy' ? ' · Autodeploy' : ''}`;
    const [roleRef, inside] = path.includes('|') ? path.split('|') : [path.split('/')[0], path.split('/').slice(1).join('/')];
    document.getElementById('file_editor_title').textContent = kind === 'role' ? (inside || path) : path;
    document.getElementById('file_editor_context').textContent = kind === 'role' ? `Роль ${roleRef} · ${where}`
        : `${kind === 'cfg' ? 'Настройки Ansible' : 'Значения по умолчанию'} · ${where}`;
    document.getElementById('file_editor_error').hidden = true;
    const show = (content) => {
        textarea.value = content || '';
        FILE_EDITOR.original = textarea.value;
        textarea.readOnly = false;
        code.refresh();
        updateFileEditorState();
        textarea.focus();
        textarea.setSelectionRange(0, 0);
    };
    textarea.value = 'Загрузка…';
    textarea.readOnly = true;
    updateFileEditorState();
    showModalSmooth('file_editor_modal');
    if (options.content !== undefined) return show(options.content);
    fetch(`${API.ROLE_FILE}?${contextQuery(`&path=${encodeURIComponent(path)}${scope ? `&scope=${scope}` : ''}`)}`)
        .then((response) => { if (!response.ok) throw Error('Не удалось открыть файл'); return response.json(); })
        .then((data) => show(data.content))
        .catch((error) => { notify(error.message, 'error'); hideModalSmooth('file_editor_modal'); });
}

// «Сохранить» активна только при изменениях; строка состояния
function updateFileEditorState(text) {
    const textarea = document.getElementById('file_editor');
    const dirty = !textarea.readOnly && textarea.value !== FILE_EDITOR.original;
    document.getElementById('file_editor_save').disabled = !dirty;
    setStatusText('file_editor_status', text ?? (dirty ? 'Есть несохранённые изменения' : ''));
}
document.getElementById('file_editor')?.addEventListener('input', () => updateFileEditorState());

// текст строки состояния окна (общий для редакторов)
function setStatusText(id, text, type = 'info') {
    const element = document.getElementById(id);
    if (!element) return;
    element.textContent = text;
    element.classList.toggle('is-success', type === 'success');
    element.classList.toggle('is-error', type === 'error');
}

// сохраняет файл; YAML проверяет сервер — при ошибке файл не меняется
function saveFileEditor(force = false) {
    const textarea = document.getElementById('file_editor');
    if (textarea.readOnly || (!force && textarea.value === FILE_EDITOR.original)) return;
    if (!force) return confirmAction('Сохранить изменения?', `Файл <strong>${esc(shownPath(FILE_EDITOR.path))}</strong> будет перезаписан. Предыдущая версия сохранится в backups/.`, 'Сохранить', () => saveFileEditor('confirmed'), 'primary', 'Редактор');
    force = force === true;
    const errorBox = document.getElementById('file_editor_error');
    const content = textarea.value;
    document.getElementById('file_editor_save').disabled = true;
    setStatusText('file_editor_status', 'Сохранение…');
    const isRole = FILE_EDITOR.kind === 'role';
    const format = FILE_EDITOR.kind === 'cfg' ? 'INI' : 'YAML';
    const body = { project: CURRENT_PROJECT, object: CURRENT_OBJECT, content, force, ...(isRole ? { path: FILE_EDITOR.path, scope: FILE_EDITOR.scope || '' } : { kind: FILE_EDITOR.kind }) };
    fetch(isRole ? API.ROLE_FILE_SAVE : API.OBJECT_FILE_SAVE, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then((response) => response.json().then((data) => ({ response, data })))
        .then(({ response, data }) => {
            if (data.yaml_error) { updateFileEditorState(`Не сохранено: ошибка ${format}`); showYamlError(errorBox, textarea, data.yaml_error, () => saveFileEditor(true), format); return; }
            if (!response.ok || data.ok === false) throw Error(data.error || 'Не удалось сохранить файл');
            errorBox.hidden = true;
            FILE_EDITOR.original = content;
            updateFileEditorState();
            setStatusText('file_editor_status', force ? 'Сохранено с ошибкой YAML' : 'Сохранено', force ? 'error' : 'success');
            notify(`Файл ${shownPath(FILE_EDITOR.path)} сохранён`, 'success');
            if (isRole) refreshPlaybookFiles();
        })
        .catch((error) => { updateFileEditorState(); notify(error.message, 'error'); });
}

// закрытие: если есть несохранённые изменения — спросить
function closeFileEditor() {
    const textarea = document.getElementById('file_editor');
    if (!textarea.readOnly && textarea.value !== FILE_EDITOR.original) {
        showConfirmation('Закрыть без сохранения?', `В файле <strong>${esc(shownPath(FILE_EDITOR.path))}</strong> есть несохранённые изменения — они будут потеряны.`,
            () => hideModalSmooth('file_editor_modal'), 'Закрыть без сохранения', 'danger', 'Редактор файла');
        return;
    }
    hideModalSmooth('file_editor_modal');
}

// «＋ Новый файл…» в папке роли: спросить имя, создать, открыть в редакторе
function promptRoleFile(folder) {
    showConfirmation('Новый файл', `Папка <strong>${esc(shownPath(folder).replace(/\/$/, ''))}</strong><br><br><input id="new_role_file_name" class="modal-input" type="text" placeholder="например, nginx.conf.j2" autocomplete="off" spellcheck="false">
        <div class="wizard-hint">Латинские буквы, цифры, точка, дефис, подчёркивание. Шаблоны Jinja2 — с расширением .j2.</div>`,
        () => {
            const name = (document.getElementById('new_role_file_name')?.value || '').trim();
            if (!isItemName(name)) return notify('Имя файла: латинские буквы, цифры, точка, дефис и подчёркивание', 'warning');
            api(API.ROLE_FILE_CREATE, { project: CURRENT_PROJECT, object: CURRENT_OBJECT, folder, name, scope: PLAYBOOK_FILES.scope })
                .then((data) => { notify(`Создан файл ${shownPath(data.path)}`, 'success'); refreshPlaybookFiles(); openFileEditor(data.path); })
                .catch((error) => notify(error.message, 'error'));
        }, 'Создать', 'primary', 'Роль');
    setTimeout(() => document.getElementById('new_role_file_name')?.focus(), 80);
}

// ============================================================================
// Мастер нового проекта, новый плейбук, новая роль
// ============================================================================

// имя проекта/объекта/роли/файла — как проверяет сервер
function isItemName(value) { return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value || '') && !value.includes('..'); }

// поле-«фишки»: значения вводятся через Enter, запятую или пробел; × — удалить; ошибочные — красные
function mountChips(container, onChange) {
    const placeholder = container.dataset.placeholder || '';
    container.innerHTML = `<input type="text" class="chips-entry" placeholder="${esc(placeholder)}" autocomplete="off" spellcheck="false">`;
    container._chips = [];
    const entry = container.querySelector('.chips-entry');
    const render = () => {
        container.querySelectorAll('.chip').forEach((chip) => chip.remove());
        container._chips.forEach((value, index) => {
            const chip = document.createElement('span');
            chip.className = `chip${isItemName(value) ? '' : ' is-invalid'}`;
            chip.title = isItemName(value) ? value : 'Допустимы латинские буквы, цифры, точка, дефис и подчёркивание';
            chip.innerHTML = `${esc(value)}<button type="button" aria-label="Убрать ${esc(value)}">×</button>`;
            chip.querySelector('button').addEventListener('click', () => { container._chips.splice(index, 1); render(); onChange(); });
            container.insertBefore(chip, entry);
        });
    };
    const add = (text) => {
        text.split(/[\s,;]+/).map((item) => item.trim()).filter(Boolean).forEach((item) => { if (!container._chips.includes(item)) container._chips.push(item); });
        entry.value = '';
        render();
        onChange();
    };
    entry.addEventListener('keydown', (event) => {
        if (['Enter', ',', ' ', ';'].includes(event.key)) { event.preventDefault(); if (entry.value.trim()) add(entry.value); }
        else if (event.key === 'Backspace' && !entry.value && container._chips.length) { container._chips.pop(); render(); onChange(); }
    });
    entry.addEventListener('paste', (event) => { event.preventDefault(); add(event.clipboardData.getData('text')); });
    entry.addEventListener('blur', () => { if (entry.value.trim()) add(entry.value); });
    container.addEventListener('click', (event) => { if (event.target === container) entry.focus(); });
    return () => container._chips.slice();
}

let WIZARD = null;

// открывает мастер нового проекта
function openProjectWizard() {
    WIZARD_IMPORTS = [];
    WIZARD_CFG = null;
    setTimeout(loadWizardCfgSources, 0);
    setTimeout(renderWizardImports, 0);
    closeSettingsMenu();
    document.querySelectorAll('.project-select-list.is-open').forEach((list) => list.classList.remove('is-open'));
    const update = () => updateProjectWizard();
    WIZARD = { objects: mountChips(document.getElementById('wizard_objects'), update), roles: mountChips(document.getElementById('wizard_roles'), update) };
    document.getElementById('wizard_name').value = '';
    document.querySelector('input[name="wizard_kind"][value="simple"]').checked = true;
    document.getElementById('wizard_role_playbooks').checked = false;
    document.getElementById('wizard_autodeploy').checked = false;
    const select = document.getElementById('wizard_autodeploy_source');
    select.innerHTML = '<option value="">Минимальная заготовка (autodeploy.yml, roles, hdd)</option>';
    fetch(`${API.AUTODEPLOY_SOURCES}?_=${Date.now()}`).then((response) => response.json()).then((data) => {
        const sources = data.sources || [];
        select.innerHTML = sources.map((item) => `<option value="${esc(item.project)}">${esc(item.project)} — ${item.files} ${plural(item.files, 'файл', 'файла', 'файлов')}, ${formatBytes(item.size)}</option>`).join('')
            + '<option value="">Минимальная заготовка (autodeploy.yml, roles, hdd)</option>';
        updateProjectWizard();
    }).catch(() => {});
    document.getElementById('wizard_site').checked = true;
    setStatusText('wizard_status', '');
    updateProjectWizard();
    showModalSmooth('project_wizard_modal');
    setTimeout(() => document.getElementById('wizard_name').focus(), 80);
}
['wizard_name', 'wizard_site', 'wizard_role_playbooks', 'wizard_autodeploy', 'wizard_autodeploy_source'].forEach((id) => document.getElementById(id)?.addEventListener('input', () => updateProjectWizard()));
document.querySelectorAll('input[name="wizard_kind"]').forEach((input) => input.addEventListener('change', () => updateProjectWizard()));

// закрывает мастер
function closeProjectWizard() { hideModalSmooth('project_wizard_modal'); }

// проверка полей мастера и предпросмотр структуры, которая будет создана
function updateProjectWizard() {
    if (!WIZARD) return;
    const name = document.getElementById('wizard_name').value.trim();
    const kind = document.querySelector('input[name="wizard_kind"]:checked').value;
    const objects = WIZARD.objects(), roles = WIZARD.roles();
    const site = document.getElementById('wizard_site').checked, perRole = document.getElementById('wizard_role_playbooks').checked;
    const autodeploy = document.getElementById('wizard_autodeploy').checked, autodeploySource = document.getElementById('wizard_autodeploy_source').value;
    document.getElementById('wizard_autodeploy_block').classList.toggle('is-open', autodeploy);
    document.getElementById('wizard_objects_block').classList.toggle('is-open', kind === 'objects');
    let nameError = '';
    if (name && !isItemName(name)) nameError = 'Допустимы латинские буквы, цифры, точка, дефис и подчёркивание';
    else if (name && (DATA?.projects || []).includes(name)) nameError = 'Проект с таким именем уже есть';
    document.getElementById('wizard_name_error').textContent = nameError;
    const valid = name && !nameError && roles.every(isItemName) && (kind === 'simple' || (objects.length && objects.every(isItemName)));
    document.getElementById('wizard_create_btn').disabled = !valid;
    // предпросмотр
    const lines = [`${name || 'имя-проекта'}/`];
    const folder = (prefix, last) => {
        const items = ['hosts.yml', 'defaults.yml', WIZARD_CFG ? `ansible.cfg  (из ${sourceLabel(WIZARD_CFG)})` : 'ansible.cfg'];
        if (site) items.push('site.yml');
        if (perRole) roles.forEach((role, index) => items.push(`${String(index + 1).padStart(2, '0')}-${role}.yml`));
        WIZARD_IMPORTS.forEach((entry) => entry.playbooks.forEach((name) => { if (!items.includes(name)) items.push(`${name}  (импорт)`); }));
        const hostCount = WIZARD_IMPORTS.reduce((sum, entry) => sum + (entry.hosts || []).length, 0);
        if (hostCount) items[0] = `${items[0]}  (+${hostCount} ${plural(hostCount, 'узел', 'узла', 'узлов')} — импорт)`;
        items.forEach((item) => lines.push(`${prefix}├── ${item}`));
        lines.push(`${prefix}└── roles → ${kind === 'simple' ? '../roles' : '../../roles'}  (ссылка на общую папку ролей)`);
    };
    // общая папка ролей проекта — рядом с playbooks/ (или object/)
    const top = [['roles/', (prefix) => {
        const imported = [...new Set(WIZARD_IMPORTS.flatMap((entry) => entry.roles.concat(entry.playbookRoles || [])))].filter((ref) => !roles.includes(ref));
        const all = roles.map((role) => `${role}/  (скелет роли)`).concat(imported.map((ref) => `${ref}/  (импорт)`));
        if (!all.length) lines.push(`${prefix}└── (роли появятся здесь)`);
        all.forEach((item, index) => lines.push(`${prefix}${index === all.length - 1 ? '└' : '├'}── ${item}`));
    }]];
    if (kind === 'simple') top.push(['playbooks/', (prefix) => folder(prefix)]);
    else top.push(['object/', (prefix) => (objects.length ? objects : ['объект']).forEach((obj, index, list) => {
        const lastObject = index === list.length - 1;
        lines.push(`${prefix}${lastObject ? '└' : '├'}── ${obj}/`);
        folder(`${prefix}${lastObject ? '    ' : '│   '}`);
    })]);
    if (autodeploy) top.push(['autodeploy/', (prefix) => {
        if (autodeploySource) lines.push(`${prefix}└── (копия папки autodeploy проекта ${autodeploySource})`);
        else ['autodeploy.yml', 'roles/', 'hdd/'].forEach((item, index, list) => lines.push(`${prefix}${index === list.length - 1 ? '└' : '├'}── ${item}`));
    }]);
    top.forEach(([title, body], index) => {
        const last = index === top.length - 1;
        lines.push(`${last ? '└' : '├'}── ${title}`);
        body(last ? '    ' : '│   ');
    });
    document.getElementById('wizard_tree').textContent = lines.join('\n');
}

// создаёт проект и переходит в него
function createProjectFromWizard() {
    const name = document.getElementById('wizard_name').value.trim();
    const kind = document.querySelector('input[name="wizard_kind"]:checked').value;
    const button = document.getElementById('wizard_create_btn');
    button.disabled = true;
    setStatusText('wizard_status', 'Создание…');
    api(API.PROJECT_CREATE, {
        name, kind, objects: kind === 'objects' ? WIZARD.objects() : [], roles: WIZARD.roles(),
        site_playbook: document.getElementById('wizard_site').checked, role_playbooks: document.getElementById('wizard_role_playbooks').checked,
        autodeploy: document.getElementById('wizard_autodeploy').checked, autodeploy_source: document.getElementById('wizard_autodeploy_source').value || null,
        imports: WIZARD_IMPORTS,
        cfg_source: WIZARD_CFG,
    }).then((data) => {
        setStatusText('wizard_status', `Создано файлов: ${data.files.length}`, 'success');
        notify(`Проект «${name}» создан — переходим в него`, 'success');
        setTimeout(() => { window.location.href = `${window.location.pathname}?project=${encodeURIComponent(name)}`; }, 700);
    }).catch((error) => { button.disabled = false; setStatusText('wizard_status', error.message, 'error'); });
}

// подпись «проект · объект» для окон
function contextLabel() { return CURRENT_OBJECT ? `${CURRENT_PROJECT} · ${CURRENT_OBJECT}` : CURRENT_PROJECT; }

// следующий свободный номер для имени плейбука («NN-…»)
function nextPlaybookNumber() {
    const numbers = [...document.querySelectorAll('#playbooks .pb')].map((item) => parseInt(item.value, 10)).filter(Number.isFinite);
    return String((numbers.length ? Math.max(...numbers) : 0) + 1).padStart(2, '0');
}

// --- «Новый плейбук»: без ролей или с ролями. Роли выбираются в том же окне «Добавить роль»,
// что и в «Файлах плейбука», и копятся в черновике — создаются вместе с плейбуком ---
let DRAFT_ROLES = [];   // [{ ref, isNew, parts }]
function openCreatePlaybook() {
    document.getElementById('create_playbook_context').textContent = contextLabel();
    document.getElementById('create_playbook_name').value = `${nextPlaybookNumber()}-`;
    document.getElementById('create_playbook_name').dataset.auto = '0';
    document.getElementById('create_playbook_hosts').value = 'all';
    document.getElementById('create_playbook_become').checked = true;
    document.querySelector('input[name="playbook_mode"][value="plain"]').checked = true;
    document.getElementById('create_playbook_roles_block').classList.remove('is-open');
    DRAFT_ROLES = [];
    renderDraftRoles();
    IMPORT_PLAYBOOKS = [];
    renderPlaybookImportChoice();
    syncPlaybookMode();
    setStatusText('create_playbook_status', '');
    showModalSmooth('create_playbook_modal');
    setTimeout(() => { const input = document.getElementById('create_playbook_name'); input.focus(); input.setSelectionRange(input.value.length, input.value.length); }, 80);
}
document.querySelectorAll('input[name="playbook_mode"]').forEach((input) => input.addEventListener('change', () => {
    if (input.checked) syncPlaybookMode();
}));
// варианты «Состава» сменяют друг друга в одной области — окно не меняет размер
function syncPlaybookMode() {
    const mode = document.querySelector('input[name="playbook_mode"]:checked').value;
    [['create_playbook_plain_block', 'plain'], ['create_playbook_roles_block', 'roles'], ['create_playbook_import_block', 'import']].forEach(([id, value]) => {
        const pane = document.getElementById(id);
        pane.classList.toggle('is-active', mode === value);
        pane.inert = mode !== value;
    });
    // из другого проекта: имя файла, hosts и become — из исходных плейбуков
    document.querySelector('#create_playbook_modal .create-row').classList.toggle('is-disabled', mode === 'import');
    document.getElementById('create_playbook_name').closest('.modal-body').classList.toggle('is-importing', mode === 'import');
}

// роли черновика: фишки с «×»; новые роли помечены
function renderDraftRoles() {
    const box = document.getElementById('create_playbook_draft');
    box.innerHTML = DRAFT_ROLES.length
        ? DRAFT_ROLES.map((item, index) => `<span class="chip${item.isNew ? ' is-new' : ''}${item.source ? ' is-import' : ''}" title="${item.isNew ? `новая роль — будет создана: ${esc((item.parts || []).join(', ') || 'все папки')}` : item.source ? `будет скопирована из ${esc(sourceLabel(item.source))}` : 'существующая роль'}">${esc(item.ref)}${item.isNew ? ' <small>новая</small>' : ''}${item.source ? ` <small>из ${esc(sourceLabel(item.source))}</small>` : ''}<button type="button" aria-label="Убрать ${esc(item.ref)}" onclick="removeDraftRole(${index})">×</button></span>`).join('')
        : '<span class="muted">Роли не выбраны — нажмите «Добавить роль».</span>';
}
function removeDraftRole(index) { DRAFT_ROLES.splice(index, 1); renderDraftRoles(); }

// окно «Добавить роль» для черновика нового плейбука
function openAddRoleForDraft() {
    openAddRole({ mode: 'draft', scope: '', context: `${document.getElementById('create_playbook_name').value.trim() || 'новый плейбук'}`, present: new Set(DRAFT_ROLES.map((item) => item.ref)) });
}

// создаёт плейбук (и новые роли) и сразу открывает его в редакторе
function createPlaybook() {
    const name = document.getElementById('create_playbook_name').value.trim();
    const playbookMode = document.querySelector('input[name="playbook_mode"]:checked').value;
    if (playbookMode === 'import') return createImportedPlaybook();
    const withRoles = playbookMode === 'roles';
    const roles = withRoles ? DRAFT_ROLES.filter((item) => !item.isNew && !item.source).map((item) => item.ref) : [];
    // роли из других проектов — по источникам: [{project, object, roles}]
    const importRoles = [];
    (withRoles ? DRAFT_ROLES.filter((item) => item.source) : []).forEach((item) => {
        let group = importRoles.find((entry) => entry.project === item.source.project && entry.object === item.source.object);
        if (!group) importRoles.push(group = { project: item.source.project, object: item.source.object, roles: [] });
        group.roles.push(item.ref);
    });
    const newRoles = withRoles ? DRAFT_ROLES.filter((item) => item.isNew).map((item) => ({ name: item.ref, parts: item.parts })) : [];
    if (withRoles && !roles.length && !newRoles.length && !importRoles.length) return setStatusText('create_playbook_status', 'Добавьте хотя бы одну роль', 'error');
    api(API.PLAYBOOK_CREATE, { project: CURRENT_PROJECT, object: CURRENT_OBJECT, name, roles, new_roles: newRoles, import_roles: importRoles, hosts: document.getElementById('create_playbook_hosts').value.trim() || 'all', become: document.getElementById('create_playbook_become').checked })
        .then((data) => {
            hideModalSmooth('create_playbook_modal');
            notify(newRoles.length ? `Плейбук «${data.name}» и роли ${newRoles.map((item) => item.name).join(', ')} созданы` : `Плейбук «${data.name}» создан`, 'success');
            loadMain();
            setTimeout(() => editPlaybook(data.name), 350);
        })
        .catch((error) => setStatusText('create_playbook_status', error.message, 'error'));
}

// --- defaults.yml и ansible.cfg объекта: открыть (если нет — создать) в редакторе ---
function openObjectFile(kind) {
    api(API.OBJECT_FILE_OPEN, { project: CURRENT_PROJECT, object: CURRENT_OBJECT, kind })
        .then((data) => {
            if (data.created) notify(`Создан ${data.name}`, 'success');
            openFileEditor(data.name, { kind, content: data.content });
        })
        .catch((error) => notify(error.message, 'error'));
}

// --- Окно «Файлы плейбука» ---
let PLAYBOOK_FILES = { name: '', scope: '', data: null };

// открывает окно с ролями и файлами плейбука
function openPlaybookFiles(name, scope = '') {
    PLAYBOOK_FILES = { name, scope, data: null };
    document.getElementById('playbook_files_title').textContent = name;
    document.getElementById('playbook_files_context').textContent = scope === 'autodeploy' ? `Autodeploy · ${CURRENT_PROJECT}` : `Файлы плейбука · ${contextLabel()}`;
    document.getElementById('playbook_files_body').innerHTML = '<div class="muted">Загрузка…</div>';
    showModalSmooth('playbook_files_modal');
    refreshPlaybookFiles();
}

// перечитывает содержимое окна (после добавления/удаления ролей и файлов)
function refreshPlaybookFiles() {
    if (!PLAYBOOK_FILES.name || document.getElementById('playbook_files_modal').hidden) return;
    fetch(`${API.PLAYBOOK_FILES}?${contextQuery(`&name=${encodeURIComponent(PLAYBOOK_FILES.name)}&scope=${PLAYBOOK_FILES.scope}`)}`)
        .then(async (response) => { const data = await response.json(); if (!response.ok) throw Error(data.error || 'Не удалось прочитать плейбук'); return data; })
        .then((data) => { PLAYBOOK_FILES.data = data; renderPlaybookFiles(); })
        .catch((error) => { document.getElementById('playbook_files_body').innerHTML = `<div class="empty-state is-error"><b>Не удалось открыть</b><span>${esc(error.message)}</span></div>`; });
}

// рисует роли плейбука: карточка роли — заголовок с действиями и дерево файлов
function renderPlaybookFiles() {
    const data = PLAYBOOK_FILES.data;
    const problem = data.problem ? `<div class="playbook-files-note">⚠ ${esc(data.problem)}</div>` : '';
    if (!data.roles.length) {
        document.getElementById('playbook_files_body').innerHTML = problem + '<div class="empty-state"><b>Роли не подключены</b><span>Добавьте роль кнопкой «Добавить роль» — существующую или новую. Задачи без ролей пишутся прямо в плейбуке («Просмотр плейбука»).</span></div>';
        return;
    }
    document.getElementById('playbook_files_body').innerHTML = problem + data.roles.map((role) => {
        const dependency = role.dependency_of ? `<span class="role-card-usage" title="Подключена в meta/main.yml роли ${esc(role.dependency_of)} (dependencies) — Ansible выполняет её перед этой ролью">зависимость роли ${esc(role.dependency_of)}</span>` : '';
        const usage = role.used_by.length ? `<span class="role-card-usage" title="${esc(role.used_by.join(', '))}">ещё в ${role.used_by.length} ${plural(role.used_by.length, 'плейбуке', 'плейбуках', 'плейбуках')}</span>` : '';
        const where = role.found && role.location && role.location !== 'roles' ? `<span class="role-card-where" title="Папка роли">${esc(role.location)}/</span>` : '';
        const body = role.found
            ? `<div class="role-card-tree">${roleTree(role.children)}<button type="button" class="role-add-file" onclick="promptRoleFile('${esc(role.name)}|')">＋ Новый файл в корне роли…</button></div>`
            : `<div class="role-card-missing">${role.collection ? 'Роль из коллекции Ansible — её файлов нет в проекте.' : 'Папка роли не найдена ни в roles/, ни по roles_path из ansible.cfg.'}${role.collection ? '' : ` <button type="button" class="primary" onclick="createMissingRole('${esc(role.name)}')">Создать роль</button>`}</div>`;
        return `<section class="role-card${role.found ? '' : ' is-missing'}${role.dependency_of ? ' is-dependency' : ''}">
            <div class="role-card-head">
                <span class="role-card-name">${esc(role.name)}</span>${where}${dependency}${usage}
                <span class="role-card-actions">
                    ${role.found ? `<button type="button" class="edit-action" onclick="renameRole('${esc(role.name)}')" title="Переименовать роль — папку и ссылки во всех плейбуках">Переименовать</button>` : ''}
                    ${role.dependency_of ? '' : `<button type="button" class="danger" onclick="removeRoleFromPlaybook('${esc(role.name)}')" title="Убрать роль из этого плейбука (по желанию — удалить и её файлы)">Убрать из плейбука</button>`}
                </span>
            </div>
            ${body}
        </section>`;
    }).join('');
}

// --- Окно «Добавить роль»: существующие роли деревом (с подролями или без) или новая роль ---
let ADD_ROLE_SUBROLES = () => [];

let ADD_ROLE_TARGET = { mode: 'playbook' };
// target: { mode: 'draft', scope, context, present } — для «Нового плейбука»; без него — плейбук окна «Файлы плейбука»
function openAddRole(target = null) {
    ADD_ROLE_TARGET = target || { mode: 'playbook', scope: PLAYBOOK_FILES.scope, context: `${PLAYBOOK_FILES.name}${PLAYBOOK_FILES.scope === 'autodeploy' ? ' · Autodeploy' : ''}`,
        present: new Set((PLAYBOOK_FILES.data?.roles || []).filter((role) => !role.dependency_of).map((role) => role.name)) };
    document.getElementById('add_role_context').textContent = ADD_ROLE_TARGET.context;
    document.getElementById('add_role_src_project').innerHTML = '';
    document.getElementById('add_role_src_project').dataset.value = '';
    document.getElementById('add_role_import_tree').innerHTML = '';
    document.querySelector('input[name="add_role_mode"][value="existing"]').checked = true;
    document.getElementById('add_role_with_sub').checked = true;
    document.getElementById('add_role_name').value = '';
    document.getElementById('add_role_new_sub').checked = false;
    document.querySelectorAll('#add_role_parts input').forEach((box) => { box.checked = true; });
    document.getElementById('add_role_sub_block').classList.remove('is-open');
    ADD_ROLE_SUBROLES = mountChips(document.getElementById('add_role_subroles'), () => {});
    setStatusText('add_role_status', '');
    syncAddRoleMode();
    const tree = document.getElementById('add_role_tree');
    tree.innerHTML = '<div class="muted">Загрузка ролей…</div>';
    showModalSmooth('add_role_modal');
    const present = ADD_ROLE_TARGET.present;
    fetch(`${API.ROLES_TREE}?${contextQuery(`&scope=${ADD_ROLE_TARGET.scope || ''}`)}`)
        .then((response) => response.json())
        .then((data) => {
            renderRolePickTree(tree, data.roles || [], present, ADD_ROLE_TARGET.mode === 'draft' ? 'уже выбрана' : 'уже в плейбуке', 'Ролей пока нет — создайте новую на вкладке «Новая роль».');
        })
        .catch(() => { tree.innerHTML = '<div class="muted">Не удалось загрузить роли</div>'; });
}

// вкладки «Существующие» / «Новая роль»
function syncAddRoleMode() {
    const mode = document.querySelector('input[name="add_role_mode"]:checked').value;
    if (mode === 'import' && !document.getElementById('add_role_src_project').dataset.value) loadAddRoleImportSources();
    [['add_role_existing', 'existing'], ['add_role_new', 'new'], ['add_role_import', 'import']].forEach(([id, value]) => {
        const pane = document.getElementById(id);
        pane.classList.toggle('is-active', mode === value);
        pane.inert = mode !== value;   // скрытая панель не ловит фокус по Tab
    });
    if (mode === 'new') setTimeout(() => document.getElementById('add_role_name').focus(), 180);
}
document.querySelectorAll('input[name="add_role_mode"]').forEach((input) => input.addEventListener('change', syncAddRoleMode));
document.getElementById('add_role_new_sub')?.addEventListener('change', (event) => document.getElementById('add_role_sub_block').classList.toggle('is-open', event.target.checked));

// отметка роли или группы в любом дереве ролей: с «С подролями» (а у группы — всегда) отмечаются и все её подроли
document.addEventListener('change', (event) => {
    const box = event.target.closest?.('.role-pick-tree[data-sub-toggle] input[data-ref]');
    if (!box) return;
    const tree = box.closest('.role-pick-tree');
    if (box.dataset.role === '1' && !document.getElementById(tree.dataset.subToggle)?.checked) return;
    const prefix = `${box.dataset.ref}/`;
    tree.querySelectorAll('input[data-ref]').forEach((other) => { if (other.dataset.ref.startsWith(prefix) && !other.disabled) other.checked = box.checked; });
});

// добавляет выбранные роли (или создаёт новую — с подролями или без)
function submitAddRole() {
    const mode = document.querySelector('input[name="add_role_mode"]:checked').value;
    let roles = [];
    if (mode === 'import') return submitRoleImport();
    if (mode === 'existing') {
        roles = [...document.querySelectorAll('#add_role_tree input[data-role="1"]:checked:not(:disabled)')].map((box) => box.dataset.ref);
        if (!roles.length) return setStatusText('add_role_status', 'Отметьте роли', 'error');
    } else {
        const name = document.getElementById('add_role_name').value.trim();
        if (!name || !name.split('/').every(isItemName)) return setStatusText('add_role_status', 'Имя роли: латинские буквы, цифры, точка, дефис, подчёркивание', 'error');
        const subroles = document.getElementById('add_role_new_sub').checked ? ADD_ROLE_SUBROLES() : [];
        if (subroles.some((sub) => !isItemName(sub))) return setStatusText('add_role_status', 'Имя подроли: латинские буквы, цифры, точка, дефис, подчёркивание', 'error');
        if (document.getElementById('add_role_new_sub').checked && !subroles.length) return setStatusText('add_role_status', 'Добавьте подроли или снимите «С подролями»', 'error');
        roles = subroles.length ? subroles.map((sub) => `${name}/${sub}`) : [name];
    }
    const parts = mode === 'new' ? [...document.querySelectorAll('#add_role_parts input:checked')].map((box) => box.value) : null;
    if (parts && !parts.length) return setStatusText('add_role_status', 'Отметьте хотя бы одну папку роли', 'error');
    if (ADD_ROLE_TARGET.mode === 'draft') {
        // черновик «Нового плейбука»: роли запоминаются, создаются вместе с плейбуком
        roles.forEach((ref) => { if (!DRAFT_ROLES.some((item) => item.ref === ref)) DRAFT_ROLES.push({ ref, isNew: mode === 'new', parts }); });
        hideModalSmooth('add_role_modal');
        renderDraftRoles();
        return;
    }
    api(API.PLAYBOOK_ROLES_ADD, { project: CURRENT_PROJECT, object: CURRENT_OBJECT, playbook: PLAYBOOK_FILES.name, roles, scope: PLAYBOOK_FILES.scope, parts })
        .then((data) => {
            hideModalSmooth('add_role_modal');
            const parts = [];
            if (data.added.length) parts.push(`добавлено: ${data.added.join(', ')}`);
            if (data.created.length) parts.push(`создано: ${data.created.join(', ')}`);
            if (data.skipped.length) parts.push(`уже были: ${data.skipped.join(', ')}`);
            notify(`Роли — ${parts.join('; ')}`, data.added.length ? 'success' : 'info');
            refreshPlaybookFiles();
            loadMain();   // строки ролей под плейбуком в списке — сразу
        })
        .catch((error) => setStatusText('add_role_status', error.message, 'error'));
}
document.getElementById('add_role_name')?.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); submitAddRole(); } });

// роль упомянута в плейбуке, но папки нет — создать скелет
function createMissingRole(role) {
    api(API.ROLE_CREATE, { project: CURRENT_PROJECT, object: CURRENT_OBJECT, role, scope: PLAYBOOK_FILES.scope })
        .then(() => { notify(`Роль «${role}» создана`, 'success'); refreshPlaybookFiles(); })
        .catch((error) => notify(error.message, 'error'));
}

// «Убрать из плейбука»: по желанию — удалить и файлы роли (если другие плейбуки её не используют)
function removeRoleFromPlaybook(role) {
    const info = (PLAYBOOK_FILES.data?.roles || []).find((item) => item.name === role) || { used_by: [] };
    const used = info.used_by.length;
    showConfirmation('Убрать роль из плейбука?',
        `Роль <strong>${esc(role)}</strong> будет убрана из <strong>${esc(PLAYBOOK_FILES.name)}</strong> (комментарии и оформление файла сохранятся).
        ${info.found ? `<label class="wizard-check wizard-gap"><input type="checkbox" id="remove_role_files" ${used ? 'disabled' : ''}><span>Удалить и папку роли со всеми файлами (в корзину backups/deleted)</span></label>
        ${used ? `<div class="wizard-hint">Удалить файлы нельзя: роль используется ещё в ${esc(info.used_by.join(', '))}.</div>` : ''}` : ''}`,
        () => {
            const deleteFiles = Boolean(document.getElementById('remove_role_files')?.checked);
            api(API.PLAYBOOK_ROLE_REMOVE, { project: CURRENT_PROJECT, object: CURRENT_OBJECT, playbook: PLAYBOOK_FILES.name, role, delete_files: deleteFiles, scope: PLAYBOOK_FILES.scope })
                .then((data) => {
                    notify(`${deleteFiles ? `Роль «${role}» убрана и удалена` : `Роль «${role}» убрана из плейбука`}${data.pruned?.length ? `; удалена опустевшая папка ${data.pruned.join(', ')}` : ''}`, 'success');
                    refreshPlaybookFiles();
                    loadMain();
                })
                .catch((error) => notify(error.message, 'error'));
        }, 'Убрать', 'danger', 'Файлы плейбука');
}

// удаление файла роли (в корзину)
function deleteRoleFile(path) {
    showConfirmation('Удалить файл?', `Файл <strong>${esc(shownPath(path))}</strong> будет удалён. Копия останется в корзине backups/deleted рядом с web1x.py.`,
        () => api(API.ROLE_FILE_DELETE, { project: CURRENT_PROJECT, object: CURRENT_OBJECT, path, scope: PLAYBOOK_FILES.scope })
            .then(() => { notify(`Файл ${shownPath(path)} удалён`, 'success'); refreshPlaybookFiles(); })
            .catch((error) => notify(error.message, 'error')),
        'Удалить', 'danger', 'Файлы плейбука');
}


// Enter в полях окон создания — как основная кнопка; Esc и щелчок по фону — закрыть
[['create_playbook_name', createPlaybook], ['create_playbook_hosts', createPlaybook], ['wizard_name', () => { if (!document.getElementById('wizard_create_btn').disabled) createProjectFromWizard(); }]]
    .forEach(([id, action]) => document.getElementById(id)?.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); action(); } }));
document.addEventListener('click', (event) => {
    if (event.target.id === 'project_wizard_modal') closeProjectWizard();
    if (['create_playbook_modal', 'playbook_files_modal', 'add_role_modal', 'import_modal', 'cfg_compare_modal', 'run_report_modal', 'history_modal'].includes(event.target.id)) hideModalSmooth(event.target.id);
    if (event.target.id === 'file_editor_modal') closeFileEditor();
});
window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || document.querySelector('#run_confirm_modal:not([hidden])')) return;
    if (!document.getElementById('file_editor_modal').hidden) return closeFileEditor();
    // по одному окну за нажатие: сначала верхнее (окна создания лежат поверх «Файлов плейбука»)
    const top = ['history_modal', 'cfg_compare_modal', 'run_report_modal', 'import_modal', 'add_role_modal', 'project_wizard_modal', 'create_playbook_modal', 'playbook_files_modal'].find((id) => !document.getElementById(id).hidden);
    if (top) hideModalSmooth(top);
});
window.openProjectWizard = openProjectWizard;


// ============================================================================
// Подсказки при наборе (автодополнение) в редакторе
// Справочник модулей — с сервера (из установленного Ansible или встроенный),
// контекст — роли, хендлеры, шаблоны, переменные текущего проекта/объекта.
// ============================================================================
const ANSIBLE = { catalog: null, catalogPromise: null, docs: new Map(), docPromises: new Map(), context: null };
const TASK_LIST_KEYS = new Set(['tasks', 'pre_tasks', 'post_tasks', 'handlers', 'block', 'rescue', 'always']);
const EXPRESSION_KEYS = new Set(['when', 'changed_when', 'failed_when', 'until', 'that', 'loop', 'with_items', 'msg', 'var']);
const COMMON_STATES = ['present', 'absent', 'started', 'stopped', 'restarted', 'reloaded', 'latest', 'directory', 'file', 'link', 'touch', 'mounted'];
const VALUE_CHOICES = { strategy: ['linear', 'free', 'debug', 'host_pinned'], become_method: ['sudo', 'su', 'pbrun', 'pfexec', 'doas', 'dzdo', 'ksu', 'runas', 'machinectl'], order: ['inventory', 'reverse_inventory', 'sorted', 'reverse_sorted', 'shuffle'], connection: ['ssh', 'local', 'paramiko', 'winrm', 'docker'] };
const CC_KINDS = { namespace: '⋯', module: 'М', keyword: 'К', option: 'П', value: 'З', variable: '$', filter: 'Ф', handler: 'Х', role: 'Р', file: 'Ф' };
let CC = { editor: null, textarea: null, items: [], index: 0, from: 0, to: 0, el: null };

// справочник модулей: один раз за страницу; пока сервер строит полный — переспрашиваем
function loadAnsibleCatalog() {
    if (ANSIBLE.catalogPromise) return ANSIBLE.catalogPromise;
    ANSIBLE.catalogPromise = fetch(`${API.ANSIBLE_CATALOG}?_=${Date.now()}`)
        .then((response) => response.json())
        .then((data) => {
            const modules = (data.modules || []).map((item) => {
                const short = item.n.split('.').pop();
                return { n: item.n, short, d: item.d || '', builtin: item.n.startsWith('ansible.builtin.') };
            });
            const byName = new Map(modules.map((item) => [item.n, item]));
            const byShort = new Map();
            modules.forEach((item) => { if (!byShort.has(item.short) || item.builtin) byShort.set(item.short, item); });
            const namespaces = new Map();
            modules.forEach((item) => {
                const parts = item.n.split('.');
                for (let depth = 1; depth < parts.length; depth += 1) {
                    const ns = `${parts.slice(0, depth).join('.')}.`;
                    namespaces.set(ns, (namespaces.get(ns) || 0) + 1);
                }
            });
            ANSIBLE.catalog = { ...data, modules, byName, byShort, namespaces };
            Object.entries(data.options || {}).forEach(([name, options]) => { if (!ANSIBLE.docs.has(name)) ANSIBLE.docs.set(name, { options, builtin: true }); });
            if (data.loading) setTimeout(() => { ANSIBLE.catalogPromise = null; loadAnsibleCatalog(); }, 8000);
            return ANSIBLE.catalog;
        })
        .catch(() => { ANSIBLE.catalogPromise = null; return null; });
    return ANSIBLE.catalogPromise;
}

// контекст проекта для открытого файла
function loadAnsibleContext(ctx) {
    ANSIBLE.context = null;
    const extra = `&kind=${encodeURIComponent(ctx?.kind || '')}&path=${encodeURIComponent(ctx?.path || '')}&scope=${encodeURIComponent(ctx?.scope || '')}&_=${Date.now()}`;
    return fetch(`${API.ANSIBLE_CONTEXT}?${contextQuery(extra)}`).then((response) => response.json()).then((data) => { ANSIBLE.context = data; }).catch(() => {});
}

// при открытии файла в редакторе
function prepareCompletion(editor) { closeCompletion(); loadAnsibleCatalog(); loadAnsibleContext(editor.ctx); }

// модуль по ключу в тексте: полное имя или короткое (apt → ansible.builtin.apt)
function resolveModule(key) {
    const catalog = ANSIBLE.catalog;
    if (!catalog || !key) return null;
    return catalog.byName.get(key) || (!key.includes('.') ? catalog.byShort.get(key) : null) || null;
}

// параметры модуля: при полном справочнике — с сервера (ansible-doc), иначе — встроенные
function moduleDoc(name) {
    const cached = ANSIBLE.docs.get(name);
    if (cached && (cached.fetched || ANSIBLE.catalog?.source !== 'ansible-doc')) return cached;
    if (!ANSIBLE.docPromises.has(name)) {
        ANSIBLE.docPromises.set(name, fetch(`${API.ANSIBLE_MODULE}?name=${encodeURIComponent(name)}`)
            .then((response) => response.json())
            .then((data) => { ANSIBLE.docs.set(name, { options: data.options || [], fetched: true }); if (CC.editor) openCompletion(CC.editor, CC.textarea, CC.forced); })
            .catch(() => {}));
    }
    return cached || null;
}

// вид файла: задачи/хендлеры, плейбук, шаблон, переменные
function editorFileKind(ctx) {
    if (!ctx) return 'none';
    if (ctx.kind === 'playbook') return 'playbook';
    if (ctx.kind === 'object') return /\.ya?ml$/i.test(ctx.path || '') ? 'vars' : 'none';
    const path = ctx.path || '';
    const folder = (path.includes('|') ? path.split('|')[1].split('/')[0] : path.split('/')[1]) || '';
    if (folder === 'tasks' || folder === 'handlers') return 'taskfile';
    if (folder === 'templates') return 'template';
    if (folder === 'defaults' || folder === 'vars') return 'vars';
    return 'none';
}

// предки строки по отступам YAML — от ближайшего: {key} или {item}
function yamlAncestors(lines, row, startIndent, startIsItem) {
    const out = [];
    let target = startIndent, childIsItem = startIsItem;
    for (let i = row - 1; i >= 0; i -= 1) {
        const line = lines[i], trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const indent = line.search(/\S/), isItem = /^\s*-(\s|$)/.test(line), keyIndent = isItem ? indent + 2 : indent;
        const key = line.match(/^\s*(?:-\s+)?([\w.\/-]+):\s*(?:#.*)?$/);
        if (key && (keyIndent < target || (keyIndent === target && childIsItem))) {
            out.push({ key: key[1] });
            if (isItem) out.push({ item: true });
            target = indent; childIsItem = isItem;
            continue;
        }
        if (isItem && keyIndent === target && !childIsItem) { out.push({ item: true }); target = indent; childIsItem = true; }
        if (target === 0 && out.length && out[out.length - 1].item) break;
    }
    return out;
}

// ключи, уже написанные в том же словаре (чтобы не предлагать их повторно)
function siblingKeys(lines, row, keyIndent) {
    const keys = new Set();
    const collect = (line) => {
        const indent = line.search(/\S/), isItem = /^\s*-\s/.test(line);
        const m = line.match(/^\s*(?:-\s+)?([\w.\/-]+):/);
        if (m && (isItem ? indent + 2 : indent) === keyIndent) keys.add(m[1]);
    };
    for (let i = row - 1; i >= 0; i -= 1) {
        const line = lines[i];
        if (!line.trim() || line.trim().startsWith('#')) continue;
        const indent = line.search(/\S/), isItem = /^\s*-\s/.test(line);
        if (indent < keyIndent && !(isItem && indent + 2 === keyIndent)) break;
        collect(line);
        if (isItem && indent + 2 === keyIndent) break;
    }
    for (let i = row + 1; i < lines.length; i += 1) {
        const line = lines[i];
        if (!line.trim() || line.trim().startsWith('#')) continue;
        const indent = line.search(/\S/);
        if (indent < keyIndent || /^\s*-\s/.test(line) && indent + 2 <= keyIndent) break;
        collect(line);
    }
    return keys;
}

// отбор по первым буквам и порядок: точное совпадение → начало слова → остальное
function rankItems(items, prefix, limit = 150) {
    const p = prefix.toLowerCase();
    return items
        .map((item) => {
            const label = item.label.toLowerCase(), full = (item.full || item.label).toLowerCase();
            const alt = (item.alt || '').toLowerCase();   // переменная «defaults.dhcpiface» находится и по «dhcp…»
            const score = label === p ? 0 : label.startsWith(p) ? 1 + (item.rank || 0) : alt && alt.startsWith(p) ? 3 + (item.rank || 0) : full.startsWith(p) ? 5 + (item.rank || 0) : -1;
            return { item, score };
        })
        .filter((entry) => !p || entry.score >= 0)
        .sort((a, b) => (p ? a.score - b.score : (a.item.rank || 0) - (b.item.rank || 0)) || a.item.label.localeCompare(b.item.label))
        .slice(0, limit)
        .map((entry) => entry.item);
}

// переменные: из контекста проекта, register в этом файле, служебные
function variableItems(text) {
    const items = [];
    const seen = new Set();
    const add = (name, detail, rank) => { if (!seen.has(name)) { seen.add(name); items.push({ label: name, kind: 'variable', detail, rank, alt: name.includes('.') ? name.split('.').pop() : '' }); } };
    for (const match of text.matchAll(/^\s*register:\s*([A-Za-z_]\w*)/gm)) add(match[1], 'register в этом файле', 0);
    for (const match of text.matchAll(/^\s*loop_var:\s*([A-Za-z_]\w*)/gm)) add(match[1], 'переменная цикла', 0);
    (ANSIBLE.context?.variables || []).forEach((v) => add(v.n, v.s, 1));
    (ANSIBLE.catalog?.magic || []).forEach((v) => add(v.n, v.d, 2));
    return items;
}

// что подсказывать в позиции курсора: { from, to, items } или null
function computeCompletion(editor, textarea, forced) {
    const catalog = ANSIBLE.catalog;
    if (!catalog || textarea.readOnly || textarea.selectionStart !== textarea.selectionEnd) return null;
    const text = textarea.value, caret = textarea.selectionStart;
    const lineStart = text.lastIndexOf('\n', caret - 1) + 1;
    const before = text.slice(lineStart, caret);
    const lines = text.split('\n');
    const row = text.slice(0, lineStart).split('\n').length - 1;
    const fileKind = editorFileKind(editor.ctx);
    const word = (before.match(/[\w.\/-]*$/) || [''])[0];

    // 1) внутри {{ … }}: переменные; после «|» — фильтры
    const open = before.lastIndexOf('{{'), close = before.lastIndexOf('}}');
    if (open > close) {
        const jword = (before.match(/[A-Za-z_][\w.]*$/) || [''])[0];   // с точками: «defaults.dhcp…»
        if (!jword && !forced) return null;
        const head = before.slice(0, before.length - jword.length).trimEnd();
        const items = head.endsWith('|')
            ? (catalog.filters || []).map((f) => ({ label: f.n, kind: 'filter', detail: f.d }))
            : variableItems(text);
        const closeJinja = !head.endsWith('|') && !text.slice(caret).split('\n')[0].includes('}}');
        return { from: caret - jword.length, to: caret, items: rankItems(items, jword).map((item) => ({ ...item, closeJinja })) };
    }
    if (fileKind === 'template' || fileKind === 'none') return null;
    if (fileKind === 'vars') return null;

    // 2) значение «ключ: …»
    const valueMatch = before.match(/^(\s*)(-\s+)?([\w.\/-]+):\s+(.*)$/);
    if (valueMatch) {
        const key = valueMatch[3], rest = valueMatch[4];
        const keyIndent = valueMatch[1].length + (valueMatch[2] ? 2 : 0);
        const anc = yamlAncestors(lines, row, keyIndent, false);
        const parentModule = anc[0]?.key ? resolveModule(anc[0].key) : null;
        let items = [], prefix = rest;
        if (key === 'notify' || key === 'listen') {
            items = (ANSIBLE.context?.handlers || []).map((h) => ({ label: h.n, kind: 'handler', detail: h.s }));
        } else if (EXPRESSION_KEYS.has(key)) {
            prefix = (rest.match(/[A-Za-z_][\w.]*$/) || [''])[0];
            if (!prefix && !forced) return null;
            items = variableItems(text);
        } else if (/^[\w.\/-]*$/.test(rest)) {
            const doc = parentModule ? moduleDoc(parentModule.n) : null;
            const option = doc?.options?.find((o) => o.n === key);
            if (key === 'hosts') items = ['all', ...(ANSIBLE.context?.groups || [])].map((g) => ({ label: g, kind: 'value', detail: 'группа inventory' }));
            else if (key === 'name' && parentModule && /\.(include|import)_role$/.test(parentModule.n)) items = (ANSIBLE.context?.roles || []).map((r) => ({ label: r, kind: 'role', detail: 'роль' }));
            else if (key === 'src' && parentModule?.short === 'template') items = (ANSIBLE.context?.templates || []).map((f) => ({ label: f, kind: 'file', detail: 'templates/' }));
            else if (key === 'src' && parentModule?.short === 'copy') items = (ANSIBLE.context?.files || []).map((f) => ({ label: f, kind: 'file', detail: 'files/' }));
            else if (option?.c?.length) items = option.c.map((c) => ({ label: c, kind: 'value', detail: `вариант ${key}` }));
            else if (option?.t === 'bool' || (catalog.boolean_keys || []).includes(key)) items = ['true', 'false'].map((v) => ({ label: v, kind: 'value', detail: 'логическое' }));
            else if (key === 'meta' || resolveModule(key)?.short === 'meta') items = (catalog.meta_actions || []).map((v) => ({ label: v, kind: 'value', detail: 'meta' }));
            else if (VALUE_CHOICES[key]) items = VALUE_CHOICES[key].map((v) => ({ label: v, kind: 'value', detail: key }));
            else if (key === 'state') items = COMMON_STATES.map((v) => ({ label: v, kind: 'value', detail: 'state' }));
        }
        if (!items.length || (!prefix && !forced)) return null;
        return { from: caret - prefix.length, to: caret, items: rankItems(items, prefix) };
    }

    // 3) ключ: «  ключ», «- ключ» или элемент списка («- роль» в roles:, «- хендлер» в notify:)
    const keyMatch = before.match(/^(\s*)(-\s+)?([\w.\/-]*)$/);
    if (!keyMatch) return null;
    const prefix = keyMatch[3];
    if (!prefix && !forced) return null;
    const isItem = Boolean(keyMatch[2]);
    const keyIndent = keyMatch[1].length + (isItem ? 2 : 0);
    const anc = yamlAncestors(lines, row, isItem ? keyMatch[1].length : keyIndent, isItem);
    const present = siblingKeys(lines, row, keyIndent);
    const nearestKey = anc[0]?.key;
    let scope = 'none';
    if (!anc.length) scope = isItem || fileKind === 'taskfile' ? (fileKind === 'playbook' ? 'play' : 'task') : 'none';
    else if (nearestKey) {
        if (TASK_LIST_KEYS.has(nearestKey) && isItem) scope = 'task';
        else if (nearestKey === 'roles' && isItem) scope = 'roles';
        else if (nearestKey === 'notify' && isItem) scope = 'handlers';
        else if (nearestKey === 'loop_control') scope = 'loop_control';
        else if (!isItem && resolveModule(nearestKey)) scope = 'module';
    } else if (anc[0]?.item) {
        const parentKey = anc[1]?.key;
        if (!parentKey) scope = fileKind === 'playbook' ? 'play' : 'task';
        else if (TASK_LIST_KEYS.has(parentKey)) scope = 'task';
    }
    let items = [];
    const keyword = (k) => ({ label: k.n, kind: 'keyword', detail: k.d, value: k.v, rank: 0 });
    if (scope === 'task') {
        // набрано с точкой («ansible.», «ansible.builtin.co») — модули подписаны полным именем;
        // без точки — встроенные коротко («copy»), коллекции полностью. Встроенные всегда выше коллекций.
        const dotted = prefix.includes('.');
        const typedDepth = prefix.split('.').length - 1;
        const namespaceItems = [...(catalog.namespaces || new Map())]
            // следующая часть имени; «ansible.builtin.» — ещё и сразу, как ярлык, пока набрано без точки («ans…»)
            .filter(([ns]) => (ns.split('.').length - 1 === typedDepth + 1 || (!dotted && ns === 'ansible.builtin.'))
                && ns.toLowerCase().startsWith(prefix.toLowerCase()) && (dotted || prefix.length >= 2))
            .map(([ns, count]) => ({ label: ns, kind: 'namespace', detail: `${count} ${plural(count, 'модуль', 'модуля', 'модулей')}`,
                rank: !dotted ? (ns === 'ansible.builtin.' ? 1.4 : 1.5) : ns.startsWith('ansible.builtin.') || ns === 'ansible.' ? 0 : 0.5 }));
        items = (catalog.task_keywords || []).filter((k) => !present.has(k.n)).map(keyword)
            .concat(namespaceItems)
            .concat(catalog.modules.map((m) => ({ label: dotted || !m.builtin ? m.n : m.short, full: m.n, kind: 'module', detail: m.d, module: m.n, rank: m.builtin ? 1 : 2 })));
    } else if (scope === 'play') {
        items = (catalog.play_keywords || []).filter((k) => !present.has(k.n)).map(keyword);
    } else if (scope === 'module') {
        const module = resolveModule(nearestKey);
        const doc = moduleDoc(module.n);
        items = (doc?.options || []).filter((o) => !present.has(o.n)).map((o) => ({
            label: o.n, kind: 'option', option: o, rank: o.r ? 0 : 1,
            detail: `${o.t || 'str'}${o.r ? ' · обязательный' : ''}${o.c?.length ? ` · ${o.c.join(' | ')}` : ''}`, doc: o.d }));
        if (!doc) items = [{ label: 'Загрузка параметров…', kind: 'value', disabled: true, detail: module.n }];
    } else if (scope === 'roles') {
        items = (ANSIBLE.context?.roles || []).map((r) => ({ label: r, kind: 'role', detail: 'роль' }));
    } else if (scope === 'handlers') {
        items = (ANSIBLE.context?.handlers || []).map((h) => ({ label: h.n, kind: 'handler', detail: h.s }));
    } else if (scope === 'loop_control') {
        items = (catalog.loop_control || []).filter((k) => !present.has(k.n)).map((k) => ({ label: k.n, kind: 'keyword', detail: k.d, value: 'scalar' }));
    }
    if (!items.length) return null;
    return { from: caret - prefix.length, to: caret, items: rankItems(items, prefix), keyIndent };
}

// открывает (или обновляет) список подсказок; forced — Ctrl+Пробел или сразу после вставки
function openCompletion(editor, textarea, forced = false) {
    const result = computeCompletion(editor, textarea, forced);
    if (!result || !result.items.length) return closeCompletion();
    CC = { ...CC, editor, textarea, items: result.items, index: 0, from: result.from, to: result.to, keyIndent: result.keyIndent, forced };
    renderCompletion();
}

// подсказки после ввода печатного символа
function scheduleCompletion(editor, textarea, event) {
    if (editor.suppressCompletion) { editor.suppressCompletion = false; return; }
    if (event && event.inputType && !event.inputType.startsWith('insert')) { if (CC.editor === editor) openCompletion(editor, textarea, false); return; }
    const char = event?.data || '';
    if (char && !/[\w.\-\/{|: ]/.test(char)) return closeCompletion();
    openCompletion(editor, textarea, false);   // сразу: при быстром наборе список не должен отставать от текста
}

// клавиши, пока открыт список: ↑ ↓ — выбор, Enter/Tab — вставить, Esc — закрыть
function handleCompletionKey(event, editor, textarea) {
    if (!CC.el || CC.editor !== editor || CC.el.hidden) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        CC.index = (CC.index + (event.key === 'ArrowDown' ? 1 : -1) + CC.items.length) % CC.items.length;
        renderCompletion();
        return true;
    }
    if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
        if (textarea.selectionStart !== CC.to || textarea.selectionEnd !== CC.to) { closeCompletion(); return false; }
        event.preventDefault();
        acceptCompletion(CC.index);
        return true;
    }
    if (event.key === 'Escape') { event.preventDefault(); closeCompletion(); return true; }
    return false;
}
// Esc, пока открыт список, закрывает только список, а не окно редактора
window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && CC.el && !CC.el.hidden) { event.stopImmediatePropagation(); event.preventDefault(); closeCompletion(); }
}, true);

// вставляет выбранную подсказку
function acceptCompletion(index) {
    const item = CC.items[index];
    const { textarea, editor } = CC;
    if (!item || item.disabled || !textarea) return closeCompletion();
    const lineStart = textarea.value.lastIndexOf('\n', CC.from - 1) + 1;
    const column = CC.keyIndent ?? (CC.from - lineStart);
    const pad = (n) => ' '.repeat(n);
    let text = item.label, reopen = false;
    if (item.kind === 'module') { text = `${item.module}:\n${pad(column + 2)}`; reopen = true; }
    else if (item.kind === 'namespace') { text = item.label; reopen = true; }
    else if (item.kind === 'keyword') {
        if (item.value === 'list') text = `${item.label}:\n${pad(column + 2)}- `;
        else if (item.value === 'map') text = `${item.label}:\n${pad(column + 2)}`;
        else { text = `${item.label}: `; reopen = (ANSIBLE.catalog?.boolean_keys || []).includes(item.label) || ['hosts', 'notify', 'strategy', 'become_method'].includes(item.label); }
    } else if (item.kind === 'option') { text = `${item.label}: `; reopen = Boolean(item.option?.c?.length) || item.option?.t === 'bool' || ['src', 'name'].includes(item.label); }
    else if (item.kind === 'variable' && item.closeJinja) text = `${item.label} }}`;
    editor.suppressCompletion = true;
    textarea.setSelectionRange(CC.from, CC.to);
    insertCodeText(textarea, text);
    if (item.kind === 'variable' && item.closeJinja) textarea.setSelectionRange(textarea.selectionStart - 3, textarea.selectionStart - 3);
    closeCompletion();
    if (reopen) setTimeout(() => openCompletion(editor, textarea, true), 0);
}

// закрывает список
function closeCompletion() {
    if (CC.el) CC.el.hidden = true;
    CC.editor = null;
}

// рисует список подсказок у курсора
function renderCompletion() {
    if (!CC.el) {
        CC.el = document.createElement('div');
        CC.el.className = 'code-completion';
        CC.el.setAttribute('role', 'listbox');
        CC.el.addEventListener('mousedown', (event) => {
            event.preventDefault();   // фокус остаётся в редакторе
            const row = event.target.closest('.cc-item');
            if (row) acceptCompletion(Number(row.dataset.index));
        });
        document.body.appendChild(CC.el);
    }
    const active = CC.items[CC.index];
    CC.el.innerHTML = `<div class="cc-list">${CC.items.map((item, index) => `
        <div class="cc-item${index === CC.index ? ' is-active' : ''}${item.disabled ? ' is-disabled' : ''}" data-index="${index}" role="option">
            <span class="cc-kind cc-kind-${item.kind}">${CC_KINDS[item.kind] || '·'}</span>
            <span class="cc-label">${esc(item.label)}</span>
            <span class="cc-detail">${esc(item.kind === 'module' && item.full !== item.label ? item.full : (item.kind === 'module' ? '' : item.detail || ''))}</span>
        </div>`).join('')}</div>
        <div class="cc-doc">${esc(active?.doc || (active?.kind === 'module' ? active.detail : '') || '')}<span class="cc-keys">↑↓ выбор · Enter вставить · Esc закрыть</span></div>`;
    CC.el.hidden = false;
    CC.el.querySelector('.cc-item.is-active')?.scrollIntoView({ block: 'nearest' });
    positionCompletion();
}

// позиция списка: под курсором (или над ним, если внизу не хватает места)
function positionCompletion() {
    if (!CC.el || CC.el.hidden || !CC.textarea) return;
    const textarea = CC.textarea, style = getComputedStyle(textarea);
    const canvas = positionCompletion.canvas || (positionCompletion.canvas = document.createElement('canvas'));
    const context = canvas.getContext('2d');
    context.font = `${style.fontSize} ${style.fontFamily}`;
    const charWidth = context.measureText('M').width;
    const lineHeight = parseFloat(style.lineHeight) || 20;
    const before = textarea.value.slice(0, CC.from);
    const row = before.split('\n').length - 1, column = CC.from - (before.lastIndexOf('\n') + 1);
    const rect = textarea.getBoundingClientRect();
    let left = rect.left + parseFloat(style.paddingLeft) + column * charWidth - textarea.scrollLeft - 30;
    const lineTop = rect.top + parseFloat(style.paddingTop) + row * lineHeight - textarea.scrollTop;
    // строка курсора прокручена из видимой области — список не нужен
    if (lineTop + lineHeight < rect.top || lineTop > rect.bottom) return closeCompletion();
    const width = CC.el.offsetWidth, height = CC.el.offsetHeight;
    let top = lineTop + lineHeight + 2;                                     // под строкой курсора…
    if (top + height > window.innerHeight - 8) top = lineTop - height - 4;  // …или над ней, если внизу мало места
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    CC.el.style.left = `${left}px`;
    CC.el.style.top = `${Math.max(8, top)}px`;
}
window.addEventListener('resize', closeCompletion);


// ============================================================================
// Подсветка синтаксиса в редакторе: YAML (плейбуки, роли), INI (ansible.cfg), Jinja2 (*.j2)
// ============================================================================
const HL_KEYWORDS = new Set(['name', 'hosts', 'become', 'become_user', 'become_method', 'gather_facts', 'vars', 'vars_files', 'roles', 'role',
    'tasks', 'pre_tasks', 'post_tasks', 'handlers', 'block', 'rescue', 'always', 'when', 'loop', 'loop_control', 'with_items', 'register',
    'notify', 'listen', 'tags', 'ignore_errors', 'changed_when', 'failed_when', 'until', 'retries', 'delay', 'delegate_to', 'run_once',
    'no_log', 'environment', 'serial', 'strategy', 'import_playbook', 'include_tasks', 'import_tasks', 'include_role', 'import_role',
    'dependencies', 'galaxy_info', 'collections', 'module_defaults', 'any_errors_fatal', 'check_mode', 'diff', 'async', 'poll', 'args', 'vars_prompt']);

// язык файла: плейбук и *.yml — YAML, ansible.cfg — INI, *.j2 — Jinja2, остальное — без подсветки
function codeLanguage(ctx) {
    if (!ctx) return 'plain';
    if (ctx.kind === 'playbook') return 'yaml';
    const path = String(ctx.path || '').split('|').pop().toLowerCase();
    if (/\.ya?ml$/.test(path) || path === 'inventory' || /(^|\/)(defaults|vars|tasks|handlers|meta)\/main$/.test(path)) return 'yaml';
    if (/\.(cfg|ini)$/.test(path)) return 'ini';
    if (/\.j2$/.test(path)) return 'jinja';
    return 'plain';
}

const hlEsc = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const hlSpan = (cls, text) => text ? `<span class="tk-${cls}">${hlEsc(text)}</span>` : '';

// текст с выражениями Jinja2: {{ … }}, {% … %}, {# … #}
function hlJinja(text, base = '') {
    return text.split(/(\{\{.*?\}\}|\{%.*?%\}|\{#.*?#\})/).map((part, index) => index % 2
        ? hlSpan(part.startsWith('{#') ? 'comment' : 'jinja', part)
        : (base ? hlSpan(base, part) : hlEsc(part))).join('');
}

// значение после «ключ:» или элемент списка
function hlYamlValue(value) {
    // комментарий в конце строки — «#» после пробела и не внутри кавычек
    let quote = '', cut = -1;
    for (let i = 0; i < value.length; i += 1) {
        const ch = value[i];
        if (quote) { if (ch === quote) quote = ''; continue; }
        if (ch === '"' || ch === "'") quote = ch;
        else if (ch === '#' && (i === 0 || /\s/.test(value[i - 1]))) { cut = i; break; }
    }
    const body = cut >= 0 ? value.slice(0, cut) : value, comment = cut >= 0 ? value.slice(cut) : '';
    const trimmed = body.trim(), lead = body.slice(0, body.indexOf(trimmed)), tail = body.slice(lead.length + trimmed.length);
    let html;
    if (!trimmed) html = '';
    else if (/^(["']).*\1$/.test(trimmed)) html = hlJinja(trimmed, 'string');
    else if (/^(true|false|yes|no|on|off|null|~)$/i.test(trimmed)) html = hlSpan('bool', trimmed);
    else if (/^[-+]?(\d[\d_]*)(\.\d+)?([eE][-+]?\d+)?$/.test(trimmed) || /^0[xo][0-9a-f]+$/i.test(trimmed)) html = hlSpan('number', trimmed);
    else if (/^[|>][-+]?\d*$/.test(trimmed)) html = hlSpan('punct', trimmed);
    else if (/^[!&*]\S*/.test(trimmed)) { const [mark, ...rest] = trimmed.split(/(?=\s)/); html = hlSpan('tag', mark) + hlJinja(rest.join('')); }
    else if (/^[[{]/.test(trimmed) && !trimmed.startsWith('{{')) html = hlJinja(trimmed, 'flow');
    else html = hlJinja(trimmed);
    return hlEsc(lead) + html + hlEsc(tail) + hlSpan('comment', comment);
}

function hlYamlLine(line) {
    if (/^\s*#/.test(line)) return hlSpan('comment', line);
    if (/^(---|\.\.\.)\s*$/.test(line)) return hlSpan('doc', line);
    const [, indent, dashes, rest] = line.match(/^(\s*)((?:-(?:\s+|$))*)(.*)$/);
    let html = hlEsc(indent) + hlSpan('punct', dashes);
    const pair = rest.match(/^("[^"]*"|'[^']*'|[^\s#'"{[|>][^:#]*?)(\s*:)(?=\s|$)(.*)$/);
    if (!pair) return html + hlYamlValue(rest);
    const key = pair[1];
    const cls = /^[A-Za-z_][\w]*(\.[A-Za-z_]\w*){2,}$/.test(key) ? 'module' : HL_KEYWORDS.has(key) ? 'keyword' : /^["']/.test(key) ? 'string' : 'key';
    return html + hlSpan(cls, key) + hlSpan('punct', pair[2]) + hlYamlValue(pair[3]);
}

function hlIniLine(line) {
    if (/^\s*[#;]/.test(line)) return hlSpan('comment', line);
    const section = line.match(/^(\s*)(\[[^\]]*\])(.*)$/);
    if (section) return hlEsc(section[1]) + hlSpan('section', section[2]) + hlEsc(section[3]);
    const pair = line.match(/^(\s*)([^=:\s][^=:]*?)(\s*[=:]\s*)(.*)$/);
    if (pair) return hlEsc(pair[1]) + hlSpan('key', pair[2]) + hlSpan('punct', pair[3]) + hlYamlValue(pair[4]);
    return hlEsc(line);
}

// HTML подсветки всего текста; перевод строки в конце — чтобы высота слоя совпадала с полем ввода
function highlightCode(text, language) {
    const lines = text.split('\n');
    const render = language === 'yaml' ? hlYamlLine : language === 'ini' ? hlIniLine : language === 'jinja' ? (line) => hlJinja(line) : hlEsc;
    return lines.map(render).join('\n') + '\n';
}

// редактор плейбука собирается в самом конце — когда объявлены все функции подсветки и подсказок
enhanceCodeEditor(document.getElementById('playbook_editor'), { onSave: () => savePlaybookFromModal() });


// ============================================================================
// Прослушка: сканирование подсети — какие адреса заняты (память у каждого проекта своя)
// и подсветка поля IP при заполнении узла
// ============================================================================
let SUBNET_SCAN = null;
let SUBNET_SCAN_PROJECT = null;   // { subnet, total, scanned_at, used: {ip: mac} } — для текущего проекта

// загружает результат сканирования подсети текущего проекта (и ход сканирования, если идёт)
function loadSubnetScan() {
    return fetch(`${API.SUBNET_SCAN}?project=${encodeURIComponent(CURRENT_PROJECT)}&_=${Date.now()}`)
        .then((response) => response.json())
        .then((data) => { SUBNET_SCAN = data.result || null; applyIpHints(); return data; })
        .catch(() => null);
}

// поля «Подсеть» и «Маска» — из последнего сканирования проекта
function fillSubnetFields() {
    const address = document.getElementById('nmap_subnet_address'), mask = document.getElementById('nmap_subnet_mask');
    if (SUBNET_SCAN?.subnet && !address.value && !mask.value) [address.value, mask.value] = SUBNET_SCAN.subnet.split('/');
}

// запускает сканирование подсети
function startSubnetScan() {
    const subnet = document.getElementById('nmap_subnet_address').value.trim(), mask = document.getElementById('nmap_subnet_mask').value.trim();
    if (!subnet) { document.getElementById('nmap_subnet_address').focus(); return notify('Укажите подсеть, например 192.168.1.0', 'warning'); }
    document.getElementById('nmap_start_btn').disabled = true;
    api(API.SUBNET_SCAN_START, { project: CURRENT_PROJECT, subnet, mask })
        .then(() => { notify('Сканирование подсети запущено', 'info'); refreshSubnetScan(); })
        .catch((error) => { document.getElementById('nmap_start_btn').disabled = false; notify(error.message, 'error'); });
}

// забывает результат сканирования для проекта
function resetSubnetScan() {
    if (!SUBNET_SCAN) return notify('Для этого проекта подсеть ещё не сканировалась', 'info');
    showConfirmation('Сбросить результат сканирования?', `Результат сканирования подсети <strong>${esc(SUBNET_SCAN.subnet)}</strong> для проекта <strong>${esc(CURRENT_PROJECT)}</strong> будет удалён — подсветка свободных и занятых адресов в полях IP отключится.`,
        () => api(API.SUBNET_SCAN_RESET, { project: CURRENT_PROJECT })
            .then(() => { SUBNET_SCAN = null; applyIpHints(); notify('Результат сканирования сброшен', 'success'); refreshSubnetScan(); })
            .catch((error) => notify(error.message, 'error')),
        'Сбросить', 'danger', 'Подсеть');
}

// ход и результат сканирования — в окне прослушки: сводка и карта адресов подсети
function refreshSubnetScan() {
    loadSubnetScan().then((data) => {
        if (!data || getSelectedNmapMode() !== 'subnet') return;
        const startBtn = document.getElementById('nmap_start_btn'), stopBtn = document.getElementById('nmap_stop_btn');
        const running = data.running;
        startBtn.disabled = Boolean(running);
        stopBtn.disabled = true;
        document.getElementById('nmap_state_label').textContent = running ? `сканирование ${running.subnet}: ${running.done} из ${running.total}` : (SUBNET_SCAN ? `последнее сканирование: ${SUBNET_SCAN.scanned_at}` : 'подсеть не сканировалась');
        document.getElementById('nmap_subnet_reset').disabled = !SUBNET_SCAN || Boolean(running);
        document.getElementById('nmap_notice').hidden = true;
        const box = document.getElementById('nmap_devices');
        if (running) {
            const percent = Math.round((running.done / Math.max(running.total, 1)) * 100);
            box.innerHTML = `<div class="subnet-progress"><div class="subnet-progress-bar" style="width:${percent}%"></div></div><div class="muted subnet-progress-text">Проверено ${running.done} из ${running.total} адресов (${percent}%)</div>`;
            return;
        }
        if (!SUBNET_SCAN) {
            box.innerHTML = '<div class="empty-state"><b>Подсеть ещё не сканировалась</b><span>Укажите подсеть и маску и нажмите «Включить режим прослушки». Результат запомнится для этого проекта.</span></div>';
            return;
        }
        const used = SUBNET_SCAN.used || {}, usedCount = Object.keys(used).length, free = SUBNET_SCAN.total - usedCount;
        const [base, prefix] = SUBNET_SCAN.subnet.split('/');
        const start = ipToNumber(base), count = 2 ** (32 - Number(prefix));
        const cells = [];
        for (let offset = 1; offset < count - 1; offset += 1) {
            const ip = numberToIp(start + offset), mac = used[ip];
            const owner = inventoryOwnerOfIp(ip);
            cells.push(`<button type="button" class="subnet-cell ${mac !== undefined ? 'is-used' : 'is-free'}" data-ip="${ip}" title="${ip} — ${mac !== undefined ? `занят${mac ? ` (${esc(mac)})` : ''}` : 'свободен (щелчок — скопировать)'}${owner ? ` · в inventory: ${esc(owner)}` : ''}">${ip.split('.').pop()}</button>`);
        }
        box.innerHTML = `<div class="subnet-summary"><b>${esc(SUBNET_SCAN.subnet)}</b><span class="subnet-free">свободно ${free}</span><span class="subnet-used">занято ${usedCount}</span><span class="muted">${esc(SUBNET_SCAN.scanned_at)}</span></div>
            <div class="subnet-grid">${cells.join('')}</div>`;
    });
}
// щелчок по свободному адресу — скопировать его
document.addEventListener('click', (event) => {
    const cell = event.target.closest('.subnet-cell.is-free');
    if (!cell) return;
    copyText(cell.dataset.ip).then(() => notify(`Адрес ${cell.dataset.ip} скопирован`, 'success'), () => notify(`Не удалось скопировать — адрес ${cell.dataset.ip}`, 'warning'));
});

function ipToNumber(ip) { return ip.split('.').reduce((sum, part) => sum * 256 + Number(part), 0); }
function numberToIp(value) { return [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join('.'); }
function isIpv4(value) { return /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(value); }

// какому узлу текущего inventory уже назначен адрес (кроме exceptHost)
function inventoryOwnerOfIp(ip, exceptHost = '') {
    const node = (DATA?.hosts || []).find((item) => item.ip === ip && item.hostname !== exceptHost);
    return node ? node.hostname : '';
}

// поле IP узла: зелёное — свободен (по сканированию подсети), красное — занят или уже назначен другому узлу
const IP_FIELD_SELECTOR = '[data-key="ansible_host"], [data-new-key="ansible_host"]';
function applyIpHint(input) {
    input.classList.remove('ip-free', 'ip-busy');
    input.removeAttribute('data-ip-hint');
    const value = input.value.trim();
    if (!isIpv4(value)) return;
    const card = input.closest('.host-card');
    const owner = inventoryOwnerOfIp(value, card?.dataset.hostname || '');
    let busy = '', free = '';
    if (owner) busy = `Адрес уже назначен узлу ${owner}`;
    if (SUBNET_SCAN?.subnet) {
        const [base, prefix] = SUBNET_SCAN.subnet.split('/');
        const size = 2 ** (32 - Number(prefix)), start = ipToNumber(base), number = ipToNumber(value);
        if (number > start && number < start + size - 1) {
            const mac = SUBNET_SCAN.used?.[value];
            // адрес, который уже стоит у этого же узла, — не «чужой»: его не красим
            const own = card && (DATA?.hosts || []).some((item) => item.hostname === card.dataset.hostname && item.ip === value);
            if (mac !== undefined && !own && !busy) busy = `Адрес занят — ответил при сканировании ${SUBNET_SCAN.scanned_at}${mac ? ` (${mac})` : ''}`;
            else if (mac === undefined && !busy) free = `Адрес свободен по сканированию подсети ${SUBNET_SCAN.subnet} (${SUBNET_SCAN.scanned_at})`;
        }
    }
    if (busy) { input.classList.add('ip-busy'); input.dataset.ipHint = busy; input.title = busy; }
    else if (free) { input.classList.add('ip-free'); input.dataset.ipHint = free; input.title = free; }
}
function applyIpHints() { document.querySelectorAll(IP_FIELD_SELECTOR).forEach(applyIpHint); }
document.addEventListener('input', (event) => { if (event.target.matches?.(IP_FIELD_SELECTOR)) applyIpHint(event.target); });


// ============================================================================
// Окно выбора из нескольких действий (например, «Сохранить» / «Сохранить и закрыть»)
// ============================================================================
function showChoice(title, text, choices, kicker = 'Подтверждение', cancelClass = 'modal-secondary', cancelLabel = 'Отмена') {
    let modal = document.getElementById('choice_modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'choice_modal';
        modal.className = 'modal-backdrop';
        modal.hidden = true;
        modal.innerHTML = `<div class="modal-card run-confirm-card" role="dialog" aria-modal="true"><div class="modal-head"><div><div class="modal-kicker" id="choice_kicker"></div><h3 id="choice_title"></h3></div><button class="modal-close" type="button" aria-label="Закрыть">×</button></div><div class="modal-body"><div id="choice_text" class="run-confirm-text"></div></div><div class="modal-footer" id="choice_buttons"></div></div>`;
        document.body.appendChild(modal);
        modal.querySelector('.modal-close').onclick = () => { hideModalSmooth('choice_modal'); modal._restoreFocus?.(); };
        modal.addEventListener('click', (event) => { if (event.target === modal) { hideModalSmooth('choice_modal'); modal._restoreFocus?.(); } });
    }
    // после закрытия фокус возвращается туда, где был (например, в редактор после Ctrl+S → «Сохранить»)
    const returnFocus = document.activeElement;
    const restoreFocus = () => setTimeout(() => { if (returnFocus && document.contains(returnFocus) && !returnFocus.closest('[hidden]')) returnFocus.focus({ preventScroll: true }); }, 60);
    modal._restoreFocus = restoreFocus;
    modal.querySelector('#choice_kicker').textContent = kicker;
    modal.querySelector('#choice_title').textContent = title;
    modal.querySelector('#choice_text').innerHTML = text;
    const footer = modal.querySelector('#choice_buttons');
    footer.innerHTML = `<button type="button" class="${cancelClass}" data-choice="-1">${esc(cancelLabel)}</button>`
        + choices.map((choice, index) => choice.hidden ? '' : `<button type="button" class="${choice.className || ''}" data-choice="${index}">${esc(choice.label)}</button>`).join('');
    footer.onclick = (event) => {
        const button = event.target.closest('button[data-choice]');
        if (!button) return;
        hideModalSmooth('choice_modal');
        const choice = choices[Number(button.dataset.choice)];
        restoreFocus();
        if (choice) choice.action();
    };
    showModalSmooth('choice_modal');
    setTimeout(() => (footer.querySelector('button.primary, button.is-main'))?.focus(), 60);
}
window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && document.getElementById('choice_modal') && !document.getElementById('choice_modal').hidden) { event.stopImmediatePropagation(); hideModalSmooth('choice_modal'); document.getElementById('choice_modal')._restoreFocus?.(); }
}, true);

// подтверждение критического действия: «Отмена» (красная) или действие (его цвет — по смыслу)
function confirmAction(title, text, actionLabel, action, actionClass = 'danger', kicker = 'Подтверждение') {
    showChoice(title, text, [{ label: actionLabel, className: `${actionClass} is-main`, action }], kicker, actionClass === 'danger' ? 'modal-secondary is-neutral' : 'modal-secondary');
}

// сохранённые значения формы узла становятся «исходными» (для «Отмены» и признака изменений)
function commitNodeOriginals(card) {
    card.querySelectorAll('[data-key]').forEach((el) => { el.dataset.original = el.value; });
    card.querySelectorAll('.node-group-check').forEach((el) => { el.dataset.originalChecked = el.checked ? '1' : '0'; });
    card.querySelector('.node-edit')?.classList.remove('has-changes');
    const saveBtn = card.querySelector('.edit-save.primary');
    if (saveBtn) saveBtn.disabled = true;
}

// ============================================================================
// «Новый плейбук»: узлы (hosts) — вручную или группами из hosts.yml
// ============================================================================
function toggleHostsGroups(event) {
    event?.stopPropagation();
    const panel = document.getElementById('hosts_groups');
    if (panel.classList.contains('is-open')) return closeHostsGroups();
    const input = document.getElementById('create_playbook_hosts');
    const current = new Set(input.value.split(/[:,]/).map((item) => item.trim()).filter(Boolean));
    const groups = [{ name: 'all', hosts: (DATA.hosts || []).map((host) => host.hostname), title: 'все узлы' }]
        .concat((DATA.groups || []).filter((group) => group.name !== 'all'));
    panel.innerHTML = groups.map((group) => `<label class="wizard-check group-pick${current.has(group.name) ? ' is-active' : ''}"><input type="radio" name="hosts_group" value="${esc(group.name)}" ${current.has(group.name) ? 'checked' : ''}><span><b>${esc(group.name)}</b> <small>${group.title || ''}${group.title ? ' · ' : ''}${(group.hosts || []).length} ${plural((group.hosts || []).length, 'узел', 'узла', 'узлов')}</small></span></label>`).join('');
    panel.classList.add('is-open');
}
// выбирается одна группа: она становится значением поля, список закрывается
document.getElementById('hosts_groups')?.addEventListener('change', (event) => {
    if (!event.target.matches('input[name="hosts_group"]')) return;
    document.getElementById('create_playbook_hosts').value = event.target.value;
    setTimeout(closeHostsGroups, 120);
});
document.addEventListener('pointerdown', (event) => { if (!event.target.closest('.hosts-combo')) closeHostsGroups(); });
// плавное закрытие списка групп
function closeHostsGroups() {
    const panel = document.getElementById('hosts_groups');
    if (!panel?.classList.contains('is-open') || panel.classList.contains('is-closing')) return;
    panel.classList.add('is-closing');
    setTimeout(() => panel.classList.remove('is-open', 'is-closing'), 170);
}

// ============================================================================
// «Файлы плейбука»: переименование роли (папка и все ссылки на неё)
// ============================================================================
function renameRole(role) {
    showConfirmation('Переименовать роль', `Роль <strong>${esc(role)}</strong><br><br><input id="rename_role_input" class="modal-input" type="text" value="${esc(role)}" autocomplete="off" spellcheck="false">
        <div class="wizard-hint">Папка роли будет переименована, а ссылки на неё — изменены во всех плейбуках${PLAYBOOK_FILES.scope === 'autodeploy' ? ' Autodeploy' : ' этого проекта/объекта'}, в зависимостях (meta) других ролей и в tests роли. Подроль — через «/», например infra/nginx.</div>`,
        () => {
            const name = (document.getElementById('rename_role_input')?.value || '').trim();
            if (!name || name === role) return;
            if (!name.split('/').every(isItemName)) return notify('Имя роли: латинские буквы, цифры, точка, дефис и подчёркивание', 'warning');
            api(API.ROLE_RENAME, { project: CURRENT_PROJECT, object: CURRENT_OBJECT, old: role, new: name, scope: PLAYBOOK_FILES.scope })
                .then((data) => {
                    notify(`Роль «${role}» переименована в «${name}»${data.changed.length ? `; ссылки изменены в: ${data.changed.join(', ')}` : ''}`, 'success');
                    refreshPlaybookFiles();
                    loadMain();
                })
                .catch((error) => notify(error.message, 'error'));
        }, 'Переименовать', 'primary', 'Файлы плейбука');
    setTimeout(() => { const input = document.getElementById('rename_role_input'); input?.focus(); input?.select(); }, 80);
}


// «Сохранить» в редакторе плейбука — неактивна, пока текст не изменён
function updatePlaybookSaveState() {
    const editor = document.getElementById('playbook_editor'), button = document.getElementById('playbook_save_btn');
    if (editor && button) button.disabled = editor.value === window.PLAYBOOK_ORIGINAL;
}
document.getElementById('playbook_editor')?.addEventListener('input', updatePlaybookSaveState);


// ============================================================================
// «Удалить» в панели плейбуков: отмеченные целиком плейбуки — в корзину (роли остаются)
// ============================================================================
function checkedPlaybooks() { return [...document.querySelectorAll('#playbooks .pb')].filter((box) => box.checked).map((box) => box.value); }
function updatePlaybookDeleteButton() {
    const button = document.getElementById('delete_playbooks_btn');
    if (button) button.disabled = !checkedPlaybooks().length;
}
function deleteSelectedPlaybooks() {
    const names = checkedPlaybooks();
    if (!names.length) return;
    confirmAction(`Удалить ${names.length} ${plural(names.length, 'плейбук', 'плейбука', 'плейбуков')}?`,
        `${names.map((name) => `<strong>${esc(name)}</strong>`).join('<br>')}<br><br>Файлы плейбуков переносятся в корзину backups/deleted рядом с web1x.py. Роли и их файлы не удаляются — они могут использоваться другими плейбуками.`,
        'Удалить', async () => {
            const failed = [];
            for (const name of names) {
                try { await api(API.PLAYBOOK_DELETE, { project: CURRENT_PROJECT, object: CURRENT_OBJECT, name }); } catch (error) { failed.push(`${name}: ${error.message}`); }
            }
            if (failed.length) notify(`Не удалось удалить: ${failed.join('; ')}`, 'error');
            else notify(names.length === 1 ? `Плейбук «${names[0]}» удалён` : `Удалено плейбуков: ${names.length}`, 'success');
            loadMain();
        }, 'danger', 'Плейбуки');
}


// ============================================================================
// Импорт ролей и плейбуков из других проектов (мастер, «Новый плейбук», «Добавить роль»)
// ============================================================================
let IMPORT_SOURCES = [];
function sourceLabel(source) { return source.object ? `${source.project} / ${source.object}` : source.project; }

// дерево ролей с флажками (используется в «Добавить роль» и в окне импорта)
function renderRolePickTree(container, roles, present, presentLabel, emptyText) {
    const render = (items, depth) => items.map((item) => {
        const already = item.role && present.has(item.ref);
        return `<label class="wizard-check role-pick-item${item.role ? '' : ' is-group'}" style="padding-left:${depth * 20}px" title="${esc(item.ref)}">
                <input type="checkbox" data-ref="${esc(item.ref)}" data-role="${item.role ? 1 : 0}" ${already ? 'checked disabled' : ''}>
                <span>${esc(item.ref.split('/').pop())}${item.role ? '' : ' <small>— группа подролей</small>'}${already ? ` <small>(${presentLabel})</small>` : ''}</span>
            </label>${render(item.children || [], depth + 1)}`;
    }).join('');
    container.innerHTML = render(roles, 0) || `<div class="muted">${emptyText}</div>`;
}

// источники: все проекты (у проекта с объектами — его объекты), кроме текущего объекта
function loadImportSources() {
    return fetch(`${API.IMPORT_SOURCES}?_=${Date.now()}`).then((response) => response.json()).then((data) => { IMPORT_SOURCES = data.sources || []; return IMPORT_SOURCES; });
}
// excludeCurrent — не показывать текущий объект (для «Добавить роль»: его роли и так на вкладке «Существующие»);
// для нового проекта и «Нового плейбука» текущий проект — обычный источник (файлы копируются, а не переносятся)
// preferCurrent — по умолчанию выбрать текущий проект и объект
function fillImportSelects(projectBox, objectBox, onChange, { excludeCurrent = true, preferCurrent = false } = {}) {
    const isCurrent = (project, obj) => project === CURRENT_PROJECT && (obj || null) === (CURRENT_OBJECT || null);
    const objectsOf = (item) => item.objects.filter((obj) => !(excludeCurrent && isCurrent(item.project, obj)));
    const options = IMPORT_SOURCES.filter((item) => item.objects.length ? objectsOf(item).length : !(excludeCurrent && isCurrent(item.project, null)));
    const syncObjects = () => {
        const source = IMPORT_SOURCES.find((item) => item.project === projectBox.dataset.value);
        const objects = source ? objectsOf(source) : [];
        objectBox.closest('.import-object-wrap').hidden = !objects.length;
        if (objects.length) {
            const initial = preferCurrent && source.project === CURRENT_PROJECT && objects.includes(CURRENT_OBJECT) ? CURRENT_OBJECT : objects[0];
            mountUiSelect(objectBox, objects.map((obj) => ({ value: obj, label: obj, sub: isCurrent(source.project, obj) ? 'текущий' : '' })), initial, () => onChange());
        } else objectBox.dataset.value = '';
        onChange();
    };
    const initialProject = preferCurrent && options.some((item) => item.project === CURRENT_PROJECT) ? CURRENT_PROJECT : options[0]?.project;
    mountUiSelect(projectBox, options.map((item) => ({ value: item.project, label: item.project,
        sub: [item.project === CURRENT_PROJECT ? 'текущий' : '', item.objects.length ? `${item.objects.length} ${plural(item.objects.length, 'объект', 'объекта', 'объектов')}` : ''].filter(Boolean).join(' · ') })),
        initialProject, () => syncObjects());
    if (options.length) syncObjects();
    return options.length;
}
function fetchImportCatalog(project, object) {
    return fetch(`${API.IMPORT_CATALOG}?src_project=${encodeURIComponent(project)}&src_object=${encodeURIComponent(object || '')}&_=${Date.now()}`)
        .then(async (response) => { const data = await response.json(); if (!response.ok || data.ok === false) throw Error(data.error || 'Не удалось прочитать проект-источник'); return data; });
}
function currentSource(projectBox, objectBox) {
    return { project: projectBox.dataset.value || '', object: objectBox.closest('.import-object-wrap').hidden ? null : objectBox.dataset.value || null };
}

// --- «Добавить роль» → «Из других проектов» ---
function loadAddRoleImportSources() {
    const tree = document.getElementById('add_role_import_tree');
    tree.innerHTML = '<div class="muted">Загрузка проектов…</div>';
    loadImportSources().then(() => {
        const count = fillImportSelects(document.getElementById('add_role_src_project'), document.getElementById('add_role_src_object'), refreshAddRoleImportTree, { excludeCurrent: ADD_ROLE_TARGET.scope !== 'autodeploy' });
        if (!count) tree.innerHTML = '<div class="muted">Других проектов нет.</div>';
    }).catch(() => { tree.innerHTML = '<div class="muted">Не удалось загрузить список проектов</div>'; });
}
function refreshAddRoleImportTree() {
    const tree = document.getElementById('add_role_import_tree');
    const source = currentSource(document.getElementById('add_role_src_project'), document.getElementById('add_role_src_object'));
    if (!source.project) return;
    tree.innerHTML = '<div class="muted">Загрузка ролей…</div>';
    fetchImportCatalog(source.project, source.object)
        .then((data) => renderRolePickTree(tree, data.roles || [], ADD_ROLE_TARGET.present, ADD_ROLE_TARGET.mode === 'draft' ? 'уже выбрана' : 'уже в плейбуке', 'В этом проекте нет ролей.'))
        .catch((error) => { tree.innerHTML = `<div class="muted">${esc(error.message)}</div>`; });
}
function submitRoleImport() {
    const source = currentSource(document.getElementById('add_role_src_project'), document.getElementById('add_role_src_object'));
    const roles = [...document.querySelectorAll('#add_role_import_tree input[data-role="1"]:checked:not(:disabled)')].map((box) => box.dataset.ref);
    if (!source.project || !roles.length) return setStatusText('add_role_status', 'Выберите проект и отметьте роли', 'error');
    if (ADD_ROLE_TARGET.mode === 'draft') {
        roles.forEach((ref) => { if (!DRAFT_ROLES.some((item) => item.ref === ref)) DRAFT_ROLES.push({ ref, isNew: false, source }); });
        hideModalSmooth('add_role_modal');
        return renderDraftRoles();
    }
    api(API.ROLES_IMPORT, { project: CURRENT_PROJECT, object: CURRENT_OBJECT, scope: PLAYBOOK_FILES.scope, src_project: source.project, src_object: source.object, roles, playbook: PLAYBOOK_FILES.name })
        .then((data) => {
            hideModalSmooth('add_role_modal');
            const parts = [];
            if (data.copied.length) parts.push(`скопированы: ${data.copied.join(', ')}`);
            if (data.skipped.length) parts.push(`уже были в проекте: ${data.skipped.join(', ')}`);
            if (data.added.length) parts.push(`подключены к плейбуку: ${data.added.join(', ')}`);
            if (data.defaults_added?.length) parts.push(`в defaults добавлены: ${data.defaults_added.join(', ')}`);
            notify(`Импорт из ${sourceLabel(source)} — ${parts.join('; ') || 'нечего добавлять'}`, data.copied.length || data.added.length ? 'success' : 'info');
            refreshPlaybookFiles();
            loadMain();
        })
        .catch((error) => setStatusText('add_role_status', error.message, 'error'));
}

// --- Окно импорта (мастер, «Новый плейбук») ---
let IMPORT_PICKER = null;   // { kinds, single, onPick }
function openImportPicker(options) {
    IMPORT_PICKER = options;
    document.getElementById('import_context').textContent = options.context || '';
    document.querySelectorAll('#import_modal .import-kind .nmap-mode-option').forEach((label) => { label.hidden = !options.kinds.includes(label.dataset.kind); });
    document.querySelector('#import_modal .import-kind').hidden = options.kinds.length < 2;   // одна вкладка — переключатель не нужен
    document.querySelector(`input[name="import_kind"][value="${options.kinds[0]}"]`).checked = true;
    syncImportKind();
    setStatusText('import_status', '');
    document.getElementById('import_playbooks_list').innerHTML = document.getElementById('import_roles_tree').innerHTML = document.getElementById('import_hosts_tree').innerHTML = '<div class="muted">Загрузка…</div>';
    showModalSmooth('import_modal');
    loadImportSources().then(() => {
        if (!fillImportSelects(document.getElementById('import_project'), document.getElementById('import_object'), refreshImportCatalog, { excludeCurrent: Boolean(options.excludeCurrent), preferCurrent: !options.excludeCurrent })) {
            document.getElementById('import_playbooks_list').innerHTML = document.getElementById('import_roles_tree').innerHTML = '<div class="muted">Других проектов нет.</div>';
        }
    });
}
function syncImportKind() {
    const kind = document.querySelector('input[name="import_kind"]:checked').value;
    [['import_playbooks', 'playbooks'], ['import_roles', 'roles'], ['import_hosts', 'hosts']].forEach(([id, value]) => {
        const pane = document.getElementById(id);
        pane.classList.toggle('is-active', kind === value);
        pane.inert = kind !== value;
    });
}
document.querySelectorAll('input[name="import_kind"]').forEach((input) => input.addEventListener('change', syncImportKind));
function refreshImportCatalog() {
    const source = currentSource(document.getElementById('import_project'), document.getElementById('import_object'));
    if (!source.project) return;
    const list = document.getElementById('import_playbooks_list'), tree = document.getElementById('import_roles_tree'), hostsTree = document.getElementById('import_hosts_tree');
    list.innerHTML = tree.innerHTML = hostsTree.innerHTML = '<div class="muted">Загрузка…</div>';
    fetchImportCatalog(source.project, source.object).then((data) => {
        const type = IMPORT_PICKER?.single ? 'radio' : 'checkbox';
        list.innerHTML = (data.playbooks || []).map((item) => `<label class="wizard-check role-pick-item" title="${esc(item.name)}"><input type="${type}" name="import_playbook" value="${esc(item.name)}" data-roles="${esc(item.roles.join(','))}"><span>${esc(item.name)}${item.roles.length ? ` <small>роли: ${esc(item.roles.join(', '))}</small>` : ' <small>без ролей</small>'}</span></label>`).join('')
            || '<div class="muted">В этом проекте нет плейбуков.</div>';
        renderRolePickTree(tree, data.roles || [], new Set(), '', 'В этом проекте нет ролей.');
        renderHostPickTree(hostsTree, data.hosts || [], data.groups || []);
    }).catch((error) => { list.innerHTML = tree.innerHTML = hostsTree.innerHTML = `<div class="muted">${esc(error.message)}</div>`; });
}
function submitImportPicker() {
    const source = currentSource(document.getElementById('import_project'), document.getElementById('import_object'));
    const boxes = [...document.querySelectorAll('#import_playbooks_list input:checked')];
    const selection = {
        ...source,
        playbooks: IMPORT_PICKER.kinds.includes('playbooks') ? boxes.map((box) => box.value) : [],
        playbookRoles: boxes.flatMap((box) => box.dataset.roles ? box.dataset.roles.split(',') : []),
        roles: IMPORT_PICKER.kinds.includes('roles') ? [...document.querySelectorAll('#import_roles_tree input[data-role="1"]:checked')].map((box) => box.dataset.ref) : [],
        hosts: IMPORT_PICKER.kinds.includes('hosts') ? [...new Set([...document.querySelectorAll('#import_hosts_tree input[data-host]:checked')].map((box) => box.dataset.host))] : [],
    };
    if (!source.project || (!selection.playbooks.length && !selection.roles.length && !selection.hosts.length)) return setStatusText('import_status', 'Отметьте, что импортировать', 'error');
    hideModalSmooth('import_modal');
    IMPORT_PICKER.onPick(selection);
}

// --- Мастер: список импорта ---
let WIZARD_IMPORTS = [];
function openWizardImport() {
    openImportPicker({ kinds: ['playbooks', 'roles', 'hosts'], context: `Новый проект ${document.getElementById('wizard_name').value.trim()}`, onPick: (selection) => {
        WIZARD_IMPORTS.push(selection);
        renderWizardImports();
        updateProjectWizard();
    } });
}
function renderWizardImports() {
    const box = document.getElementById('wizard_imports');
    if (!box) return;
    const chips = [];
    WIZARD_IMPORTS.forEach((entry, index) => {
        entry.playbooks.forEach((name) => chips.push(`<span class="chip is-import" title="плейбук из ${esc(sourceLabel(entry))} — вместе с его ролями">${esc(name)} <small>из ${esc(sourceLabel(entry))}</small><button type="button" aria-label="Убрать" onclick="removeWizardImport(${index}, 'playbooks', '${esc(name)}')">×</button></span>`));
        entry.roles.forEach((ref) => chips.push(`<span class="chip is-import" title="роль из ${esc(sourceLabel(entry))}">роль ${esc(ref)} <small>из ${esc(sourceLabel(entry))}</small><button type="button" aria-label="Убрать" onclick="removeWizardImport(${index}, 'roles', '${esc(ref)}')">×</button></span>`));
        (entry.hosts || []).forEach((host) => chips.push(`<span class="chip is-import" title="узел из ${esc(sourceLabel(entry))} — с параметрами и группами">узел ${esc(host)} <small>из ${esc(sourceLabel(entry))}</small><button type="button" aria-label="Убрать" onclick="removeWizardImport(${index}, 'hosts', '${esc(host)}')">×</button></span>`));
    });
    box.innerHTML = chips.join('') || '<span class="muted">Ничего не выбрано — плейбуки и роли можно взять из существующих проектов.</span>';
}
function removeWizardImport(index, kind, value) {
    const entry = WIZARD_IMPORTS[index];
    if (!entry) return;
    entry[kind] = entry[kind].filter((item) => item !== value);
    if (kind === 'playbooks') entry.playbookRoles = [];   // роли плейбуков пересчитает сервер
    if (!entry.playbooks.length && !entry.roles.length && !(entry.hosts || []).length) WIZARD_IMPORTS.splice(index, 1);
    renderWizardImports();
    updateProjectWizard();
}

// --- «Новый плейбук» → «Из другого проекта»: несколько плейбуков, в том числе из разных проектов ---
let IMPORT_PLAYBOOKS = [];   // [{ project, object, name, target, roles }]
function openPlaybookImport() {
    openImportPicker({ kinds: ['playbooks'], context: 'Новый плейбук', onPick: (selection) => {
        selection.playbooks.forEach((name) => {
            if (IMPORT_PLAYBOOKS.some((item) => item.project === selection.project && item.object === selection.object && item.name === name)) return;
            IMPORT_PLAYBOOKS.push({ project: selection.project, object: selection.object, name, target: freePlaybookName(name, IMPORT_PLAYBOOKS.map((item) => item.target)) });
        });
        renderPlaybookImportChoice();
    } });
}
function renderPlaybookImportChoice() {
    const box = document.getElementById('create_playbook_import_choice');
    if (!box) return;
    box.innerHTML = IMPORT_PLAYBOOKS.length
        ? IMPORT_PLAYBOOKS.map((item, index) => `<span class="chip is-import" title="будет создан как ${esc(item.target)}">${esc(item.target)}${item.target !== item.name ? ` <small>← ${esc(item.name)}</small>` : ''} <small>из ${esc(sourceLabel(item))}</small><button type="button" aria-label="Убрать" onclick="removePlaybookImport(${index})">×</button></span>`).join('')
        : '<span class="muted">Плейбуки не выбраны — нажмите «Выбрать плейбуки».</span>';
}
function removePlaybookImport(index) { IMPORT_PLAYBOOKS.splice(index, 1); renderPlaybookImportChoice(); }
async function createImportedPlaybook() {
    if (!IMPORT_PLAYBOOKS.length) return setStatusText('create_playbook_status', 'Выберите плейбуки в других проектах', 'error');
    const done = [], failed = [], copied = new Set(), variables = new Set();
    for (const item of IMPORT_PLAYBOOKS) {
        try {
            const data = await api(API.PLAYBOOK_IMPORT, { project: CURRENT_PROJECT, object: CURRENT_OBJECT, src_project: item.project, src_object: item.object, name: item.name, new_name: item.target });
            done.push(data.name);
            data.copied.forEach((role) => copied.add(role));
            (data.defaults_added || []).forEach((name) => variables.add(name));
        } catch (error) { failed.push(`${item.target}: ${error.message}`); }
    }
    if (failed.length && !done.length) return setStatusText('create_playbook_status', failed.join('; '), 'error');
    hideModalSmooth('create_playbook_modal');
    notify(`Импортировано плейбуков: ${done.join(', ')}${copied.size ? `; роли: ${[...copied].join(', ')}` : ''}${variables.size ? `; в defaults добавлены: ${[...variables].join(', ')}` : ''}${failed.length ? `; не удалось: ${failed.join('; ')}` : ''}`, failed.length ? 'warning' : 'success');
    loadMain();
    if (done.length === 1) setTimeout(() => editPlaybook(done[0]), 350);
}


// свободное имя плейбука в текущем объекте: «web.yml» → «web-copy.yml», «web-copy2.yml»… (если такое уже есть)
function freePlaybookName(name, reserved = []) {
    const taken = new Set((DATA?.playbooks || []).map((item) => item.name).concat(reserved));
    if (!taken.has(name)) return name;
    const match = name.match(/^(.*?)(\.ya?ml)$/i), stem = match ? match[1] : name, ext = match ? match[2] : '.yml';
    for (let index = 1; ; index += 1) {
        const candidate = `${stem}-copy${index > 1 ? index : ''}${ext}`;
        if (!taken.has(candidate)) return candidate;
    }
}
document.getElementById('create_playbook_name')?.addEventListener('input', (event) => { event.target.dataset.auto = '0'; });



// --- Узлы из других проектов: дерево «группа → узлы» (узел в нескольких группах отмечается везде) ---
function renderHostPickTree(container, hosts, groups) {
    const ipOf = Object.fromEntries(hosts.map((host) => [host.hostname, host.ip]));
    const grouped = new Set(groups.flatMap((group) => group.hosts));
    const sections = groups.filter((group) => group.hosts.length).map((group) => ({ title: group.name, hosts: group.hosts }));
    const loose = hosts.map((host) => host.hostname).filter((name) => !grouped.has(name));
    if (loose.length) sections.push({ title: 'без группы', hosts: loose, loose: true });
    container.innerHTML = sections.map((section) => `
        <label class="wizard-check role-pick-item is-group"><input type="checkbox" data-group-of="${esc(section.title)}"><span>${esc(section.title)} <small>${section.loose ? '' : 'группа · '}${section.hosts.length} ${plural(section.hosts.length, 'узел', 'узла', 'узлов')}</small></span></label>
        ${section.hosts.map((name) => `<label class="wizard-check role-pick-item" style="padding-left:20px"><input type="checkbox" data-host="${esc(name)}" data-in="${esc(section.title)}"><span>${esc(name)}${ipOf[name] ? ` <small>${esc(ipOf[name])}</small>` : ''}</span></label>`).join('')}`).join('')
        || '<div class="muted">В этом проекте нет узлов.</div>';
}
document.getElementById('import_hosts_tree')?.addEventListener('change', (event) => {
    const tree = event.currentTarget, box = event.target;
    const setHost = (name, value) => tree.querySelectorAll(`input[data-host]`).forEach((other) => { if (other.dataset.host === name) other.checked = value; });
    if (box.dataset.groupOf !== undefined) tree.querySelectorAll('input[data-host]').forEach((other) => { if (other.dataset.in === box.dataset.groupOf) setHost(other.dataset.host, box.checked); });
    else if (box.dataset.host) setHost(box.dataset.host, box.checked);
    // флажок группы: отмечены все её узлы
    tree.querySelectorAll('input[data-group-of]').forEach((group) => {
        const members = [...tree.querySelectorAll('input[data-host]')].filter((other) => other.dataset.in === group.dataset.groupOf);
        group.checked = members.length > 0 && members.every((other) => other.checked);
    });
});

// «Добавить узел» → «Импорт из другого проекта…»
function openHostsImport() {
    openImportPicker({ kinds: ['hosts'], excludeCurrent: true, context: `Узлы → ${contextLabel()}`, onPick: (selection) => {
        api(API.HOSTS_IMPORT, { project: CURRENT_PROJECT, object: CURRENT_OBJECT, src_project: selection.project, src_object: selection.object, hosts: selection.hosts })
            .then((data) => {
                if (data.added.length) window.closeAddNodeModal?.();
                notify(`Узлы из ${sourceLabel(selection)} — ${data.added.length ? `добавлены: ${data.added.join(', ')}` : 'ничего не добавлено'}${data.skipped.length ? `; пропущены: ${data.skipped.join('; ')}` : ''}`, data.skipped.length ? 'warning' : 'success');
                loadMain();
            })
            .catch((error) => notify(error.message, 'error'));
    } });
}


// Подсветка выбранного варианта классами is-checked / is-disabled (вместо CSS :has() — его нет в штатных
// браузерах Astra Linux 1.7: Firefox ESR < 121, Chromium < 105)
document.addEventListener('change', (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    const holder = input.closest('.autobuild-source, .pb-role-row, .group-pick');
    if (!holder) return;
    // у переключателей (radio) меняется и соседний вариант — обновляем всю группу
    const scope = input.type === 'radio' ? (holder.parentElement || document) : holder;
    const items = input.type === 'radio' ? scope.querySelectorAll(':scope > .autobuild-source, :scope > .group-pick') : [holder];
    items.forEach((item) => {
        const box = item.querySelector('input');
        if (!box) return;
        item.classList.toggle('is-checked', box.checked);
        item.classList.toggle('is-active', box.checked && item.classList.contains('group-pick'));
        item.classList.toggle('is-disabled', box.disabled);
    });
});

// копирование в буфер обмена: navigator.clipboard есть только на https и localhost — интерфейс же обычно
// открыт по http с другой машины; тогда — через скрытое поле и execCommand('copy')
function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise((resolve, reject) => {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand('copy');
        area.remove();
        ok ? resolve() : reject(new Error('copy'));
    });
}


// ============================================================================
// Роли «ступенькой» и теги плейбуков (и Autodeploy)
// ============================================================================
function roleStepsHTML(name, roles, title) {
    if (roles.length < 2) return '';
    return `
            <div class="playbook-role-steps" aria-label="Роли ${esc(name)}">${roles.map((role) => `
                <label class="pb-role-row" title="${esc(title)}"><input type="checkbox" class="pb-role" data-playbook="${esc(name)}" value="${esc(role)}"><span>${esc(role)}</span></label>`).join('')}
            </div>`;
}

// выбранные теги: плейбук (или '@autodeploy') → Set тегов; сохраняются при перерисовке списка
const TAG_SELECTION = new Map();
function tagsButtonHTML(name, tags) {
    if (!tags.length) return '';
    const chosen = [...(TAG_SELECTION.get(name) || [])].filter((tag) => tags.includes(tag));
    TAG_SELECTION.set(name, new Set(chosen));
    return `<button type="button" class="tags-btn${chosen.length ? ' is-active' : ''}" data-playbook="${esc(name)}" onclick="toggleTagsMenu(event, this)" title="Теги задач: выполнить только задачи с выбранными тегами (--tags)">Теги${chosen.length ? ` · ${chosen.length}` : ''}</button>`;
}
// плейбук → выбранные теги (только для запускаемых плейбуков)
function selectedTagMap(playbooks) {
    const map = {};
    playbooks.forEach((name) => { const chosen = [...(TAG_SELECTION.get(name) || [])]; if (chosen.length) map[name] = chosen; });
    return map;
}
function tagsOf(name) {
    return name === '@autodeploy' ? (DATA.autodeploy_tags || []) : ((DATA.playbooks || []).find((item) => item.name === name)?.tags || []);
}

// список тегов под кнопкой «Теги» (шириной не меньше кнопки)
function toggleTagsMenu(event, button) {
    event.stopPropagation();
    let menu = document.getElementById('tags_menu');
    if (menu?.classList.contains('is-open') && menu.dataset.playbook === button.dataset.playbook) return closeTagsMenu();
    if (!menu) {
        menu = document.createElement('div');
        menu.id = 'tags_menu';
        menu.className = 'tags-menu';
        document.body.appendChild(menu);
        menu.addEventListener('change', onTagToggle);
        menu.addEventListener('click', (clickEvent) => {
            if (clickEvent.target.closest('[data-tags-clear]')) {
                TAG_SELECTION.set(menu.dataset.playbook, new Set());
                menu.querySelectorAll('input').forEach((box) => { box.checked = false; });
                updateTagsButton(menu.dataset.playbook);
            }
        });
    }
    const name = button.dataset.playbook, chosen = TAG_SELECTION.get(name) || new Set();
    menu.dataset.playbook = name;
    menu.innerHTML = `<div class="tags-menu-list">${tagsOf(name).map((tag) => `<label class="wizard-check tags-menu-item"><input type="checkbox" value="${esc(tag)}" ${chosen.has(tag) ? 'checked' : ''}><span>${esc(tag)}${tag === 'always' || tag === 'never' ? ' <small>особый</small>' : ''}</span></label>`).join('')}</div>
        <div class="tags-menu-foot"><span class="muted">Выполнятся только задачи с этими тегами</span><button type="button" data-tags-clear>Сбросить</button></div>`;
    const rect = button.getBoundingClientRect();
    menu.style.minWidth = `${Math.max(rect.width, 220)}px`;
    menu.classList.remove('is-closing');
    menu.classList.add('is-open');
    const width = menu.offsetWidth;
    menu.style.left = `${Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))}px`;
    const below = rect.bottom + 6, height = menu.offsetHeight;
    menu.style.top = `${below + height > window.innerHeight - 8 ? Math.max(8, rect.top - height - 6) : below}px`;
}
function onTagToggle(event) {
    const menu = event.currentTarget, name = menu.dataset.playbook;
    const chosen = new Set([...menu.querySelectorAll('input:checked')].map((box) => box.value));
    TAG_SELECTION.set(name, chosen);
    updateTagsButton(name);
    // выбран тег у неотмеченного плейбука — отметить его: теги выбирают для запуска
    if (chosen.size && name !== '@autodeploy') {
        const box = [...document.querySelectorAll('#playbooks .pb')].find((item) => item.value === name);
        if (box && !box.checked && !box.indeterminate) { setPlaybookChecked(box, true); updateSelectionSummary(); window.updatePlaybookSelectionButton?.(); }
    }
}
function updateTagsButton(name) {
    const count = (TAG_SELECTION.get(name) || new Set()).size;
    document.querySelectorAll('#playbooks .tags-btn').forEach((button) => {
        if (button.dataset.playbook !== name) return;
        button.textContent = count ? `Теги · ${count}` : 'Теги';
        button.classList.toggle('is-active', Boolean(count));
    });
}
function closeTagsMenu() {
    const menu = document.getElementById('tags_menu');
    if (!menu?.classList.contains('is-open') || menu.classList.contains('is-closing')) return;
    menu.classList.add('is-closing');
    setTimeout(() => menu.classList.remove('is-open', 'is-closing'), 160);
}
document.addEventListener('pointerdown', (event) => { if (!event.target.closest('#tags_menu, .tags-btn')) closeTagsMenu(); });
window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !document.getElementById('tags_menu')?.classList.contains('is-open')) return;
    event.stopImmediatePropagation();
    closeTagsMenu();
}, true);
document.getElementById('playbooks')?.addEventListener('scroll', closeTagsMenu, { passive: true });


// восстановление выбора после перерисовки списка плейбуков (в том же проекте и объекте)
let PLAYBOOK_RENDER_KEPT = { project: null, object: null };
function restorePlaybookSelection(playbooks, roles) {
    if (!playbooks.size && !roles.size) return;
    document.querySelectorAll('#playbooks .pb').forEach((box) => { if (playbooks.has(box.value)) setPlaybookChecked(box, true); });
    const touched = new Set();
    document.querySelectorAll('#playbooks .pb-role').forEach((box) => {
        const kept = roles.has(`${box.dataset.playbook}\n${box.value}`);
        if (box.checked !== kept) { box.checked = kept; touched.add(box.dataset.playbook); }
    });
    touched.forEach((name) => syncPlaybookFromRoles(name));
    updateSelectionSummary();
    window.updatePlaybookSelectionButton?.();
}


// ============================================================================
// Мастер: ansible.cfg — стандартный или из другого проекта (с предпросмотром и сравнением)
// ============================================================================
let WIZARD_CFG = null;   // { project, object } или null — стандартный
function loadWizardCfgSources() {
    const box = document.getElementById('wizard_cfg_source');
    loadImportSources().then(() => {
        const options = [{ value: '', label: 'Стандартный', sub: 'для нового проекта' }];
        IMPORT_SOURCES.forEach((item) => (item.objects.length ? item.objects : [null]).forEach((obj) =>
            options.push({ value: `${item.project}\n${obj || ''}`, label: obj ? `${item.project} / ${obj}` : item.project, sub: item.project === CURRENT_PROJECT && (obj || null) === (CURRENT_OBJECT || null) ? 'текущий' : '' })));
        mountUiSelect(box, options, '', (value) => {
            const [project, obj] = value ? value.split('\n') : [];
            WIZARD_CFG = value ? { project, object: obj || null } : null;
            document.getElementById('wizard_cfg_compare_btn').disabled = !WIZARD_CFG;
            updateProjectWizard();
            if (WIZARD_CFG) openCfgCompare();   // выбран файл другого проекта — сразу показать сравнение
        });
        document.getElementById('wizard_cfg_compare_btn').disabled = true;
    });
}
function openCfgCompare() {
    if (!WIZARD_CFG) return;
    document.getElementById('cfg_compare_context').textContent = `стандартный ↔ ${sourceLabel(WIZARD_CFG)}`;
    document.getElementById('cfg_diff').innerHTML = document.getElementById('cfg_file').innerHTML = '<div class="muted">Загрузка…</div>';
    document.querySelector('input[name="cfg_view"][value="diff"]').checked = true;
    syncCfgView();
    showModalSmooth('cfg_compare_modal');
    fetch(`${API.CFG_COMPARE}?src_project=${encodeURIComponent(WIZARD_CFG.project)}&src_object=${encodeURIComponent(WIZARD_CFG.object || '')}&_=${Date.now()}`)
        .then(async (response) => { const data = await response.json(); if (!response.ok || data.ok === false) throw Error(data.error || 'Не удалось прочитать ansible.cfg'); return data; })
        .then((data) => {
            document.getElementById('cfg_diff').innerHTML = renderDiffTable(data.rows, 'Стандартный', sourceLabel(WIZARD_CFG), 'ini');
            document.getElementById('cfg_file').innerHTML = highlightCode(data.source, 'ini');
            const problem = document.getElementById('cfg_compare_problem');
            problem.hidden = !data.problem;
            problem.textContent = data.problem ? `В этом ansible.cfg ошибка: ${data.problem}` : '';
        })
        .catch((error) => { document.getElementById('cfg_diff').innerHTML = `<div class="muted">${esc(error.message)}</div>`; });
}
function syncCfgView() {
    const view = document.querySelector('input[name="cfg_view"]:checked').value;
    [['cfg_view_diff', 'diff'], ['cfg_view_file', 'file']].forEach(([id, value]) => { const pane = document.getElementById(id); pane.classList.toggle('is-active', view === value); pane.inert = view !== value; });
}
document.querySelectorAll('input[name="cfg_view"]').forEach((input) => input.addEventListener('change', syncCfgView));
function useStandardCfg() {
    WIZARD_CFG = null;
    const box = document.getElementById('wizard_cfg_source');
    mountUiSelect(box, box._options, '', box._onChange);
    document.getElementById('wizard_cfg_compare_btn').disabled = true;
    updateProjectWizard();
    hideModalSmooth('cfg_compare_modal');
}

// ============================================================================
// Шестерёнка → «Журнал запусков»: краткие итоги выполнения плейбуков
// ============================================================================
function openRunReport() {
    closeSettingsMenu();
    showModalSmooth('run_report_modal');
    loadRunReport();
}
function loadRunReport() {
    const list = document.getElementById('run_report_list');
    list.innerHTML = '<div class="muted">Загрузка…</div>';
    fetch(`${API.RUN_REPORT}?_=${Date.now()}`).then((response) => response.json()).then((data) => {
        document.getElementById('run_report_path').textContent = data.path;
        list.innerHTML = data.entries.length ? data.entries.map((entry) => {
            const lines = entry.split('\n');
            const verdict = /ИТОГ: УСПЕШНО/.test(entry) ? 'is-ok' : /ИТОГ: ПРЕРВАНО/.test(entry) ? 'is-stopped' : 'is-failed';
            return `<div class="run-report-entry ${verdict}"><div class="run-report-head">${esc(lines[0])}</div>${lines.slice(1).map((line) =>
                `<div class="run-report-line${/✗/.test(line) ? ' is-bad' : ''}${/ИТОГ/.test(line) ? ' is-total' : ''}">${esc(line)}</div>`).join('')}</div>`;
        }).join('') : '<div class="empty-state"><b>Запусков пока не было</b><span>После каждого запуска или проверки плейбука здесь появится краткий итог: успешно или с ошибкой, по ролям и задачам.</span></div>';
    }).catch(() => { list.innerHTML = '<div class="muted">Не удалось загрузить журнал</div>'; });
}
function clearRunReport() {
    confirmAction('Очистить журнал запусков?', 'Все записи об итогах выполнения плейбуков будут удалены.', 'Очистить', () =>
        api(API.RUN_REPORT_CLEAR, {}).then(() => { notify('Журнал запусков очищен', 'success'); loadRunReport(); }).catch((error) => notify(error.message, 'error')), 'danger', 'Журнал запусков');
}


// ============================================================================
// Узел: смена шаблона (набора параметров) в режиме правки
// ============================================================================
function paramFieldHTML(key, value) {
    return `<div class="param-name" title="${esc(key)}">${esc(key)}</div>${key === HWTYPE_PARAM_NAME ? renderHwtypeField(value) : `<input class="param-value" data-key="${esc(key)}" value="${esc(value)}" readonly>`}`;
}
function mountNodeTemplatePick(card) {
    const pick = card.querySelector('.node-template-pick');
    if (!pick) return;
    const schemas = DATA?.template_schemas || {};
    const node = (DATA?.hosts || []).find((item) => item.hostname === card.dataset.hostname);
    const current = node?.template;
    const options = Object.keys(schemas).map((name) => ({ value: name, label: name, sub: `${schemas[name].length} ${plural(schemas[name].length, 'параметр', 'параметра', 'параметров')}` }));
    if (current && !schemas[current]) options.unshift({ value: current, label: current, sub: 'текущий' });
    mountUiSelect(pick, options, current, (value) => applyNodeTemplate(card, value));
    card.querySelector('.node-template-note').innerHTML = '';
}
// поля — по набору параметров выбранного шаблона: значения общих параметров сохраняются, новые — пустые,
// лишние удаляются при сохранении (видно в пояснении)
function applyNodeTemplate(card, template) {
    const schema = (DATA?.template_schemas || {})[template];
    if (!schema) return;
    const grid = card.querySelector('.param-grid');
    const values = {};
    grid.querySelectorAll('[data-key]').forEach((el) => { if (el.dataset.key !== 'hostname') values[el.dataset.key] = el.value; });
    const node = (DATA?.hosts || []).find((item) => item.hostname === card.dataset.hostname);
    const original = Object.keys(node?.parameters || {});
    // имя узла и строку шаблона оставить, остальное — заново
    const keep = [...grid.children].slice(0, 4);
    grid.innerHTML = '';
    keep.forEach((el) => grid.appendChild(el));
    grid.insertAdjacentHTML('beforeend', schema.map((key) => paramFieldHTML(key, values[key] ?? '')).join(''));
    grid.querySelectorAll('.param-value').forEach((el) => { el.readOnly = false; el.disabled = false; });
    const added = schema.filter((key) => !original.includes(key)), removed = original.filter((key) => !schema.includes(key));
    card.querySelector('.node-template-note').innerHTML = [
        added.length ? `<span class="is-added">добавятся: ${added.map(esc).join(', ')}</span>` : '',
        removed.length ? `<span class="is-removed">удалятся при сохранении: ${removed.map(esc).join(', ')}</span>` : '',
    ].filter(Boolean).join('');
    card.dataset.templateChanged = '1';
    card._markChanged?.();
    applyIpHints();
}


// ============================================================================
// Сравнение рядом (ansible.cfg в мастере, история файлов)
// ============================================================================
function renderDiffTable(rows, leftTitle, rightTitle, language) {
    const line = (text) => text === null ? '' : (highlightCode(text, language) || esc(text) || '&nbsp;');
    const changed = rows.some((row) => row[0] !== 'same');
    return `<table class="cfg-diff-table"><thead><tr><th>${esc(leftTitle)}</th><th>${esc(rightTitle)}</th></tr></thead><tbody>${
        rows.map(([type, left, right]) => `<tr class="is-${type}"><td>${line(left)}</td><td>${line(right)}</td></tr>`).join('')}</tbody></table>`
        + (changed ? '' : '<div class="muted cfg-same">Совпадает с текущим.</div>');
}

// ============================================================================
// Редакторы: проверка синтаксиса и история изменений
// ============================================================================
// что открыто в редакторе: плейбук или файл (роли, defaults, ansible.cfg)
function editorContext(which) {
    if (which === 'playbook') return { kind: 'playbook', path: window.CURRENT_EDITING_PLAYBOOK, scope: window.CURRENT_EDITING_SCOPE || '', textarea: 'playbook_editor', result: 'playbook_check', title: window.CURRENT_EDITING_PLAYBOOK, language: 'yaml' };
    const kind = FILE_EDITOR.kind === 'role' ? 'role' : FILE_EDITOR.kind;
    return { kind, path: kind === 'role' ? FILE_EDITOR.path : kind, scope: FILE_EDITOR.scope || '', textarea: 'file_editor', result: 'file_check',
        title: kind === 'role' ? shownPath(FILE_EDITOR.path) : (kind === 'cfg' ? 'ansible.cfg' : 'defaults'), language: codeLanguage(kind === 'role' ? { kind: 'role', path: FILE_EDITOR.path } : { kind: 'object', path: kind === 'cfg' ? 'ansible.cfg' : 'defaults.yml' }) };
}
function showCheckResult(boxId, state, title, output) {
    const box = document.getElementById(boxId);
    box.className = `check-result is-${state}`;
    box.innerHTML = `<div class="check-result-head"><span>${esc(title)}</span><button type="button" class="check-result-close" aria-label="Скрыть" onclick="hideCheckResult('${boxId}')">×</button></div>${output ? `<pre>${esc(output)}</pre>` : ''}`;
    if (box.hidden) { box.hidden = false; box.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 180, easing: 'ease-out' }); }
}
function hideCheckResult(boxId) {
    const box = document.getElementById(boxId);
    if (box.hidden) return;
    box.animate([{ opacity: 1 }, { opacity: 0, transform: 'translateY(6px)' }], { duration: 150, easing: 'ease-in' }).onfinish = () => { box.hidden = true; };
}
function checkEditorSyntax(which) {
    const ctx = editorContext(which);
    const button = document.querySelector(`#${which === 'playbook' ? 'playbook_modal' : 'file_editor_modal'} .editor-check-btn`);
    button.disabled = true;
    button.textContent = 'Проверка…';
    // напрямую, не через api(): «ok: false» здесь — найденные ошибки синтаксиса, а не сбой запроса
    fetch(API.SYNTAX_CHECK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: CURRENT_PROJECT, object: CURRENT_OBJECT, scope: ctx.scope, kind: ctx.kind, path: ctx.path, content: document.getElementById(ctx.textarea).value }) })
        .then(async (response) => { const data = await response.json(); if (!response.ok) throw Error(data.error || 'Проверка не выполнена'); return data; })
        .then((data) => {
            const state = data.ok === true ? 'ok' : data.ok === false ? 'error' : 'info';
            const title = data.ok === true ? `Синтаксис в порядке${data.tool ? ` · ${data.tool}` : ''}` : data.ok === false ? `Найдены ошибки${data.tool ? ` · ${data.tool}` : ''}` : data.output;
            showCheckResult(ctx.result, state, title, data.ok === null ? '' : data.output);
        })
        .catch((error) => showCheckResult(ctx.result, 'error', 'Проверка не выполнена', error.message))
        .finally(() => { button.disabled = false; button.textContent = 'Синтаксис'; });
}
// при открытии редактора результат прошлой проверки не показывается
['playbook_check', 'file_check'].forEach((id) => {
    const modal = document.getElementById(id)?.closest('.modal-backdrop');
    if (modal) new MutationObserver(() => { if (!modal.hidden) document.getElementById(id).hidden = true; }).observe(modal, { attributes: true, attributeFilter: ['hidden'] });
});

let HISTORY = null;   // { ctx, versions, selected, content }
function openFileHistory(which) {
    const ctx = editorContext(which);
    HISTORY = { ctx, versions: [], selected: null, content: null };
    document.getElementById('history_context').textContent = ctx.title;
    document.getElementById('history_versions').innerHTML = '<div class="muted">Загрузка…</div>';
    document.getElementById('history_diff').innerHTML = '';
    document.getElementById('history_restore').disabled = true;
    showModalSmooth('history_modal');
    const query = `project=${encodeURIComponent(CURRENT_PROJECT)}&object=${encodeURIComponent(CURRENT_OBJECT || '')}&scope=${encodeURIComponent(ctx.scope)}&kind=${encodeURIComponent(ctx.kind)}&path=${encodeURIComponent(ctx.path)}`;
    HISTORY.query = query;
    fetch(`${API.FILE_HISTORY}?${query}&_=${Date.now()}`).then(async (response) => { const data = await response.json(); if (!response.ok || data.ok === false) throw Error(data.error || 'Не удалось прочитать историю'); return data; })
        .then((data) => {
            HISTORY.versions = data.versions;
            const box = document.getElementById('history_versions');
            if (!data.versions.length) {
                box.innerHTML = '<div class="empty-state"><b>Версий пока нет</b><span>Прежняя версия сохраняется при каждом сохранении файла.</span></div>';
                return;
            }
            box.innerHTML = data.versions.map((item, index) => `<button type="button" class="history-version" data-id="${esc(item.id)}"><b>${esc(item.time)}</b><small>${index === 0 ? 'последняя · ' : ''}${formatBytes(item.size)}</small></button>`).join('');
            box.querySelectorAll('.history-version').forEach((button) => button.addEventListener('click', () => selectHistoryVersion(button.dataset.id)));
            selectHistoryVersion(data.versions[0].id);
        })
        .catch((error) => { document.getElementById('history_versions').innerHTML = `<div class="muted">${esc(error.message)}</div>`; });
}
function selectHistoryVersion(id) {
    HISTORY.selected = id;
    document.querySelectorAll('#history_versions .history-version').forEach((button) => button.classList.toggle('active', button.dataset.id === id));
    document.getElementById('history_diff').innerHTML = '<div class="muted">Загрузка…</div>';
    fetch(`${API.FILE_HISTORY_VERSION}?${HISTORY.query}&id=${encodeURIComponent(id)}&_=${Date.now()}`).then(async (response) => { const data = await response.json(); if (!response.ok || data.ok === false) throw Error(data.error || 'Не удалось прочитать версию'); return data; })
        .then((data) => {
            if (HISTORY.selected !== id) return;
            HISTORY.content = data.content;
            document.getElementById('history_diff').innerHTML = renderDiffTable(data.rows, `Версия ${data.time}`, 'Сейчас в файле', HISTORY.ctx.language);
            document.getElementById('history_restore').disabled = false;
        })
        .catch((error) => { document.getElementById('history_diff').innerHTML = `<div class="muted">${esc(error.message)}</div>`; });
}
// версия загружается в редактор как правка — применяется после «Сохранить» (текущая версия тоже попадёт в историю)
function restoreHistoryVersion() {
    if (HISTORY?.content == null) return;
    const textarea = document.getElementById(HISTORY.ctx.textarea);
    textarea.value = HISTORY.content;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    hideModalSmooth('history_modal');
    notify('Версия загружена в редактор — нажмите «Сохранить», чтобы применить', 'info');
}
