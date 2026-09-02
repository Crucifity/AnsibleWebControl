/*
 * Consolidated UI layer for 3.0.
 *
 * The older 5x-fixes.js and status-fix.js files are intentionally kept in
 * the repository for compatibility, but main.html no longer loads them.
 * This file is the single runtime layer for the current main page.
 */
(function () {
    'use strict';

    let activeGroup = null;
    let confirmAction = null;
    let selectionButtonTimer = null;

    function contextQuery(extra = '') {
        const project = encodeURIComponent(CURRENT_PROJECT);
        const object = CURRENT_OBJECT
            ? `&object=${encodeURIComponent(CURRENT_OBJECT)}`
            : '';
        return `project=${project}${object}${extra}`;
    }

    function roleFileUrl(path) {
        return `/role_file?${contextQuery(`&path=${encodeURIComponent(path)}`)}`;
    }

    function playbookUrl(name) {
        return `/playbook?${contextQuery(`&name=${encodeURIComponent(name)}`)}`;
    }

    function updateHostSelectionButton(animate = false) {
        const button = document.getElementById('host_select_toggle');
        if (!button) return;

        const label = button.querySelector('.selection-button-label');
        if (!label) return;

        const checkboxes = [...document.querySelectorAll('.node-check')];
        const allSelected = checkboxes.length > 0
            && checkboxes.every((checkbox) => checkbox.checked);
        const nextText = allSelected ? 'Отменить выбор' : 'Выбрать все узлы';

        if (label.textContent === nextText) return;

        if (selectionButtonTimer) {
            clearTimeout(selectionButtonTimer);
            selectionButtonTimer = null;
        }

        if (!animate) {
            label.textContent = nextText;
            return;
        }

        button.classList.add('selection-changing');
        selectionButtonTimer = setTimeout(() => {
            label.textContent = nextText;
            button.classList.remove('selection-changing');
            selectionButtonTimer = null;
        }, 90);
    }

    window.toggleHostSelection = function () {
        const checkboxes = [...document.querySelectorAll('.node-check')];
        if (!checkboxes.length) return;

        const allSelected = checkboxes.every((checkbox) => checkbox.checked);
        const nextValue = !allSelected;

        checkboxes.forEach((checkbox) => {
            checkbox.checked = nextValue;
        });

        if (typeof updateRunHint === 'function') updateRunHint();
        updateHostSelectionButton(true);
    };

    function restoreSelectedNodes(selected) {
        document.querySelectorAll('.node-check').forEach((checkbox) => {
            checkbox.checked = selected.has(checkbox.value);
        });
    }

    function renderNodesWithFilter() {
        const container = document.getElementById('nodes');
        if (!container || !DATA) return;

        const selected = new Set(
            [...container.querySelectorAll('.node-check:checked')]
                .map((checkbox) => checkbox.value),
        );

        const nodes = (DATA.hosts || []).filter((node) => {
            if (!activeGroup) return true;

            return (activeGroup.hosts || []).some((host) => {
                const name = typeof host === 'string'
                    ? host
                    : host?.hostname || host?.name;
                return name === node.hostname;
            });
        });

        container.innerHTML = nodes.map((node) => renderNode(node)).join('')
            || '<div class="empty">В этой группе узлов нет</div>';
        restoreSelectedNodes(selected);
        updateRunHint();
        updateHostSelectionButton();
    }

    function renderGroupButtons() {
        const container = document.getElementById('groups');
        if (!container) return;

        const groups = DATA?.groups || [];
        container.innerHTML = groups.map((group) => {
            const active = activeGroup?.name === group.name;
            return `
                <button type="button"
                        class="group-chip group-filter${active ? ' active' : ''}"
                        data-group-name="${esc(group.name)}">
                    <b>${esc(group.name)}</b>${group.hosts?.length || 0}
                </button>
            `;
        }).join('');
    }

    function applyGroupFilter() {
        renderGroupButtons();
        renderNodesWithFilter();
    }

    function findGroup(name) {
        return (DATA?.groups || []).find((group) => group.name === name) || null;
    }

    function setupGroupFilters() {
        const container = document.getElementById('groups');
        if (!container || container.dataset.filtersReady === '1') return;

        container.dataset.filtersReady = '1';
        container.addEventListener('click', (event) => {
            const button = event.target.closest('.group-filter');
            if (!button) return;

            const name = button.dataset.groupName;
            activeGroup = activeGroup?.name === name ? null : findGroup(name);
            applyGroupFilter();
        });

        const observer = new MutationObserver(() => {
            if (container.dataset.rendering === '1') return;
            if (!DATA?.groups?.length) return;

            if (!container.querySelector('.group-filter')) {
                container.dataset.rendering = '1';
                renderGroupButtons();
                delete container.dataset.rendering;
            }
        });
        observer.observe(container, { childList: true });
    }

    function setupRenderObserver() {
        const container = document.getElementById('nodes');
        if (!container || container.dataset.filterObserverReady === '1') return;

        container.dataset.filterObserverReady = '1';
        const observer = new MutationObserver(() => {
            if (!activeGroup || container.dataset.filtering === '1') {
                updateHostSelectionButton();
                return;
            }

            const visibleNames = new Set(
                [...container.querySelectorAll('.node-check')].map((input) => input.value),
            );
            const expectedNames = new Set(
                (activeGroup.hosts || []).map((host) => (
                    typeof host === 'string'
                        ? host
                        : host?.hostname || host?.name
                )),
            );

            const hasForeignNode = [...visibleNames]
                .some((name) => !expectedNames.has(name));

            if (hasForeignNode) {
                container.dataset.filtering = '1';
                renderNodesWithFilter();
                delete container.dataset.filtering;
            } else {
                updateHostSelectionButton();
            }
        });
        observer.observe(container, { childList: true });
    }

    function ensureConfirmModal() {
        let modal = document.getElementById('run_confirm_modal');
        if (modal) return modal;

        modal = document.createElement('div');
        modal.id = 'run_confirm_modal';
        modal.className = 'modal-backdrop';
        modal.hidden = true;
        modal.innerHTML = `
            <div class="modal-card run-confirm-card" role="dialog" aria-modal="true" aria-labelledby="run_confirm_title">
                <div class="modal-head">
                    <div>
                        <div class="modal-kicker">Подтверждение запуска</div>
                        <h3 id="run_confirm_title">Запустить?</h3>
                    </div>
                    <button class="modal-close" type="button" aria-label="Закрыть">×</button>
                </div>
                <div class="modal-body">
                    <div id="run_confirm_text" class="run-confirm-text"></div>
                </div>
                <div class="modal-footer">
                    <button type="button" class="modal-secondary run-confirm-cancel">Отмена</button>
                    <button type="button" class="primary run-confirm-ok">Запустить</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        const close = () => {
            modal.hidden = true;
            confirmAction = null;
        };

        modal.querySelector('.modal-close').addEventListener('click', close);
        modal.querySelector('.run-confirm-cancel').addEventListener('click', close);
        modal.addEventListener('click', (event) => {
            if (event.target === modal) close();
        });
        modal.querySelector('.run-confirm-ok').addEventListener('click', () => {
            const action = confirmAction;
            close();
            if (action) action();
        });

        return modal;
    }

    function showConfirmation(title, text, action) {
        const modal = ensureConfirmModal();
        confirmAction = action;
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

            const playbooks = [...document.querySelectorAll('.pb:checked')]
                .map((input) => input.value);
            const hosts = [...document.querySelectorAll('.node-check:checked')]
                .map((input) => input.value);

            if (isRun && !playbooks.length) {
                alert('Выберите хотя бы один плейбук');
                return;
            }

            if (isRun) {
                const hostsText = hosts.length
                    ? `${hosts.length} ${hosts.length === 1 ? 'узел' : 'узлов'}`
                    : 'все узлы';

                showConfirmation(
                    'Запустить выбранные плейбуки?',
                    `<strong>Плейбуки:</strong><br>${playbooks.map(esc).join('<br>')}<br><br>`
                        + `<strong>Узлы:</strong> ${hostsText}`,
                    () => window.runSelected(),
                );
                return;
            }

            const hostsText = hosts.length
                ? `${hosts.length} ${hosts.length === 1 ? 'выбранный узел' : 'выбранных узлов'}`
                : 'все узлы';

            showConfirmation(
                'Запустить авторазвертывание?',
                `<strong>Плейбук:</strong> autodeploy.yml<br><br>`
                    + `<strong>Узлы:</strong> ${hostsText}`,
                () => window.runAutodeploy(),
            );
        }, true);
    }

    function installPlaybookEditor() {
        window.editPlaybook = function (name) {
            const modal = document.getElementById('playbook_modal');
            const editor = document.getElementById('playbook_editor');
            const title = document.getElementById('playbook_modal_title');
            if (!modal || !editor || !title) return;

            window.CURRENT_EDITING_PLAYBOOK = name;
            title.textContent = name;
            editor.value = 'Загрузка…';
            editor.readOnly = true;
            modal.hidden = false;

            fetch(playbookUrl(name))
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
        };

        window.closePlaybookModal = function () {
            const modal = document.getElementById('playbook_modal');
            if (modal) modal.hidden = true;
            window.CURRENT_EDITING_PLAYBOOK = '';
        };

        window.savePlaybookFromModal = function () {
            const name = window.CURRENT_EDITING_PLAYBOOK;
            const editor = document.getElementById('playbook_editor');
            if (!name || !editor) return;

            editor.disabled = true;
            fetch('/save_playbook', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    project: CURRENT_PROJECT,
                    object: CURRENT_OBJECT,
                    name,
                    content: editor.value,
                }),
            })
                .then(async (response) => {
                    const data = await response.json();
                    if (!response.ok || data.ok === false) {
                        throw Error(data.error || 'Не удалось сохранить плейбук');
                    }
                    closePlaybookModal();
                    loadMain();
                })
                .catch((error) => alert(error.message))
                .finally(() => { editor.disabled = false; });
        };
    }

    function fitPlaybookEditor() {
        const editor = document.getElementById('playbook_editor');
        const card = document.getElementById('playbook_editor_card');
        if (!editor || !card) return;

        const longestLine = editor.value.split('\n').reduce(
            (max, line) => Math.max(max, line.length),
            0,
        );
        const width = Math.min(1100, Math.max(620, longestLine * 7.2 + 70));
        editor.style.width = `${width}px`;
        card.style.width = `${Math.min(width + 42, window.innerWidth - 40)}px`;
    }

    function patchStatusInterval() {
        const originalSetInterval = window.setInterval;
        window.setInterval = function (callback, delay, ...args) {
            if (
                typeof callback === 'function'
                && callback.name === 'updateNodeStatuses'
                && delay === 15000
            ) {
                return originalSetInterval.call(this, callback, 10000, ...args);
            }

            return originalSetInterval.call(this, callback, delay, ...args);
        };
    }

    function initialize() {
        setupGroupFilters();
        setupRenderObserver();
        interceptRunButtons();
        installPlaybookEditor();

        document.addEventListener('change', (event) => {
            if (event.target.matches('.node-check')) {
                updateHostSelectionButton();
            }
        });

        const sync = () => {
            setupGroupFilters();
            setupRenderObserver();

            if (DATA) {
                if (activeGroup && !findGroup(activeGroup.name)) {
                    activeGroup = null;
                }
                renderGroupButtons();
                if (activeGroup) renderNodesWithFilter();
            }

            updateHostSelectionButton();

            // main.js is loaded after this file and replaces editPlaybook.
            installPlaybookEditor();
        };

        window.addEventListener('load', sync);
        window.addEventListener('resize', () => {
            const modal = document.getElementById('playbook_modal');
            if (modal && !modal.hidden) fitPlaybookEditor();
        });

        document.addEventListener('keydown', (event) => {
            if (event.key !== 'Escape') return;

            const modal = document.getElementById('run_confirm_modal');
            if (modal) {
                modal.hidden = true;
                confirmAction = null;
            }

            if (typeof closePlaybookModal === 'function') closePlaybookModal();
        });

        setTimeout(sync, 0);
        setTimeout(sync, 100);
    }

    // main.js registers its 15-second status timer after this file is loaded.
    // Convert that single timer to the desired 10-second interval.
    patchStatusInterval();
    initialize();
})();
