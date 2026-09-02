/* 3.0 UI behaviour: node group filters and launch confirmation. */
(function () {
    let activeGroup = null;

    const originalRenderNode = window.renderNode;
    const originalRenderGroups = window.renderGroups;
    const originalRunSelected = window.runSelected;
    const originalRunAutodeploy = window.runAutodeploy;

    function groupContainsNode(group, hostname) {
        return (group?.hosts || []).some((host) => {
            if (typeof host === 'string') return host === hostname;
            return host?.hostname === hostname || host?.name === hostname;
        });
    }

    window.renderNode = function (node) {
        if (activeGroup && !groupContainsNode(activeGroup, node.hostname)) return '';
        return originalRenderNode(node);
    };

    function redrawNodes() {
        const element = document.getElementById('nodes');
        if (!element || !window.DATA) return;
        const nodes = window.DATA.hosts || [];
        element.innerHTML = nodes.map(window.renderNode).join('') || '<div class="empty">В этой группе узлов нет</div>';
        updateRunHint();
    }

    window.renderGroups = function (groups) {
        const element = document.getElementById('groups');
        if (!element) return;

        if (!groups?.length) {
            element.innerHTML = '';
            activeGroup = null;
            return;
        }

        if (activeGroup && !groups.some((group) => group.name === activeGroup.name)) {
            activeGroup = null;
        }

        element.innerHTML = groups.map((group) => {
            const active = activeGroup?.name === group.name;
            return `
                <button type="button" class="group-chip group-filter ${active ? 'active' : ''}"
                    data-group-name="${esc(group.name)}">
                    <b>${esc(group.name)}</b>${group.hosts?.length || 0}
                </button>
            `;
        }).join('');

        element.querySelectorAll('.group-filter').forEach((button) => {
            button.addEventListener('click', () => {
                const name = button.dataset.groupName;
                activeGroup = activeGroup?.name === name
                    ? null
                    : groups.find((group) => group.name === name) || null;
                window.renderGroups(groups);
                redrawNodes();
            });
        });
    };

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
                        <h3 id="run_confirm_title">Запустить выбранные плейбуки?</h3>
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

        const close = () => { modal.hidden = true; };
        modal.querySelector('.modal-close').addEventListener('click', close);
        modal.querySelector('.run-confirm-cancel').addEventListener('click', close);
        modal.addEventListener('click', (event) => {
            if (event.target === modal) close();
        });
        return modal;
    }

    function confirmRun({ title, text, action }) {
        const modal = ensureConfirmModal();
        modal.querySelector('#run_confirm_title').textContent = title;
        modal.querySelector('#run_confirm_text').innerHTML = text;
        modal.querySelector('.run-confirm-ok').textContent = 'Запустить';
        modal.hidden = false;

        const ok = modal.querySelector('.run-confirm-ok');
        const handler = () => {
            ok.removeEventListener('click', handler);
            modal.hidden = true;
            action();
        };
        ok.addEventListener('click', handler);
    }

    window.runSelected = function () {
        const playbooks = [...document.querySelectorAll('.pb:checked')].map((item) => item.value);
        const hosts = [...document.querySelectorAll('.node-check:checked')].map((item) => item.value);

        if (!playbooks.length) {
            alert('Выберите хотя бы один плейбук');
            return;
        }

        const hostsText = hosts.length
            ? `${hosts.length} ${hosts.length === 1 ? 'узел' : 'узлов'}`
            : 'все выбранные узлы';
        const playbooksText = playbooks.map(esc).join('<br>');

        confirmRun({
            title: 'Запустить выбранные плейбуки?',
            text: `<strong>Плейбуки:</strong><br>${playbooksText}<br><br><strong>Узлы:</strong> ${hostsText}`,
            action: () => originalRunSelected(),
        });
    };

    window.runAutodeploy = function () {
        const hosts = [...document.querySelectorAll('.node-check:checked')].map((item) => item.value);
        const hostsText = hosts.length
            ? `${hosts.length} ${hosts.length === 1 ? 'выбранный узел' : 'выбранных узлов'}`
            : 'все узлы';

        confirmRun({
            title: 'Запустить авторазвертывание?',
            text: `<strong>Плейбук:</strong> autodeploy.yml<br><br><strong>Узлы:</strong> ${hostsText}`,
            action: () => originalRunAutodeploy(),
        });
    };

    window.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        const modal = document.getElementById('run_confirm_modal');
        if (modal) modal.hidden = true;
    });
})();
