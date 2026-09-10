document.write('<script src="/main-base.js"><\/script>');

(function installGroupFilterFix() {
    function install() {
        if (document.documentElement.dataset.awcGroupFilterFix === '1') return;
        document.documentElement.dataset.awcGroupFilterFix = '1';

        const style = document.createElement('style');
        style.textContent = `
            .nodes-section-head .group-strip { overflow: visible; }
            .group-filter-dropdown { z-index: 1101; }
        `;
        document.head.appendChild(style);

        document.addEventListener('click', (event) => {
            const clearButton = event.target.closest('#group-filter-clear');
            const filterButton = event.target.closest('#group-filter-btn');
            if (!clearButton && !filterButton) return;

            event.preventDefault();
            event.stopImmediatePropagation();
            if (clearButton) clearGroupFilter();
            else toggleGroupFilter();
        }, true);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', install, { once: true });
    } else {
        install();
    }
})();