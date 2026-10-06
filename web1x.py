#!/usr/bin/env python3
"""
AnsibleWebControl — простой веб-интерфейс для запуска Ansible-плейбуков
и редактирования inventory-файлов (hosts.yml) через браузер.

Все "постоянный велечины" значения (пути, имена файлов, порт сервера, тайминги
и т.п.) вынесены в constants.py — начните оттуда, если нужно что-то
перенастроить.
"""

import concurrent.futures
import json
import os
import re
import subprocess
import threading
import time
from collections import deque
from datetime import datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

import yaml

from constants import (
    ANSIBLE_CFG_FILE_NAME,
    AUTODEPLOY_DIR_NAME,
    AUTODEPLOY_PLAYBOOK_NAME,
    BACKGROUND_IMAGE_NAME,
    DEFAULT_PROJECTS_ROOT,
    DEFAULTS_FILE_CANDIDATES,
    DHCP_PORT,
    DHCP_SERVICE_CANDIDATES,
    HOSTS_FILE_CANDIDATES,
    HWTYPE_FILE_EXTENSION,
    HWTYPE_HDD_DIR_NAME,
    HWTYPE_PART_RELATIVE_PATH,
    ISO_DIR,
    ISO_FILE_EXTENSION,
    ANSIBLE_VERBOSITY_FLAGS,
    LOG_MAX_LINES,
    NODE_TEMPLATES_BY_PARAM_COUNT,
    NON_PLAYBOOK_FILE_NAMES,
    OBJECTS_DIR_NAME,
    PING_PACKET_COUNT,
    PING_TIMEOUT_SECONDS,
    PLAYBOOKS_DIR_NAME,
    PUBLIC_DIR_NAME,
    ROLES_DIR_NAME,
    SERVER_HOST,
    SERVER_PORT,
    STATIC_ROUTES,
    STATUS_POLL_INTERVAL_SECONDS,
    STATUS_THREAD_POOL_SIZE,
    SWITCH_POLL_INTERVAL_SECONDS,
    SWITCH_SSH_COMMAND,
    SWITCH_SSH_TIMEOUT_SECONDS,
    SWITCH_SSH_USER,
    SYSTEM_CHECK_TIMEOUT_SECONDS,
    SYSTEM_STATUS_POLL_INTERVAL_SECONDS,
    TCPDUMP_INTERFACE_FALLBACK,
    TCPDUMP_RAW_LINES_LIMIT,
    TFTP_PORT,
    TFTP_SERVICE_CANDIDATES,
)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.join(BASE_DIR, PUBLIC_DIR_NAME)
PROJECTS_ROOT = os.environ.get("ANSIBLE_PROJECTS_ROOT", DEFAULT_PROJECTS_ROOT)

LOG = []
LOG_OFFSET = 0
LOG_LOCK = threading.Lock()
PROCESSES = []
PROC_LOCK = threading.Lock()
HOST_STATUS = {}
STATUS_LOCK = threading.Lock()
SYSTEM_STATUS = {"dhcp": None, "tftp": None, "iso": None}
SYSTEM_STATUS_LOCK = threading.Lock()
NMAP_LOCK = threading.Lock()
NMAP_STATE = {"running": False, "mode": None, "devices": {}, "raw_output": ""}
NMAP_STOP_EVENT = threading.Event()
NMAP_THREAD = None
NMAP_PROCESS = None

# Шаблоны параметров узла — вынесены в constants.py, чтобы их можно было
# найти и поправить, не копаясь в логике classify_node() ниже.
TEMPLATES = NODE_TEMPLATES_BY_PARAM_COUNT

def safe(value):
    """Оставляет только последнюю часть пути (без каталогов) — защита от выхода за пределы папки через ../"""
    return os.path.basename(value or "")

def project_dir(project):
    """Путь к каталогу проекта внутри корня проектов."""
    return os.path.join(PROJECTS_ROOT, safe(project)) if project else None

def single_project(project):
    """True, если проект простой (есть папка playbooks/) и не делится на объекты."""
    return bool(project and os.path.isdir(os.path.join(project_dir(project), PLAYBOOKS_DIR_NAME)))

def get_projects():
    """Отсортированный список имён проектов из корня проектов."""
    if not os.path.isdir(PROJECTS_ROOT):
        return []
    return sorted(name for name in os.listdir(PROJECTS_ROOT) if os.path.isdir(project_dir(name)))

def get_objects(project):
    """Отсортированный список объектов проекта (пустой для простого проекта)."""
    if single_project(project):
        return []
    directory = os.path.join(project_dir(project) or "", OBJECTS_DIR_NAME)
    if not os.path.isdir(directory):
        return []
    return sorted(name for name in os.listdir(directory) if os.path.isdir(os.path.join(directory, name)))

def object_dir(project, obj):
    """Каталог выбранного объекта (или playbooks/ для простого проекта), либо None."""
    if single_project(project):
        return os.path.join(project_dir(project), PLAYBOOKS_DIR_NAME)
    if not project or not obj or obj not in get_objects(project):
        return None
    return os.path.join(project_dir(project), OBJECTS_DIR_NAME, safe(obj))

def read(path):
    """Читает текстовый файл целиком; пустая строка, если файла нет."""
    try:
        with open(path, encoding="utf-8") as file:
            return file.read()
    except OSError:
        return ""

