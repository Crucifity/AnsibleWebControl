"""
Встроенный справочник Ansible для подсказок в редакторе.

Используется, пока на сервере не собран полный справочник из установленного Ansible
(`ansible-doc`), и если `ansible-doc` недоступен. Полный справочник точнее: он совпадает
с вашей версией Ansible и установленными коллекциями.

Формат параметра модуля: (имя, тип, обязательный, варианты значений, описание).
"""

def _o(name, kind="str", required=False, choices=None, description=""):
    return {"n": name, "t": kind, "r": required, "c": choices or [], "d": description}

STATES_PRESENT = ["absent", "present"]

# Модуль → (краткое описание, параметры)
MODULES = {
    "ansible.builtin.apt": ("Пакеты apt (Debian/Ubuntu/Astra)", [
        _o("name", "list", description="Имя пакета или список пакетов"),
        _o("state", choices=["absent", "build-dep", "latest", "present", "fixed"], description="Состояние пакета"),
        _o("update_cache", "bool", description="Выполнить apt-get update перед установкой"),
        _o("cache_valid_time", "int", description="Не обновлять кэш, если он моложе N секунд"),
        _o("upgrade", choices=["dist", "full", "no", "safe", "yes"], description="Обновление системы"),
        _o("install_recommends", "bool", description="Ставить рекомендуемые пакеты"),
        _o("autoremove", "bool", description="Удалить ненужные зависимости"),
        _o("purge", "bool", description="Удалить вместе с конфигурацией"),
        _o("deb", "path", description="Установить локальный .deb"),
        _o("force", "bool"), _o("default_release"), _o("only_upgrade", "bool")]),
    "ansible.builtin.apt_key": ("Ключи репозиториев apt", [
        _o("url"), _o("id"), _o("keyserver"), _o("data"), _o("file", "path"), _o("keyring", "path"),
        _o("state", choices=STATES_PRESENT)]),
    "ansible.builtin.apt_repository": ("Репозитории apt", [
        _o("repo", required=True, description="Строка репозитория"), _o("state", choices=STATES_PRESENT),
        _o("filename"), _o("update_cache", "bool"), _o("mode", "raw"), _o("codename")]),
    "ansible.builtin.dnf": ("Пакеты dnf (RHEL/Fedora)", [
        _o("name", "list"), _o("state", choices=["absent", "present", "installed", "removed", "latest"]),
        _o("enablerepo", "list"), _o("disablerepo", "list"), _o("update_cache", "bool"), _o("disable_gpg_check", "bool")]),
    "ansible.builtin.yum": ("Пакеты yum", [
        _o("name", "list"), _o("state", choices=["absent", "installed", "latest", "present", "removed"]),
        _o("enablerepo", "list"), _o("disablerepo", "list"), _o("update_cache", "bool"), _o("disable_gpg_check", "bool")]),
    "ansible.builtin.package": ("Пакеты (менеджер выбирается автоматически)", [
        _o("name", "list", True), _o("state", required=True, choices=["absent", "present", "latest"]), _o("use")]),
    "ansible.builtin.pip": ("Пакеты Python (pip)", [
        _o("name", "list"), _o("version"), _o("requirements"), _o("virtualenv", "path"),
        _o("state", choices=["absent", "forcereinstall", "latest", "present"]), _o("executable", "path"), _o("extra_args")]),
    "ansible.builtin.copy": ("Копирование файлов на узел", [
        _o("src", "path", description="Исходный файл (в роли — из files/)"),
        _o("dest", "path", True, description="Куда положить на узле"),
        _o("content", description="Содержимое файла вместо src"),
        _o("owner"), _o("group"), _o("mode", "raw", description="Права, например '0644'"),
        _o("backup", "bool", description="Сохранить резервную копию"), _o("force", "bool"),
        _o("remote_src", "bool", description="src уже на узле"), _o("validate"), _o("directory_mode", "raw")]),
    "ansible.builtin.template": ("Файл из шаблона Jinja2", [
        _o("src", "path", True, description="Шаблон (в роли — из templates/)"),
        _o("dest", "path", True, description="Куда положить на узле"),
        _o("owner"), _o("group"), _o("mode", "raw"), _o("backup", "bool"), _o("force", "bool"), _o("validate"),
        _o("trim_blocks", "bool"), _o("newline_sequence", choices=["\\n", "\\r", "\\r\\n"])]),
    "ansible.builtin.file": ("Файлы, каталоги, ссылки, права", [
        _o("path", "path", True), _o("state", choices=["absent", "directory", "file", "hard", "link", "touch"]),
        _o("owner"), _o("group"), _o("mode", "raw"), _o("src", "path", description="Цель ссылки"),
        _o("recurse", "bool"), _o("force", "bool"), _o("follow", "bool")]),
    "ansible.builtin.lineinfile": ("Строка в файле", [
        _o("path", "path", True), _o("line"), _o("regexp"), _o("state", choices=STATES_PRESENT),
        _o("insertafter"), _o("insertbefore"), _o("create", "bool"), _o("backup", "bool"), _o("backrefs", "bool"),
        _o("owner"), _o("group"), _o("mode", "raw"), _o("validate")]),
    "ansible.builtin.blockinfile": ("Блок текста в файле", [
        _o("path", "path", True), _o("block"), _o("marker"), _o("state", choices=STATES_PRESENT),
        _o("insertafter"), _o("insertbefore"), _o("create", "bool"), _o("backup", "bool"), _o("owner"), _o("group"), _o("mode", "raw")]),
    "ansible.builtin.replace": ("Замена по регулярному выражению", [
        _o("path", "path", True), _o("regexp", required=True), _o("replace"), _o("after"), _o("before"), _o("backup", "bool")]),
    "ansible.builtin.service": ("Службы", [
        _o("name", required=True), _o("state", choices=["reloaded", "restarted", "started", "stopped"]),
        _o("enabled", "bool", description="Запускать при загрузке"), _o("arguments"), _o("pattern")]),
    "ansible.builtin.systemd": ("Службы systemd", [
        _o("name"), _o("state", choices=["reloaded", "restarted", "started", "stopped"]), _o("enabled", "bool"),
        _o("daemon_reload", "bool", description="systemctl daemon-reload"), _o("masked", "bool"),
        _o("scope", choices=["system", "user", "global"]), _o("no_block", "bool")]),
    "ansible.builtin.command": ("Команда (без оболочки)", [
        _o("cmd", description="Команда"), _o("argv", "list"), _o("chdir", "path"), _o("creates", "path"),
        _o("removes", "path"), _o("stdin")]),
    "ansible.builtin.shell": ("Команда через оболочку", [
        _o("cmd"), _o("chdir", "path"), _o("creates", "path"), _o("removes", "path"), _o("executable", "path"), _o("stdin")]),
    "ansible.builtin.raw": ("Команда без Python на узле", [_o("executable", "path")]),
    "ansible.builtin.script": ("Локальный скрипт на узле", [
        _o("cmd"), _o("chdir", "path"), _o("creates", "path"), _o("removes", "path"), _o("executable")]),
    "ansible.builtin.user": ("Пользователи", [
        _o("name", required=True), _o("state", choices=STATES_PRESENT), _o("uid", "int"), _o("group"),
        _o("groups", "list"), _o("append", "bool"), _o("shell"), _o("home", "path"), _o("create_home", "bool"),
        _o("password"), _o("comment"), _o("system", "bool"), _o("remove", "bool"), _o("generate_ssh_key", "bool"),
        _o("ssh_key_file", "path"), _o("expires", "float"), _o("password_lock", "bool")]),
    "ansible.builtin.group": ("Группы пользователей", [
        _o("name", required=True), _o("state", choices=STATES_PRESENT), _o("gid", "int"), _o("system", "bool")]),
    "ansible.builtin.get_url": ("Скачать файл по URL", [
        _o("url", required=True), _o("dest", "path", True), _o("mode", "raw"), _o("owner"), _o("group"),
        _o("checksum"), _o("force", "bool"), _o("timeout", "int"), _o("validate_certs", "bool"), _o("headers", "dict"),
        _o("url_username"), _o("url_password"), _o("backup", "bool")]),
    "ansible.builtin.uri": ("HTTP-запрос", [
        _o("url", required=True), _o("method"), _o("body", "raw"),
        _o("body_format", choices=["form-urlencoded", "json", "raw", "form-multipart"]), _o("headers", "dict"),
        _o("status_code", "list"), _o("return_content", "bool"), _o("validate_certs", "bool"), _o("user"),
        _o("password"), _o("timeout", "int"), _o("dest", "path")]),
    "ansible.builtin.unarchive": ("Распаковка архива", [
        _o("src", "path", True), _o("dest", "path", True), _o("remote_src", "bool"), _o("creates", "path"),
        _o("owner"), _o("group"), _o("mode", "raw"), _o("extra_opts", "list"), _o("list_files", "bool")]),
    "ansible.builtin.debug": ("Вывод сообщения или переменной", [
        _o("msg", description="Сообщение"), _o("var", description="Имя переменной"), _o("verbosity", "int")]),
    "ansible.builtin.set_fact": ("Задать переменные", [_o("cacheable", "bool")]),
    "ansible.builtin.fail": ("Остановить с ошибкой", [_o("msg")]),
    "ansible.builtin.assert": ("Проверка условий", [
        _o("that", "list", True, description="Список условий"), _o("fail_msg"), _o("success_msg"), _o("quiet", "bool")]),
    "ansible.builtin.pause": ("Пауза", [_o("seconds", "int"), _o("minutes", "int"), _o("prompt"), _o("echo", "bool")]),
    "ansible.builtin.wait_for": ("Ожидание порта, файла или условия", [
        _o("port", "int"), _o("host"), _o("path", "path"),
        _o("state", choices=["absent", "drained", "present", "started", "stopped"]), _o("timeout", "int"),
        _o("delay", "int"), _o("search_regex"), _o("sleep", "int")]),
    "ansible.builtin.wait_for_connection": ("Ожидание доступности узла", [
        _o("timeout", "int"), _o("delay", "int"), _o("sleep", "int"), _o("connect_timeout", "int")]),
    "ansible.builtin.include_tasks": ("Подключить задачи (динамически)", [_o("file"), _o("apply", "dict")]),
    "ansible.builtin.import_tasks": ("Подключить задачи (статически)", [_o("file")]),
    "ansible.builtin.include_role": ("Подключить роль (динамически)", [
        _o("name", required=True, description="Имя роли"), _o("tasks_from"), _o("vars_from"), _o("defaults_from"),
        _o("handlers_from"), _o("apply", "dict"), _o("public", "bool"), _o("allow_duplicates", "bool")]),
    "ansible.builtin.import_role": ("Подключить роль (статически)", [
        _o("name", required=True, description="Имя роли"), _o("tasks_from"), _o("vars_from"), _o("defaults_from"),
        _o("handlers_from"), _o("allow_duplicates", "bool")]),
    "ansible.builtin.include_vars": ("Загрузить переменные из файла", [
        _o("file", "path"), _o("dir", "path"), _o("name"), _o("depth", "int"), _o("files_matching"), _o("ignore_files", "list")]),
    "ansible.builtin.stat": ("Сведения о файле", [
        _o("path", "path", True), _o("follow", "bool"), _o("get_checksum", "bool"),
        _o("checksum_algorithm", choices=["md5", "sha1", "sha224", "sha256", "sha384", "sha512"]), _o("get_mime", "bool")]),
    "ansible.builtin.find": ("Поиск файлов", [
        _o("paths", "list", True), _o("patterns", "list"), _o("recurse", "bool"),
        _o("file_type", choices=["any", "directory", "file", "link"]), _o("age"), _o("size"), _o("hidden", "bool"),
        _o("excludes", "list"), _o("contains")]),
    "ansible.builtin.fetch": ("Забрать файл с узла", [
        _o("src", required=True), _o("dest", required=True), _o("flat", "bool"), _o("fail_on_missing", "bool"),
        _o("validate_checksum", "bool")]),
    "ansible.builtin.setup": ("Сбор фактов", [
        _o("gather_subset", "list"), _o("filter", "list"), _o("gather_timeout", "int"), _o("fact_path", "path")]),
    "ansible.builtin.hostname": ("Имя узла", [_o("name", required=True), _o("use")]),
    "ansible.builtin.cron": ("Задания cron", [
        _o("name"), _o("minute"), _o("hour"), _o("day"), _o("month"), _o("weekday"), _o("job"),
        _o("state", choices=STATES_PRESENT), _o("user"),
        _o("special_time", choices=["annually", "daily", "hourly", "monthly", "reboot", "weekly", "yearly"]), _o("disabled", "bool")]),
    "ansible.builtin.reboot": ("Перезагрузка", [
        _o("reboot_timeout", "int"), _o("msg"), _o("pre_reboot_delay", "int"), _o("post_reboot_delay", "int"), _o("test_command")]),
    "ansible.builtin.git": ("Клонирование git-репозитория", [
        _o("repo", required=True), _o("dest", "path", True), _o("version"), _o("force", "bool"), _o("update", "bool"),
        _o("depth", "int"), _o("accept_hostkey", "bool"), _o("key_file", "path")]),
    "ansible.builtin.tempfile": ("Временный файл или каталог", [
        _o("state", choices=["directory", "file"]), _o("suffix"), _o("prefix"), _o("path", "path")]),
    "ansible.builtin.slurp": ("Прочитать файл с узла", [_o("src", "path", True)]),
    "ansible.builtin.known_hosts": ("Файл known_hosts", [
        _o("name", required=True), _o("key"), _o("path", "path"), _o("state", choices=STATES_PRESENT), _o("hash_host", "bool")]),
    "ansible.builtin.debconf": ("Ответы debconf", [
        _o("name", required=True), _o("question"), _o("value", "raw"), _o("vtype"), _o("unseen", "bool")]),
    "ansible.builtin.meta": ("Служебные действия", []),
    "ansible.builtin.add_host": ("Добавить узел в inventory", [_o("name", required=True), _o("groups", "list")]),
    "ansible.builtin.group_by": ("Группы по признаку", [_o("key", required=True), _o("parents", "list")]),
    "ansible.builtin.iptables": ("Правила iptables", [
        _o("chain"), _o("protocol"), _o("destination_port"), _o("jump"), _o("source"), _o("state", choices=STATES_PRESENT),
        _o("table", choices=["filter", "nat", "mangle", "raw", "security"]), _o("comment"), _o("ctstate", "list"), _o("in_interface")]),
    "ansible.builtin.expect": ("Ответы на вопросы команды", [
        _o("command", required=True), _o("responses", "dict", True), _o("timeout", "raw"), _o("chdir", "path"), _o("creates", "path")]),
    "ansible.builtin.async_status": ("Статус асинхронной задачи", [_o("jid", required=True), _o("mode", choices=["status", "cleanup"])]),
    "ansible.builtin.rpm_key": ("Ключи rpm", [_o("key", required=True), _o("state", choices=STATES_PRESENT), _o("fingerprint")]),
    "ansible.builtin.yum_repository": ("Репозитории yum", [
        _o("name", required=True), _o("description"), _o("baseurl", "list"), _o("gpgcheck", "bool"), _o("gpgkey", "list"),
        _o("enabled", "bool"), _o("state", choices=STATES_PRESENT), _o("file")]),
    "ansible.builtin.getent": ("Записи getent", [_o("database", required=True), _o("key"), _o("split")]),
    "ansible.builtin.ping": ("Проверка связи", [_o("data")]),
    "ansible.builtin.package_facts": ("Факты об установленных пакетах", [_o("manager", "list")]),
    "ansible.builtin.service_facts": ("Факты о службах", []),
    "ansible.builtin.sysvinit": ("Службы SysV", [
        _o("name", required=True), _o("state", choices=["started", "stopped", "restarted", "reloaded"]), _o("enabled", "bool")]),
    "ansible.builtin.dpkg_selections": ("Выбор пакетов dpkg", [
        _o("name", required=True), _o("selection", required=True, choices=["install", "hold", "deinstall", "purge"])]),
    "ansible.posix.authorized_key": ("Ключи SSH пользователя", [
        _o("user", required=True), _o("key", required=True), _o("state", choices=STATES_PRESENT), _o("path", "path"),
        _o("exclusive", "bool"), _o("manage_dir", "bool")]),
    "ansible.posix.mount": ("Точки монтирования", [
        _o("path", "path", True), _o("src", "path"), _o("fstype"), _o("opts"),
        _o("state", required=True, choices=["absent", "mounted", "present", "unmounted", "remounted", "ephemeral"]),
        _o("dump"), _o("passno"), _o("boot", "bool")]),
    "ansible.posix.sysctl": ("Параметры ядра sysctl", [
        _o("name", required=True), _o("value"), _o("state", choices=STATES_PRESENT), _o("reload", "bool"),
        _o("sysctl_file", "path"), _o("sysctl_set", "bool")]),
    "ansible.posix.selinux": ("Режим SELinux", [_o("policy"), _o("state", required=True, choices=["disabled", "enforcing", "permissive"])]),
    "ansible.posix.firewalld": ("Правила firewalld", [
        _o("service"), _o("port"), _o("zone"), _o("permanent", "bool"), _o("immediate", "bool"),
        _o("state", required=True, choices=["absent", "disabled", "enabled", "present"]), _o("source"), _o("rich_rule"), _o("interface")]),
    "ansible.posix.synchronize": ("Синхронизация каталогов (rsync)", [
        _o("src", "path", True), _o("dest", "path", True), _o("mode", choices=["pull", "push"]), _o("delete", "bool"),
        _o("recursive", "bool"), _o("archive", "bool"), _o("rsync_opts", "list")]),
    "community.general.ufw": ("Правила ufw", [
        _o("rule", choices=["allow", "deny", "limit", "reject"]), _o("port"), _o("proto", choices=["any", "tcp", "udp"]),
        _o("state", choices=["disabled", "enabled", "reloaded", "reset"]), _o("from_ip"), _o("to_ip"),
        _o("direction", choices=["in", "incoming", "out", "outgoing", "routed"]), _o("comment")]),
    "community.general.timezone": ("Часовой пояс", [_o("name"), _o("hwclock", choices=["local", "UTC"])]),
    "community.general.modprobe": ("Модули ядра", [_o("name", required=True), _o("state", choices=STATES_PRESENT), _o("params")]),
}

