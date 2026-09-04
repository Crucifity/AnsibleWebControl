const P = getProjectFromURL();
let O = getObjectFromURL();
let PLAY = '';

function esc(s) {
    return String(s ?? '').replace(/[&<>\"']/g, (c) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '\"': '&quot;',
        "'": '&#39;'
    }[c]));
}

function load() {
    fetch(`/data?project=${encodeURIComponent(P)}&object=${encodeURIComponent(O)}`)
        .then((r) => r.json())
        .then((d) => {
            if (!O && d.objects?.length) {
                O = d.objects[0];
                history.replaceState(
                    {},
                    '',
                    `/editor?project=${encodeURIComponent(P)}&object=${encodeURIComponent(O)}`
                );
            }

            injectNav('editor', d.projects || [], d.selected_project || '', O);

            document.getElementById('object_select').innerHTML = (d.objects || [])
                .map((o) => `<option value="${esc(o)}" ${o === O ? 'selected' : ''}>${esc(o)}</option>`)
                .join('');

            document.getElementById('playbook_select').innerHTML = (d.playbooks || [])
                .map((x) => `<option value="${esc(x.name)}">${esc(x.name)}</option>`)
                .join('');

            renderSummary(d.hosts || {}, d.status || {});

            return Promise.all([
                fetch(`/files?project=${encodeURIComponent(P)}&object=${encodeURIComponent(O)}`).then((r) => r.json()),
                d
            ]);
        })
        .then((x) => {
            if (!x) return;

            document.getElementById('hosts_editor').value = x[0].hosts || '';
            document.getElementById('defaults_editor').value = x[0].defaults || '';
            loadPlaybook();
        })
        .catch((error) => console.error('Ошибка загрузки редактора:', error));
}

function loadPlaybook() {
    PLAY = document.getElementById('playbook_select').value;
    if (!PLAY) return;

    fetch(`/playbook?project=${encodeURIComponent(P)}&object=${encodeURIComponent(O)}&name=${encodeURIComponent(PLAY)}`)
        .then((r) => r.json())
        .then((d) => {
            document.getElementById('playbook_editor').value = d.content || '';
        })
        .catch((error) => console.error('Ошибка загрузки плейбука:', error));
}

function savePlaybook() {
    fetch('/save_playbook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            project: P,
            object: O,
            name: PLAY,
            content: document.getElementById('playbook_editor').value
        })
    })
        .then((r) => r.json())
        .then((x) => alert(x.ok ? 'Сохранено' : (x.error || 'Ошибка сохранения')))
        .catch((error) => alert('Сетевая ошибка при сохранении: ' + error.message));
}

// ИСПРАВЛЕНО: Валидация содержимого перед сохранением
function saveFiles() {
    const hostsContent = document.getElementById('hosts_editor').value;
    
    if (!hostsContent.trim()) {
        return alert('Ошибка: файл hosts.yml не может быть пустым!');
    }
    
    if (!hostsContent.includes('all:') && !hostsContent.includes('hosts:')) {
        if (!confirm('Файл не содержит базовой структуры YAML (all:/hosts:). Вы уверены, что хотите сохранить?')) {
            return;
        }
    }

    fetch('/save_files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            project: P,
            object: O,
            hosts: hostsContent,
            defaults: document.getElementById('defaults_editor').value
        })
    })
        .then((r) => r.json())
        .then((x) => {
            if (x.ok) alert('Сохранено');
            else alert(x.error || 'Ошибка сохранения');
        })
        .catch((error) => alert('Сетевая ошибка: ' + error.message));
}

load();