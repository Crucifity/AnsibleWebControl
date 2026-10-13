// Единое место для констант фронтенда: адресов API,
// интервалов опроса и длительностей анимаций.
//
// Файл подключается самым первым (до common.js и main.js) и не является
// ES-модулем — объявленные тут const/let доступны из всех остальных
// <script>-файлов страницы напрямую, без window.

// --- Адреса backend-эндпоинтов ---------------------------------------------
const API = {
    DATA: '/data',
    STATUS: '/status',
    SYSTEM_STATUS: '/system_status',
    LOG_NEW: '/log_new',
    ROLES: '/roles',
    ROLE_FILE: '/role_file',
    PLAYBOOK: '/playbook',
    SAVE_PLAYBOOK: '/save_playbook',
    RUN: '/run',
    RUN_AUTODEPLOY: '/run_autodeploy',
    STOP: '/stop',
    UPDATE_HOST: '/update_host',
    ADD_HOST: '/add_host',
    DELETE_HOSTS: '/delete_hosts',
    DELETE_GROUP: '/delete_group',
    NMAP_START: '/nmap_start',
    NMAP_STOP: '/nmap_stop',
    NMAP_STATUS: '/nmap_status',
    NMAP_INTERFACES: '/nmap_interfaces',
    CONSTANTS: '/constants',
    NETMAP: '/netmap',
    NETMAP_STATUS: '/netmap_status',
    NETMAP_AUTOBUILD: '/netmap_autobuild',
    DISCOVERED_SUMMARY: '/discovered_summary',
    DISCOVERED_CLEAR: '/discovered_clear',
    NETMAP_RESET: '/netmap_reset',
    PROJECT_CREATE: '/project_create',
    ROLE_CREATE: '/role_create',
    PLAYBOOK_CREATE: '/playbook_create',
    ROLES_LIST: '/roles_list',
    ROLE_FILE_SAVE: '/role_file_save',
    ROLE_FILE_CREATE: '/role_file_create',
    ANSIBLE_CATALOG: '/ansible_catalog',
    ANSIBLE_MODULE: '/ansible_module',
    ANSIBLE_CONTEXT: '/ansible_context',
    PLAYBOOK_FILES: '/playbook_files',
    PLAYBOOK_DELETE: '/playbook_delete',
    PLAYBOOK_ROLE_ADD: '/playbook_role_add',
    PLAYBOOK_ROLE_REMOVE: '/playbook_role_remove',
    ROLE_FILE_DELETE: '/role_file_delete',
    OBJECT_FILE_OPEN: '/object_file_open',
    OBJECT_FILE_SAVE: '/object_file_save',
    AUTODEPLOY_SOURCES: '/autodeploy_sources',
    ROLES_TREE: '/roles_tree',
    PLAYBOOK_ROLES_ADD: '/playbook_roles_add',
    SUBNET_SCAN: '/subnet_scan',
    SUBNET_SCAN_START: '/subnet_scan_start',
    SUBNET_SCAN_RESET: '/subnet_scan_reset',
    ROLE_RENAME: '/role_rename',
    NMAP_SWITCH_HOSTKEY: '/nmap_switch_hostkey',
    NMAP_SWITCH_TRUST: '/nmap_switch_trust',
    NMAP_SWITCH_FORGET: '/nmap_switch_forget',
};

// --- Интервалы опроса сервера (мс) ------------------------------------------
// STATUS_POLL_INTERVAL_MS соответствует STATUS_POLL_INTERVAL_SECONDS
// в backend/constants.py — если меняете период там, поменяйте и здесь.
const LOG_POLL_INTERVAL_MS = 1000;
const STATUS_POLL_INTERVAL_MS = 10000;
// Соответствует SYSTEM_STATUS_POLL_INTERVAL_SECONDS в backend/constants.py —
// DHCP/TFTP/ISO обновляются реже, чем доступность узлов.
const SYSTEM_STATUS_POLL_INTERVAL_MS = 30000;
// Пока открыто окно NMAP и включён режим прослушки, список устройств
// обновляется чаще — это активный процесс
const NMAP_POLL_INTERVAL_MS = 3000;

// --- Прочие константы ---------------------------------------------------
// Имя параметра узла, значение которого выбирается из списка (см.
// hwtype_options в /data и HWTYPE_* в backend/constants.py)
const HWTYPE_PARAM_NAME = 'hwtype';

// --- Длительности анимаций интерфейса (мс) ----------------------------------
// Должны совпадать с длительностями transition/animation в style.css —
// иначе JS уберёт inline-стили раньше или позже, чем закончится сам переход.
const ANIM = {
    PANEL_TOGGLE_MS: 240,   // разворачивание/сворачивание карточки узла и роли
    BODY_COLLAPSE_MS: 230,  // сворачивание общего плейбук-раздела
    LABEL_FADE_MS: 180,     // смена текста на кнопке (например, "Выбрать все")
    MODAL_MOTION_MS: 220,   // открытие/закрытие модальных окон
};

// Ключ в localStorage, под которым браузер помнит выбранную тему (light/dark).
// Тот же ключ прописан во встроенном скрипте в <head> main.html.
const THEME_STORAGE_KEY = 'awc-theme';

// Версия интерфейса. Если сервер сообщает другую (поле version в /data) — значит, файлы обновили,
// а web1x.py не перезапустили: интерфейс покажет предупреждение.
const APP_VERSION = '0.0.33';