# Ключевые слова плея и таска: (имя, описание, вид значения: "scalar" | "list" | "map")
PLAY_KEYWORDS = [
    ("name", "Название плея", "scalar"), ("hosts", "Узлы или группы", "scalar"), ("become", "Повышение прав (sudo)", "scalar"),
    ("become_user", "Пользователь для become", "scalar"), ("become_method", "Способ become", "scalar"),
    ("gather_facts", "Собирать факты", "scalar"), ("vars", "Переменные плея", "map"), ("vars_files", "Файлы переменных", "list"),
    ("vars_prompt", "Запрос переменных", "list"), ("roles", "Роли", "list"), ("tasks", "Задачи", "list"),
    ("pre_tasks", "Задачи до ролей", "list"), ("post_tasks", "Задачи после ролей", "list"), ("handlers", "Хендлеры", "list"),
    ("serial", "Порциями по N узлов", "scalar"), ("strategy", "Стратегия выполнения", "scalar"),
    ("any_errors_fatal", "Остановить всё при ошибке", "scalar"), ("max_fail_percentage", "Допустимый % ошибок", "scalar"),
    ("environment", "Переменные окружения", "map"), ("tags", "Теги", "list"), ("collections", "Коллекции", "list"),
    ("connection", "Тип подключения", "scalar"), ("remote_user", "Пользователь SSH", "scalar"),
    ("ignore_unreachable", "Не падать на недоступных", "scalar"), ("order", "Порядок узлов", "scalar"),
    ("check_mode", "Режим проверки", "scalar"), ("diff", "Показывать изменения", "scalar"),
    ("force_handlers", "Запускать хендлеры даже при ошибке", "scalar"), ("module_defaults", "Значения по умолчанию модулей", "map"),
]
TASK_KEYWORDS = [
    ("name", "Название задачи", "scalar"), ("when", "Условие", "scalar"), ("loop", "Цикл по списку", "scalar"),
    ("register", "Сохранить результат в переменную", "scalar"), ("notify", "Вызвать хендлер", "scalar"),
    ("become", "Повышение прав (sudo)", "scalar"), ("become_user", "Пользователь для become", "scalar"),
    ("tags", "Теги", "list"), ("vars", "Переменные задачи", "map"), ("ignore_errors", "Не падать при ошибке", "scalar"),
    ("changed_when", "Когда считать «изменено»", "scalar"), ("failed_when", "Когда считать ошибкой", "scalar"),
    ("delegate_to", "Выполнить на другом узле", "scalar"), ("run_once", "Один раз на все узлы", "scalar"),
    ("block", "Блок задач", "list"), ("rescue", "Задачи при ошибке в block", "list"), ("always", "Задачи всегда после block", "list"),
    ("until", "Повторять до условия", "scalar"), ("retries", "Число повторов", "scalar"), ("delay", "Пауза между повторами", "scalar"),
    ("no_log", "Скрыть вывод", "scalar"), ("environment", "Переменные окружения", "map"), ("check_mode", "Режим проверки", "scalar"),
    ("diff", "Показывать изменения", "scalar"), ("loop_control", "Настройки цикла", "map"), ("with_items", "Цикл (старый синтаксис)", "scalar"),
    ("args", "Аргументы модуля", "map"), ("listen", "Тема для notify (в хендлере)", "scalar"), ("throttle", "Ограничить параллельность", "scalar"),
    ("timeout", "Таймаут задачи", "scalar"), ("any_errors_fatal", "Остановить всё при ошибке", "scalar"),
    ("async", "Выполнять асинхронно (сек)", "scalar"), ("poll", "Опрос асинхронной задачи", "scalar"),
]
LOOP_CONTROL_KEYS = [("loop_var", "Имя переменной цикла"), ("index_var", "Переменная с номером"), ("label", "Подпись в выводе"),
                     ("pause", "Пауза между итерациями"), ("extended", "Расширенные сведения ansible_loop")]