def write(path, content):
    """Записывает текст в файл, создавая недостающие каталоги."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as file:
        file.write(content)

def paths(project, obj):
    """Словарь путей объекта: каталог, hosts, defaults и ansible.cfg."""
    directory = object_dir(project, obj)
    if not directory:
        return None
    def first_existing(candidate_names):
        """Первый существующий файл из списка имён-кандидатов (или первый по умолчанию)."""
        for candidate_name in candidate_names:
            path = os.path.join(directory, candidate_name)
            if os.path.isfile(path):
                return path
        return os.path.join(directory, candidate_names[0])
    return {
        "object_dir": directory,
        "hosts": first_existing(HOSTS_FILE_CANDIDATES),
        "defaults": first_existing(DEFAULTS_FILE_CANDIDATES),
        "cfg": os.path.join(directory, ANSIBLE_CFG_FILE_NAME),
    }

def roles_dir(project, obj):
    """Каталог ролей выбранного объекта."""
    directory = object_dir(project, obj)
    return os.path.join(directory, ROLES_DIR_NAME) if directory else None

def _find_subdir(root, name):
    """Ищет поддиректорию с именем `name` где-то внутри `root`, на любом
    уровне вложенности, и возвращает путь к первой найденной. Используется
    вместо жёстко заданного пути, потому что заранее не известно, на какой
    именно глубине лежит нужная папка."""
    if not root or not os.path.isdir(root):
        return None
    for dirpath, dirnames, _ in os.walk(root):
        if name in dirnames:
            return os.path.join(dirpath, name)
    return None

def hwtype_options(project, obj):
    """Список доступных значений параметра hwtype — это имена .j2-файлов
    (без расширения) в специальной поддиректории:
    - для проекта без объектов — папка "hdd" где-то внутри autodeploy/
      (там же, где лежит сам файл autodeploy.yml) — точное расположение
      заранее не известно, поэтому ищем по имени рекурсивно;
    - для проекта с объектами — фиксированный путь внутри каталога объекта:
      roles/pxe_prepare/templates/part (расположение здесь точно известно,
      поэтому просто подставляем путь, без обхода дерева).
    Если подходящая папка не найдена, возвращается пустой список — тогда
    на фронтенде выпадающий список hwtype будет содержать только текущее
    значение узла (если оно есть).
    """
    if single_project(project):
        root = os.path.join(project_dir(project) or "", AUTODEPLOY_DIR_NAME)
        directory = _find_subdir(root, HWTYPE_HDD_DIR_NAME)
    else:
        object_root = object_dir(project, obj)
        directory = os.path.join(object_root, *HWTYPE_PART_RELATIVE_PATH) if object_root else None
        if directory and not os.path.isdir(directory):
            directory = None
    if not directory:
        return []
    return sorted(os.path.splitext(name)[0] for name in os.listdir(directory) if name.lower().endswith(HWTYPE_FILE_EXTENSION) and os.path.isfile(os.path.join(directory, name)))

def log(message):
    """Добавляет строку с временем в общий журнал (с обрезкой по лимиту)."""
    global LOG_OFFSET
    with LOG_LOCK:
        LOG.append(f"[{datetime.now():%H:%M:%S}] {message}")
        if len(LOG) > LOG_MAX_LINES:
            trimmed = len(LOG) - LOG_MAX_LINES
            del LOG[:trimmed]
            LOG_OFFSET += trimmed

def load_inventory(project, obj):
    """Читает hosts.yml объекта в словарь (пустой при ошибке или отсутствии файла)."""
    file_paths = paths(project, obj)
    if not file_paths or not os.path.exists(file_paths["hosts"]):
        return {}
    try:
        return yaml.safe_load(read(file_paths["hosts"])) or {}
    except yaml.YAMLError as error:
        log(f"HOSTS YAML ERROR: {error}")
        return {}

def load_hosts(project, obj, data=None):
    """Плоский словарь всех хостов объекта из секции all.hosts.

    `data` позволяет переиспользовать уже прочитанный load_inventory(),
    чтобы не парсить hosts.yml повторно (см. parse_hosts/inventory_groups)."""
    return (data if data is not None else load_inventory(project, obj)).get("all", {}).get("hosts", {}) or {}

def classify_node(params):
    """Определяет тип и название шаблона узла по количеству его параметров.

    Это единственный признак классификации — сами имена/значения параметров
    не анализируются (см. constants.NODE_TEMPLATES_BY_PARAM_COUNT). Если
    нужного количества параметров нет в справочнике, используется запасной
    вариант по последнему параметру, а если и он не подошёл — узел считается
    "неизвестным" и получает общее имя "Узел".
    """
    keys = list(params) if isinstance(params, dict) else []
    count = len(keys)
    if count in TEMPLATES:
        template = TEMPLATES[count]
        node_type = "md" if template.startswith("МД") else "si" if template.startswith("СИ") else "host"
        return node_type, template
    last_key = keys[-1] if keys else ""
    if last_key == "uefi":
        return "host", "Хост"
    if last_key == "Description":
        return "md", "МД"
    return "unknown", "Узел"

def parse_hosts(project, obj, data=None):
    """Список узлов объекта с IP, параметрами и определённым шаблоном."""
    result = []
    for name, raw in load_hosts(project, obj, data).items():
        params = dict(raw) if isinstance(raw, dict) else {}
        node_type, template = classify_node(params)
        result.append({"hostname": name, "parameters": params, "node_type": node_type, "template": template, "ip": params.get("ansible_host", params.get("ip", ""))})
    return result

def template_schemas(project, obj, nodes=None):
    """Схема параметров каждого шаблона: {имя_шаблона: [ключи параметров]}.

    Принимает необязательный `nodes` — уже готовый список узлов (например,
    от parse_hosts()), чтобы не парсить hosts.yml второй раз, если он уже
    был прочитан рядом (см. использование в do_GET "/data")."""
    schemas = {}
    for node in nodes if nodes is not None else parse_hosts(project, obj):
        template = node["template"]
        if template not in ("Хост", "МД", "Узел") and template not in schemas:
            schemas[template] = list(node["parameters"])
    return schemas

def inventory_groups(project, obj, data=None):
    """Список групп инвентаря с именами их хостов.

    `data` позволяет переиспользовать уже прочитанный load_inventory()."""
    data = data if data is not None else load_inventory(project, obj)
    if not isinstance(data, dict):
        return []
    groups = {}
    def collect(value):
        """Рекурсивно собирает имена хостов группы вместе с вложенными children."""
        found = set()
        if isinstance(value, dict):
            hosts = value.get("hosts", {})
            if isinstance(hosts, dict):
                found.update(hosts.keys())
            for child in (value.get("children", {}) or {}).values():
                found.update(collect(child))
        return found
    for name, value in data.items():
        if name != "all" and isinstance(value, dict) and ("hosts" in value or "children" in value):
            groups[name] = sorted(collect(value))
    all_group = data.get("all", {})
    if isinstance(all_group, dict):
        for name, value in (all_group.get("children", {}) or {}).items():
            if isinstance(value, dict) and ("hosts" in value or "children" in value):
                groups[name] = sorted(collect(value))
    return [{"name": name, "hosts": hosts} for name, hosts in groups.items()]

class InventoryDumper(yaml.SafeDumper):
    pass

def _represent_none_as_empty(dumper, value):
    """Пишет None в YAML как пустое значение (а не null)."""
    return dumper.represent_scalar("tag:yaml.org,2002:null", "")

InventoryDumper.add_representer(type(None), _represent_none_as_empty)

def save_hosts(path, data):
    """Полностью перезаписывает hosts.yml из словаря (теряет ручное форматирование)."""
    dumped = yaml.dump(data, Dumper=InventoryDumper, allow_unicode=True, sort_keys=False, default_flow_style=False)
    lines = dumped.splitlines(keepends=True)
    if len(lines) > 1:
        formatted = []
        for index, line in enumerate(lines):
            if index and line and not line.startswith((" ", "\t")) and formatted and formatted[-1].strip():
                formatted.append("\n")
            formatted.append(line)
        dumped = "".join(formatted)
    write(path, dumped)

def scalar(value):
    """Приводит строку из HTML-формы к «естественному» YAML-типу.

    Веб-форма всегда присылает значения параметров как строки; чтобы в
    hosts.yml не оседало "true" в кавычках вместо булева true, здесь
    строка распознаётся как bool/null/int, где это уместно, а в остальных
    случаях остаётся строкой как есть.
    """
    if not isinstance(value, str):
        return value
    stripped = value.strip()
    lowered = stripped.lower()
    if lowered in ("true", "false"):
        return lowered == "true"
    if lowered in ("null", "~"):
        return None
    try:
        return int(stripped) if stripped else value
    except ValueError:
        return value

def _hosts_section_bounds(lines):
    """Находит секцию `hosts:` в файле инвентаря по списку его строк.

    Возвращает (индекс_строки_с_"hosts:", индекс_конца_секции, отступ_в_пробелах).
    Концом секции считается первая непустая строка с отступом не больше,
    чем у самой строки "hosts:" (т.е. следующий ключ того же уровня —
    например, "children:" — или конец файла).
    """
    match_info = next(((index, len(line) - len(line.lstrip(" "))) for index, line in enumerate(lines) if re.match(r"^ *hosts:\s*(?:#.*)?$", line)), None)
    if match_info is None:
        return None, None, None
    hosts_index, indent = match_info
    end_index = len(lines)
    for index in range(hosts_index + 1, len(lines)):
        stripped = lines[index].rstrip("\r\n")
        if not stripped:
            continue
        current_indent = len(stripped) - len(stripped.lstrip(" "))
        if current_indent <= indent:
            end_index = index
            break
    return hosts_index, end_index, indent

def _host_entry_indexes(lines, hosts_index, end_index, indent):
    """Возвращает индексы строк с именами хостов внутри секции hosts:.

    Каждая такая строка на 2 пробела глубже самой "hosts:" и выглядит как
    "    имя_хоста:" (без вложенных списков/значений на той же строке).
    """
    entry_indent = indent + 2
    return [index for index in range(hosts_index + 1, end_index) if re.match(rf"^ {{{entry_indent}}}\S.*?:\s*(?:#.*)?(?:\r?\n)?$", lines[index])]

def _host_name_from_line(line, indent):
    """Извлекает имя хоста из строки вида "  имя_хоста:" на заданном отступе."""
    match = re.match(rf"^ {{{indent}}}(\S.*?):\s*(?:#.*)?(?:\r?\n)?$", line.rstrip("\r\n"))
    return match.group(1) if match else None

def _host_yaml_block(name, values, newline, indent):
    """Строит YAML-блок одного хоста (имя + параметры) с нужным отступом.

    Используется и при добавлении нового хоста, и при переименовании —
    в обоих случаях старый/новый блок вставляется в файл построчно, а не
    через полную пересборку YAML.
    """
    block = yaml.safe_dump({name: values}, allow_unicode=True, sort_keys=False, default_flow_style=False)
    if newline != "\n":
        block = block.replace("\n", newline)
    return "".join(f"{' ' * indent}{line}" if line.strip() else line for line in block.splitlines(keepends=True))

def _entries_use_blank_separator(lines, entry_indexes):
    """Проверяет, разделены ли уже существующие записи хостов пустой строкой.

    Нужно, чтобы при добавлении/переименовании хоста сохранить тот же
    визуальный стиль файла: если администратор разделял хосты пустыми
    строками — новый хост тоже получит такой отступ; если файл компактный
    (без пустых строк) — компактность сохранится.
    """
    for index in entry_indexes[1:]:
        if not lines[index - 1].strip():
            return True
    return False

def _delete_host_block(lines, target_index, next_index):
    """Удаляет из списка строк блок одного хоста, сохраняя ровно один
    разделитель между соседями (а не два и не ноль).

    Если пустая строка есть и до, и после удаляемого блока — оставляем
    только ту, что была до него, а сам блок вместе с "хвостовой" пустой
    строкой убираем целиком, иначе после соседних записей останется
    сразу два пустых промежутка. Если разделитель только с одной стороны
    (или отсутствует вовсе) — трогаем исключительно содержимое блока.
    """
    entry_end = target_index + 1
    while entry_end < next_index and lines[entry_end].strip():
        entry_end += 1
    has_pre_blank = target_index > 0 and not lines[target_index - 1].strip()
    has_post_blank = entry_end < next_index
    if has_pre_blank and has_post_blank:
        del lines[target_index:next_index]
    else:
        del lines[target_index:entry_end]

def _group_subsection_bounds(lines, group_name, key):
    """Находит подсекцию `key:` (обычно "hosts" или "children") внутри блока
    группы `group_name` и возвращает (индекс_строки_key, индекс_конца, отступ).

    Группа ищется как строка "имя_группы:" с отступом 0 или 4 пробела —
    то есть либо на верхнем уровне файла, либо на один уровень вложенности
    внутри "all: children:". Конец подсекции — первая строка внутри блока
    группы с отступом не больше, чем у самой строки "key:" (её "сосед",
    например соседняя подсекция "children:" на той же глубине).
    """
    escaped = re.escape(group_name)
    for group_index, line in enumerate(lines):
        stripped = line.rstrip("\r\n")
        match = re.match(r"^( {0,4})" + escaped + r":\s*(?:#.*)?$", stripped)
        if not match:
            continue
        group_indent = len(match.group(1))
        for index in range(group_index + 1, len(lines)):
            current_stripped = lines[index].rstrip("\r\n")
            indent = len(current_stripped) - len(current_stripped.lstrip(" ")) if current_stripped else group_indent + 1
            if current_stripped and indent <= group_indent:
                break
            if indent == group_indent + 2 and current_stripped.strip() == f"{key}:":
                section_indent = indent
                end_index = len(lines)
                for end in range(index + 1, len(lines)):
                    value = lines[end].rstrip("\r\n")
                    if value.strip():
                        value_indent = len(value) - len(value.lstrip(" "))
                        if value_indent <= section_indent:
                            end_index = end
                            break
                return index, end_index, section_indent
    return None, None, None

def _group_hosts_bounds(lines, group_name):
    """То же, что _group_subsection_bounds(..., "hosts") — самый частый случай."""
    return _group_subsection_bounds(lines, group_name, "hosts")

def _group_block_bounds(lines, group_name):
    """Находит границы ВСЕГО блока группы (заголовок + все его подсекции),
    в отличие от _group_subsection_bounds, которая ищет только одну
    подсекцию внутри него. Используется, когда группу нужно убрать из
    файла целиком (она осталась без единого хоста)."""
    escaped = re.escape(group_name)
    for index, line in enumerate(lines):
        stripped = line.rstrip("\r\n")
        match = re.match(r"^( {0,4})" + escaped + r":\s*(?:#.*)?$", stripped)
        if not match:
            continue
        indent = len(match.group(1))
        end_index = len(lines)
        for end in range(index + 1, len(lines)):
            value = lines[end].rstrip("\r\n")
            if value.strip():
                value_indent = len(value) - len(value.lstrip(" "))
                if value_indent <= indent:
                    end_index = end
                    break
        return index, end_index, indent
    return None, None, None

def _group_entry_indexes(lines, hosts_index, end_index, hosts_indent):
    """Аналог _host_entry_indexes, но для списка хостов внутри группы."""
    entry_indent = hosts_indent + 2
    return [index for index in range(hosts_index + 1, end_index) if re.match(rf"^ {{{entry_indent}}}\S.*?:\s*(?:#.*)?(?:\r?\n)?$", lines[index].rstrip("\r\n"))]

def _insert_host_into_group(path, group_name, name):
    """Добавляет хост в список hosts: группы group_name, построчно.

    Если такой группы в файле ещё нет — дописывает новый блок группы в
    конец файла. Если группа уже есть — вставляет хост последней записью
    в её существующий список.
    """
    if not group_name:
        return
    raw = read(path)
    lines = raw.splitlines(keepends=True)
    hosts_index, end_index, hosts_indent = _group_hosts_bounds(lines, group_name)
    newline = "\r\n" if "\r\n" in raw else "\n"
    if hosts_index is None:
        if lines and lines[-1].strip():
            lines.append(newline)
        lines.append(f"{group_name}:{newline}  hosts:{newline}    {name}:{newline}")
        write(path, "".join(lines))
        return
    entry_indexes = _group_entry_indexes(lines, hosts_index, end_index, hosts_indent)
    entry_indent = hosts_indent + 2
    if entry_indexes:
        insert_at = entry_indexes[-1] + 1
    else:
        insert_at = hosts_index + 1
    lines.insert(insert_at, f"{' ' * entry_indent}{name}:{newline}")
    write(path, "".join(lines))

def _remove_host_from_group(path, group_name, name):
    """Убирает хост из списка hosts: конкретной группы (построчно,
    с сохранением форматирования — см. _delete_host_block)."""
    raw = read(path)
    lines = raw.splitlines(keepends=True)
    hosts_index, end_index, hosts_indent = _group_hosts_bounds(lines, group_name)
    if hosts_index is None:
        return
    entry_indexes = _group_entry_indexes(lines, hosts_index, end_index, hosts_indent)
    target = next((index for index in entry_indexes if _host_name_from_line(lines[index], hosts_indent + 2) == name), None)
    if target is None:
        return
    next_index = next((index for index in entry_indexes if index > target), end_index)
    _delete_host_block(lines, target, next_index)
    write(path, "".join(lines))

def _remove_group_block(path, group_name):
    """Полностью убирает блок группы (её заголовок + всё содержимое), не трогая
    остальной файл — в отличие от полного save_hosts(), это не переписывает
    hosts.yml целиком и не теряет ручное форматирование (пустые строки) у
    остальных групп и у секции hosts:."""
    raw = read(path)
    lines = raw.splitlines(keepends=True)
    start, end, _ = _group_block_bounds(lines, group_name)
    if start is None:
        return False
    del lines[start:end]
    write(path, "".join(lines))
    return True

def _remove_group_subsection(path, group_name, key):
    """Убирает только подсекцию (hosts: или children:) внутри блока группы,
    сама группа при этом остаётся (у неё есть другое непустое содержимое)."""
    raw = read(path)
    lines = raw.splitlines(keepends=True)
    start, end, _ = _group_subsection_bounds(lines, group_name, key)
    if start is None:
        return False
    del lines[start:end]
    write(path, "".join(lines))
    return True



def _group_is_empty(value):
    """True, если в группе не осталось ни хостов, ни вложенных групп."""
    if not isinstance(value, dict):
        return True
    hosts = value.get("hosts")
    children = value.get("children")
    return not (isinstance(hosts, dict) and hosts) and not (isinstance(children, dict) and children)

def _prune_empty_groups(value):
    """Рекурсивно убирает из словаря пустые подгруппы и пустые секции."""
    if not isinstance(value, dict):
        return False
    children = value.get("children")
    if isinstance(children, dict):
        for name in list(children):
            child = children[name]
            _prune_empty_groups(child)
            if _group_is_empty(child):
                del children[name]
        if not children:
            value.pop("children", None)
    hosts = value.get("hosts")
    if not (isinstance(hosts, dict) and hosts) and "hosts" in value:
        value.pop("hosts", None)
    return _group_is_empty(value)

def _cleanup_empty_groups(path):
    """Убирает из hosts.yml группы, оставшиеся без единого хоста после
    удаления/переименования узлов.

    Загружает файл через YAML (только для АНАЛИЗА — понять, какие группы
    и подсекции опустели), а затем правит сам файл точечно, построчно:
    удаляет только те блоки/подсекции, которые реально нужно убрать,
    не трогая остальной hosts.yml. Так пустые строки и форматирование
    у ХОСТОВ и у других групп не теряются.

    Полная пересборка файла через save_hosts() используется только как
    аварийный запасной вариант — если точечная правка почему-то не
    удалась (например, из-за нетипичной вложенности групп).
    """
    raw = read(path)
    if not raw.strip():
        return
    try:
        data = yaml.safe_load(raw) or {}
    except yaml.YAMLError as error:
        log(f"HOSTS YAML ERROR DURING CLEANUP: {error}")
        return
    if not isinstance(data, dict):
        return

    remove_blocks = []
    remove_subsections = []

    def plan(name, value):
        """Определяет, какие группы или подсекции нужно убрать из файла после чистки."""
        orphan_keys = {key for key in ("hosts", "children") if key in value and not (isinstance(value[key], dict) and value[key])}
        _prune_empty_groups(value)
        if _group_is_empty(value):
            remove_blocks.append(name)
            return
        for key in orphan_keys:
            remove_subsections.append((name, key))

    nested_names = set()
    all_group = data.get("all")
    if isinstance(all_group, dict) and isinstance(all_group.get("children"), dict):
        children = all_group["children"]
        nested_names = set(children)
        for child_name in list(children):
            plan(child_name, children[child_name])
            if child_name in remove_blocks:
                del children[child_name]
        if not children:
            all_group.pop("children", None)

    for name in list(data):
        if name == "all":
            continue
        value = data[name]
        if isinstance(value, dict) and ("hosts" in value or "children" in value):
            plan(name, value)
            if name in remove_blocks:
                del data[name]

    if not remove_blocks and not remove_subsections:
        return

    # Точечно правим только то, что реально нужно поправить, вместо полной
    # пересборки всего файла — так остальные группы и секция hosts: сохраняют
    # своё ручное форматирование (например, пустые строки между хостами).
    fallback = False
    for name, key in remove_subsections:
        if not _remove_group_subsection(path, name, key):
            fallback = True
    for name in remove_blocks:
        if not _remove_group_block(path, name):
            fallback = True

    removed_nested = nested_names & set(remove_blocks)
    if removed_nested and not fallback:
        raw_after = read(path)
        try:
            data_after = yaml.safe_load(raw_after) or {}
        except yaml.YAMLError:
            data_after = None
        if isinstance(data_after, dict):
            all_after = data_after.get("all")
            if isinstance(all_after, dict) and not all_after.get("children"):
                _remove_group_subsection(path, "all", "children")

    if fallback:
        # Точечное редактирование не удалось (например, из-за совпадения
        # имён групп на разных уровнях вложенности) — подстраховываемся
        # полной пересборкой, чтобы файл не остался в неконсистентном виде.
        save_hosts(path, data)

def delete_group(project, obj, group_name):
    """Удаляет группу целиком — как топ-уровневую, так и вложенную под
    all.children — построчно, не трогая остальной hosts.yml (см.
    _remove_group_block). В отличие от _cleanup_empty_groups, здесь группа
    удаляется по явному запросу пользователя независимо от того, пуста
    она или нет — вместе с ней "теряют дом" и её хосты (сами хосты в
    секции all.hosts не трогаются, удаляется только блок группы)."""
    file_paths = paths(project, obj)
    if not file_paths:
        raise ValueError("Объект не найден")
    group_name = safe(group_name)
    if not group_name or group_name == "all":
        raise ValueError("Недопустимое имя группы")
    data = load_inventory(project, obj)
    if not isinstance(data, dict):
        raise ValueError("Inventory пуст или повреждён")

    exists_top_level = isinstance(data.get(group_name), dict) and ("hosts" in data[group_name] or "children" in data[group_name])
    all_group = data.get("all")
    nested_children = all_group.get("children") if isinstance(all_group, dict) else None
    exists_nested = isinstance(nested_children, dict) and group_name in nested_children
    if not exists_top_level and not exists_nested:
        raise ValueError("Группа не найдена")

    if not _remove_group_block(file_paths["hosts"], group_name):
        # Точечная правка не удалась (нетипичная структура файла) —
        # подстраховываемся полной пересборкой, чтобы группа всё равно
        # была удалена корректно.
        if group_name in data:
            del data[group_name]
        if isinstance(nested_children, dict) and group_name in nested_children:
            del nested_children[group_name]
            if not nested_children:
                all_group.pop("children", None)
        save_hosts(file_paths["hosts"], data)
        return

    if exists_nested:
        # Группа была вложена под all.children — если после её удаления
        # там больше ничего не осталось, убираем и саму пустую "children:".
        raw_after = read(file_paths["hosts"])
        try:
            data_after = yaml.safe_load(raw_after) or {}
        except yaml.YAMLError:
            data_after = None
        if isinstance(data_after, dict):
            all_after = data_after.get("all")
            if isinstance(all_after, dict) and not all_after.get("children"):
                _remove_group_subsection(file_paths["hosts"], "all", "children")

def add_host(project, obj, name, values, groups=None):
    """Добавляет узел в hosts.yml (с проверкой дубликатов по имени и ansible_host) и в группы."""
    file_paths = paths(project, obj)
    if not file_paths:
        raise ValueError("Объект не найден")
    data = load_inventory(project, obj)
    hosts = data.setdefault("all", {}).setdefault("hosts", {})
    if not name:
        raise ValueError("Имя узла не указано")
    normalized_values = {key: scalar(value) for key, value in values.items()}

    # Проверяем совпадение и по имени узла, и по ansible_host — второе
    # тоже фактически означает дубликат (один и тот же адрес под другим
    # именем), просто заметить это можно только сравнив параметры.
    conflicts = []
    if name in hosts:
        conflicts.append(f"именем «{name}»")
    ansible_host = normalized_values.get("ansible_host")
    if ansible_host not in (None, ""):
        owner = next((existing_name for existing_name, existing_values in hosts.items() if existing_name != name and isinstance(existing_values, dict) and existing_values.get("ansible_host") == ansible_host), None)
        if owner:
            conflicts.append(f"ansible_host «{ansible_host}» (уже используется узлом «{owner}»)")
    if conflicts:
        raise ValueError("Узел с таким " + " и ".join(conflicts) + " уже существует")

    hosts[name] = normalized_values
    raw = read(file_paths["hosts"])
    lines = raw.splitlines(keepends=True)
    hosts_index, end_index, hosts_indent = _hosts_section_bounds(lines)
    if hosts_index is None:
        save_hosts(file_paths["hosts"], data)
    else:
        newline = "\r\n" if "\r\n" in raw else "\n"
        entry_indexes = _host_entry_indexes(lines, hosts_index, end_index, hosts_indent)
        if entry_indexes:
            insert_at = end_index
            while insert_at > hosts_index + 1 and not lines[insert_at - 1].strip():
                insert_at -= 1
            separator = [newline] if _entries_use_blank_separator(lines, entry_indexes) and lines[insert_at - 1].strip() else []
        else:
            insert_at = hosts_index + 1
            separator = []
        block = _host_yaml_block(name, normalized_values, newline, hosts_indent + 2)
        lines[insert_at:insert_at] = separator + [block]
        write(file_paths["hosts"], "".join(lines))
    for group in (groups or []):
        if group:
            _insert_host_into_group(file_paths["hosts"], group, name)

def _delete_host_no_cleanup(project, obj, file_paths, name):
    """Удаляет узел из hosts.yml и групп, не чистя опустевшие группы."""
    data = load_inventory(project, obj)
    hosts = data.get("all", {}).get("hosts", {}) if isinstance(data, dict) else {}
    if name not in hosts:
        raise ValueError(f"Узел «{name}» не найден")
    hosts.pop(name, None)
    raw = read(file_paths["hosts"])
    lines = raw.splitlines(keepends=True)
    hosts_index, end_index, hosts_indent = _hosts_section_bounds(lines)
    if hosts_index is not None:
        entry_indexes = _host_entry_indexes(lines, hosts_index, end_index, hosts_indent)
        target_index = next((index for index in entry_indexes if _host_name_from_line(lines[index], hosts_indent + 2) == name), None)
        if target_index is not None:
            next_index = next((index for index in entry_indexes if index > target_index), end_index)
            _delete_host_block(lines, target_index, next_index)
            write(file_paths["hosts"], "".join(lines))
    for group in inventory_groups(project, obj):
        _remove_host_from_group(file_paths["hosts"], group["name"], name)

def delete_host(project, obj, name):
    """Удаляет один узел и затем убирает опустевшие группы."""
    file_paths = paths(project, obj)
    if not file_paths:
        raise ValueError("Объект не найден")
    _delete_host_no_cleanup(project, obj, file_paths, name)
    _cleanup_empty_groups(file_paths["hosts"])

def delete_hosts(project, obj, names):
    """Удаляет несколько узлов за один проход и один раз чистит опустевшие группы."""
    file_paths = paths(project, obj)
    if not file_paths:
        raise ValueError("Объект не найден")
    errors = []
    for name in names:
        try:
            _delete_host_no_cleanup(project, obj, file_paths, name)
        except ValueError as error:
            errors.append(str(error))
    _cleanup_empty_groups(file_paths["hosts"])
    if errors:
        raise ValueError("; ".join(errors))

def save_host(project, obj, old_name, new_name, values):
    """Сохраняет изменённые параметры/имя узла в hosts.yml, перенося его членство в группах."""
    file_paths = paths(project, obj)
    if not file_paths:
        raise ValueError("Объект не найден")
    data = load_inventory(project, obj)
    hosts = data.setdefault("all", {}).setdefault("hosts", {})
    if old_name not in hosts:
        raise ValueError("Узел не найден")
    if new_name != old_name and new_name in hosts:
        raise ValueError("Узел с таким именем уже существует")
    updated = dict(hosts[old_name]) if isinstance(hosts[old_name], dict) else {}
    for key, value in values.items():
        updated[key] = scalar(value)
    raw = read(file_paths["hosts"])
    lines = raw.splitlines(keepends=True)
    hosts_index, end_index, hosts_indent = _hosts_section_bounds(lines)
    if hosts_index is not None:
        entry_indexes = _host_entry_indexes(lines, hosts_index, end_index, hosts_indent)
        target_index = next((index for index in entry_indexes if _host_name_from_line(lines[index], hosts_indent + 2) == old_name), None)
        if target_index is not None:
            next_index = next((index for index in entry_indexes if index > target_index), end_index)
            spaced = _entries_use_blank_separator(lines, entry_indexes)
            _delete_host_block(lines, target_index, next_index)
            normalized_values = {key: scalar(value) for key, value in values.items()}
            newline = "\r\n" if "\r\n" in raw else "\n"
            insert_at = target_index
            prefix = newline if (insert_at > hosts_index + 1 and lines[insert_at - 1].strip()) else ""
            block = _host_yaml_block(new_name, normalized_values, newline, hosts_indent + 2)
            new_lines = [prefix + block]
            if spaced and insert_at < len(lines) and lines[insert_at].strip():
                new_lines.append(newline)
            lines[insert_at:insert_at] = new_lines
            write(file_paths["hosts"], "".join(lines))
        else:
            hosts.pop(old_name)
            hosts[new_name] = updated
            save_hosts(file_paths["hosts"], data)
    else:
        hosts.pop(old_name)
        hosts[new_name] = updated
        save_hosts(file_paths["hosts"], data)
    if new_name != old_name:
        for group in inventory_groups(project, obj):
            if old_name in group["hosts"]:
                _remove_host_from_group(file_paths["hosts"], group["name"], old_name)
                _insert_host_into_group(file_paths["hosts"], group["name"], new_name)
        _cleanup_empty_groups(file_paths["hosts"])

def set_host_groups(project, obj, hostname, groups):
    """Приводит членство узла в группах к заданному списку (добавляет/убирает)."""
    file_paths = paths(project, obj)
    if not file_paths:
        raise ValueError("Объект не найден")
    if groups is None:
        return
    desired = {group for group in groups if group}
    current = {group["name"] for group in inventory_groups(project, obj) if hostname in group["hosts"]}
    to_add = desired - current
    to_remove = current - desired
    for group in to_add:
        _insert_host_into_group(file_paths["hosts"], group, hostname)
    for group in to_remove:
        _remove_host_from_group(file_paths["hosts"], group, hostname)
    if to_remove:
        _cleanup_empty_groups(file_paths["hosts"])

def get_playbooks(project, obj):
    """Список плейбуков (.yml/.yaml) в каталоге объекта."""
    directory = object_dir(project, obj)
    if not directory or not os.path.isdir(directory):
        return []
    return [{"name": name, "path": os.path.join(directory, name), "type": "playbook"} for name in sorted(os.listdir(directory)) if os.path.isfile(os.path.join(directory, name)) and name.lower().endswith((".yml", ".yaml")) and name not in NON_PLAYBOOK_FILE_NAMES]

def playbook_roles(project, obj, playbook_name):
    """Дерево ролей, которые использует выбранный плейбук."""
    file_paths = paths(project, obj)
    if not file_paths:
        return []
    playbook_path = os.path.join(file_paths["object_dir"], safe(playbook_name))
    if not os.path.isfile(playbook_path):
        return []
    try:
        document = yaml.safe_load(read(playbook_path)) or []
    except yaml.YAMLError as error:
        log(f"PLAYBOOK YAML ERROR: {error}")
        return []
    names = []
    def inspect(value):
        """Разбирает содержимое плейбука и собирает имена используемых ролей."""
        if isinstance(value, list):
            for item in value: inspect(item)
        elif isinstance(value, dict):
            roles = value.get("roles")
            if isinstance(roles, list):
                for role in roles:
                    if isinstance(role, str): names.append(role)
                    elif isinstance(role, dict):
                        role_name = role.get("role") or role.get("name")
                        if isinstance(role_name, str): names.append(role_name)
            for key, child in value.items():
                if key != "roles": inspect(child)
    inspect(document)
    root = roles_dir(project, obj)
    if not root or not os.path.isdir(root): return []
    result = []
    seen = set()
    root_abs = os.path.abspath(root)
    for role_name in names:
        role_path = os.path.abspath(os.path.join(root, role_name))
        if not role_path.startswith(root_abs + os.sep) or not os.path.isdir(role_path) or role_name in seen: continue
        seen.add(role_name)
        def walk(directory):
            """Рекурсивно обходит каталог роли и строит дерево директорий и файлов."""
            items = []
            for name in sorted(os.listdir(directory), key=str.lower):
                path = os.path.join(directory, name)
                relative = os.path.relpath(path, root)
                if os.path.isdir(path): items.append({"name": name, "type": "dir", "path": relative, "children": walk(path)})
                else: items.append({"name": name, "type": "file", "path": relative})
            return items
        result.append({"name": role_name, "type": "dir", "path": role_name, "children": walk(role_path)})
    return result

def role_file(project, obj, relative_path):
    """Содержимое файла роли по относительному пути (с защитой от выхода за каталог)."""
    root = roles_dir(project, obj)
    if not root: return None
    root = os.path.abspath(root)
    path = os.path.abspath(os.path.join(root, relative_path))
    return path if path.startswith(root + os.sep) and os.path.isfile(path) else None

def autodeploy(project):
    """Путь к autodeploy.yml проекта или None, если файла нет."""
    path = os.path.join(project_dir(project) or "", AUTODEPLOY_DIR_NAME, AUTODEPLOY_PLAYBOOK_NAME)
    return path if os.path.isfile(path) else None

def host_up(ip):
    """True, если узел отвечает на ping."""
    if not ip: return False
    try:
        return subprocess.run(["ping", "-c", str(PING_PACKET_COUNT), "-W", str(PING_TIMEOUT_SECONDS), str(ip)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    except OSError:
        return False

def _check_node(node):
    """Пара (hostname, доступен ли) для одного узла — для параллельного опроса."""
    return node["hostname"], host_up(node["ip"])

def status_worker():
    """Фоновый поток: раз в интервал пингует все узлы всех проектов и кладёт результат в общий статус."""
    global HOST_STATUS
    with concurrent.futures.ThreadPoolExecutor(max_workers=STATUS_THREAD_POOL_SIZE) as executor:
        while True:
            statuses = {}
            for project in get_projects():
                for obj in (get_objects(project) or [None]):
                    key = obj or ""
                    nodes = parse_hosts(project, obj)
                    results = dict(executor.map(_check_node, nodes))
                    statuses.setdefault(project, {})[key] = results
            with STATUS_LOCK:
                HOST_STATUS = statuses
            time.sleep(STATUS_POLL_INTERVAL_SECONDS)

def status(project, obj):
    """Последний известный статус доступности узлов проекта/объекта."""
    with STATUS_LOCK:
        return dict(HOST_STATUS.get(project, {}).get(obj or "", {}))

def _service_state(name):
    """Спрашивает systemd о состоянии сервиса `name`. Возвращает строку
    состояния ("active", "inactive", "failed" и т.п.) или None, если
    systemd о таком сервисе вообще не знает (например, не установлен) —
    в этом случае имеет смысл проверить кандидата дальше по списку."""
    try:
        result = subprocess.run(
            ["systemctl", "is-active", name],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, timeout=SYSTEM_CHECK_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    state = result.stdout.strip()
    # "unknown"/"" — systemd не нашёл юнит с таким именем вообще.
    return state if state and state != "unknown" else None

def _port_is_listening(port, proto="udp"):
    """Запасной способ проверки, если systemd недоступен или ни один из
    кандидатов сервисов не найден: смотрим, слушает ли что-нибудь
    указанный UDP/TCP-порт (стандартный порт DHCP — 67, TFTP — 69)."""
    flag = "-u" if proto == "udp" else "-t"
    try:
        result = subprocess.run(
            ["ss", flag, "-l", "-n"],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, timeout=SYSTEM_CHECK_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    return any(f":{port} " in line or line.rstrip().endswith(f":{port}") for line in result.stdout.splitlines())

def _daemon_status(service_candidates, port, proto="udp"):
    """Общая логика для dhcp_status()/tftp_status(): сначала пытаемся
    опознать сервис через systemd (это даёт понятное имя и состояние —
    "active"/"failed"/...), а если ни один кандидат не найден, проверяем
    хотя бы сам факт, что порт слушается кем-то."""
    for name in service_candidates:
        state = _service_state(name)
        if state is not None:
            return {"service": name, "state": state, "active": state == "active", "checked_via": "systemd"}
    listening = _port_is_listening(port, proto)
    if listening is None:
        return {"service": None, "state": "unknown", "active": False, "checked_via": "none"}
    return {"service": None, "state": "active" if listening else "inactive", "active": listening, "checked_via": "port"}

def dhcp_status():
    """Состояние DHCP-сервера (через systemd или проверкой порта)."""
    return _daemon_status(DHCP_SERVICE_CANDIDATES, DHCP_PORT, "udp")

def tftp_status():
    """Состояние TFTP-сервиса (через systemd или проверкой порта)."""
    return _daemon_status(TFTP_SERVICE_CANDIDATES, TFTP_PORT, "udp")

def iso_inventory():
    """Рекурсивно собирает список .iso-файлов в ISO_DIR (включая все
    подпапки). Путь к каждому файлу отдаётся относительно ISO_DIR, чтобы
    не светить на фронтенде абсолютный путь на диске сервера."""
    if not os.path.isdir(ISO_DIR):
        return {"exists": False, "directory": ISO_DIR, "count": 0, "total_size": 0, "files": []}
    files = []
    for dirpath, _, filenames in os.walk(ISO_DIR):
        for filename in filenames:
            if not filename.lower().endswith(ISO_FILE_EXTENSION):
                continue
            full_path = os.path.join(dirpath, filename)
            try:
                size = os.path.getsize(full_path)
                mtime = os.path.getmtime(full_path)
            except OSError:
                continue
            files.append({
                "name": filename,
                "path": os.path.relpath(full_path, ISO_DIR).replace(os.sep, "/"),
                "size": size,
                "modified": datetime.fromtimestamp(mtime).strftime("%Y-%m-%d %H:%M"),
            })
    files.sort(key=lambda item: item["path"].lower())
    return {"exists": True, "directory": ISO_DIR, "count": len(files), "total_size": sum(item["size"] for item in files), "files": files}

def system_status_worker():
    """Фоновый поток, отдельный от status_worker (там опрашиваются узлы
    проектов раз в STATUS_POLL_INTERVAL_SECONDS) — эти проверки не привязаны
    ни к какому проекту и обновляются реже, поскольку состояние DHCP/TFTP и
    набор ISO-образов меняется значительно нечаще, чем доступность узлов."""
    global SYSTEM_STATUS
    while True:
        snapshot = {"dhcp": dhcp_status(), "tftp": tftp_status(), "iso": iso_inventory()}
        with SYSTEM_STATUS_LOCK:
            SYSTEM_STATUS = snapshot
        time.sleep(SYSTEM_STATUS_POLL_INTERVAL_SECONDS)

def system_status():
    """Последний снимок состояния DHCP, TFTP и ISO-образов."""
    with SYSTEM_STATUS_LOCK:
        return dict(SYSTEM_STATUS)

def _active_interface():
    """Определяет сетевой интерфейс, через который сервер ходит в сеть по
    умолчанию (интерфейс маршрута по умолчанию) — именно его слушает
    tcpdump в режиме прослушки. Если определить не удалось, используется
    запасной вариант TCPDUMP_INTERFACE_FALLBACK."""
    try:
        result = subprocess.run(
            ["ip", "route", "show", "default"],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, timeout=SYSTEM_CHECK_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    match = re.search(r"\bdev\s+(\S+)", result.stdout)
    return match.group(1) if match else None

def list_network_interfaces():
    """Поднятые интерфейсы сервера с назначенным IPv4-адресом — список для
    выбора в окне прослушки (по умолчанию выбирается активный интерфейс
    маршрута по умолчанию, см. _active_interface, остальные — на выбор,
    если на сервере их несколько)."""
    try:
        result = subprocess.run(
            ["ip", "-4", "-o", "addr", "show", "up", "scope", "global"],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, timeout=SYSTEM_CHECK_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.TimeoutExpired):
        result = None
    interfaces = []
    if result is not None:
        for line in result.stdout.splitlines():
            match = re.match(r"\d+:\s+(\S+)\s+inet\s+(\d{1,3}(?:\.\d{1,3}){3})", line)
            if match:
                interfaces.append({"name": match.group(1), "ip": match.group(2)})
    default_name = _active_interface()
    if not any(item["name"] == default_name for item in interfaces):
        default_name = interfaces[0]["name"] if interfaces else (default_name or TCPDUMP_INTERFACE_FALLBACK)
    return {"interfaces": interfaces, "default": default_name}

_MAC_TOKEN = r"[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5}"
_TCPDUMP_LINE_RE = re.compile(rf"^\S+\s+({_MAC_TOKEN})\s*>\s*({_MAC_TOKEN})")
_TCPDUMP_ARP_TELL_RE = re.compile(r"\btell\s+(\d{1,3}(?:\.\d{1,3}){3})")
_TCPDUMP_IPV4_SRC_RE = re.compile(r"IPv4.*?:\s*(\d{1,3}(?:\.\d{1,3}){3})\.\d+\s*>")

def _parse_tcpdump_line(line):
    """Вытаскивает из одной строки вывода `tcpdump -e` MAC-адрес источника
    и, если получится, его IP — либо из ARP ("tell <ip>" — это IP того, кто
    спрашивает), либо из заголовка IPv4 (адрес перед портом источника)."""
    match = _TCPDUMP_LINE_RE.search(line)
    if not match:
        return None
    src_mac = match.group(1).upper()
    tell_match = _TCPDUMP_ARP_TELL_RE.search(line)
    if tell_match:
        return src_mac, tell_match.group(1)
    ipv4_match = _TCPDUMP_IPV4_SRC_RE.search(line)
    if ipv4_match:
        return src_mac, ipv4_match.group(1)
    return src_mac, None

def _tcpdump_worker(interface=""):
    """Вариант 1 режима прослушки: слушает выбранный сетевой интерфейс
    сервера через `tcpdump -i <интерфейс> -e` и пассивно собирает пары
    MAC/IP из проходящих пакетов — ничего в сеть сам не отправляет.
    Если интерфейс не передан явно (не выбран в интерфейсе), определяется
    автоматически — активный интерфейс маршрута по умолчанию."""
    global NMAP_STATE, NMAP_PROCESS
    interface = interface or _active_interface() or TCPDUMP_INTERFACE_FALLBACK
    command = ["tcpdump", "-i", interface, "-e", "-n", "-l"]
    try:
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    except FileNotFoundError:
        with NMAP_LOCK:
            NMAP_STATE["raw_output"] = "tcpdump не найден на сервере (команда не установлена)."
            NMAP_STATE["running"] = False
        return
    except OSError as error:
        with NMAP_LOCK:
            NMAP_STATE["raw_output"] = f"Не удалось запустить tcpdump: {error}"
            NMAP_STATE["running"] = False
        return

    with NMAP_LOCK:
        NMAP_PROCESS = process
        NMAP_STATE["raw_output"] = f"Слушаю интерфейс {interface}…\n"

    raw_lines = deque(maxlen=TCPDUMP_RAW_LINES_LIMIT)
    while not NMAP_STOP_EVENT.is_set():
        line = process.stdout.readline()
        if not line:
            break  # процесс сам завершился — например, не хватило прав на захват пакетов
        raw_lines.append(line.rstrip())
        parsed = _parse_tcpdump_line(line)
        now = datetime.now().strftime("%H:%M:%S")
        with NMAP_LOCK:
            if parsed:
                mac, ip = parsed
                entry = NMAP_STATE["devices"].setdefault(mac, {"mac": mac, "ip": "", "first_seen": now})
                if ip:
                    entry["ip"] = ip
                entry["last_seen"] = now
            NMAP_STATE["raw_output"] = "\n".join(raw_lines)

    process.terminate()
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        process.kill()
    with NMAP_LOCK:
        NMAP_PROCESS = None
        NMAP_STATE["running"] = False

_SWITCH_MAC_RE = re.compile(rf"\b({_MAC_TOKEN})\b")

def _parse_mikrotik_bridge_hosts(output):
    """Разбирает вывод `/interface/bridge/host/print` на MikroTik-коммутаторе.
    Формат вывода зависит от версии RouterOS, поэтому колонки не привязаны
    жёстко к позиции — вместо этого ищем в строке MAC-адрес и берём то, что
    стоит до него (флаги/номер), и то, что после (порт, мост, VLAN)."""
    rows = []
    for line in output.splitlines():
        match = _SWITCH_MAC_RE.search(line)
        if not match:
            continue
        mac = match.group(1).upper()
        before = line[:match.start()].split()
        after = line[match.end():].split()
        rows.append({
            "mac": mac,
            "flags": before[-1] if before else "",
            "port": after[0] if len(after) > 0 else "",
            "bridge": after[1] if len(after) > 1 else "",
            "vlan": after[2] if len(after) > 2 else "",
        })
    return rows

def _switch_worker(switch_address, switch_user="", switch_password=""):
    """Вариант 2 режима прослушки: раз в SWITCH_POLL_INTERVAL_SECONDS
    подключается по SSH к коммутатору MikroTik и запрашивает его таблицу
    bridge host — какие MAC-адреса видны на каких портах/VLAN'ах. Каждый
    опрос показывает текущий снимок таблицы целиком (не копит историю),
    и каждая строка коммутатора показывается отдельно — даже если один и
    тот же MAC встречается в нескольких строках (например, на разных VLAN).
    Пользователь по умолчанию — SWITCH_SSH_USER ("admin"); пароль
    необязателен — если задан, подключение идёт через sshpass (обычный
    `ssh` не умеет принимать пароль неинтерактивно), если нет — ssh
    отрабатывает как обычно (например, по заранее настроенному ключу)."""
    global NMAP_STATE
    user = switch_user.strip() or SWITCH_SSH_USER
    ssh_command = ["ssh", f"{user}@{switch_address}", SWITCH_SSH_COMMAND]
    command = ["sshpass", "-p", switch_password, *ssh_command] if switch_password else ssh_command
    while not NMAP_STOP_EVENT.is_set():
        try:
            result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=SWITCH_SSH_TIMEOUT_SECONDS)
            output = result.stdout
        except FileNotFoundError:
            output = "sshpass не найден на сервере (нужен для входа по паролю)." if switch_password else "ssh не найден на сервере (команда не установлена)."
        except subprocess.TimeoutExpired:
            output = "Коммутатор не ответил вовремя (таймаут SSH-подключения)."
        except OSError as error:
            output = f"Не удалось подключиться к коммутатору: {error}"

        rows = _parse_mikrotik_bridge_hosts(output)
        now = datetime.now().strftime("%H:%M:%S")
        with NMAP_LOCK:
            devices = {}
            for index, row in enumerate(rows):
                row["last_seen"] = now
                devices[f"{row['mac']}#{index}"] = row
            NMAP_STATE["devices"] = devices
            NMAP_STATE["raw_output"] = output
        NMAP_STOP_EVENT.wait(SWITCH_POLL_INTERVAL_SECONDS)
    with NMAP_LOCK:
        NMAP_STATE["running"] = False

def nmap_start(mode, switch_address="", interface="", switch_user="", switch_password=""):
    """Запускает режим прослушки выбранным способом (tcpdump на выбранном
    интерфейсе или SSH на коммутатор)."""
    global NMAP_THREAD
    if mode not in ("tcpdump", "switch"):
        raise ValueError("Неизвестный режим прослушки")
    if mode == "switch" and not switch_address.strip():
        raise ValueError("Не указан IP-адрес коммутатора")
    with NMAP_LOCK:
        if NMAP_STATE["running"]:
            return
        NMAP_STATE["running"] = True
        NMAP_STATE["mode"] = mode
        NMAP_STATE["devices"] = {}
        NMAP_STATE["raw_output"] = ""
    NMAP_STOP_EVENT.clear()
    if mode == "tcpdump":
        target = lambda: _tcpdump_worker(interface.strip())
    else:
        target = lambda: _switch_worker(switch_address.strip(), switch_user, switch_password)
    NMAP_THREAD = threading.Thread(target=target, daemon=True)
    NMAP_THREAD.start()

def nmap_stop():
    """Останавливает режим прослушки (и процесс tcpdump, если он запущен)."""
    NMAP_STOP_EVENT.set()
    with NMAP_LOCK:
        process = NMAP_PROCESS
        NMAP_STATE["running"] = False
    # Для варианта с tcpdump просто выставить NMAP_STOP_EVENT недостаточно:
    # поток может в этот момент ждать в блокирующем readline() следующего
    # пакета. Останавливаем сам процесс — тогда чтение сразу же завершится.
    if process:
        try:
            process.terminate()
        except OSError:
            pass

def nmap_status():
    """Текущее состояние прослушки: режим, найденные устройства, «сырой» вывод команды."""
    with NMAP_LOCK:
        devices = sorted(NMAP_STATE["devices"].values(), key=lambda item: item.get("mac", ""))
        return {"running": NMAP_STATE["running"], "mode": NMAP_STATE["mode"], "devices": devices, "raw_output": NMAP_STATE.get("raw_output", "")}


def run_playbook(command, project, obj, name, cwd, cfg, label=None):
    """Запускает ansible-playbook в подпроцессе и стримит его вывод в журнал."""
    title = label or name
    log(f"=== START {title} [{project}{('/' + obj) if obj else ''}] ===")
    process = None
    try:
        environment = os.environ.copy()
        if os.path.isfile(cfg): environment["ANSIBLE_CONFIG"] = cfg
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1, cwd=cwd, env=environment)
        with PROC_LOCK: PROCESSES.append(process)
        for line in process.stdout: log(line.rstrip())
        log(f"=== DONE {title}: rc={process.wait()} ===")
    except OSError as error:
        log(f"EXECUTION ERROR: {error}")
    finally:
        if process:
            with PROC_LOCK:
                if process in PROCESSES: PROCESSES.remove(process)

def _verbosity_flag(verbosity):
    """Флаг подробности вывода ansible-playbook (-v/-vv/-vvv) или None; всё остальное отбрасывается."""
    return verbosity if verbosity in ANSIBLE_VERBOSITY_FLAGS else None

def run_command(project, obj, names, hosts, verbosity=""):
    """Запускает выбранные плейбуки по очереди через ansible-playbook (опционально только на указанных узлах)."""
    file_paths = paths(project, obj)
    available = {item["name"]: item["path"] for item in get_playbooks(project, obj)}
    if not file_paths: return
    for name in names:
        if name in available:
            command = ["ansible-playbook", "-i", file_paths["hosts"], available[name]]
            if hosts: command += ["-l", ",".join(hosts)]
            if _verbosity_flag(verbosity): command.append(_verbosity_flag(verbosity))
            run_playbook(command, project, obj, name, os.path.dirname(available[name]), file_paths["cfg"])

def run_autodeploy(project, hosts, verbosity=""):
    """Запускает плейбук автодеплоя проекта на отмеченных узлах."""
    path = autodeploy(project)
    if not path: return
    file_paths = paths(project, None)
    command = ["ansible-playbook", path]
    if hosts: command += ["-l", ",".join(hosts)]
    if _verbosity_flag(verbosity): command.append(_verbosity_flag(verbosity))
    run_playbook(command, project, None, "autodeploy.yml", os.path.dirname(path), file_paths["cfg"] if file_paths else "")

def stop():
    """Останавливает все запущенные подпроцессы ansible."""
    with PROC_LOCK:
        for process in PROCESSES:
            try: process.terminate()
            except OSError: pass
        PROCESSES.clear()
    log("=== EXECUTION STOPPED ===")

class Handler(BaseHTTPRequestHandler):
    def json(self, data, code=200):
        """Отправляет клиенту JSON-ответ с нужным HTTP-статусом."""
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json; charset=utf-8"); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)

    def file(self, path, content_type):
        """Отдаёт клиенту файл с заданным Content-Type (или 404)."""
        if not os.path.isfile(path): self.send_error(404); return
        with open(path, "rb") as file: body = file.read()
        self.send_response(200); self.send_header("Content-Type", content_type); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)

    def do_GET(self):
        """Обрабатывает GET: статические файлы и JSON-эндпоинты данных/статусов."""
        url = urlparse(self.path); query = parse_qs(url.query)
        project = query.get("project", [""])[0]
        obj = query.get("object", [""])[0]
        # Корень панели и /main открывают интерфейс без обязательных query-параметров.
        # Если проект/объект не переданы, выбираем первый доступный контекст,
        # но URL при этом не меняем.
        if url.path == "/":
            self.file(os.path.join(PUBLIC_DIR, STATIC_ROUTES["/main"]), "text/html; charset=utf-8"); return
        if url.path in STATIC_ROUTES:
            filename = STATIC_ROUTES[url.path]
            content_type = "text/html; charset=utf-8" if filename.endswith(".html") else "text/css; charset=utf-8" if filename.endswith(".css") else "application/javascript; charset=utf-8"
            self.file(os.path.join(PUBLIC_DIR, filename), content_type); return
        if url.path == "/background": self.file(os.path.join(BASE_DIR, BACKGROUND_IMAGE_NAME), "image/png"); return
        if url.path == "/data":
            projects = get_projects()
            if not project and projects:
                project = projects[0]
            objects = get_objects(project)
            single_object_mode = single_project(project)
            if not single_object_mode and not obj and objects:
                obj = objects[0]
            # Один раз читаем и парсим hosts.yml, вместо того чтобы делать это
            # отдельно для узлов и отдельно для групп — раньше оба вызова
            # независимо перечитывали один и тот же файл.
            inventory = load_inventory(project, obj)
            hosts = parse_hosts(project, obj, inventory)
            auto = autodeploy(project)
            self.json({"projects": projects, "objects": objects, "single_object_mode": single_object_mode, "selected_project": project, "selected_object": obj, "hosts": hosts, "status": status(project, obj), "groups": inventory_groups(project, obj, inventory), "template_schemas": template_schemas(project, obj, hosts), "playbooks": get_playbooks(project, obj), "autodeploy": bool(auto), "autodeploy_playbook": AUTODEPLOY_PLAYBOOK_NAME if auto else None, "hwtype_options": hwtype_options(project, obj)}); return
        if url.path == "/roles":
            playbook = query.get("playbook", [""])[0]; self.json(playbook_roles(project, obj, playbook) if playbook else []); return
        if url.path == "/role_file":
            path = role_file(project, obj, query.get("path", [""])[0])
            if not path: self.send_error(404); return
            self.json({"path": query.get("path", [""])[0], "content": read(path), "name": os.path.basename(path)}); return
        if url.path == "/status": self.json(status(project, obj)); return
        if url.path == "/system_status": self.json(system_status()); return
        if url.path == "/nmap_status": self.json(nmap_status()); return
        if url.path == "/nmap_interfaces": self.json(list_network_interfaces()); return
        if url.path == "/log_new":
            try: start = int(query.get("start", ["0"])[0])
            except ValueError: start = 0
            with LOG_LOCK:
                local_start = max(0, start - LOG_OFFSET)
                lines = LOG[local_start:]
                next_index = LOG_OFFSET + len(LOG)
            self.json({"lines": lines, "next": next_index}); return
        if url.path == "/playbook":
            name = safe(query.get("name", [""])[0]); file_paths = paths(project, obj)
            self.json({"name": name, "content": read(os.path.join(file_paths["object_dir"], name)) if file_paths else ""}); return
        self.send_error(404)

    def do_POST(self):
        """Обрабатывает POST: действия над узлами, группами, плейбуками, запуском и прослушкой."""
        try:
            body = self.rfile.read(int(self.headers.get("Content-Length", 0))); data = json.loads(body.decode() or "{}")
        except Exception: data = {}
        project = data.get("project", ""); obj = data.get("object", "")
        try:
            if self.path == "/run":
                threading.Thread(target=run_command, args=(project, obj, data.get("playbooks", []), data.get("hosts", []), data.get("verbosity", "")), daemon=True).start(); self.json({"ok": True}); return
            if self.path == "/run_autodeploy":
                threading.Thread(target=run_autodeploy, args=(project, data.get("hosts", []), data.get("verbosity", "")), daemon=True).start(); self.json({"ok": True}); return
            if self.path == "/stop": stop(); self.json({"ok": True}); return
            if self.path == "/nmap_start":
                nmap_start(data.get("mode", ""), data.get("switch_address", ""), data.get("interface", ""), data.get("switch_user", ""), data.get("switch_password", ""))
                self.json({"ok": True}); return
            if self.path == "/nmap_stop": nmap_stop(); self.json({"ok": True}); return
            if self.path == "/update_host":
                new_hostname = data.get("new_hostname", data.get("hostname", ""))
                save_host(project, obj, data.get("hostname", ""), new_hostname, data.get("values", {}))
                if "groups" in data:
                    set_host_groups(project, obj, new_hostname, data.get("groups", []))
                self.json({"ok": True}); return
            if self.path == "/add_host":
                groups = data.get("groups", [])
                if not isinstance(groups, list):
                    groups = [groups] if groups else []
                if not groups and data.get("group"):
                    groups = [data.get("group")]
                add_host(project, obj, data.get("hostname", ""), data.get("values", {}), groups)
                self.json({"ok": True}); return
            if self.path == "/delete_host":
                delete_host(project, obj, data.get("hostname", "")); self.json({"ok": True}); return
            if self.path == "/delete_group":
                delete_group(project, obj, data.get("group", "")); self.json({"ok": True}); return
            if self.path == "/save_playbook":
                file_paths = paths(project, obj)
                if file_paths: write(os.path.join(file_paths["object_dir"], safe(data.get("name"))), data.get("content", ""))
                self.json({"ok": True}); return
            if self.path == "/delete_hosts":
                names = data.get("hostnames", [])
                if not isinstance(names, list):
                    names = [names] if names else []
                delete_hosts(project, obj, names)
                self.json({"ok": True}); return
        except (OSError, ValueError) as error:
            self.json({"ok": False, "error": str(error)}, 500); return
        self.send_error(404)

if __name__ == "__main__":
    threading.Thread(target=status_worker, daemon=True).start()
    threading.Thread(target=system_status_worker, daemon=True).start()
    HTTPServer((SERVER_HOST, SERVER_PORT), Handler).serve_forever()
