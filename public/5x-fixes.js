/* 5.x targeted fixes. Loaded after the existing 4.x UI. */

(function () {
    function statusFor(hostname) {
        if (!window.DATA || !window.DATA.status) {
            return 'pending';
        }

        if (!Object.prototype.hasOwnProperty.call(window.DATA.status, hostname)) {
            return 'pending';
        }

        return window.DATA.status[hostname] === true ? 'available' : 'unavailable';
    }

    window.renderNode = function (node) {
        const availability = statusFor(node.hostname);
        const params = Object.entries(node.parameters || {});
        const id = `node-${encodeURIComponent(node.hostname)}`;

        let state = `
            <span class="node-status pending">
                <span class="status-dot status-pending"></span>
                проверка
            </span>`;

        if (availability === 'available') {
            state = `
                <span class="node-status available">
                    <span class="status-dot status-up"></span>
                    доступен
                </span>`;
        } else if (availability === 'unavailable') {
            state = `
                <span class="node-status unavailable">
                    <span class="status-dot status-down"></span>
                    недоступен
                </span>`;
        }

        return `
            <div class="host-card node-card node-${availability}" id="${id}">
                <div class="host-head" onclick="toggleNodeFromHead(event, this.closest('.node-card'))">
                    ${state}
                    <input class="node-check" type="checkbox"
                           value="${esc(node.hostname)}"
                           onclick="event.stopPropagation()"
                           onchange="updateRunHint()">
                    <span class="node-expand">▸</span>
                    <div class="node-main">
                        <span class="node-name">${esc(node.hostname)}</span>
                        <span class="node-ip">${esc(node.ip || '—')}</span>
                        <span class="node-template">${esc(node.template || node.node_type || 'Узел')}</span>
                    </div>
                    <button class="node-edit"
                            onclick="editNode(event, '${esc(node.hostname)}')">
                        Изменить
                    </button>
                </div>

                <div class="host-body" hidden>
                    <div class="param-grid">
                        ${params.length
                            ? params.map(([key, value]) => `
                                <div class="param-name" title="${esc(key)}">${esc(key)}</div>
                                <input class="param-value"
                                       data-key="${esc(key)}"
                                       value="${esc(value)}"
                                       readonly>
                            `).join('')
                            : '<div class="empty">Параметров нет</div>'}
                    </div>
                    <div class="host-footer">
                        <span class="edit-note">
                            ${esc(node.template || node.node_type || 'Узел')} · изменения сохраняются в hosts.yml
                        </span>
                        <button class="edit-save primary"
                                onclick="saveNode(event, '${esc(node.hostname)}')">
                            Сохранить
                        </button>
                        <button class="edit-save" onclick="cancelNodeEdit(event)">
                            Отмена
                        </button>
                    </div>
                </div>
            </div>`;
    };

    window.renderRoleTree = function (nodes) {
        return (nodes || []).map((node) => {
            if (node.type === 'dir') {
                return `
                    <div class="role-dir">
                        <button class="role-toggle" onclick="toggleRoleDir(this)">
                            ▸ <span>${esc(node.name)}</span>
                        </button>
                        <div class="role-children" hidden>
                            ${renderRoleTree(node.children)}
                        </div>
                    </div>`;
            }

            return `
                <button class="role-file"
                        onclick="openRoleFile('${esc(node.path)}')">
                    ${esc(node.name)}
                </button>`;
        }).join('');
    };

    window.togglePlaybookRoles = function (button, name) {
        const card = button.closest('.playbook-card');
        const panel = card.querySelector('.playbook-roles');

        if (!panel.hidden) {
            panel.hidden = true;
            button.textContent = 'Роли ▸';
            return;
        }

        if (!panel.dataset.loaded) {
            panel.innerHTML = '<div class="roles-loading">Загрузка…</div>';

            const query = `/roles?project=${encodeURIComponent(CURRENT_PROJECT)}`
                + `${CURRENT_OBJECT ? `&object=${encodeURIComponent(CURRENT_OBJECT)}` : ''}`
                + `&playbook=${encodeURIComponent(name)}`;

            fetch(query)
                .then((response) => {
                    if (!response.ok) {
                        throw Error('Не удалось загрузить роли');
                    }
                    return response.json();
                })
                .then((roles) => {
                    panel.innerHTML = roles.length
                        ? `<div class="roles-title">Роли плейбука</div>${renderRoleTree(roles)}`
                        : '<div class="muted">Роли в плейбуке не указаны.</div>';
                    panel.dataset.loaded = '1';
                })
                .catch((error) => {
                    panel.innerHTML = `<div class="muted">${esc(error.message)}</div>`;
                });
        }

        panel.hidden = false;
        button.textContent = 'Роли ▾';
    };

    window.openRoleFile = function (path) {
        const query = `/role_file?project=${encodeURIComponent(CURRENT_PROJECT)}`
            + `${CURRENT_OBJECT ? `&object=${encodeURIComponent(CURRENT_OBJECT)}` : ''}`
            + `&path=${encodeURIComponent(path)}`;

        fetch(query)
            .then((response) => {
                if (!response.ok) {
                    throw Error('Не удалось открыть файл');
                }
                return response.json();
            })
            .then((data) => {
                const child = window.open('', '_blank');
                if (!child) {
                    throw Error('Браузер заблокировал новое окно');
                }

                child.document.write(`
                    <!doctype html>
                    <html lang="ru">
                    <head>
                        <meta charset="utf-8">
                        <title>${esc(data.name)}</title>
                        <style>
                            body {
                                margin: 0;
                                background: #171717;
                                color: #eee;
                                font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
                            }
                            header {
                                padding: 12px 20px;
                                border-bottom: 1px solid #333;
                                color: #aaa;
                            }
                            pre {
                                margin: 0;
                                padding: 20px;
                                white-space: pre-wrap;
                                line-height: 1.5;
                            }
                        </style>
                    </head>
                    <body>
                        <header>${esc(data.name)}</header>
                        <pre>${esc(data.content)}</pre>
                    </body>
                    </html>`);
                child.document.close();
            })
            .catch((error) => alert(error.message));
    };

    const originalLoadMain = window.loadMain;
    if (typeof originalLoadMain === 'function') {
        originalLoadMain();
    }
})();
