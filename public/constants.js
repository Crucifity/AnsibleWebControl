// Единое место для "жёстко прибитых" значений фронтенда: адресов API,
// интервалов опроса и длительностей анимаций.
//
// Файл подключается самым первым (до common.js и main.js) и не является
// ES-модулем — объявленные тут const/let доступны из всех остальных
// <script>-файлов страницы напрямую, без window.

// --- Адреса backend-эндпоинтов ---------------------------------------------
// Держим их в одном месте, чтобы при изменении маршрута на сервере (web1x.py)
// не пришлось искать соответствующую строку по всем JS-файлам.
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
    DELETE_HOST: '/delete_host',
    DELETE_HOSTS: '/delete_hosts',
    DELETE_GROUP: '/delete_group',
};

// --- Интервалы опроса сервера (мс) ------------------------------------------
// STATUS_POLL_INTERVAL_MS соответствует STATUS_POLL_INTERVAL_SECONDS
// в backend/constants.py — если меняете период там, поменяйте и здесь.
const LOG_POLL_INTERVAL_MS = 1000;
const STATUS_POLL_INTERVAL_MS = 10000;
// Соответствует SYSTEM_STATUS_POLL_INTERVAL_SECONDS в backend/constants.py —
// DHCP/TFTP/ISO обновляются реже, чем доступность узлов.
const SYSTEM_STATUS_POLL_INTERVAL_MS = 30000;

// --- Прочие константы ---------------------------------------------------
// Имя параметра узла, значение которого выбирается из списка (см.
// hwtype_options в /data и HWTYPE_* в backend/constants.py), а не вводится
// свободным текстом.
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
