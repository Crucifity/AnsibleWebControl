// разбирает query-параметры текущего адреса страницы
function getParams() {
    return new URLSearchParams(window.location.search);
}

// имя проекта из адреса страницы (пустая строка, если не задан)
function getProjectFromURL() {
    return getParams().get('project') || '';
}

// имя объекта из адреса страницы (пустая строка, если не задан)
function getObjectFromURL() {
    return getParams().get('object') || '';
}

// экранирует HTML-спецсимволы в строке перед вставкой в разметку
function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
}

// строит разметку кастомного выпадающего списка выбора проекта
function projectSelectorHTML(projects, selected) {
    const currentLabel = selected || 'не выбран';
    const options = projects.map((project) => `
        <button type="button" class="project-option${project === selected ? ' active' : ''}" data-project="${escapeHTML(project)}" onclick="selectProjectOption(this.dataset.project)">
            ${escapeHTML(project)}
        </button>
    `).join('');

    return `<div class="project-select" id="project_select_wrap">
        <select id="project_select" hidden aria-hidden="true">
            <option value="">-- выберите проект --</option>
            ${projects.map((project) => `<option value="${escapeHTML(project)}" ${project === selected ? 'selected' : ''}>${escapeHTML(project)}</option>`).join('')}
        </select>
        <button type="button" class="system-status-item project-select-button" id="project_select_button" title="Выбрать проект" aria-haspopup="listbox" aria-expanded="false" onclick="toggleProjectSelector(event)">
            <span class="project-select-caption">Проект</span>
            <span class="project-select-value" title="${escapeHTML(currentLabel)}">${escapeHTML(currentLabel)}</span>
            <span class="project-select-arrow">▾</span>
        </button>
        <div class="project-select-list" id="project_select_list" role="listbox">
            ${options}
        </div>
    </div>`;
}

// один раз добавляет в <head> стили выбора проекта/объекта и плавных панелей
function injectProjectSelectorStyles() {
    if (document.getElementById('project-selector-styles')) return;
    const style = document.createElement('style');
    style.id = 'project-selector-styles';
    style.textContent = `
/* Проект — кнопка в верхнем ряду, того же вида, что DHCP/TFTP/ISO */
        .project-select { position: relative; display: flex; flex: 0 0 auto; }
        .project-select-button {
            cursor: pointer;
            width: 180px;
            justify-content: flex-start;
            transition: background .15s, border-color .15s;
        }
        .project-select-button:hover { background: rgba(255,255,255,.09); transform: none; }
        .project-select-button[aria-expanded="true"] { border-color: rgba(64,150,255,.5); background: rgba(35,110,210,.14); }
        .project-select-caption { font-size: 14px; font-weight: 600; color: #fff; }
        .project-select-value {
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            font-size: 13px;
            color: rgba(190,215,255,.95);
        }
        .project-select-arrow {
            flex: 0 0 auto;
            margin-left: auto;
            font-size: 11px;
            color: rgba(255,255,255,.55);
            transition: transform .22s ease;
        }
        .project-select-button[aria-expanded="true"] .project-select-arrow { transform: rotate(180deg); }
        .project-select-list {
            position: absolute;
            left: 0;
            top: calc(100% + 6px);
            z-index: 1100;
            min-width: 100%;
            width: max-content;
            max-width: 320px;
            max-height: 0;
            overflow: hidden;
            padding: 0 4px;
            box-sizing: border-box;
            border: 1px solid transparent;
            border-radius: 10px;
            background: #1e1e1e;
            box-shadow: 0 12px 30px rgba(0,0,0,.42);
            opacity: 0;
            transform: translateY(-6px);
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

        /* Объекты */
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
        .object-select-button:hover {
            background: rgba(0,0,0,.62);
            transform: none;
        }
        .object-select-button[aria-expanded="true"] { border-color: rgba(0,210,106,.45); }
        .object-select-value {
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .object-select-arrow {
            flex: 0 0 auto;
            color: rgba(255,255,255,.65);
            transition: transform .22s ease;
        }
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

/* Автодеплой */
        .playbook-card { overflow: visible; }
        .role-children:not(.smooth-panel) {
            width: 100%;
            max-width: none;
            box-sizing: border-box;
            max-height: none !important;
            overflow: visible !important;
        }
        .role-children.smooth-panel { overflow: hidden !important; }
    `;
    document.head.appendChild(style);
}


// ставит выпадающий список объекта под его кнопкой (position: fixed по координатам кнопки)
function positionObjectSelectorList(wrap, list) {
    if (!wrap || !list) return;
    const button = wrap.querySelector('.object-select-button');
    if (!button) return;
    const rect = button.getBoundingClientRect();
    list.style.left = `${rect.left}px`;
    list.style.top = `${rect.bottom + 5}px`;
    list.style.width = `${rect.width}px`;
}