BOOLEAN_KEYS = {"become", "gather_facts", "ignore_errors", "no_log", "run_once", "check_mode", "diff", "any_errors_fatal",
                "ignore_unreachable", "force_handlers", "public", "allow_duplicates"}
META_ACTIONS = ["flush_handlers", "end_play", "end_host", "end_batch", "clear_facts", "clear_host_errors",
                "refresh_inventory", "reset_connection", "noop"]

FILTERS = [
    ("default", "Значение по умолчанию"), ("d", "Короткая запись default"), ("mandatory", "Ошибка, если не задано"),
    ("bool", "В логическое"), ("int", "В целое"), ("float", "В дробное"), ("string", "В строку"),
    ("lower", "В нижний регистр"), ("upper", "В верхний регистр"), ("capitalize", "С заглавной"), ("title", "Каждое слово с заглавной"),
    ("trim", "Убрать пробелы по краям"), ("replace", "Заменить подстроку"), ("regex_replace", "Заменить по регулярному выражению"),
    ("regex_search", "Найти по регулярному выражению"), ("regex_findall", "Найти все совпадения"),
    ("join", "Склеить список"), ("split", "Разбить строку"), ("first", "Первый элемент"), ("last", "Последний элемент"),
    ("length", "Длина"), ("unique", "Без повторов"), ("sort", "Сортировка"), ("reverse", "В обратном порядке"),
    ("map", "Применить к каждому"), ("select", "Отобрать по условию"), ("reject", "Отбросить по условию"),
    ("selectattr", "Отобрать по атрибуту"), ("rejectattr", "Отбросить по атрибуту"), ("combine", "Объединить словари"),
    ("dict2items", "Словарь в список"), ("items2dict", "Список в словарь"), ("flatten", "Сделать список плоским"),
    ("zip", "Попарно объединить списки"), ("product", "Декартово произведение"), ("difference", "Разность списков"),
    ("intersect", "Пересечение списков"), ("union", "Объединение списков"), ("min", "Минимум"), ("max", "Максимум"),
    ("sum", "Сумма"), ("random", "Случайный элемент"), ("shuffle", "Перемешать"), ("list", "В список"), ("dict", "В словарь"),
    ("to_json", "В JSON"), ("to_nice_json", "В красивый JSON"), ("from_json", "Из JSON"), ("to_yaml", "В YAML"),
    ("to_nice_yaml", "В красивый YAML"), ("from_yaml", "Из YAML"), ("b64encode", "В base64"), ("b64decode", "Из base64"),
    ("hash", "Хэш"), ("password_hash", "Хэш пароля"), ("basename", "Имя файла из пути"), ("dirname", "Каталог из пути"),
    ("realpath", "Полный путь"), ("quote", "Экранировать для оболочки"), ("ternary", "Условное значение"),
    ("type_debug", "Тип значения"), ("version", "Сравнение версий"), ("urlsplit", "Разбор URL"), ("comment", "Как комментарий"),
]

