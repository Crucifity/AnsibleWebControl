/* Reliable client-side status refresh for 2.0x. */
(function () {
    let busy = false;

    window.updateNodeStatuses = function () {
        if (!window.CURRENT_PROJECT || busy || !window.DATA) return;
        busy = true;

        const query = `?project=${encodeURIComponent(window.CURRENT_PROJECT)}${window.CURRENT_OBJECT ? `&object=${encodeURIComponent(window.CURRENT_OBJECT)}` : ''}&_=${Date.now()}`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 4500);

        fetch(`/status${query}`, { cache: 'no-store', signal: controller.signal })
            .then((response) => {
                if (!response.ok) throw new Error('status request failed');
                return response.json();
            })
            .then((status) => {
                window.DATA.status = status || {};
                renderStatusCards();
            })
            .catch(() => {
                /* Never leave the interface frozen at "проверка". */
                window.DATA.status = Object.fromEntries(
                    (window.DATA.hosts || []).map((node) => [node.hostname, false])
                );
                renderStatusCards();
            })
            .finally(() => {
                clearTimeout(timeout);
                busy = false;
            });
    };

    function renderStatusCards() {
        const container = document.getElementById('nodes');
        if (!container || typeof window.renderNode !== 'function') return;
        const selected = new Set(
            [...container.querySelectorAll('.node-check:checked')].map((input) => input.value)
        );
        container.innerHTML = (window.DATA.hosts || []).map(window.renderNode).join('')
            || '<div class="empty">Узлов нет</div>';
        container.querySelectorAll('.node-check').forEach((input) => {
            input.checked = selected.has(input.value);
        });
        if (typeof window.updateRunHint === 'function') window.updateRunHint();
    }

    window.addEventListener('load', () => {
        setTimeout(window.updateNodeStatuses, 150);
        setInterval(window.updateNodeStatuses, 15000);
    });
})();