// рисует поверх нативного <select> объекта собственную кнопку и список, держа select источником значения
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
    button.className = 'system-status-item object-select-button';
    button.title = select.title || '';
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', 'false');
    const caption = select.dataset.caption ? `<span class="object-select-caption">${escapeHTML(select.dataset.caption)}</span>` : '';
    button.innerHTML = `${caption}<span class="object-select-value"></span><span class="object-select-arrow">▾</span>`;
    wrap.appendChild(button);

    const list = document.createElement('div');
    list.className = 'object-select-list';
    list.setAttribute('role', 'listbox');
    wrap.appendChild(list);

    // синхронизирует подпись и выбранный пункт кастомного списка с реальным <select>
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
    select.syncCustomList = sync; // main.js вызывает после заполнения списка объектов
    new MutationObserver(sync).observe(select, { childList: true, subtree: true });
    window.addEventListener('resize', () => {
        if (list.classList.contains('is-open')) positionObjectSelectorList(wrap, list);
    });
    window.addEventListener('scroll', () => {
        if (list.classList.contains('is-open')) positionObjectSelectorList(wrap, list);
    }, true);
    sync();
}

// вешает перехват кликов по ролям/файлам плейбука для плавного раскрытия и закрытия
function injectRoleAndModalBehavior() {
    if (document.documentElement.dataset.awcRoleModalFix === '1') return;
    document.documentElement.dataset.awcRoleModalFix = '1';

    // пересчитывает высоту раскрытых родительских панелей после изменения вложенной
    function updateRoleAncestors(panel) {
        let parent = panel?.parentElement;
        while (parent) {
            if (parent.classList.contains('role-children')) {
                if (!parent.hidden) parent.style.maxHeight = `${parent.scrollHeight}px`;
            }
            parent = parent.parentElement;
        }
    }

    // вертикальные отступы панели, которые анимируются вместе с высотой
    const PANEL_BOX_PROPS = ['paddingTop', 'paddingBottom', 'marginTop', 'marginBottom'];

    // полная высота панели в раскрытом виде: содержимое + её «родные» внутренние отступы
    // (во время анимации текущие отступы ещё не дошли до конечных — их не учитываем)
    function panelContentHeight(panel) {
        const style = getComputedStyle(panel);
        const current = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
        return panel.scrollHeight - current + (panel._naturalPadding ?? current);
    }

    // плавно раскрывает/сворачивает папку роли. Вместе с высотой анимируются и вертикальные отступы
    // (иначе в конце сворачивания они исчезают рывком — «ступенька»); конечная высота берётся из
    // фактического содержимого — панель подстраивается под число файлов.
    function animateRolePanel(panel, open) {
        if (!panel || panel.dataset.animating === '1') return;
        const ms = ANIM.PANEL_TOGGLE_MS;
        panel.classList.add('smooth-panel');
        panel.dataset.animating = '1';
        const transition = `max-height ${ms}ms ease, padding-top ${ms}ms ease, padding-bottom ${ms}ms ease, margin-top ${ms}ms ease, margin-bottom ${ms}ms ease, opacity ${Math.round(ms * 0.8)}ms ease`;
        // начальное состояние выставляется без перехода, затем переход включается и задаётся конечное
        panel.style.transition = 'none';
        panel.style.overflow = 'hidden';
        let target;
        if (open) {
            panel.hidden = false;
            panel.style.maxHeight = 'none';
            const style = getComputedStyle(panel);
            const natural = Object.fromEntries(PANEL_BOX_PROPS.map((prop) => [prop, style[prop]]));
            panel._naturalPadding = parseFloat(natural.paddingTop) + parseFloat(natural.paddingBottom);
            panel.style.maxHeight = '0px';
            panel.style.opacity = '0';
            PANEL_BOX_PROPS.forEach((prop) => { panel.style[prop] = '0px'; });
            // высота — в момент старта: к нему содержимое могло уже смениться (пришёл список файлов)
            target = () => { panel.style.maxHeight = `${panelContentHeight(panel)}px`; PANEL_BOX_PROPS.forEach((prop) => { panel.style[prop] = natural[prop]; }); panel.style.opacity = '1'; };
        } else {
            const style = getComputedStyle(panel);
            PANEL_BOX_PROPS.forEach((prop) => { panel.style[prop] = style[prop]; });
            panel.style.maxHeight = `${panel.offsetHeight}px`;
            panel.style.opacity = '1';
            target = () => { panel.style.maxHeight = '0px'; PANEL_BOX_PROPS.forEach((prop) => { panel.style[prop] = '0px'; }); panel.style.opacity = '0'; };
        }
        panel.getBoundingClientRect();                     // применить начальное состояние
        requestAnimationFrame(() => {
            panel.style.transition = transition;
            target();
            if (open) updateRoleAncestors(panel);
        });
        setTimeout(() => {
            if (!open) panel.hidden = true;
            panel.classList.remove('smooth-panel');
            ['maxHeight', 'opacity', 'overflow', 'transition', ...PANEL_BOX_PROPS].forEach((prop) => { panel.style[prop] = ''; });
            panel.dataset.animating = '0';
            updateRoleAncestors(panel);
        }, ms + 20);
    }

    // подгружает содержимое README вложенных директорий роли по мере раскрытия
    function loadRoleReadmes(children) {
        children.querySelectorAll('pre[data-readme-path]:not([data-loaded])').forEach((pre) => {
            pre.dataset.loaded = '1';
            fetch(`${API.ROLE_FILE}?project=${encodeURIComponent(CURRENT_PROJECT)}${CURRENT_OBJECT ? `&object=${encodeURIComponent(CURRENT_OBJECT)}` : ''}&path=${encodeURIComponent(pre.dataset.readmePath)}`)
                .then((response) => { if (!response.ok) throw Error('Не удалось загрузить README.md'); return response.json(); })
                .then((data) => {
                    pre.textContent = data.content;
                    updateRoleAncestors(children);
                })
                .catch((error) => { pre.textContent = error.message; updateRoleAncestors(children); });
        });
    }

    // раскрывает/сворачивает директорию роли с анимацией
    function toggleRoleDirAnimated(button) {
        const children = button.parentElement?.querySelector('.role-children');
        if (!children) return;
        const open = children.hidden;
        animateRolePanel(children, open);
        loadRoleReadmes(children);
        const chevron = button.querySelector('.role-chevron');
        if (chevron) chevron.textContent = open ? '▾' : '▸';
    }

    document.addEventListener('click', (event) => {
        const roleButton = event.target.closest('.role-toggle');
        if (roleButton) {
            event.preventDefault();
            event.stopImmediatePropagation();
            toggleRoleDirAnimated(roleButton);
            return;
        }
    }, true);
}

