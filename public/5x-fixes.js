/* Small, isolated UI changes for the 2.0 branch. */

(function () {
    function roleFileUrl(path) {
        return `/role_file?project=${encodeURIComponent(CURRENT_PROJECT)}`
            + `${CURRENT_OBJECT ? `&object=${encodeURIComponent(CURRENT_OBJECT)}` : ''}`
            + `&path=${encodeURIComponent(path)}`;
    }

    function playbookUrl(name) {
        return `/playbook?project=${encodeURIComponent(CURRENT_PROJECT)}`
            + `${CURRENT_OBJECT ? `&object=${encodeURIComponent(CURRENT_OBJECT)}` : ''}`
            + `&name=${encodeURIComponent(name)}`;
    }

    window.editPlaybook = function (name) {
        window.openPlaybookModal(name);
    };

    window.openPlaybookModal = function (name) {
        const modal = document.getElementById('playbook_modal');
        const editor = document.getElementById('playbook_editor');
        const title = document.getElementById('playbook_modal_title');
        if (!modal || !editor) return;

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
                if (typeof loadMain === 'function') loadMain();
            })
            .catch((error) => alert(error.message))
            .finally(() => { editor.disabled = false; });
    };

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

    window.addEventListener('resize', () => {
        if (!document.getElementById('playbook_modal')?.hidden) {
            fitPlaybookEditor();
        }
    });

    window.renderNode = function (node) {
        const status = window.DATA?.status || {};
        const hasStatus = Object.prototype.hasOwnProperty.call(status, node.hostname);
        const state = !hasStatus
            ? 'pending'
            : status[node.hostname] === true
                ? 'available'
                : 'unavailable';
        const label = {
            pending: 'проверка',
            available: 'доступен',
            unavailable: 'недоступен',
        }[state];
        const dot = {
            pending: 'status-pending',
            available: 'status-up',
            unavailable: 'status-down',
        }[state];
        const params = Object.entries(node.parameters || {});
        const id = `node-${encodeURIComponent(node.hostname)}`;

        return `<div class="host-card node-card node-${state}" id="${id}">
            <div class="host-head" onclick="toggleNodeFromHead(event, this.closest('.node-card'))">
                <span class="node-status ${state}"><span class="status-dot ${dot}"></span>${label}</span>
                <input class="node-check" type="checkbox" value="${esc(node.hostname)}" onclick="event.stopPropagation()" onchange="updateRunHint()">
                <span class="node-expand">▸</span>
                <div class="node-main">
                    <span class="node-name">${esc(node.hostname)}</span>
                    <span class="node-ip">${esc(node.ip || '—')}</span>
                    <span class="node-template">${esc(node.template || node.node_type || 'Узел')}</span>
                </div>
                <button class="node-edit" onclick="editNode(event, '${esc(node.hostname)}')">Изменить</button>
            </div>
            <div class="host-body" hidden>
                <div class="param-grid">
                    ${params.length
                        ? params.map(([key, value]) => `
                            <div class="param-name" title="${esc(key)}">${esc(key)}</div>
                            <input class="param-value" data-key="${esc(key)}" value="${esc(value)}" readonly>
                        `).join('')
                        : '<div class="empty">Параметров нет</div>'}
                </div>
                <div class="host-footer">
                    <span class="edit-note">${esc(node.template || node.node_type || 'Узел')} · изменения сохраняются в hosts.yml</span>
                    <button class="edit-save primary" onclick="saveNode(event, '${esc(node.hostname)}')">Сохранить</button>
                    <button class="edit-save" onclick="cancelNodeEdit(event)">Отмена</button>
                </div>
            </div>
        </div>`;
    };

    /* Availability polling: one request immediately, then every 10 seconds. */
    let statusTimer = null;
    let statusRequest = null;

    async function pollNodeStatus() {
        if (!CURRENT_PROJECT) return;
        if (statusRequest) return;

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 4500);
        statusRequest = fetch(
            `/status?project=${encodeURIComponent(CURRENT_PROJECT)}`
                + `${CURRENT_OBJECT ? `&object=${encodeURIComponent(CURRENT_OBJECT)}` : ''}`,
            { cache: 'no-store', signal: controller.signal },
        )
            .then((response) => {
                if (!response.ok) throw Error(`HTTP ${response.status}`);
                return response.json();
            })
            .then((data) => {
                if (!window.DATA) window.DATA = {};
                window.DATA.status = data.status || data;
                if (typeof renderNodes === 'function') renderNodes();
            })
            .catch(() => {
                /* A failed poll must not leave a permanent "проверка" state. */
            })
            .finally(() => {
                clearTimeout(timeout);
                statusRequest = null;
            });

        await statusRequest;
    }

    function startStatusPolling() {
        if (statusTimer) clearInterval(statusTimer);
        pollNodeStatus();
        statusTimer = setInterval(pollNodeStatus, 10000);
    }

    window.startStatusPolling = startStatusPolling;
    window.stopStatusPolling = function () {
        if (statusTimer) clearInterval(statusTimer);
        statusTimer = null;
    };

    window.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            closePlaybookModal();
            if (typeof closeAddNodeModal === 'function') closeAddNodeModal();
        }
    });

    startStatusPolling();
})();