MAGIC_VARIABLES = [
    ("inventory_hostname", "Имя узла в inventory"), ("inventory_hostname_short", "Короткое имя узла"),
    ("ansible_host", "Адрес узла"), ("ansible_user", "Пользователь подключения"), ("ansible_port", "Порт подключения"),
    ("hostvars", "Переменные всех узлов"), ("groups", "Группы и их узлы"), ("group_names", "Группы текущего узла"),
    ("ansible_play_hosts", "Узлы текущего плея"), ("ansible_play_batch", "Узлы текущей порции"),
    ("ansible_check_mode", "Идёт проверка (--check)"), ("ansible_facts", "Факты узла"),
    ("ansible_distribution", "Дистрибутив"), ("ansible_distribution_version", "Версия дистрибутива"),
    ("ansible_distribution_major_version", "Основная версия дистрибутива"), ("ansible_os_family", "Семейство ОС"),
    ("ansible_hostname", "Имя узла (факт)"), ("ansible_fqdn", "Полное имя узла"), ("ansible_default_ipv4", "Основной IPv4"),
    ("ansible_all_ipv4_addresses", "Все IPv4-адреса"), ("ansible_architecture", "Архитектура"), ("ansible_kernel", "Ядро"),
    ("ansible_memtotal_mb", "Память, МБ"), ("ansible_processor_vcpus", "Число vCPU"), ("ansible_env", "Окружение"),
    ("ansible_date_time", "Дата и время"), ("role_path", "Путь к роли"), ("role_name", "Имя роли"),
    ("playbook_dir", "Каталог плейбука"), ("inventory_dir", "Каталог inventory"), ("item", "Элемент цикла"),
    ("ansible_loop", "Сведения о цикле"), ("omit", "Пропустить параметр"),
]


def builtin_catalog():
    """Справочник в формате, который отдаёт сервер редактору."""
    return {
        "source": "builtin",
        "modules": [{"n": name, "d": description} for name, (description, _) in sorted(MODULES.items())],
        "options": {name: options for name, (_, options) in MODULES.items()},
        "play_keywords": [{"n": n, "d": d, "v": v} for n, d, v in PLAY_KEYWORDS],
        "task_keywords": [{"n": n, "d": d, "v": v} for n, d, v in TASK_KEYWORDS],
        "loop_control": [{"n": n, "d": d} for n, d in LOOP_CONTROL_KEYS],
        "boolean_keys": sorted(BOOLEAN_KEYS),
        "meta_actions": META_ACTIONS,
        "filters": [{"n": n, "d": d} for n, d in FILTERS],
        "magic": [{"n": n, "d": d} for n, d in MAGIC_VARIABLES],
    }