// рисует верхнюю навигацию и селектор проекта/объекта
function injectNav(active, projects = [], selectedProject = '', selectedObject = '') {
    const selector = document.getElementById('project_selector');
    injectProjectSelectorStyles();
    if (selector) selector.innerHTML = projectSelectorHTML(projects, selectedProject);
    enhanceObjectSelector();
}

// открывает/закрывает выпадающий список проектов
function toggleProjectSelector(event) {
    event?.stopPropagation();
    const button = document.getElementById('project_select_button');
    const list = document.getElementById('project_select_list');
    if (!button || !list) return;
    const open = list.classList.toggle('is-open');
    button.setAttribute('aria-expanded', String(open));
}

// закрывает выпадающий список проектов
function closeProjectSelector() {
    const button = document.getElementById('project_select_button');
    const list = document.getElementById('project_select_list');
    if (!button || !list) return;
    list.classList.remove('is-open');
    button.setAttribute('aria-expanded', 'false');
}

// выбирает проект из списка и переходит к нему
function selectProjectOption(project) {
    const select = document.getElementById('project_select');
    if (!select) return;
    select.value = project;
    changeProject();
}

document.addEventListener('click', (event) => {
    const projectWrap = document.getElementById('project_select_wrap');
    if (projectWrap && !projectWrap.contains(event.target)) closeProjectSelector();
    // список объектов открыт признаком is-open у самого списка (раньше снимался с обёртки — и список не закрывался)
    const objectWrap = document.querySelector('.object-select-custom');
    if (objectWrap && !objectWrap.contains(event.target)) closeObjectSelector();
});
// Esc закрывает открытый список проекта/объекта (на этапе перехвата — раньше обработчиков окон страницы)
window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !document.querySelector('.object-select-list.is-open, .project-select-list.is-open')) return;
    event.stopImmediatePropagation();
    closeObjectSelector();
    closeProjectSelector();
}, true);

// закрывает список объектов
function closeObjectSelector() {
    document.querySelectorAll('.object-select-list.is-open').forEach((list) => list.classList.remove('is-open'));
    document.querySelectorAll('.object-select-button[aria-expanded="true"]').forEach((button) => button.setAttribute('aria-expanded', 'false'));
}

// переходит на страницу выбранного проекта
function changeProject() {
    const project = document.getElementById('project_select').value;
    // Объект в адрес НЕ переносим: имена объектов свои у каждого проекта, а
    // старый объект в новом проекте давал пустые узлы/плейбуки. Сервер сам
    // выберет первый объект нового проекта.
    window.location.href = project ? `${window.location.pathname}?project=${encodeURIComponent(project)}` : window.location.pathname;
}

// переходит на страницу выбранного объекта текущего проекта
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
