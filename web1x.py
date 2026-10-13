#!/usr/bin/env python3
"""
AnsibleWebControl — простой веб-интерфейс для запуска Ansible-плейбуков
и редактирования inventory-файлов (hosts.yml) через браузер.

Все "постоянный велечины" значения (пути, имена файлов, порт сервера, тайминги
и т.п.) вынесены в constants.py — начните оттуда, если нужно что-то
перенастроить.
"""

import ast
import concurrent.futures
import configparser
import importlib
import gzip
import hashlib
import io
import ipaddress
import json
import os
import re
import shutil
import socket
import subprocess
import threading
import tempfile
import time
import tokenize
from collections import deque
from datetime import datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

import yaml

import ansible_catalog

from constants import (
    ANSIBLE_CFG_FILE_NAME,
    AUTODEPLOY_DIR_NAME,
    AUTODEPLOY_PLAYBOOK_NAME,
    BACKGROUND_IMAGE_NAME,
    LOGO_MARK_IMAGE_NAME,
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
    NETMAP_DIR_NAME,
    NETMAP_NODE_TYPES,
    NETMAP_PING_CACHE_SECONDS,
    NETMAP_SELF_NAME,
    NETMAP_TRACE_MAX_HOPS,
    REPO_URL,
    NODE_KIND_BY_PARAM_COUNT,
    NODE_KIND_DEFAULT,
    NODE_KIND_MARKERS,
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

# Версия приложения: интерфейс сравнивает её со своей (APP_VERSION в constants.js) и предупреждает,
# если файлы обновили, а сервер не перезапустили.
APP_VERSION = "0.0.33"

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
    def first_existing(candidate_names, allow_dir=False):
        """Первый существующий файл (или, если allow_dir, папка) из списка имён-кандидатов (или первый по умолчанию)."""
        for candidate_name in candidate_names:
            path = os.path.join(directory, candidate_name)
            if os.path.isfile(path) or (allow_dir and os.path.isdir(path)):
                return path
        return os.path.join(directory, candidate_names[0])
    return {
        "object_dir": directory,
        "hosts": first_existing(HOSTS_FILE_CANDIDATES),
        "defaults": first_existing(DEFAULTS_FILE_CANDIDATES, allow_dir=True),   # общие переменные: файл или папка defaults/
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
        playbook = autodeploy(project)   # hdd/ ищется рядом с autodeploy.yml проекта
        directory = _find_subdir(os.path.dirname(playbook), HWTYPE_HDD_DIR_NAME) if playbook else None
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

# Внутренние коды типов узла (используются в разметке, не в названиях).
_KIND_CODES = {"Хост": "host", "МД": "md", "СИ": "si"}

def node_kind(keys):
    """Тип узла для названия шаблона: по числу параметров, затем по характерному параметру, иначе «Узел»."""
    kind = NODE_KIND_BY_PARAM_COUNT.get(len(keys))
    if kind:
        return kind
    keyset = set(keys)
    for marker_kind, markers in NODE_KIND_MARKERS:
        if keyset & markers:
            return marker_kind
    return NODE_KIND_DEFAULT

def assign_templates(hosts):
    """Сопоставляет каждому хосту шаблон по его набору параметров.

    Хосты с одинаковым набором параметров (порядок не важен) попадают в один
    шаблон; каждый новый набор — новый шаблон. Номер считается отдельно для
    каждого типа и только внутри переданного hosts (одного проекта/объекта),
    в порядке первого появления в hosts.yml. Возвращает
    ({hostname: (kind_code, template_name)}, {template_name: [ключи]})."""
    by_signature, counters, schemas, result = {}, {}, {}, {}
    for name, raw in hosts.items():
        keys = list(raw) if isinstance(raw, dict) else []
        if not keys:
            result[name] = ("unknown", NODE_KIND_DEFAULT)
            continue
        signature = frozenset(keys)
        if signature not in by_signature:
            kind = node_kind(keys)
            counters[kind] = counters.get(kind, 0) + 1
            template = f"{kind} шаблон-{counters[kind]}"
            by_signature[signature] = (_KIND_CODES.get(kind, "unknown"), template)
            schemas[template] = keys
        result[name] = by_signature[signature]
    return result, schemas

def parse_hosts(project, obj, data=None):
    """Список узлов объекта с IP, параметрами и определённым шаблоном."""
    hosts = load_hosts(project, obj, data)
    templates, _ = assign_templates(hosts)
    result = []
    for name, raw in hosts.items():
        params = dict(raw) if isinstance(raw, dict) else {}
        node_type, template = templates[name]
        result.append({"hostname": name, "parameters": params, "node_type": node_type, "template": template, "ip": params.get("ansible_host", params.get("ip", ""))})
    return result

def template_schemas(project, obj, nodes=None):
    """Схема параметров каждого шаблона проекта/объекта: {имя_шаблона: [ключи параметров]}.

    `nodes` — уже готовый список от parse_hosts(), чтобы не читать hosts.yml повторно."""
    schemas = {}
    for node in nodes if nodes is not None else parse_hosts(project, obj):
        template = node["template"]
        if template != NODE_KIND_DEFAULT and template not in schemas:
            schemas[template] = list(node["parameters"])
    # В новом (пустом) проекте узлов ещё нет — значит, нет и шаблонов, и первый узел нельзя было
    # добавить. Пока шаблонов нет, предлагается базовый: только адрес узла.
    return schemas or templates_from_other_projects(project, obj)

def templates_from_other_projects(project, obj, limit=12):
    """Пустой проект: шаблоны узлов (наборы параметров) из ваших существующих проектов — без повторов,
    с нумерацией по типу; в конце — базовый шаблон с одним адресом."""
    found, counters = {}, {}
    for other in get_projects():
        for other_obj in ([None] if single_project(other) else get_objects(other)):
            if other == project and (other_obj or None) == (obj or None):
                continue
            try:
                _, schemas = assign_templates(load_hosts(other, other_obj))
            except Exception:
                continue
            for name, keys in schemas.items():
                signature = frozenset(keys)
                if signature in found or signature == frozenset(["ansible_host"]) or len(found) >= limit:
                    continue   # повтор или то же, что «Базовый»
                kind = name.split(" шаблон-")[0]
                counters[kind] = counters.get(kind, 0) + 1
                found[signature] = (f"{kind} шаблон-{counters[kind]}", keys)
    result = {name: keys for name, keys in found.values()}
    result["Базовый"] = ["ansible_host"]
    return result

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
    # пустые «all:» / «hosts:» в YAML — это None, а не словарь (так выглядит инвентарь нового проекта)
    if not isinstance(data.get("all"), dict):
        data["all"] = {}
    if not isinstance(data["all"].get("hosts"), dict):
        data["all"]["hosts"] = {}
    hosts = data["all"]["hosts"]
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
    return [{"name": name, "path": os.path.join(directory, name), "type": "playbook"} for name in sorted(os.listdir(directory)) if os.path.isfile(os.path.join(directory, name)) and name.lower().endswith((".yml", ".yaml")) and name not in NON_PLAYBOOK_FILE_NAMES and not name.startswith(".")]

AUTODEPLOY_SCOPE = "autodeploy"

def scope_of(value):
    """Область работы с плейбуками и ролями: "autodeploy" — папка Autodeploy проекта, иначе — объект."""
    return AUTODEPLOY_SCOPE if value == AUTODEPLOY_SCOPE else None

def scope_dir(project, obj, scope=None):
    """Папка области: папка autodeploy.yml проекта или папка плейбуков объекта."""
    if scope == AUTODEPLOY_SCOPE:
        path = autodeploy(project)
        return os.path.dirname(path) if path else None
    return object_dir(project, obj)

def scope_key(obj, scope=None):
    """Подпапка в backups/ для резервных копий и корзины."""
    return "_autodeploy" if scope == AUTODEPLOY_SCOPE else obj

def playbook_path(project, obj, name, scope=None):
    """Путь к плейбуку, только если это действительно плейбук области: из списка get_playbooks
    (или autodeploy.yml для области Autodeploy). Так через «плейбук» нельзя прочитать или
    перезаписать hosts.yml, ansible.cfg и другие файлы."""
    if scope == AUTODEPLOY_SCOPE:
        path = autodeploy(project)
        return path if path and name == AUTODEPLOY_PLAYBOOK_NAME else None
    for playbook in get_playbooks(project, obj):
        if playbook["name"] == name:
            return playbook["path"]
    return None

# --- Роли: где их искать и как плейбук на них ссылается ---
ROLE_NAME_RE = r"[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}"
ROLE_REF_MODULES = {"include_role", "import_role", "ansible.builtin.include_role", "ansible.builtin.import_role"}
PLAYBOOK_IMPORT_KEYS = {"import_playbook", "ansible.builtin.import_playbook"}

def _cfg_roles_paths(cfg):
    """Пути из roles_path в ansible.cfg (относительно папки ansible.cfg), как их понимает Ansible."""
    if not cfg or not os.path.isfile(cfg):
        return []
    parser = configparser.ConfigParser(interpolation=None, strict=False)
    try:
        parser.read(cfg, encoding="utf-8")
    except (configparser.Error, UnicodeDecodeError):
        return []
    value = parser.get("defaults", "roles_path", fallback="") or ""
    base = os.path.dirname(cfg)
    return [os.path.normpath(os.path.join(base, os.path.expanduser(part.strip()))) for part in value.split(":") if part.strip()]

def role_search_paths(project, obj, scope=None):
    """Папки, где Ansible ищет роли области: roles/ рядом с плейбуком, roles_path из ansible.cfg
    области и roles/ проекта. Учитываются только папки внутри папки проектов — так через roles_path
    нельзя направить «роль» в системные каталоги и править их из веб-интерфейса."""
    base = scope_dir(project, obj, scope)
    if not base:
        return []
    candidates = [os.path.join(base, ROLES_DIR_NAME)] + _cfg_roles_paths(os.path.join(base, ANSIBLE_CFG_FILE_NAME)) \
        + [os.path.join(project_dir(project) or "", ROLES_DIR_NAME)]
    result = []
    for path in candidates:
        if path and os.path.isdir(path) and _inside(PROJECTS_ROOT, path) and all(os.path.realpath(path) != os.path.realpath(seen) for seen in result):
            result.append(path)
    return result

def _role_ref(value):
    """Ссылка на роль из плейбука в нормальном виде: «common», «infra/nginx» (роль во вложенной
    папке), «roles/common» → как есть, без «./» и «/» в конце. None — если это не ссылка на роль
    (шаблон Jinja, «..», недопустимые символы)."""
    if not isinstance(value, str) or "{{" in value:
        return None
    ref = value.strip().strip("'\"").rstrip("/")
    while ref.startswith("./"):
        ref = ref[2:]
    parts = ref.split("/")
    if not ref or any(not re.fullmatch(ROLE_NAME_RE, part) or part == ".." for part in parts):
        return None
    return ref

def find_role_dir(project, obj, ref, scope=None):
    """Каталог роли по ссылке — как у Ansible: в папках поиска ролей (ссылка «infra/nginx» —
    это путь внутри папки ролей), затем относительно папки плейбука («roles/common»). Или None."""
    ref = _role_ref(ref)
    if not ref:
        return None
    parts = ref.split("/")
    bases = role_search_paths(project, obj, scope) + [scope_dir(project, obj, scope) or ""]
    for base in bases:
        if not base:
            continue
        path = os.path.join(base, *parts)
        if os.path.isdir(path) and _inside(base, path) and _inside(PROJECTS_ROOT, path):
            return path
    return None

def _split_role_path(relative):
    """«роль|путь/в/роли» → (роль, [части пути]). Старый вид «роль/путь» (роль без «/») тоже понимается."""
    relative = str(relative or "").replace("\\", "/")
    if "|" in relative:
        ref, rest = relative.split("|", 1)
    else:
        ref, _, rest = relative.partition("/")
    parts = [part for part in rest.split("/") if part not in ("", ".")]
    return ref, parts

def role_path(project, obj, relative, scope=None):
    """Файл или папка роли по пути «роль|внутри/роли» → абсолютный путь (не выходит за каталог роли) или None."""
    ref, parts = _split_role_path(relative)
    if ".." in parts:
        return None
    directory = find_role_dir(project, obj, ref, scope)
    if not directory:
        return None
    path = os.path.join(directory, *parts)
    return path if _inside(directory, path) else None

class _TolerantLoader(yaml.SafeLoader):
    """YAML-загрузчик, который не падает на тегах Ansible (!vault, !unsafe…): значение берётся как есть."""

def _construct_tagged(loader, suffix, node):
    if isinstance(node, yaml.ScalarNode):
        return loader.construct_scalar(node)
    if isinstance(node, yaml.SequenceNode):
        return loader.construct_sequence(node)
    return loader.construct_mapping(node)

_TolerantLoader.add_multi_constructor("!", _construct_tagged)

def _text_role_refs(text):
    """Роли по тексту — если файл не читается как YAML: блоки roles:, roles: [..], include_role/import_role."""
    names, lines = [], text.splitlines()
    for index, line in enumerate(lines):
        flow = re.match(r"^\s*-?\s*roles:\s*\[(.*)\]", line)
        if flow:
            names += [item.strip().strip("'\"") for item in flow.group(1).split(",")]
            continue
        block = re.match(r"^(\s*)-?\s*roles:\s*(#.*)?$", line)
        if block:
            indent = len(block.group(1))
            for item in lines[index + 1:]:
                if not item.strip() or item.strip().startswith("#"):
                    continue
                if len(item) - len(item.lstrip()) <= indent and not item.lstrip().startswith("-"):
                    break
                match = re.match(r"^\s*-\s*(?:\{\s*)?(?:(?:role|name)\s*:\s*)?['\"]?([^'\",}\s#]+)", item)
                if match and len(item) - len(item.lstrip()) > indent - 1:
                    names.append(match.group(1))
                elif len(item) - len(item.lstrip()) <= indent:
                    break
        if re.match(r"^\s*-?\s*(ansible\.builtin\.)?(include|import)_role:", line):
            for item in lines[index + 1:index + 6]:
                match = re.match(r"^\s*name:\s*['\"]?([^'\"#\s]+)", item)
                if match:
                    names.append(match.group(1))
                    break
    return names

def playbook_role_refs(path, _seen=None):
    """Все роли, на которые ссылается плейбук: roles: в каждом плее (строки и {role:/name:}),
    include_role/import_role в задачах, роли плейбуков из import_playbook.
    Возвращает (имена в порядке появления без повторов, описание проблемы разбора или None)."""
    _seen = _seen or set()
    real = os.path.realpath(path)
    if real in _seen or not os.path.isfile(path):
        return [], None
    _seen.add(real)
    text, names, problem = read(path), [], None
    def walk(value):
        if isinstance(value, list):
            for item in value:
                walk(item)
        elif isinstance(value, dict):
            roles = value.get("roles")
            if isinstance(roles, list):
                for role in roles:
                    names.append(role if isinstance(role, str) else role.get("role") or role.get("name") if isinstance(role, dict) else None)
            for key, child in value.items():
                if key in ROLE_REF_MODULES and isinstance(child, dict):
                    names.append(child.get("name"))
                elif key in PLAYBOOK_IMPORT_KEYS and isinstance(child, str) and "{{" not in child:
                    nested = os.path.join(os.path.dirname(path), child)
                    if _inside(os.path.dirname(real), nested) or _inside(PROJECTS_ROOT, nested):
                        names.extend(playbook_role_refs(nested, _seen)[0])
                elif key != "roles":
                    walk(child)
    try:
        walk(yaml.load(text, Loader=_TolerantLoader))
    except yaml.YAMLError as error:
        mark = getattr(error, "problem_mark", None)
        problem = f"плейбук не разобран как YAML{f' (строка {mark.line + 1})' if mark else ''} — роли найдены по тексту"
        names = _text_role_refs(text)
    result = []
    for name in (_role_ref(item) for item in names):
        if name and name not in result:
            result.append(name)
    return result, problem

def _role_tree(directory, ref, relative=""):
    """Дерево каталога роли; путь каждого элемента — «роль|путь/в/роли»."""
    items = []
    for name in sorted(os.listdir(directory), key=str.lower):
        path = os.path.join(directory, name)
        inner = f"{relative}/{name}" if relative else name
        if os.path.isdir(path):
            items.append({"name": name, "type": "dir", "path": f"{ref}|{inner}", "children": _role_tree(path, ref, inner)})
        else:
            items.append({"name": name, "type": "file", "path": f"{ref}|{inner}"})
    return items

def role_dependencies(directory):
    """Зависимости роли из meta/main.yml (dependencies:) — Ansible выполняет их перед ролью."""
    data = None
    for name in ("main.yml", "main.yaml"):
        path = os.path.join(directory, "meta", name)
        if os.path.isfile(path):
            try:
                data = yaml.load(read(path), Loader=_TolerantLoader)
            except yaml.YAMLError:
                data = None
            break
    deps = data.get("dependencies") if isinstance(data, dict) else None
    refs = []
    for item in deps if isinstance(deps, list) else []:
        ref = _role_ref(item if isinstance(item, str) else (item.get("role") or item.get("name")) if isinstance(item, dict) else None)
        if ref and ref not in refs:
            refs.append(ref)
    return refs

def playbook_files(project, obj, playbook_name, scope=None):
    """Всё для окна «Файлы плейбука»: роли плейбука и их зависимости (из meta/main.yml) с деревьями
    файлов, ненайденные — с пометкой; в каких ещё плейбуках используется каждая роль."""
    path = playbook_path(project, obj, playbook_name, scope)
    if not path:
        raise ValueError("Плейбук не найден")
    refs, problem = playbook_role_refs(path)
    usage = {}
    if scope != AUTODEPLOY_SCOPE:
        for other in get_playbooks(project, obj):
            if other["name"] != playbook_name:
                for role in playbook_role_refs(other["path"])[0]:
                    usage.setdefault(role, []).append(other["name"])
    base = scope_dir(project, obj, scope) or ""
    roles, queue, seen = [], [(ref, None) for ref in refs], set()
    while queue and len(roles) < 200:
        ref, parent = queue.pop(0)
        if ref in seen:
            continue
        seen.add(ref)
        directory = find_role_dir(project, obj, ref, scope)
        entry = {"name": ref, "found": bool(directory), "collection": "/" not in ref and ref.count(".") >= 2,
                 "used_by": usage.get(ref, []), "dependency_of": parent}
        if directory:
            entry["location"] = os.path.relpath(os.path.dirname(directory), base) if base else ""
            entry["children"] = _role_tree(directory, ref)
            queue += [(dep, ref) for dep in role_dependencies(directory)]
        roles.append(entry)
    return {"playbook": playbook_name, "scope": scope, "roles": roles, "problem": problem,
            "available": [role for role in list_roles(project, obj, scope) if role not in refs]}

def playbook_roles(project, obj, playbook_name):
    """Дерево ролей плейбука (прежний формат ответа /roles) — на основе playbook_files."""
    try:
        data = playbook_files(project, obj, playbook_name)
    except ValueError:
        return []
    return [{"name": role["name"], "type": "dir", "path": role["name"], "children": role["children"]} for role in data["roles"] if role["found"]]

def role_file(project, obj, relative_path, scope=None):
    """Файл роли по пути «роль|…» (с защитой от выхода за каталог роли) или None."""
    path = role_path(project, obj, relative_path, scope)
    return path if path and os.path.isfile(path) else None

# ============================================================================
# Создание проектов, ролей, плейбуков и редактирование файлов
# ============================================================================
ITEM_NAME_RE = r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}"

def _check_item_name(value, what):
    """Имя проекта/объекта/роли/файла: латиница, цифры, точка, дефис, подчёркивание; без «..»."""
    if not isinstance(value, str) or not re.fullmatch(ITEM_NAME_RE, value) or ".." in value:
        raise ValueError(f"{what} «{value}»: допустимы латинские буквы, цифры, точка, дефис и подчёркивание (до 64 символов)")
    return value

def _inside(root, path):
    """Путь лежит внутри root — с учётом символических ссылок."""
    root, path = os.path.realpath(root), os.path.realpath(path)
    return path == root or path.startswith(root + os.sep)

# --- заготовки файлов ---
HOSTS_TEMPLATE = "---\n# Узлы. Добавлять их удобнее кнопкой «Добавить узел» в веб-интерфейсе.\nall:\n  hosts:\n"
DEFAULTS_TEMPLATE = "---\n# Значения по умолчанию для этого {where}.\n"
ANSIBLE_CFG_TEMPLATE = """[defaults]
inventory = {hosts}
roles_path = ./{roles}
host_key_checking = False
retry_files_enabled = False
"""
ROLE_SKELETON = {
    "tasks/main.yml": "---\n# Задачи роли «{role}».\n\n- name: Пример задачи роли {role}\n  ansible.builtin.debug:\n    msg: \"Роль {role} выполнена на {{{{ inventory_hostname }}}}\"\n",
    "handlers/main.yml": "---\n# Хендлеры роли «{role}»: запускаются из задач через «notify: <имя хендлера>».\n",
    "defaults/main.yml": "---\n# Переменные роли «{role}» по умолчанию — самый низкий приоритет,\n# их можно переопределить в inventory, плейбуке или vars.\n",
    "vars/main.yml": "---\n# Переменные роли «{role}» — высокий приоритет.\n",
    "meta/main.yml": "---\ngalaxy_info:\n  role_name: {leaf}\n  author: \"\"\n  description: \"\"\n  min_ansible_version: \"2.9\"\ndependencies: []\n",
    "README.md": "# Роль {role}\n\nЧто делает роль и какие переменные использует (см. defaults/main.yml).\n",
    "tests/inventory": "localhost\n",
    "tests/test.yml": "---\n- hosts: localhost\n  remote_user: root\n  roles:\n    - {role}\n",
}
ROLE_EMPTY_DIRS = ("templates", "files")

def _playbook_text(title, roles, hosts="all", become=True):
    """Текст плейбука: роли — списком; без ролей — пример задачи."""
    # название — в кавычках: в нём бывают «:» и другие символы, значимые для YAML
    lines = ["---", f"- name: {json.dumps(title, ensure_ascii=False)}", f"  hosts: {hosts}"]
    if become:
        lines.append("  become: true")
    if roles:
        lines.append("  roles:")
        lines += [f"    - {role}" for role in roles]
    else:
        lines += ["  tasks:", "    - name: Пример задачи", "      ansible.builtin.debug:", "        msg: \"Плейбук выполнен\""]
    return "\n".join(lines) + "\n"

ROLE_PARTS = ("tasks", "handlers", "defaults", "vars", "meta", "templates", "files", "tests", "README.md")

def _role_files(role, parts=None):
    """Файлы скелета роли (как у ansible-galaxy init): относительный путь → содержимое; None — пустая папка."""
    leaf = role.split("/")[-1]
    files = {f"{role}/{path}": text.format(role=role, leaf=leaf) for path, text in ROLE_SKELETON.items()}
    files.update({f"{role}/{folder}": None for folder in ROLE_EMPTY_DIRS})
    if parts is not None:   # только выбранные части скелета (папки и README.md)
        chosen = set(parts)
        files = {path: text for path, text in files.items() if path[len(role) + 1:].split("/")[0] in chosen}
        files[role] = None   # сама папка роли — всегда
    return files

def _object_files(roles, where, site_playbook, role_playbooks, title):
    """Содержимое папки playbooks/ или object/<объект>/: inventory, ansible.cfg, плейбуки, роли."""
    files = {
        HOSTS_FILE_CANDIDATES[0]: HOSTS_TEMPLATE,
        DEFAULTS_FILE_CANDIDATES[0]: DEFAULTS_TEMPLATE.format(where=where),
        ANSIBLE_CFG_FILE_NAME: ANSIBLE_CFG_TEMPLATE.format(hosts=HOSTS_FILE_CANDIDATES[0], roles=ROLES_DIR_NAME),
        ROLES_DIR_NAME: None,
    }
    if site_playbook:
        files["site.yml"] = _playbook_text(title, roles)
    if role_playbooks:
        for index, role in enumerate(roles, 1):
            files[f"{index:02d}-{role}.yml"] = _playbook_text(f"{title}: {role}", [role])
    for path, text in (item for role in roles for item in _role_files(role).items()):
        files[f"{ROLES_DIR_NAME}/{path}"] = text
    return files

def _write_tree(root, files):
    """Создаёт папки и файлы по словарю «относительный путь → текст (None — папка)»."""
    for relative, text in sorted(files.items()):
        path = os.path.join(root, *relative.split("/"))
        if text is None:
            os.makedirs(path, exist_ok=True)
        else:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w", encoding="utf-8") as handle:
                handle.write(text)

def project_plan(name, kind, objects, roles, site_playbook=True, role_playbooks=False, with_autodeploy=False):
    """Проверяет параметры нового проекта и возвращает его структуру: {относительный путь: текст или None}."""
    _check_item_name(name, "Имя проекта")
    if kind not in ("simple", "objects"):
        raise ValueError("Неизвестный тип проекта")
    roles = [_check_item_name(role, "Роль") for role in dict.fromkeys(roles or [])]
    objects = [_check_item_name(obj, "Объект") for obj in dict.fromkeys(objects or [])]
    if kind == "objects" and not objects:
        raise ValueError("Укажите хотя бы один объект")
    if len(roles) > 50 or len(objects) > 50:
        raise ValueError("Слишком много ролей или объектов за один раз (до 50)")
    files = {}
    if kind == "simple":
        for path, text in _object_files(roles, "проекта", site_playbook, role_playbooks, name).items():
            files[f"{PLAYBOOKS_DIR_NAME}/{path}"] = text
    else:
        for obj in objects:
            for path, text in _object_files(roles, "объекта", site_playbook, role_playbooks, f"{name} / {obj}").items():
                files[f"{OBJECTS_DIR_NAME}/{obj}/{path}"] = text
    if with_autodeploy:
        # без проекта-образца — минимальная заготовка; с образцом папка копируется в create_project
        files[f"{AUTODEPLOY_DIR_NAME}/{AUTODEPLOY_PLAYBOOK_NAME}"] = (
            f"---\n# Autodeploy проекта «{name}»: разворачивание узлов.\n" + _playbook_text("Autodeploy", [])[4:])
        files[f"{AUTODEPLOY_DIR_NAME}/{ROLES_DIR_NAME}"] = None
        files[f"{AUTODEPLOY_DIR_NAME}/{HWTYPE_HDD_DIR_NAME}"] = None
    return files

def autodeploy_sources():
    """Проекты, у которых есть Autodeploy: образцы структуры для нового проекта (число файлов и объём)."""
    result = []
    for project in get_projects():
        path = autodeploy(project)
        if not path:
            continue
        count = size = 0
        for directory, _, names in os.walk(os.path.dirname(path)):
            for name in names:
                count += 1
                try:
                    size += os.path.getsize(os.path.join(directory, name))
                except OSError:
                    pass
        result.append({"project": project, "files": count, "size": size})
    return result

def create_project(name, kind, objects, roles, site_playbook=True, role_playbooks=False, with_autodeploy=False, autodeploy_source=None):
    """Создаёт проект целиком. Сначала — во временной папке рядом, затем одно переименование:
    при ошибке не остаётся наполовину созданного проекта."""
    files = project_plan(name, kind, objects, roles, site_playbook, role_playbooks, with_autodeploy)
    os.makedirs(PROJECTS_ROOT, exist_ok=True)
    target = os.path.join(PROJECTS_ROOT, name)
    if os.path.exists(target):
        raise ValueError(f"Проект «{name}» уже существует")
    staging = tempfile.mkdtemp(prefix=f".{name}.", dir=PROJECTS_ROOT)
    source = autodeploy(autodeploy_source) if with_autodeploy and autodeploy_source in get_projects() else None
    try:
        if source:
            # структура Autodeploy — копией папки autodeploy выбранного проекта (дальше копия живёт отдельно)
            files = {path: text for path, text in files.items() if not path.startswith(AUTODEPLOY_DIR_NAME + "/")}
            shutil.copytree(os.path.dirname(source), os.path.join(staging, AUTODEPLOY_DIR_NAME), symlinks=True)
        _write_tree(staging, files)
        os.rename(staging, target)
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    log(f"Создан проект {name}: {'простой' if kind == 'simple' else 'объекты: ' + ', '.join(objects)}; роли: {', '.join(roles) or 'нет'}"
        + (f"; Autodeploy — копия из проекта {autodeploy_source}" if source else "; Autodeploy — заготовка" if with_autodeploy else ""))
    return sorted(path for path, text in files.items() if text is not None)

def list_roles(project, obj, scope=None):
    """Роли, доступные области: папки во всех местах поиска ролей (без повторов)."""
    names = set()
    for base in role_search_paths(project, obj, scope):
        names.update(name for name in os.listdir(base) if os.path.isdir(os.path.join(base, name)) and not name.startswith("."))
    return sorted(names, key=str.lower)

def add_role(project, obj, role, scope=None, parts=None):
    """Добавляет в область роль со стандартным скелетом (ссылка «infra/nginx» — во вложенной папке)."""
    ref = _role_ref(role)
    if not ref:
        raise ValueError(f"Роль «{role}»: допустимы латинские буквы, цифры, точка, дефис и подчёркивание (вложенная — через «/»)")
    directory = scope_dir(project, obj, scope)
    if not directory or not os.path.isdir(directory):
        raise ValueError("Проект или объект не найден")
    if find_role_dir(project, obj, ref, scope):
        raise ValueError(f"Роль «{ref}» уже есть")
    if parts is not None:
        parts = [part for part in parts if part in ROLE_PARTS]
        if not parts:
            raise ValueError("Выберите хотя бы одну папку роли")
    _write_tree(os.path.join(directory, ROLES_DIR_NAME), _role_files(ref, parts))
    log(f"Создана роль {ref} в {project}{' / ' + obj if obj else ''}{' (Autodeploy)' if scope else ''}")

def add_playbook(project, obj, name, roles, hosts="all", become=True, new_roles=None):
    """Добавляет плейбук с выбранными ролями; new_roles — роли, которые создаются тут же (скелет)."""
    for role in new_roles or []:
        _check_item_name(role, "Роль")
    name = name.strip() if isinstance(name, str) else ""
    if name and not name.lower().endswith((".yml", ".yaml")):
        name += ".yml"
    _check_item_name(name, "Имя плейбука")
    if name in NON_PLAYBOOK_FILE_NAMES:
        raise ValueError(f"Имя «{name}» занято служебным файлом")
    if not re.fullmatch(r"[A-Za-z0-9_.,:*!&\[\]-]{1,200}", hosts or ""):
        raise ValueError("Узлы (hosts): имя группы, узла или шаблон, например all или web")
    directory = object_dir(project, obj)
    if not directory or not os.path.isdir(directory):
        raise ValueError("Проект или объект не найден")
    path = os.path.join(directory, name)
    if os.path.exists(path):
        raise ValueError(f"Плейбук «{name}» уже есть")
    for role in new_roles or []:
        if not find_role_dir(project, obj, role):
            add_role(project, obj, role)
    roles = list(dict.fromkeys(list(roles or []) + list(new_roles or [])))
    known = set(list_roles(project, obj))
    unknown = [role for role in roles if role not in known]
    if unknown:
        raise ValueError(f"Нет таких ролей: {', '.join(unknown)}")
    path = os.path.join(directory, name)
    if os.path.exists(path):
        raise ValueError(f"Плейбук «{name}» уже есть")
    write(path, _playbook_text(os.path.splitext(name)[0], list(dict.fromkeys(roles or [])), hosts, become))
    log(f"Создан плейбук {name} в {project}{' / ' + obj if obj else ''}")
    return name

# --- Роли плейбука: добавить / убрать (правкой текста — комментарии и оформление сохраняются) ---
def _first_play_roles_ok(text, role, present):
    """Проверка результата правки: файл читается, и роль есть/нет среди ролей плейбука."""
    try:
        document = yaml.load(text, Loader=_TolerantLoader)
    except yaml.YAMLError:
        return False
    found = []
    for play in document if isinstance(document, list) else []:
        if isinstance(play, dict) and isinstance(play.get("roles"), list):
            found += [_role_ref(item if isinstance(item, str) else (item.get("role") or item.get("name")) if isinstance(item, dict) else None) for item in play["roles"]]
    return (role in found) == present

def _add_role_text(text, role):
    """Добавляет роль в roles: первого плея; если roles: нет — создаёт его после hosts:."""
    lines = text.split("\n")
    for index, line in enumerate(lines):
        flow = re.match(r"^(\s*)roles:\s*\[(.*)\]\s*(#.*)?$", line)
        if flow:
            items = [item.strip() for item in flow.group(2).split(",") if item.strip()]
            lines[index] = f"{flow.group(1)}roles: [{', '.join(items + [role])}]" + (f" {flow.group(3)}" if flow.group(3) else "")
            return "\n".join(lines)
        block = re.match(r"^(\s*)roles:\s*(#.*)?$", line)
        if block:
            indent, last, item_indent = len(block.group(1)), index, None
            for j in range(index + 1, len(lines)):
                current = lines[j]
                if not current.strip() or current.strip().startswith("#"):
                    continue
                current_indent = len(current) - len(current.lstrip())
                if current_indent < indent or (current_indent == indent and not current.lstrip().startswith("-")):
                    break
                if current.lstrip().startswith("-") and item_indent is None:
                    item_indent = current_indent
                last = j
            lines.insert(last + 1, " " * (item_indent if item_indent is not None else indent + 2) + f"- {role}")
            return "\n".join(lines)
    # roles: нет — добавить в первый плей (после hosts:, иначе после первой строки плея)
    play = next((i for i, line in enumerate(lines) if re.match(r"^\s*-\s+\S", line)), None)
    if play is None:
        raise ValueError("В плейбуке не найден плей — добавьте роль вручную в редакторе плейбука")
    key_indent = len(lines[play]) - len(lines[play].lstrip()) + 2
    insert_at = play
    for j in range(play + 1, len(lines)):
        current = lines[j]
        if current.strip() and len(current) - len(current.lstrip()) < key_indent:
            break
        if re.match(rf"^ {{{key_indent}}}hosts:", current):
            insert_at = j
            break
    lines[insert_at + 1:insert_at + 1] = [" " * key_indent + "roles:", " " * (key_indent + 2) + f"- {role}"]
    return "\n".join(lines)

def _remove_role_text(text, role):
    """Убирает роль из roles: всех плеев (строкой, {role: …} или многострочной записью с vars и т.п.);
    опустевший roles: удаляется целиком."""
    lines = text.split("\n")
    item_re = re.compile(r"^(\s*)-\s*(?:\{\s*)?(?:(?:role|name)\s*:\s*)?['\"]?([^'\",}\s#]+)")
    removed, index = False, 0
    while index < len(lines):
        line = lines[index]
        flow = re.match(r"^(\s*)roles:\s*\[(.*)\]\s*(#.*)?$", line)
        if flow:
            items = [item.strip() for item in flow.group(2).split(",") if item.strip()]
            kept = [item for item in items if _role_ref(item.strip("'\"")) != role]
            if len(kept) != len(items):
                removed = True
                if kept:
                    lines[index] = f"{flow.group(1)}roles: [{', '.join(kept)}]" + (f" {flow.group(3)}" if flow.group(3) else "")
                else:
                    del lines[index]
                    continue
            index += 1
            continue
        block = re.match(r"^(\s*)roles:\s*(#.*)?$", line)
        if not block:
            index += 1
            continue
        indent, j, remaining, removed_here = len(block.group(1)), index + 1, 0, False
        while j < len(lines):
            current = lines[j]
            current_indent = len(current) - len(current.lstrip())
            if current.strip() and (current_indent < indent or (current_indent == indent and not current.lstrip().startswith("-"))):
                break
            match = item_re.match(current)
            if match and _role_ref(match.group(2)) == role:
                item_indent, end = len(match.group(1)), j + 1
                # продолжение многострочной записи — строки глубже самого элемента
                while end < len(lines) and (not lines[end].strip() or len(lines[end]) - len(lines[end].lstrip()) > item_indent):
                    end += 1
                while end > j + 1 and not lines[end - 1].strip():
                    end -= 1
                del lines[j:end]
                removed = removed_here = True
                continue
            if match:
                remaining += 1
            j += 1
        if remaining == 0 and removed_here:      # блок опустел именно из-за этой правки
            del lines[index]
            continue
        index = j
    if not removed:
        raise ValueError("Роль подключена не через roles: (например, include_role в задачах) — уберите её в редакторе плейбука")
    return "\n".join(lines)

def playbook_role_add(project, obj, playbook_name, role, scope=None):
    """Добавляет роль в плейбук; если такой роли нет — создаёт её стандартный скелет."""
    path = playbook_path(project, obj, playbook_name, scope)
    if not path:
        raise ValueError("Плейбук не найден")
    role = _role_ref(role)
    if not role:
        raise ValueError("Имя роли: латинские буквы, цифры, точка, дефис и подчёркивание (вложенная — через «/»)")
    if role in playbook_role_refs(path)[0]:
        raise ValueError(f"Роль «{role}» уже есть в плейбуке")
    created = False
    if not find_role_dir(project, obj, role, scope):
        add_role(project, obj, role, scope)
        created = True
    text = read(path)
    new_text = _add_role_text(text, role)
    if not _first_play_roles_ok(new_text, role, True):
        raise ValueError("Не удалось добавить роль автоматически — добавьте её в редакторе плейбука")
    _backup_file(project, scope_key(obj, scope), "playbook", playbook_name, text)
    write(path, new_text)
    log(f"Роль {role} добавлена в плейбук {playbook_name}{' (роль создана)' if created else ''}")
    return created

def playbook_roles_add(project, obj, playbook_name, roles, scope=None, parts=None):
    """Добавляет в плейбук несколько ролей за раз (например, роль с подролями «группа/роль»);
    несуществующие создаются со всеми основными файлами и папками. Один файл — одна правка."""
    path = playbook_path(project, obj, playbook_name, scope)
    if not path:
        raise ValueError("Плейбук не найден")
    refs = []
    for role in roles or []:
        ref = _role_ref(role)
        if not ref:
            raise ValueError(f"Роль «{role}»: латинские буквы, цифры, точка, дефис и подчёркивание (подроль — через «/»)")
        if ref not in refs:
            refs.append(ref)
    if not refs:
        raise ValueError("Не выбрано ни одной роли")
    present = playbook_role_refs(path)[0]
    added, created = [], []
    text = original = read(path)
    for ref in refs:
        if ref in present:
            continue
        if not find_role_dir(project, obj, ref, scope):
            add_role(project, obj, ref, scope, parts)
            created.append(ref)
        new_text = _add_role_text(text, ref)
        if not _first_play_roles_ok(new_text, ref, True):
            raise ValueError(f"Не удалось добавить роль «{ref}» автоматически — добавьте её в редакторе плейбука")
        text = new_text
        added.append(ref)
    if added:
        _backup_file(project, scope_key(obj, scope), "playbook", playbook_name, original)
        write(path, text)
        log(f"В плейбук {playbook_name} добавлены роли: {', '.join(added)}{f' (созданы: {chr(44).join(created)})' if created else ''}")
    return {"added": added, "created": created, "skipped": [ref for ref in refs if ref not in added]}

ROLE_MARKER_DIRS = ("tasks", "handlers", "meta", "defaults", "vars", "templates", "files", "tests", "library", "module_utils", "lookup_plugins")

def roles_tree(project, obj, scope=None):
    """Роли области деревом: роли и папки-группы с подролями (вложенность до 3 уровней)."""
    def is_role(path):
        return any(os.path.isdir(os.path.join(path, marker)) for marker in ROLE_MARKER_DIRS[:7])
    def walk(base, prefix, depth):
        items = []
        for name in sorted(os.listdir(base), key=str.lower):
            path = os.path.join(base, name)
            if name.startswith(".") or name in ROLE_MARKER_DIRS or not os.path.isdir(path) or not re.fullmatch(ROLE_NAME_RE, name):
                continue
            ref = f"{prefix}{name}"
            role = is_role(path)
            children = walk(path, ref + "/", depth + 1) if depth < 3 else []
            if role or children:
                items.append({"ref": ref, "role": role, "children": children})
        return items
    merged = {}
    for base in role_search_paths(project, obj, scope):
        for item in walk(base, "", 1):
            merged.setdefault(item["ref"], item)
    return sorted(merged.values(), key=lambda item: item["ref"].lower())

def playbook_role_remove(project, obj, playbook_name, role, delete_files=False, scope=None):
    """Убирает роль из плейбука; по желанию — удаляет и папку роли (в корзину backups/deleted)."""
    role = _role_ref(role) or role
    path = playbook_path(project, obj, playbook_name, scope)
    if not path:
        raise ValueError("Плейбук не найден")
    text = read(path)
    new_text = _remove_role_text(text, role)
    if not _first_play_roles_ok(new_text, role, False):
        raise ValueError("Не удалось убрать роль автоматически — уберите её в редакторе плейбука")
    _backup_file(project, scope_key(obj, scope), "playbook", playbook_name, text)
    write(path, new_text)
    trashed = None
    if delete_files:
        directory = find_role_dir(project, obj, role, scope)
        if directory:
            trashed = _trash(project, scope_key(obj, scope), directory)
    log(f"Роль {role} убрана из плейбука {playbook_name}{' и удалена (в корзине backups/deleted)' if trashed else ''}")

# --- Удаление: не насовсем, а в корзину backups/deleted рядом с web1x.py ---
def _trash(project, obj, path):
    """Переносит файл или папку в backups/<проект>/<объект>/deleted/<время>-<имя> — удалённое можно вернуть."""
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    target = os.path.join(BASE_DIR, "backups", safe(project), safe(obj) or "_", "deleted", f"{stamp}-{os.path.basename(os.path.normpath(path))}")
    os.makedirs(os.path.dirname(target), exist_ok=True)
    shutil.move(path, target)
    return target

def delete_playbook(project, obj, name, scope=None):
    """Удаляет плейбук (в корзину). Роли не трогаются — они могут использоваться другими плейбуками.
    autodeploy.yml из интерфейса не удаляется."""
    if scope == AUTODEPLOY_SCOPE:
        raise ValueError("autodeploy.yml из интерфейса не удаляется")
    path = playbook_path(project, obj, name)
    if not path:
        raise ValueError("Плейбук не найден")
    _trash(project, obj, path)
    log(f"Удалён плейбук {name} (в корзине backups/deleted)")

def delete_role_file(project, obj, relative, scope=None):
    """Удаляет файл роли (в корзину)."""
    path = role_path(project, obj, relative, scope)
    if not path or not os.path.isfile(path) or not _split_role_path(relative)[1]:
        raise ValueError("Файл роли не найден")
    _trash(project, scope_key(obj, scope), path)
    log(f"Удалён файл роли {relative} (в корзине backups/deleted)")

# --- defaults.yml и ansible.cfg объекта: открыть (создать, если нет) и сохранить ---
OBJECT_FILE_KINDS = ("defaults", "cfg")

def object_file_path(project, obj, kind):
    """Путь к defaults.yml (первый существующий из кандидатов) или ansible.cfg объекта."""
    file_paths = paths(project, obj)
    if not file_paths or kind not in OBJECT_FILE_KINDS:
        return None
    if kind == "cfg":
        return file_paths["cfg"]
    path = file_paths["defaults"]
    if os.path.isdir(path):   # папка defaults/ — её main.yml или первый YAML-файл
        for name in ("main.yml", "main.yaml"):
            if os.path.isfile(os.path.join(path, name)):
                return os.path.join(path, name)
        files = sorted(name for name in os.listdir(path) if name.lower().endswith((".yml", ".yaml")))
        return os.path.join(path, files[0] if files else "main.yml")
    return path

def object_file_open(project, obj, kind):
    """Содержимое defaults.yml / ansible.cfg; если файла нет — создаёт его из заготовки."""
    path = object_file_path(project, obj, kind)
    if not path:
        raise ValueError("Проект или объект не найден")
    created = not os.path.isfile(path)
    if created:
        file_paths = paths(project, obj)
        write(path, DEFAULTS_TEMPLATE.format(where="объекта" if obj else "проекта") if kind == "defaults"
              else ANSIBLE_CFG_TEMPLATE.format(hosts=os.path.basename(file_paths["hosts"]), roles=ROLES_DIR_NAME))
        log(f"Создан {os.path.basename(path)} в {project}{' / ' + obj if obj else ''}")
    return {"name": os.path.relpath(path, object_dir(project, obj) or os.path.dirname(path)), "content": read(path), "created": created}

def ini_problem(text):
    """Ошибка формата ansible.cfg (INI) или None."""
    parser = configparser.ConfigParser(interpolation=None, strict=False)
    try:
        parser.read_string(text)
        return None
    except configparser.MissingSectionHeaderError as error:
        return {"line": error.lineno, "column": None, "message": "до первого параметра нужен заголовок секции, например [defaults]"}
    except configparser.ParsingError as error:
        line = error.errors[0][0] if getattr(error, "errors", None) else None
        return {"line": line, "column": None, "message": "строка не похожа на «параметр = значение»"}
    except configparser.Error as error:
        return {"line": getattr(error, "lineno", None), "column": None, "message": str(error)}

# --- редактирование файлов: проверка YAML и резервная копия ---
YAML_MESSAGES_RU = {
    "mapping values are not allowed here": "здесь не может быть «ключ: значение» — проверьте отступ или возьмите значение в кавычки",
    "could not find expected ':'": "не найдено двоеточие «:» после ключа",
    "found character '\\t' that cannot start any token": "символ табуляции — в YAML для отступов используются только пробелы",
    "did not find expected key": "неожиданный отступ — элемент не совпадает по уровню с соседними",
    "did not find expected '-' indicator": "неожиданный отступ в списке — элементы списка должны начинаться с «-» на одном уровне",
    "found undefined alias": "ссылка на неопределённый якорь (*)",
    "found unexpected end of stream": "файл обрывается — не закрыта кавычка или скобка",
    "found unknown escape character": "неизвестная экранированная последовательность в строке в двойных кавычках",
    "expected <block end>, but found '-'": "элемент списка «-» на неверном уровне отступа",
    "expected <block end>, but found '<block mapping start>'": "неверный отступ: строка сдвинута относительно соседних",
    "expected <block end>, but found '<scalar>'": "неверный отступ или лишний текст после значения",
}

def yaml_problem(text):
    """Ошибка синтаксиса YAML в тексте: {"line", "column", "message"} или None, если всё в порядке."""
    try:
        yaml.safe_load(text)
        return None
    except yaml.MarkedYAMLError as error:
        mark = error.problem_mark or error.context_mark
        problem = (error.problem or str(error)).strip()
        message = YAML_MESSAGES_RU.get(problem, problem)
        return {"line": mark.line + 1 if mark else None, "column": mark.column + 1 if mark else None, "message": message}
    except yaml.YAMLError as error:
        return {"line": None, "column": None, "message": str(error)}

def _backup_file(project, obj, kind, relative, old_text):
    """Предыдущая версия файла — в backups/ рядом с web1x.py (в папках проекта лишнего не появляется)."""
    path = os.path.join(BASE_DIR, "backups", safe(project), safe(obj) or "_", kind, *relative.split("/"))
    write(path + ".bak", old_text)

def save_text_file(project, obj, kind, relative, content, force=False, scope=None):
    """Сохраняет плейбук (kind="playbook") или файл роли (kind="role"). YAML проверяется до записи;
    с ошибкой не сохраняет — кроме случая force. Возвращает ошибку YAML или None."""
    if not isinstance(content, str) or len(content.encode("utf-8")) > 1024 * 1024:
        raise ValueError("Файл слишком большой (больше 1 МБ)")
    if kind == "playbook":
        path = playbook_path(project, obj, safe(relative), scope)
        if not path:
            raise ValueError("Плейбук не найден")
    elif kind == "role":
        path = role_path(project, obj, relative, scope)
        if not path or not os.path.isfile(path):
            raise ValueError("Файл роли не найден")
    else:
        path = object_file_path(project, obj, kind)
        if not path or not os.path.isfile(path):
            raise ValueError("Файл не найден")
    if not force:
        problem = yaml_problem(content) if path.lower().endswith((".yml", ".yaml")) else ini_problem(content) if kind == "cfg" else None
        if problem:
            return problem
    _backup_file(project, scope_key(obj, scope), kind, relative.replace("|", "/") if kind == "role" else os.path.basename(path), read(path))
    write(path, content)
    log(f"Сохранён {'плейбук' if kind == 'playbook' else 'файл роли' if kind == 'role' else 'файл'} {relative}{' (с ошибкой формата)' if force else ''}")
    return None

def create_role_file(project, obj, folder, filename, scope=None):
    """Создаёт новый файл в папке роли (например, шаблон в templates/). Возвращает путь «роль|…»."""
    _check_item_name(filename, "Имя файла")
    directory = role_path(project, obj, folder, scope)
    if not directory or not os.path.isdir(directory):
        raise ValueError("Папка роли не найдена")
    path = os.path.join(directory, filename)
    if os.path.exists(path):
        raise ValueError(f"Файл «{filename}» уже есть")
    write(path, "---\n" if filename.lower().endswith((".yml", ".yaml")) else "")
    ref, parts = _split_role_path(folder)
    relative = f"{ref}|{'/'.join(parts + [filename])}"
    log(f"Создан файл роли {relative}")
    return relative

# ============================================================================
# Подсказки в редакторе: справочник Ansible и контекст проекта
# ============================================================================
CATALOG_DIR = os.path.join(BASE_DIR, "cache")
ANSIBLE_DOC_LOCK = threading.Lock()
ANSIBLE_DOC = {"version": None, "status": "idle", "modules": None, "options": {}}
MODULE_NAME_RE = r"[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+){0,2}"

def _ansible_version():
    """Версия установленного Ansible (первая строка `ansible-doc --version`) или '' — если его нет."""
    with ANSIBLE_DOC_LOCK:
        if ANSIBLE_DOC["version"] is not None:
            return ANSIBLE_DOC["version"]
    try:
        output = subprocess.run(["ansible-doc", "--version"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=30).stdout
        version = output.splitlines()[0].strip() if output.strip() else ""
    except (OSError, subprocess.TimeoutExpired):
        version = ""
    with ANSIBLE_DOC_LOCK:
        ANSIBLE_DOC["version"] = version
    return version

def _catalog_cache_path():
    return os.path.join(CATALOG_DIR, "ansible_modules.json")

def _doc_text(value):
    """Описание из ansible-doc: список строк или строка; разметка C(), I(), L(текст,url) и т.п. — убирается."""
    text = " ".join(value) if isinstance(value, list) else str(value or "")
    text = re.sub(r"L\(([^,)]*),[^)]*\)", r"\1", text)
    text = re.sub(r"\b[CIBMOVERPU]\(([^)]*)\)", r"\1", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:240] + ("…" if len(text) > 240 else "")

def _build_module_list(version):
    """Фоновый поток: полный список модулей (`ansible-doc -l -j`) — может занять десятки секунд."""
    modules = None
    try:
        output = subprocess.run(["ansible-doc", "-l", "-j"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=600).stdout
        listing = json.loads(output or "{}")
        if isinstance(listing, dict) and listing:
            modules = [{"n": name, "d": _doc_text(description)} for name, description in sorted(listing.items()) if re.fullmatch(MODULE_NAME_RE, name)]
            write(_catalog_cache_path(), json.dumps({"version": version, "modules": modules}, ensure_ascii=False))
    except (OSError, subprocess.TimeoutExpired, ValueError):
        modules = None
    with ANSIBLE_DOC_LOCK:
        ANSIBLE_DOC["modules"] = modules
        ANSIBLE_DOC["status"] = "ready" if modules else "unavailable"

def ansible_catalog_get():
    """Справочник для подсказок. Если установлен Ansible — полный список модулей ваших коллекций
    (строится один раз в фоне и кэшируется до смены версии), иначе — встроенный справочник."""
    catalog = ansible_catalog.builtin_catalog()
    version = _ansible_version()
    if not version:
        catalog["loading"] = False
        return catalog
    with ANSIBLE_DOC_LOCK:
        status, modules = ANSIBLE_DOC["status"], ANSIBLE_DOC["modules"]
    if status == "idle":
        try:
            cached = json.loads(read(_catalog_cache_path()) or "{}")
        except ValueError:
            cached = {}
        if cached.get("version") == version and cached.get("modules"):
            with ANSIBLE_DOC_LOCK:
                ANSIBLE_DOC.update(status="ready", modules=cached["modules"])
            status, modules = "ready", cached["modules"]
        else:
            with ANSIBLE_DOC_LOCK:
                ANSIBLE_DOC["status"] = status = "loading"
            threading.Thread(target=_build_module_list, args=(version,), daemon=True).start()
    if status == "ready" and modules:
        catalog.update(source="ansible-doc", modules=modules, version=version)
    catalog["loading"] = status == "loading"
    return catalog

def ansible_module_doc(name):
    """Параметры модуля: из `ansible-doc -j <модуль>` (с кэшем) или из встроенного справочника."""
    if not re.fullmatch(MODULE_NAME_RE, name or ""):
        raise ValueError("Некорректное имя модуля")
    with ANSIBLE_DOC_LOCK:
        if name in ANSIBLE_DOC["options"]:
            return ANSIBLE_DOC["options"][name]
    fallback = ansible_catalog.MODULES.get(name) or ansible_catalog.MODULES.get(f"ansible.builtin.{name}")
    result = {"name": name, "description": fallback[0] if fallback else "", "options": fallback[1] if fallback else []}
    version = _ansible_version()
    if version:
        cache = os.path.join(CATALOG_DIR, "modules", f"{name}.json")
        try:
            cached = json.loads(read(cache) or "{}")
        except ValueError:
            cached = {}
        if cached.get("version") == version and "options" in cached:
            result = cached["result"]
        else:
            try:
                output = subprocess.run(["ansible-doc", "-j", name], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=60).stdout
                data = json.loads(output or "{}")
                entry = next(iter(data.values()), {}) if isinstance(data, dict) else {}
                doc = entry.get("doc") or {}
                options = []
                for option, spec in sorted((doc.get("options") or {}).items()):
                    spec = spec or {}
                    choices = spec.get("choices")
                    options.append({"n": option, "t": str(spec.get("type") or "str"), "r": bool(spec.get("required")),
                                    "c": [str(choice) for choice in choices] if isinstance(choices, list) else [],
                                    "d": _doc_text(spec.get("description"))})
                if doc:
                    result = {"name": name, "description": _doc_text(doc.get("short_description")), "options": options}
                    write(cache, json.dumps({"version": version, "options": True, "result": result}, ensure_ascii=False))
            except (OSError, subprocess.TimeoutExpired, ValueError, StopIteration):
                pass
    with ANSIBLE_DOC_LOCK:
        ANSIBLE_DOC["options"][name] = result
    return result

def _yaml_file(path):
    """YAML-файл или None, если его нет или он с ошибкой (контекст подсказок не должен падать)."""
    try:
        return yaml.safe_load(read(path)) if os.path.isfile(path) else None
    except yaml.YAMLError:
        return None

VAR_NAME_RE = r"[A-Za-z_][A-Za-z0-9_]*"

def _yaml_keys(path):
    """Переменные YAML-файла — с вложенными ключами: в файле «defaults:\n  dhcpiface: eth0» это
    «defaults» и «defaults.dhcpiface» (так к ним обращаются в Jinja). До трёх уровней вложенности.
    !vault и т.п. не мешают; если файл не читается — ключи верхнего уровня по тексту."""
    text = read(path)
    try:
        data = yaml.load(text, Loader=_TolerantLoader)
    except yaml.YAMLError:
        return re.findall(r"(?m)^(" + VAR_NAME_RE + r")\s*:", text)
    names = []
    def walk(prefix, value, depth):
        for key, child in value.items():
            if not isinstance(key, str) or not re.fullmatch(VAR_NAME_RE, key):
                continue
            name = f"{prefix}.{key}" if prefix else key
            names.append(name)
            if isinstance(child, dict) and depth < 3:
                walk(name, child, depth + 1)
    if isinstance(data, dict):
        walk("", data, 1)
    return names[:1000]

def _var_files(path):
    """Файлы переменных: сам файл или все YAML-файлы папки (как Ansible читает group_vars/<группа>/)."""
    if os.path.isfile(path):
        return [path]
    found = []
    if os.path.isdir(path):
        for directory, dirs, names in os.walk(path):
            dirs.sort()
            for name in sorted(names):
                if name.lower().endswith((".yml", ".yaml", ".json")) or "." not in name:
                    found.append(os.path.join(directory, name))
    return found[:300]

def ansible_context(project, obj, kind="", path="", scope=None):
    """Контекст для подсказок: роли, хендлеры, шаблоны/файлы текущей роли, переменные, группы inventory."""
    roles = list_roles(project, obj, scope)
    current = _split_role_path(path)[0] if kind == "role" and path else ""
    handlers, variables, templates, files = [], [], [], []
    seen_vars = set()
    def add_var(name, source):
        if isinstance(name, str) and re.fullmatch(VAR_NAME_RE + r"(\." + VAR_NAME_RE + r")*", name) and name not in seen_vars:
            seen_vars.add(name)
            variables.append({"n": name, "s": source})
    # переменные текущей роли — первыми
    for role in sorted(roles, key=lambda item: item != current):
        role_dir = find_role_dir(project, obj, role, scope)
        if not role_dir:
            continue
        for folder in ("defaults", "vars"):
            for path in _var_files(os.path.join(role_dir, folder)):
                for key in _yaml_keys(path):
                    add_var(key, f"{folder} роли {role}")
        data = _yaml_file(os.path.join(role_dir, "handlers", "main.yml"))
        if isinstance(data, list):
            for item in data:
                if isinstance(item, dict):
                    for title in [item.get("name")] + ([item.get("listen")] if isinstance(item.get("listen"), str) else list(item.get("listen") or [])):
                        if isinstance(title, str) and title.strip():
                            handlers.append({"n": title.strip(), "s": f"роль {role}", "own": role == current})
        if role == current:
            for folder, target in (("templates", templates), ("files", files)):
                base = os.path.join(role_dir, folder)
                for directory, _, names in os.walk(base):
                    for name in sorted(names):
                        target.append(os.path.relpath(os.path.join(directory, name), base).replace(os.sep, "/"))
    # общие переменные: defaults (файл или папка defaults/ объекта), group_vars/ и host_vars/
    # рядом с inventory, плейбуками области и в проекте
    file_paths = paths(project, obj)
    base_dir = object_dir(project, obj) or ""
    for candidate in DEFAULTS_FILE_CANDIDATES if base_dir else []:     # все существующие: и defaults.yml, и папка defaults/
        for path in _var_files(os.path.join(base_dir, candidate)):
            for key in _yaml_keys(path):
                add_var(key, os.path.relpath(path, base_dir))
    seen_dirs = set()
    for root in (base_dir, scope_dir(project, obj, scope) or "", project_dir(project) or ""):
        for folder in ("group_vars", "host_vars"):
            directory = os.path.join(root, folder)
            if not root or not os.path.isdir(directory) or os.path.realpath(directory) in seen_dirs:
                continue
            seen_dirs.add(os.path.realpath(directory))
            for path in _var_files(directory):
                for key in _yaml_keys(path):
                    add_var(key, os.path.relpath(path, root))
    for host in parse_hosts(project, obj):
        for key in host["parameters"]:
            add_var(key, "параметр узла")
    groups = [item.get("name") if isinstance(item, dict) else item for item in inventory_groups(project, obj)]
    handlers.sort(key=lambda item: not item["own"])
    return {"roles": roles, "handlers": handlers, "templates": templates[:300], "files": files[:300],
            "variables": variables[:2000], "groups": [group for group in groups if isinstance(group, str)]}

def autodeploy(project):
    """autodeploy.yml проекта или None — Autodeploy есть только у тех проектов, где он создан."""
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

INTERFACES_CACHE = {"time": 0.0, "value": None}
INTERFACES_CACHE_SECONDS = 15

def list_network_interfaces():
    """Список интерфейсов с кэшем на INTERFACES_CACHE_SECONDS: его спрашивают карта сети, прослушка
    и автопостроение — каждый раз запускать ip незачем, интерфейсы меняются редко."""
    now = time.time()
    if INTERFACES_CACHE["value"] is not None and now - INTERFACES_CACHE["time"] < INTERFACES_CACHE_SECONDS:
        return INTERFACES_CACHE["value"]
    value = _list_network_interfaces()
    INTERFACES_CACHE.update(time=now, value=value)
    return value

def _list_network_interfaces():
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
    """Вытаскивает из одной строки вывода `tcpdump -e` MAC-адрес источника и, если получится, его IP:
    из ARP ("tell <ip>" — IP того, кто спрашивает) или из заголовка IPv4 (адрес отправителя).
    Возвращает (mac, ip, ip_из_arp) или None."""
    match = _TCPDUMP_LINE_RE.search(line)
    if not match:
        return None
    src_mac = match.group(1).upper()
    tell_match = _TCPDUMP_ARP_TELL_RE.search(line)
    if tell_match:
        return src_mac, tell_match.group(1), True
    ipv4_match = _TCPDUMP_IPV4_SRC_RE.search(line)
    if ipv4_match:
        return src_mac, ipv4_match.group(1), False
    return src_mac, None, False

def _local_networks():
    """Подсети, в которых у сервера есть адрес. Пакет из чужой сети приходит с MAC-адресом шлюза,
    поэтому IP из заголовка IPv4 принимается как адрес устройства, только если он из этих подсетей."""
    try:
        output = subprocess.run(["ip", "-4", "-o", "addr", "show"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                text=True, timeout=SYSTEM_CHECK_TIMEOUT_SECONDS).stdout
    except (OSError, subprocess.TimeoutExpired):
        return []
    networks = []
    for match in re.finditer(r"\binet\s+(\d{1,3}(?:\.\d{1,3}){3}/\d{1,2})", output):
        try:
            network = ipaddress.ip_interface(match.group(1)).network
        except ValueError:
            continue
        if not network.is_loopback:
            networks.append(network)
    return networks

def _ip_in_networks(ip, networks):
    """IP входит в одну из подсетей."""
    try:
        address = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return any(address in network for network in networks)

def _tcpdump_error_hint(lines, interface):
    """Понятное пояснение, почему tcpdump остановился сам (пишется над таблицей окна прослушки)."""
    text = "\n".join(lines)
    if "ermission" in text or "Operation not permitted" in text:
        return ("Не хватает прав для захвата трафика. Запустите web1x.py от root или разрешите tcpdump захват: "
                "sudo setcap cap_net_raw,cap_net_admin=eip $(which tcpdump)")
    if "No such device" in text or "doesn't exist" in text:
        return f"Сетевой интерфейс {interface} не найден — выберите другой в списке."
    last = next((line for line in reversed(lines) if line.strip()), "")
    return f"TCPdump остановился: {last}" if last else "TCPdump остановился без вывода."

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
            NMAP_STATE["hint"] = "TCPdump не установлен на сервере — установите пакет tcpdump или используйте таблицу коммутатора (SSH)."
            NMAP_STATE["running"] = False
        return
    except OSError as error:
        with NMAP_LOCK:
            NMAP_STATE["raw_output"] = f"Не удалось запустить tcpdump: {error}"
            NMAP_STATE["hint"] = f"Не удалось запустить TCPdump: {error}"
            NMAP_STATE["running"] = False
        return

    with NMAP_LOCK:
        NMAP_PROCESS = process
        NMAP_STATE["raw_output"] = f"Слушаю интерфейс {interface}…\n"

    raw_lines = deque(maxlen=TCPDUMP_RAW_LINES_LIMIT)
    networks = _local_networks()
    while not NMAP_STOP_EVENT.is_set():
        line = process.stdout.readline()
        if not line:
            break  # процесс сам завершился — например, не хватило прав на захват пакетов
        raw_lines.append(line.rstrip())
        parsed = _parse_tcpdump_line(line)
        now = datetime.now().strftime("%H:%M:%S")
        with NMAP_LOCK:
            if parsed:
                mac, ip, from_arp = parsed
                if ip and not from_arp and not _ip_in_networks(ip, networks):
                    ip = None   # пакет из чужой сети: MAC здесь — шлюза, а не этого IP
                entry = NMAP_STATE["devices"].setdefault(mac, {"mac": mac, "ip": "", "first_seen": now})
                if ip:
                    entry["ip"] = ip
                entry["last_seen"] = now
            NMAP_STATE["raw_output"] = "\n".join(raw_lines)
        if parsed:
            _remember_tcpdump_device(parsed[0], ip)   # в реестр найденного (для карты «по найденным»)
        _flush_discovered()

    stopped_by_user = NMAP_STOP_EVENT.is_set()
    _flush_discovered(force=True)
    process.terminate()
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        process.kill()
    with NMAP_LOCK:
        NMAP_PROCESS = None
        NMAP_STATE["running"] = False
        if not stopped_by_user:   # tcpdump завершился сам — значит, ошибка; объясняем её над таблицей
            NMAP_STATE["hint"] = _tcpdump_error_hint(list(raw_lines), interface)

_SWITCH_MAC_RE = re.compile(rf"\b({_MAC_TOKEN})\b")

def _parse_mikrotik_bridge_hosts(output):
    """Разбирает вывод `/interface/bridge/host/print` на MikroTik-коммутаторе.

    Порядок столбцов у RouterOS 6 и 7 разный, поэтому столбцы определяются по строке
    заголовка (MAC-ADDRESS, VID, ON-INTERFACE, BRIDGE): вывод выровнен по ширине, и значение
    каждого столбца берётся из той же позиции, что и его заголовок. Если заголовка нет —
    запасной вариант: порт, мост и VLAN — по порядку после MAC-адреса."""
    lines = output.splitlines()
    # заголовок — строка столбцов («#  MAC-ADDRESS  VID …»), а не строка «Columns: MAC-ADDRESS, VID, …» из RouterOS 7
    candidates = [line for line in lines if "MAC-ADDRESS" in line.upper() and not line.strip().upper().startswith("COLUMNS")]
    header = candidates[-1] if candidates else None
    headers = [(found.group(0).upper(), (found.start() + found.end()) / 2) for found in re.finditer(r"\S+", header)] if header else []
    rows = []
    for line in lines:
        match = _SWITCH_MAC_RE.search(line)
        if not match or line is header:
            continue
        mac = match.group(1).upper()
        before = line[:match.start()].split()
        flags = next((token for token in reversed(before) if not token.isdigit()), "")
        if headers:
            # каждое значение после MAC — к ближайшему по положению заголовку: так работают и числа,
            # выровненные по правому краю (VID в RouterOS 7), и текст, выровненный по левому
            values = {}
            for token in re.finditer(r"\S+", line[match.end():]):
                center = match.end() + (token.start() + token.end()) / 2
                name = min(headers, key=lambda column: abs(column[1] - center))[0]
                values.setdefault(name, token.group(0))
            vlan = values.get("VID") or values.get("VLAN-ID") or values.get("VLAN") or ""
            row = {"mac": mac, "flags": flags, "port": values.get("ON-INTERFACE") or values.get("INTERFACE") or "",
                   "bridge": values.get("BRIDGE", ""), "vlan": vlan if re.fullmatch(r"\d{1,4}", vlan) else ""}
        else:
            after = line[match.end():].split()
            row = {"mac": mac, "flags": flags, "port": after[0] if len(after) > 0 else "",
                   "bridge": after[1] if len(after) > 1 else "", "vlan": after[2] if len(after) > 2 and re.fullmatch(r"\d{1,4}", after[2]) else ""}
        rows.append(row)
    return rows

# --- Последняя таблица коммутатора (MAC → VLAN/порт): нужна автопостроению карты для подписей VLAN ---
SWITCH_MAC_LOCK = threading.Lock()

def _switch_mac_cache_path():
    """Файл с последней таблицей MAC-адресов коммутатора (рядом с данными карты)."""
    return os.path.join(BASE_DIR, NETMAP_DIR_NAME, "switch_macs.json")

def _load_switch_macs():
    """{MAC: {"vlan", "port", "switch", "seen"}} — то, что коммутатор показывал при последней прослушке по SSH."""
    try:
        return json.loads(read(_switch_mac_cache_path()) or "{}")
    except json.JSONDecodeError:
        return {}

def _remember_switch_macs(rows, switch_address):
    """Сохраняет VLAN и порт каждого MAC из таблицы коммутатора (файл переживает перезапуск сервера)."""
    seen = datetime.now().strftime("%Y-%m-%d %H:%M")
    with SWITCH_MAC_LOCK:
        cache = _load_switch_macs()
        changed = False
        for row in rows:
            entry = {"vlan": row.get("vlan", ""), "port": row.get("port", ""), "switch": switch_address, "seen": seen,
                     "local": "L" in row.get("flags", "")}
            if cache.get(row["mac"], {}).get("vlan") != entry["vlan"] or cache.get(row["mac"], {}).get("port") != entry["port"]:
                changed = True
            cache[row["mac"]] = entry
        if changed:
            write(_switch_mac_cache_path(), json.dumps(cache, ensure_ascii=False, indent=2))

# --- Устройства, найденные прослушкой (для автопостроения карты «по найденным») ---
DISCOVERED_LOCK = threading.Lock()
DISCOVERED_TCPDUMP = None          # MAC → {"ip", "first_seen", "last_seen"}; читается из файла при первом обращении
DISCOVERED_STATE = {"dirty": False, "saved_at": 0.0}

def _discovered_path():
    """Файл с устройствами, которые видел TCPdump (рядом с данными карты; переживает перезапуск)."""
    return os.path.join(BASE_DIR, NETMAP_DIR_NAME, "discovered_devices.json")

def _tcpdump_registry():
    """Реестр TCPdump в памяти (при первом обращении — из файла). Вызывать под DISCOVERED_LOCK."""
    global DISCOVERED_TCPDUMP
    if DISCOVERED_TCPDUMP is None:
        try:
            DISCOVERED_TCPDUMP = json.loads(read(_discovered_path()) or "{}")
        except json.JSONDecodeError:
            DISCOVERED_TCPDUMP = {}
    return DISCOVERED_TCPDUMP

def _remember_tcpdump_device(mac, ip):
    """Запоминает устройство, увиденное TCPdump (MAC и, если известен, IP)."""
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with DISCOVERED_LOCK:
        entry = _tcpdump_registry().setdefault(mac, {"ip": "", "first_seen": now})
        if ip and entry.get("ip") != ip:
            entry["ip"] = ip
        entry["last_seen"] = now
        DISCOVERED_STATE["dirty"] = True

def _flush_discovered(force=False):
    """Пишет реестр на диск не чаще раза в 5 секунд (и обязательно — когда прослушка останавливается)."""
    with DISCOVERED_LOCK:
        if not DISCOVERED_STATE["dirty"] or (not force and time.time() - DISCOVERED_STATE["saved_at"] < 5):
            return
        write(_discovered_path(), json.dumps(_tcpdump_registry(), ensure_ascii=False, indent=2))
        DISCOVERED_STATE.update(dirty=False, saved_at=time.time())

def _own_macs():
    """MAC-адреса сетевых интерфейсов самого сервера."""
    macs = set()
    try:
        names = os.listdir("/sys/class/net")
    except OSError:
        names = []
    for name in names:
        mac = read(os.path.join("/sys/class/net", name, "address")).strip().upper()
        if re.fullmatch(_MAC_TOKEN, mac) and mac != "00:00:00:00:00:00":
            macs.add(mac)
    return macs

def _usable_mac(mac):
    """Обычный MAC устройства — не широковещательный и не групповой (multicast)."""
    return bool(re.fullmatch(_MAC_TOKEN, mac or "")) and not int(mac[:2], 16) & 1

def _usable_ip(ip):
    """Обычный адрес устройства — не 0.0.0.0, не широковещательный, не групповой."""
    try:
        address = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return not (address.is_multicast or address.is_unspecified or address.is_loopback or str(address) == "255.255.255.255")

def discovered_devices():
    """Всё, что нашла прослушка: TCPdump (MAC + IP) и таблица коммутатора (MAC + порт + VLAN),
    IP для MAC из таблицы коммутатора — по ARP-таблице сервера. Устройства самого сервера,
    собственные MAC коммутатора и служебные адреса пропускаются.
    Возвращает (устройства, через какие порты коммутатора подключён сам сервер)."""
    with DISCOVERED_LOCK:
        tcpdump = {mac: dict(info) for mac, info in _tcpdump_registry().items()}
    switch_macs = _load_switch_macs()
    mac_to_ip = {mac: ip for ip, mac in _ip_to_mac().items()}
    own = _own_macs()
    self_ips = {item["ip"] for item in list_network_interfaces()["interfaces"]}
    devices, self_ports = {}, []
    for mac, info in tcpdump.items():
        devices[mac] = {"mac": mac, "ip": info.get("ip", ""), "last_seen": info.get("last_seen", "")}
    for mac, info in switch_macs.items():
        if info.get("local"):
            continue
        if mac in own:
            self_ports.append({"switch": info.get("switch", ""), "port": info.get("port", ""), "vlan": info.get("vlan", "")})
            continue
        device = devices.setdefault(mac, {"mac": mac, "ip": "", "last_seen": info.get("seen", "")})
        device.update(vlan=info.get("vlan", ""), port=info.get("port", ""), switch=info.get("switch", ""))
    result = []
    for mac, device in devices.items():
        if mac in own or not _usable_mac(mac):
            continue
        if not device["ip"] and mac in mac_to_ip:
            device["ip"] = mac_to_ip[mac]
        if device["ip"] and (not _usable_ip(device["ip"]) or device["ip"] in self_ips):
            device["ip"] = ""
        if device["ip"] or device.get("switch"):
            result.append(device)
    return sorted(result, key=lambda item: (item["ip"] == "", item["ip"], item["mac"])), self_ports

def discovered_summary():
    """Сводка для окна автопостроения: сколько устройств нашла прослушка и когда видела последнее."""
    devices, _ = discovered_devices()
    return {"total": len(devices), "with_ip": sum(1 for item in devices if item["ip"]),
            "on_switch": sum(1 for item in devices if item.get("switch")),
            "last_seen": max((item.get("last_seen", "") for item in devices), default="")}

def discovered_clear():
    """Забывает всё найденное прослушкой (и таблицу коммутатора — она же даёт VLAN для карты)."""
    global DISCOVERED_TCPDUMP
    with DISCOVERED_LOCK:
        DISCOVERED_TCPDUMP = {}
        DISCOVERED_STATE["dirty"] = False
        for path in (_discovered_path(), _switch_mac_cache_path()):
            try:
                os.remove(path)
            except OSError:
                pass
    log("Очищен список устройств, найденных прослушкой")

# --- Сканирование подсети: какие адреса заняты (память — у каждого проекта своя) ---
SUBNET_LOCK = threading.Lock()
SUBNET_RUNNING = {}            # проект → {"subnet", "total", "done", "started"}
SUBNET_MIN_PREFIX = 22          # не больше /22 (1022 адреса) — иначе сканирование слишком долгое

def _subnet_path(project):
    return os.path.join(BASE_DIR, NETMAP_DIR_NAME, "subnets", f"{safe(project)}.json")

def _parse_subnet(subnet, mask):
    """Подсеть из адреса и маски: маска — «24» или «255.255.255.0»; можно сразу «192.168.1.0/24»."""
    subnet, mask = str(subnet or "").strip(), str(mask or "").strip().lstrip("/")
    if "/" in subnet and not mask:
        subnet, mask = subnet.split("/", 1)
    try:
        network = ipaddress.ip_network(f"{subnet}/{mask}", strict=False)
    except ValueError:
        raise ValueError("Подсеть: адрес вида 192.168.1.0 и маска вида 24 или 255.255.255.0") from None
    if network.version != 4:
        raise ValueError("Поддерживаются только подсети IPv4")
    if network.prefixlen < SUBNET_MIN_PREFIX or network.prefixlen > 30:
        raise ValueError(f"Маска от /{SUBNET_MIN_PREFIX} до /30 — не больше 1022 адресов за одно сканирование")
    return network

def _ping_once(ip):
    """Один пинг с таймаутом 1 секунда."""
    try:
        return subprocess.run(["ping", "-c", "1", "-W", "1", str(ip)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=4).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False

def _arp_alive():
    """IP → MAC из ARP-таблицы сервера — только живые записи (REACHABLE, DELAY, PROBE, PERMANENT):
    так находятся и устройства, которые не отвечают на пинг, но отвечают на ARP."""
    try:
        output = subprocess.run(["ip", "neigh", "show"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=SYSTEM_CHECK_TIMEOUT_SECONDS).stdout
    except (OSError, subprocess.TimeoutExpired):
        return {}
    alive = {}
    for line in output.splitlines():
        match = re.match(rf"(\d{{1,3}}(?:\.\d{{1,3}}){{3}})\s.*\blladdr\s+({_MAC_TOKEN})\s+(REACHABLE|DELAY|PROBE|PERMANENT)", line)
        if match:
            alive[match.group(1)] = match.group(2).upper()
    return alive

def _subnet_worker(project, network):
    hosts = [str(ip) for ip in network.hosts()]
    used = {}
    def check(ip):
        return ip, _ping_once(ip)
    with concurrent.futures.ThreadPoolExecutor(max_workers=64) as executor:
        for ip, alive in executor.map(check, hosts):
            if alive:
                used[ip] = ""
            with SUBNET_LOCK:
                SUBNET_RUNNING[project]["done"] += 1
    for ip, mac in _arp_alive().items():
        if ipaddress.ip_address(ip) in network:
            used[ip] = mac
    for item in list_network_interfaces()["interfaces"]:
        if item.get("ip") and ipaddress.ip_address(item["ip"]) in network:
            used[item["ip"]] = used.get(item["ip"]) or "этот сервер"
    result = {"subnet": str(network), "total": len(hosts), "scanned_at": datetime.now().strftime("%Y-%m-%d %H:%M"),
              "used": dict(sorted(used.items(), key=lambda item: ipaddress.ip_address(item[0])))}
    write(_subnet_path(project), json.dumps(result, ensure_ascii=False, indent=1))
    with SUBNET_LOCK:
        SUBNET_RUNNING.pop(project, None)
    log(f"Сканирование подсети {network} ({project}): занято {len(used)} из {len(hosts)}")

def subnet_scan_start(project, subnet, mask):
    """Запускает сканирование подсети проекта в фоне (пинг всех адресов + ARP)."""
    if project not in get_projects():
        raise ValueError("Проект не найден")
    network = _parse_subnet(subnet, mask)
    with SUBNET_LOCK:
        if project in SUBNET_RUNNING:
            raise ValueError("Сканирование уже идёт")
        SUBNET_RUNNING[project] = {"subnet": str(network), "total": network.num_addresses - 2, "done": 0, "started": time.time()}
    threading.Thread(target=_subnet_worker, args=(project, network), daemon=True).start()

def subnet_scan_get(project):
    """Результат последнего сканирования подсети проекта (и ход текущего, если идёт)."""
    with SUBNET_LOCK:
        running = dict(SUBNET_RUNNING[project]) if project in SUBNET_RUNNING else None
    try:
        saved = json.loads(read(_subnet_path(project)) or "null")
    except ValueError:
        saved = None
    return {"running": running, "result": saved}

def subnet_scan_reset(project):
    """Забывает результат сканирования подсети проекта."""
    try:
        os.remove(_subnet_path(project))
    except FileNotFoundError:
        pass
    log(f"Сброшен результат сканирования подсети ({project})")

def _ip_to_mac():
    """IP → MAC по ARP-таблице сервера (ip neigh) и по найденному TCPdump."""
    mapping = {}
    try:
        output = subprocess.run(["ip", "neigh", "show"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=SYSTEM_CHECK_TIMEOUT_SECONDS).stdout
    except (OSError, subprocess.TimeoutExpired):
        output = ""
    for line in output.splitlines():
        match = re.match(rf"(\d{{1,3}}(?:\.\d{{1,3}}){{3}})\s.*\blladdr\s+({_MAC_TOKEN})", line)
        if match:
            mapping[match.group(1)] = match.group(2).upper()
    with NMAP_LOCK:
        for device in NMAP_STATE.get("devices", {}).values():
            if device.get("ip") and device.get("mac") and NMAP_STATE.get("mode") == "tcpdump":
                mapping.setdefault(device["ip"], device["mac"].upper())
    return mapping

SWITCH_HOSTKEY_PENDING = {}   # адрес → (время, строки ключей) — показанные пользователю, ещё не подтверждённые
SWITCH_HOSTKEY_LOCK = threading.Lock()

def _known_hosts_path():
    """known_hosts пользователя, от имени которого работает сервер (его же читает ssh)."""
    return os.path.expanduser("~/.ssh/known_hosts")

def _switch_target_check(address, user=""):
    """Адрес и пользователь попадают в команду ssh — строки, похожие на опции («-o…»), не допускаются."""
    if not _ping_target_ok(address):
        raise ValueError("Некорректный адрес коммутатора")
    if user and not re.fullmatch(r"[A-Za-z0-9._][A-Za-z0-9._-]{0,63}", user):
        raise ValueError("Некорректное имя пользователя: допустимы латинские буквы, цифры, точка, дефис и подчёркивание")

def switch_hostkey_status(address):
    """Знает ли сервер ключ SSH коммутатора. Если нет — получает его (ssh-keyscan) и возвращает
    отпечатки для подтверждения пользователем — то же, что вопрос «yes/no» при первом входе в консоли."""
    address = (address or "").strip()
    _switch_target_check(address)
    try:
        known = subprocess.run(["ssh-keygen", "-F", address, "-f", _known_hosts_path()], stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, timeout=SYSTEM_CHECK_TIMEOUT_SECONDS).returncode == 0
    except FileNotFoundError:
        raise ValueError("На сервере не установлен OpenSSH-клиент (ssh-keygen)") from None
    except subprocess.TimeoutExpired:
        known = False
    if known:
        return {"known": True}
    try:
        scan = subprocess.run(["ssh-keyscan", "-T", "5", address], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=20)
    except FileNotFoundError:
        raise ValueError("На сервере не установлен OpenSSH-клиент (ssh-keyscan)") from None
    except subprocess.TimeoutExpired:
        raise ValueError(f"Коммутатор {address} не ответил по SSH") from None
    lines = [line for line in scan.stdout.splitlines() if line.strip() and not line.startswith("#")]
    if not lines:
        raise ValueError(f"Не удалось получить ключ SSH коммутатора {address}: он не отвечает на порту 22")
    with tempfile.NamedTemporaryFile("w", suffix=".pub", delete=False) as handle:
        handle.write("\n".join(lines) + "\n")
        temp_path = handle.name
    try:
        listing = subprocess.run(["ssh-keygen", "-lf", temp_path], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=5).stdout
    finally:
        os.unlink(temp_path)
    fingerprints = []
    for line in listing.splitlines():
        match = re.match(r"(\d+)\s+(\S+)\s+.*\((\S+)\)\s*$", line)
        if match:
            fingerprints.append({"type": match.group(3), "bits": match.group(1), "fingerprint": match.group(2)})
    with SWITCH_HOSTKEY_LOCK:
        SWITCH_HOSTKEY_PENDING[address] = (time.time(), lines)
    return {"known": False, "fingerprints": fingerprints}

def switch_hostkey_trust(address):
    """Запоминает в known_hosts ровно те ключи, отпечатки которых видел и подтвердил пользователь."""
    address = (address or "").strip()
    _switch_target_check(address)
    with SWITCH_HOSTKEY_LOCK:
        pending = SWITCH_HOSTKEY_PENDING.pop(address, None)
    if not pending or time.time() - pending[0] > 600:
        raise ValueError("Отпечаток устарел — нажмите «Включить режим прослушки» ещё раз")
    path = _known_hosts_path()
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    with open(path, "a", encoding="utf-8") as handle:
        handle.write("\n".join(pending[1]) + "\n")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    log(f"Сохранён ключ SSH коммутатора {address}")

def switch_hostkey_forget(address):
    """Удаляет сохранённый ключ коммутатора (после его замены/сброса), чтобы подтвердить новый."""
    address = (address or "").strip()
    _switch_target_check(address)
    try:
        subprocess.run(["ssh-keygen", "-R", address, "-f", _known_hosts_path()], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=SYSTEM_CHECK_TIMEOUT_SECONDS)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ValueError(f"Не удалось удалить ключ: {error}") from None
    log(f"Удалён сохранённый ключ SSH коммутатора {address}")

def _ssh_error_hint(output):
    """Понятное пояснение к типичным ошибкам ssh (пишется над «сырым» выводом)."""
    text = output or ""
    if "REMOTE HOST IDENTIFICATION HAS CHANGED" in text or "Host key verification failed" in text:
        return "Ключ SSH коммутатора не совпадает с сохранённым. Так бывает после замены или сброса коммутатора, но может означать и подмену устройства."
    if "Permission denied" in text:
        return "Коммутатор отклонил вход: проверьте пользователя и пароль."
    if "Connection refused" in text:
        return "Коммутатор отказал в подключении: SSH на нём выключен или работает на другом порту."
    if "timed out" in text or "No route to host" in text:
        return "Коммутатор не отвечает: проверьте адрес и доступность по сети."
    return ""

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
    # Ключ коммутатора к этому моменту уже подтверждён (switch_hostkey_trust), поэтому проверка строгая:
    # подменённый ключ ssh не примет. Без пароля — BatchMode: не зависать на запросе пароля.
    options = ["-o", "StrictHostKeyChecking=yes", "-o", f"ConnectTimeout={SWITCH_SSH_TIMEOUT_SECONDS}"]
    options += ["-o", "NumberOfPasswordPrompts=1"] if switch_password else ["-o", "BatchMode=yes"]
    ssh_command = ["ssh", *options, f"{user}@{switch_address}", SWITCH_SSH_COMMAND]
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
        if rows:
            _remember_switch_macs(rows, switch_address)
        first = next((line.strip() for line in output.splitlines() if line.strip() and not line.lstrip().startswith(("Flags", "Columns", "#"))), "")
        hint = "" if rows else (_ssh_error_hint(output) or (f"Коммутатор не вернул ни одной записи MAC-адресов. Ответ: {first[:200]}" if first else "Коммутатор вернул пустой ответ."))
        now = datetime.now().strftime("%H:%M:%S")
        with NMAP_LOCK:
            NMAP_STATE["hint"] = hint
            NMAP_STATE["hostkey_changed"] = "REMOTE HOST IDENTIFICATION HAS CHANGED" in output
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
    if mode == "switch":
        _switch_target_check(switch_address.strip(), switch_user.strip())
    with NMAP_LOCK:
        if NMAP_STATE["running"]:
            return
        NMAP_STATE["running"] = True
        NMAP_STATE["mode"] = mode
        NMAP_STATE["devices"] = {}
        NMAP_STATE["raw_output"] = ""
        NMAP_STATE["hint"] = ""
        NMAP_STATE["hostkey_changed"] = False
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
        return {"running": NMAP_STATE["running"], "mode": NMAP_STATE["mode"], "devices": devices, "raw_output": NMAP_STATE.get("raw_output", ""),
                "hint": NMAP_STATE.get("hint", ""), "hostkey_changed": NMAP_STATE.get("hostkey_changed", False)}


# ============================================================================
# Редактор констант (constants.py) из веб-интерфейса
# ============================================================================
CONSTANTS_PATH = os.path.join(BASE_DIR, "constants.py")
# Читаются только при запуске сервера: новое значение сохраняется в файл,
# но начинает действовать после перезапуска web1x.py.
CONSTANTS_RESTART_REQUIRED = {"SERVER_HOST", "SERVER_PORT", "DEFAULT_PROJECTS_ROOT", "PUBLIC_DIR_NAME"}
CONSTANTS_LOCK = threading.Lock()

# Какие настройки показываются в окне «Константы» и как они подписаны.
# Остальные константы из constants.py в окне не показываются и через него не меняются.
# Формат пункта: (имя, подпись, пояснение, единица измерения, минимум, максимум).
CONSTANTS_EDITOR_SCHEMA = [
    ("Каталоги проекта", [
        ("DEFAULT_PROJECTS_ROOT", "Папка со всеми проектами", "Если задана переменная окружения ANSIBLE_PROJECTS_ROOT, используется она", None, None, None),
        ("PLAYBOOKS_DIR_NAME", "Папка плейбуков простого проекта", "Проект без объектов хранит плейбуки и inventory здесь", None, None, None),
        ("OBJECTS_DIR_NAME", "Папка объектов", "В проекте с объектами — папка, внутри которой лежат объекты", None, None, None),
        ("ROLES_DIR_NAME", "Папка ролей", "Папка с ролями Ansible внутри объекта", None, None, None),
        ("AUTODEPLOY_DIR_NAME", "Папка Autodeploy", "Папка проекта, где лежит плейбук Autodeploy", None, None, None),
        ("AUTODEPLOY_PLAYBOOK_NAME", "Плейбук Autodeploy", "Имя файла, который запускает кнопка Autodeploy", None, None, None),
    ]),
    ("Файлы инвентаря объекта", [
        ("HOSTS_FILE_CANDIDATES", "Имена файла с узлами", "Проверяются по порядку — берётся первый найденный; если нет ни одного, создаётся первый из списка", None, None, None),
        ("DEFAULTS_FILE_CANDIDATES", "Имена файла значений по умолчанию", "Проверяются по порядку, как и имена файла с узлами", None, None, None),
        ("ANSIBLE_CFG_FILE_NAME", "Файл настроек Ansible", "Имя файла настроек в папке объекта", None, None, None),
    ]),
    ("Сеть", [
        ("SERVER_HOST", "Адрес веб-интерфейса", "0.0.0.0 — доступен со всех сетевых интерфейсов сервера", None, None, None),
        ("SERVER_PORT", "Порт веб-интерфейса", "Порт, по которому открывается это приложение", None, 1, 65535),
    ]),
    ("Проверка доступности узлов", [
        ("PING_PACKET_COUNT", "Пакетов ping на проверку", "", "шт.", 1, 10),
        ("PING_TIMEOUT_SECONDS", "Ожидание ответа ping", "", "сек", 1, 30),
        ("STATUS_POLL_INTERVAL_SECONDS", "Период проверки узлов", "Как часто обновляется «доступен / недоступен»", "сек", 2, 3600),
        ("STATUS_THREAD_POOL_SIZE", "Узлов проверяется одновременно", "", "шт.", 1, 200),
    ]),
    ("Журнал выполнения плейбуков", [
        ("LOG_MAX_LINES", "Хранить строк журнала", "Более старые строки удаляются", "строк", 100, 100000),
    ]),
    ("Системные сервисы и ISO-образы", [
        ("ISO_DIR", "Папка ISO-образов", "Образы ищутся в этой папке и во всех вложенных", None, None, None),
        ("ISO_FILE_EXTENSION", "Расширение образов", "Например .iso", None, None, None),
        ("SYSTEM_STATUS_POLL_INTERVAL_SECONDS", "Период обновления DHCP / TFTP / ISO", "", "сек", 5, 3600),
    ]),
    ("HTTP-репозиторий", [
        ("REPO_URL", "Адрес репозитория", "Открывается кнопкой рядом с шестерёнкой. {host} заменяется адресом, по которому открыт этот веб-интерфейс", None, None, None),
    ]),
    ("Режим прослушки", [
        ("TCPDUMP_INTERFACE_FALLBACK", "Интерфейс TCPdump по умолчанию", "Если активный интерфейс определить не удалось", None, None, None),
        ("TCPDUMP_RAW_LINES_LIMIT", "Строк вывода TCPdump в окне", "", "строк", 10, 5000),
        ("SWITCH_SSH_USER", "Пользователь SSH коммутатора", "Подставляется, если в окне прослушки поле пустое", None, None, None),
        ("SWITCH_SSH_COMMAND", "Команда на коммутаторе", "Выводит таблицу MAC-адресов", None, None, None),
        ("SWITCH_SSH_TIMEOUT_SECONDS", "Ожидание ответа коммутатора", "", "сек", 1, 300),
        ("SWITCH_POLL_INTERVAL_SECONDS", "Период опроса коммутатора", "", "сек", 2, 3600),
    ]),
]
CONSTANTS_EDITOR_ITEMS = {item[0]: item for _, items in CONSTANTS_EDITOR_SCHEMA for item in items}

def read_constants_source():
    """Текст constants.py. utf-8-sig — на случай, если файл сохранили редактором, который добавляет
    невидимый маркер BOM в начало: Python такой файл запускает, а разбор для редактора без этого падал."""
    try:
        with open(CONSTANTS_PATH, encoding="utf-8-sig") as handle:
            return handle.read()
    except OSError as error:
        raise ValueError(f"Не удалось открыть constants.py: {error}") from None

def _constant_entries(source):
    """Присваивания верхнего уровня из constants.py: имя, текст значения и его позиция в файле, раздел, описание.

    Границы значения определяются модулем tokenize, а не атрибутами end_lineno/end_col_offset
    узлов ast — те появились только в Python 3.8, а на части серверов (например, Astra Linux 1.7)
    стоит Python 3.7. tokenize к тому же даёт позиции сразу в символах, а не в байтах UTF-8."""
    stream = io.StringIO(source)
    lines = stream.readlines()                       # те же границы строк, что видит tokenize
    line_starts = [0]
    for line in lines:
        line_starts.append(line_starts[-1] + len(line))
    sections, current = {}, ""
    for number, line in enumerate(lines, 1):
        match = re.match(r"\s*#\s*===\s*(.+?)\s*=*\s*$", line)
        if match:
            current = match.group(1).strip()
        sections[number] = current
    # какие строки начинают присваивание КОНСТАНТА = значение (ast — только чтобы знать, что это присваивание)
    targets = {node.lineno: node.targets[0].id for node in ast.parse(source).body
               if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name)
               and node.targets[0].id.isupper()}
    skip = (tokenize.COMMENT, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT, tokenize.ENDMARKER)
    entries, logical = [], []
    for token in tokenize.generate_tokens(io.StringIO(source).readline):
        if token.type == tokenize.NL and not any(item.type not in skip for item in logical):
            logical = []                             # пустая строка или строка из одного комментария
            continue
        logical.append(token)
        if token.type not in (tokenize.NEWLINE, tokenize.ENDMARKER):
            continue
        significant = [item for item in logical if item.type not in skip]
        comments = [item.string for item in logical if item.type == tokenize.COMMENT]
        logical = []
        if len(significant) < 3:
            continue
        first, row = significant[0], significant[0].start[0]
        if targets.get(row) != first.string or first.start[1] != 0 or significant[1].string != "=":
            continue
        value_start = line_starts[significant[2].start[0] - 1] + significant[2].start[1]
        value_end = line_starts[significant[-1].end[0] - 1] + significant[-1].end[1]
        description, index = [], row - 2
        while index >= 0 and lines[index].lstrip().startswith("#") and not re.match(r"\s*#\s*===", lines[index]):
            description.insert(0, lines[index].strip().lstrip("#").strip())
            index -= 1
        description += [comment.lstrip("#").strip() for comment in comments]
        entries.append({"name": first.string, "value": source[value_start:value_end], "start": value_start, "end": value_end,
                        "section": sections.get(row, ""), "description": " ".join(part for part in description if part)})
    return entries

def constants_update(changes):
    """Проверяет и записывает новые значения констант, затем применяет их к работающему серверу.

    Принимаются только литералы Python (строки, числа, списки, словари…) того же
    типа, что был; при любой ошибке файл не меняется. Перед записью делается
    резервная копия constants.py.bak. Возвращает (ошибки по именам, требуют перезапуска)."""
    if not isinstance(changes, dict) or not changes:
        raise ValueError("Нет изменений")
    with CONSTANTS_LOCK:
        source = read_constants_source()
        entries = {entry["name"]: entry for entry in _constant_entries(source)}
        errors, replacements = {}, []
        for name, text in changes.items():
            entry = entries.get(name)
            if not entry:
                errors[name] = "Нет такой константы"; continue
            try:
                old_value = ast.literal_eval(entry["value"])
            except (ValueError, SyntaxError, TypeError):
                errors[name] = "Значение вычисляется из других констант — правьте их"; continue
            try:
                new_value = ast.literal_eval(str(text).strip())
            except (ValueError, SyntaxError, TypeError, MemoryError, RecursionError):
                errors[name] = "Не литерал Python: строки — в кавычках, списки — в [ ], словари — в { }"; continue
            if type(new_value) is not type(old_value):
                errors[name] = f"Нужен тип «{type(old_value).__name__}», а получен «{type(new_value).__name__}»"; continue
            replacements.append((entry["start"], entry["end"], str(text).strip()))
        if errors:
            return errors, []
        new_source = source
        for start, end, text in sorted(replacements, reverse=True):
            new_source = new_source[:start] + text + new_source[end:]
        compile(new_source, CONSTANTS_PATH, "exec")  # на всякий случай: файл должен остаться валидным
        write(CONSTANTS_PATH + ".bak", source)
        write(CONSTANTS_PATH, new_source)
        import constants as constants_module
        importlib.reload(constants_module)
        module_globals = globals()
        for name in dir(constants_module):
            if name.isupper() and name in module_globals:
                module_globals[name] = getattr(constants_module, name)
    log("Изменены настройки: " + ", ".join(CONSTANTS_EDITOR_ITEMS[name][1] if name in CONSTANTS_EDITOR_ITEMS else name for name in changes))
    return {}, sorted(name for name in changes if name in CONSTANTS_RESTART_REQUIRED)

def constants_editor_list():
    """Настройки для окна «Константы»: только разрешённые, с подписями, единицами и обычными значениями
    (строка / число / список строк) — без синтаксиса Python."""
    with CONSTANTS_LOCK:
        source = read_constants_source()
    values = {}
    for entry in _constant_entries(source):
        try:
            values[entry["name"]] = ast.literal_eval(entry["value"])
        except (ValueError, SyntaxError, TypeError):
            pass
    sections = []
    for title, items in CONSTANTS_EDITOR_SCHEMA:
        rows = []
        for name, label, hint, unit, minimum, maximum in items:
            if name not in values:
                continue
            value = values[name]
            kind = "list" if isinstance(value, (list, tuple, set)) else "number" if isinstance(value, int) and not isinstance(value, bool) else "text"
            rows.append({"name": name, "label": label, "hint": hint, "unit": unit, "min": minimum, "max": maximum, "kind": kind,
                         "value": sorted(value) if isinstance(value, set) else list(value) if kind == "list" else value,
                         "restart_required": name in CONSTANTS_RESTART_REQUIRED})
        if rows:
            sections.append({"title": title, "items": rows})
    return {"sections": sections}

def _constant_literal(name, value, old):
    """Обычное значение из формы → текст для constants.py (кавычки и скобки расставляются здесь).
    Бросает ValueError с понятным сообщением, если значение не подходит."""
    _, _, _, _, minimum, maximum = CONSTANTS_EDITOR_ITEMS[name]
    if isinstance(old, (list, tuple, set)):
        if not isinstance(value, list):
            raise ValueError("Ожидается список значений")
        items = [str(item).strip() for item in value if str(item).strip()]
        if not items:
            raise ValueError("Нужно хотя бы одно значение")
        inner = ", ".join(json.dumps(item, ensure_ascii=False) for item in items)
        if isinstance(old, tuple):
            return f"({inner},)" if len(items) == 1 else f"({inner})"
        return f"{{{inner}}}" if isinstance(old, set) else f"[{inner}]"
    if isinstance(old, int) and not isinstance(old, bool):
        try:
            number = int(str(value).strip())
        except ValueError:
            raise ValueError("Нужно целое число") from None
        if (minimum is not None and number < minimum) or (maximum is not None and number > maximum):
            raise ValueError(f"Допустимо от {minimum} до {maximum}")
        return str(number)
    text = str(value).strip() if value is not None else ""
    if not text:
        raise ValueError("Поле не может быть пустым")
    if name == "REPO_URL" and not re.match(r"https?://", text):
        raise ValueError("Адрес должен начинаться с http:// или https://")
    return json.dumps(text, ensure_ascii=False)

def constants_editor_update(changes):
    """Сохраняет значения из окна «Константы». Возвращает (ошибки по именам, требуют перезапуска)."""
    if not isinstance(changes, dict) or not changes:
        raise ValueError("Нет изменений")
    with CONSTANTS_LOCK:
        source = read_constants_source()
    current = {}
    for entry in _constant_entries(source):
        try:
            current[entry["name"]] = ast.literal_eval(entry["value"])
        except (ValueError, SyntaxError, TypeError):
            pass
    errors, literals = {}, {}
    for name, value in changes.items():
        if name not in CONSTANTS_EDITOR_ITEMS or name not in current:
            errors[name] = "Эту настройку нельзя изменить здесь"
            continue
        try:
            literals[name] = _constant_literal(name, value, current[name])
        except ValueError as error:
            errors[name] = str(error)
    if errors:
        return errors, []
    return constants_update(literals)

# ============================================================================
# Карта сети: значки и расположение узлов
# ============================================================================
NETMAP_SELF_ID = "self:autodeploy"   # узел этой машины на карте
NETMAP_PING_CACHE = {}
NETMAP_PING_LOCK = threading.Lock()

def _netmap_self_ip():
    """IP этой машины на активном интерфейсе (тот же, что предлагается в окне «Прослушка»)."""
    info = list_network_interfaces()
    return next((item["ip"] for item in info["interfaces"] if item["name"] == info["default"]), "")

def _ping_target_ok(value):
    """Строка похожа на IP/имя хоста и не начинается с «-» — её безопасно передать ping."""
    return bool(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.:-]{0,252}", value or ""))

def _cached_ping(ip):
    """host_up() с кэшем на NETMAP_PING_CACHE_SECONDS — чтобы частые обновления карты не плодили пинги."""
    now = time.time()
    with NETMAP_PING_LOCK:
        hit = NETMAP_PING_CACHE.get(ip)
    if hit and now - hit[0] < NETMAP_PING_CACHE_SECONDS:
        return hit[1]
    result = host_up(ip)
    with NETMAP_PING_LOCK:
        NETMAP_PING_CACHE[ip] = (now, result)
    return result

def _netmap_path(project, obj):
    """Файл раскладки карты для проекта/объекта (в папке NETMAP_DIR_NAME рядом с web1x.py)."""
    return os.path.join(BASE_DIR, NETMAP_DIR_NAME, f"{safe(project)}__{safe(obj) or '_'}.json")

def _netmap_coord(value):
    """Координата узла на карте: целое число в разумных пределах (или None)."""
    try:
        return max(0, min(6000, int(float(value))))
    except (TypeError, ValueError):
        return None

def netmap_get(project, obj):
    """Узлы карты: хосты из hosts.yml (с сохранёнными значком и местом) + добавленные вручную (коммутаторы и т.п.)."""
    if project not in get_projects():
        raise ValueError("Проект не найден")
    try:
        saved = json.loads(read(_netmap_path(project, obj)) or "{}")
    except json.JSONDecodeError:
        saved = {}
    layout, custom = saved.get("nodes", {}) or {}, saved.get("custom", []) or []
    place = saved.get("self", {}) or {}
    # Эта машина (Autodeploy) есть на карте всегда; удалить её нельзя, только переместить и соединить
    nodes = [{"id": NETMAP_SELF_ID, "name": NETMAP_SELF_NAME, "ip": _netmap_self_ip(), "type": "autodeploy",
              "x": place.get("x"), "y": place.get("y"), "custom": False, "self": True, "hostname": socket.gethostname()}]
    for host in parse_hosts(project, obj):
        place = layout.get(host["hostname"], {})
        # МД — маршрутизатор, СИ — сервер, остальные — компьютер (значок можно сменить на карте)
        default_type = {"md": "router", "si": "server"}.get(host["node_type"], "pc")
        nodes.append({"id": f"host:{host['hostname']}", "name": host["hostname"], "ip": str(host["ip"] or ""),
                      "type": place.get("type") if place.get("type") in NETMAP_NODE_TYPES else default_type,
                      "x": place.get("x"), "y": place.get("y"), "custom": False})
    for item in custom:
        nodes.append({"id": item.get("id"), "name": item.get("name", ""), "ip": item.get("ip", ""), "mac": item.get("mac", ""),
                      "type": item.get("type") if item.get("type") in NETMAP_NODE_TYPES else "switch",
                      "x": item.get("x"), "y": item.get("y"), "custom": True})
    ids = {node["id"] for node in nodes}
    links = [{key: link[key] for key in ("a", "b", "vlan", "port") if link.get(key)} for link in saved.get("links", []) or []
             if isinstance(link, dict) and link.get("a") in ids and link.get("b") in ids and link.get("a") != link.get("b")]
    return {"nodes": nodes, "links": links, "types": list(NETMAP_NODE_TYPES)}

def netmap_save(project, obj, items, links=None):
    """Сохраняет значки и расположение узлов карты, добавленные вручную узлы и соединения между узлами."""
    if project not in get_projects():
        raise ValueError("Проект не найден")
    if not isinstance(items, list):
        raise ValueError("Неверные данные карты")
    nodes, custom, self_place = {}, [], {}
    known_hosts = {host["hostname"] for host in parse_hosts(project, obj)}
    for item in items[:1000]:
        if not isinstance(item, dict):
            continue
        node_type = item.get("type") if item.get("type") in NETMAP_NODE_TYPES else None
        x, y = _netmap_coord(item.get("x")), _netmap_coord(item.get("y"))
        item_id = str(item.get("id", ""))
        if item_id == NETMAP_SELF_ID:
            self_place = {"x": x, "y": y}
        elif item_id.startswith("host:") and item_id[5:] in known_hosts:
            nodes[item_id[5:]] = {"type": node_type, "x": x, "y": y}
        elif item_id.startswith("custom:") and re.fullmatch(r"custom:[A-Za-z0-9_-]{1,40}", item_id):
            mac = str(item.get("mac", "") or "").upper()
            custom.append({"id": item_id, "name": str(item.get("name", ""))[:60], "ip": str(item.get("ip", ""))[:45],
                           "type": node_type or "switch", "x": x, "y": y, **({"mac": mac} if re.fullmatch(_MAC_TOKEN, mac) else {})})
    # соединения: только между существующими узлами, без петель и повторов
    ids = {f"host:{name}" for name in nodes} | {item["id"] for item in custom} | {NETMAP_SELF_ID}
    clean_links, seen = [], set()
    for link in (links or [])[:3000]:
        if not isinstance(link, dict):
            continue
        a, b = str(link.get("a", "")), str(link.get("b", ""))
        pair = tuple(sorted((a, b)))
        if a == b or a not in ids or b not in ids or pair in seen:
            continue
        seen.add(pair)
        clean = {"a": pair[0], "b": pair[1]}
        vlan = str(link.get("vlan", "") or "").strip()
        if re.fullmatch(r"\d{1,4}(?:[,-]\d{1,4}){0,9}", vlan):
            clean["vlan"] = vlan
        port = str(link.get("port", "") or "").strip()
        if re.fullmatch(r"[A-Za-z0-9._:/+-]{1,32}", port):
            clean["port"] = port
        clean_links.append(clean)
    write(_netmap_path(project, obj), json.dumps({"self": self_place, "nodes": nodes, "custom": custom, "links": clean_links}, ensure_ascii=False, indent=2))

# --- Автопостроение карты по числу хопов -------------------------------------
NETMAP_AUTOBUILD = {}   # (проект, объект) → {"running", "result", "error"}
NETMAP_AUTOBUILD_LOCK = threading.Lock()

def _trace_command(ip):
    """Команда трассировки маршрута: traceroute, а если его нет — tracepath (обычно есть в iputils)."""
    if shutil.which("traceroute"):
        return "traceroute", ["traceroute", "-n", "-q", "1", "-w", "1", "-m", str(NETMAP_TRACE_MAX_HOPS), ip]
    if shutil.which("tracepath"):
        return "tracepath", ["tracepath", "-n", "-m", str(NETMAP_TRACE_MAX_HOPS), ip]
    return None, None

def _parse_trace(tool, output, target):
    """Вывод traceroute/tracepath → (промежуточные хопы до цели — IP или None для «нет ответа», дошли ли до цели)."""
    hops = {}
    pattern = r"\s*(\d+)\s+(\S+)" if tool == "traceroute" else r"\s*(\d+)\??:\s+(\S+)"
    for line in output.splitlines():
        match = re.match(pattern, line)
        if not match:
            continue
        number, token = int(match.group(1)), match.group(2)
        ip = token if re.fullmatch(r"\d{1,3}(?:\.\d{1,3}){3}", token) else None
        if number not in hops or (hops[number] is None and ip):
            hops[number] = ip
    ordered = [hops[number] for number in sorted(hops)]
    if target in ordered:
        return ordered[:ordered.index(target)], True
    return ordered, False

def _trace_node(item):
    """Трассировка до одного устройства карты: (id, {"hops": [...], "reached": bool})."""
    node_id, address = item
    try:
        ip = socket.gethostbyname(address)
    except OSError:
        return node_id, {"hops": [], "reached": False}
    tool, command = _trace_command(ip)
    try:
        output = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=NETMAP_TRACE_MAX_HOPS * 3 + 5).stdout
    except (OSError, subprocess.TimeoutExpired):
        return node_id, {"hops": [], "reached": False}
    hops, reached = _parse_trace(tool, output, ip)
    return node_id, {"hops": hops, "reached": reached}

def _netmap_autobuild_worker(key, project, obj, source="hosts"):
    """Фоновый поток автопостроения: трассирует маршруты (параллельно) либо до устройств карты с IP
    (source="hosts"), либо до устройств, найденных прослушкой, и до опрошенных коммутаторов
    (source="discovered")."""
    try:
        tool, _ = _trace_command("127.0.0.1")
        if not tool:
            raise ValueError("Для автопостроения на сервере нужен traceroute или tracepath (пакет traceroute или iputils-tracepath)")
        extra = {}
        if source == "discovered":
            devices, self_ports = discovered_devices()
            if not devices:
                raise ValueError("Прослушка ещё ничего не нашла: включите режим прослушки (TCPdump или таблица коммутатора), "
                                 "дайте ему поработать и повторите автопостроение")
            switches = sorted({item["switch"] for item in devices if item.get("switch")} | {item["switch"] for item in self_ports if item.get("switch")})
            targets = {f"disc:{item['mac']}": item["ip"] for item in devices if _ping_target_ok(item["ip"])}
            targets.update({f"switch:{ip}": ip for ip in switches if _ping_target_ok(ip)})
            extra = {"mode": "discovered", "devices": devices, "switches": switches, "self_ports": self_ports}
        else:
            targets = {node["id"]: node["ip"] for node in netmap_get(project, obj)["nodes"] if not node.get("self") and _ping_target_ok(node.get("ip"))}
        with concurrent.futures.ThreadPoolExecutor(max_workers=STATUS_THREAD_POOL_SIZE) as executor:
            paths = dict(executor.map(_trace_node, targets.items()))
        # VLAN: IP → MAC (ARP-таблица сервера свежая — трассировка только что прошла) → VLAN из таблицы коммутатора
        macs, switch_macs = _ip_to_mac(), _load_switch_macs()
        addresses = set(targets.values()) | {hop for path in paths.values() for hop in path["hops"] if hop}
        vlans = {ip: switch_macs[macs[ip]]["vlan"] for ip in addresses if macs.get(ip) in switch_macs and switch_macs[macs[ip]].get("vlan")}
        state = {"running": False, "result": {"paths": paths, "tool": tool, "vlans": vlans, **extra}, "error": None}
    except ValueError as error:
        state = {"running": False, "result": None, "error": str(error)}
    except Exception as error:   # фоновый поток не должен падать молча — ошибка уйдёт в интерфейс
        state = {"running": False, "result": None, "error": f"Ошибка автопостроения: {error}"}
    with NETMAP_AUTOBUILD_LOCK:
        NETMAP_AUTOBUILD[key] = state

def netmap_autobuild_start(project, obj, source="hosts"):
    """Запускает автопостроение в фоне (сервер однопоточный — долгая трассировка не должна его блокировать)."""
    if project not in get_projects():
        raise ValueError("Проект не найден")
    if source not in ("hosts", "discovered"):
        raise ValueError("Неизвестный источник устройств")
    key = (project, obj or "")
    with NETMAP_AUTOBUILD_LOCK:
        if NETMAP_AUTOBUILD.get(key, {}).get("running"):
            return
        NETMAP_AUTOBUILD[key] = {"running": True, "result": None, "error": None}
    threading.Thread(target=_netmap_autobuild_worker, args=(key, project, obj, source), daemon=True).start()

def netmap_autobuild_state(project, obj):
    """Ход автопостроения: идёт ли ещё, результат (маршруты) или ошибка."""
    with NETMAP_AUTOBUILD_LOCK:
        return dict(NETMAP_AUTOBUILD.get((project, obj or ""), {"running": False, "result": None, "error": None}))

def netmap_reset(project, obj):
    """Сбрасывает карту проекта/объекта: удаляет добавленные устройства, соединения и расположение.
    На карте остаются Autodeploy и узлы из hosts.yml — в исходной раскладке (они всегда берутся из hosts.yml)."""
    if project not in get_projects():
        raise ValueError("Проект не найден")
    try:
        os.remove(_netmap_path(project, obj))
    except FileNotFoundError:
        pass
    log(f"Карта сети сброшена: {project}{' / ' + obj if obj else ''}")

def netmap_status(project, obj):
    """Доступность устройств карты: {id: True/False/None}. None — нет IP или ещё не проверено.

    Узлы из hosts.yml — из фонового опроса (status_worker), эта машина — всегда True,
    добавленные вручную устройства с IP пингуются параллельно (с кэшем)."""
    host_status = status(project, obj)
    result, to_ping = {}, {}
    for node in netmap_get(project, obj)["nodes"]:
        if node.get("self"):
            result[node["id"]] = True
        elif not node["custom"]:
            result[node["id"]] = host_status.get(node["name"])
        elif _ping_target_ok(node.get("ip")):
            to_ping[node["id"]] = node["ip"]
        else:
            result[node["id"]] = None
    if to_ping:
        with concurrent.futures.ThreadPoolExecutor(max_workers=STATUS_THREAD_POOL_SIZE) as executor:
            for node_id, up in zip(to_ping, executor.map(_cached_ping, to_ping.values())):
                result[node_id] = up
    return {"status": result}

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
        code = process.wait()
        if code != 0: _mark_run_failed()
        log(f"=== DONE {title}: rc={code} ===")
    except OSError as error:
        _mark_run_failed()
        log(f"EXECUTION ERROR: {error}")
    finally:
        if process:
            with PROC_LOCK:
                if process in PROCESSES: PROCESSES.remove(process)

# --- Идёт ли выполнение (для строки состояния «Выполнение» в интерфейсе) ---
RUN_LOCK = threading.Lock()
RUN_STATE = {"active": 0, "failed": False}

def _run_in_background(function, *args):
    """Запускает плейбуки в фоне и отмечает выполнение активным сразу — до старта потока, чтобы
    интерфейс не принял только что запущенное выполнение за уже завершённое."""
    with RUN_LOCK:
        if RUN_STATE["active"] == 0:
            RUN_STATE["failed"] = False
        RUN_STATE["active"] += 1
    def target():
        try:
            function(*args)
        finally:
            with RUN_LOCK:
                RUN_STATE["active"] = max(0, RUN_STATE["active"] - 1)
    threading.Thread(target=target, daemon=True).start()

def _mark_run_failed():
    """Хотя бы один плейбук завершился с ошибкой (код возврата не 0) или не запустился."""
    with RUN_LOCK:
        RUN_STATE["failed"] = True

def _verbosity_flag(verbosity):
    """Флаг подробности вывода ansible-playbook (-v/-vv/-vvv) или None; всё остальное отбрасывается."""
    return verbosity if verbosity in ANSIBLE_VERBOSITY_FLAGS else None

def role_entries_text(text):
    """Роли из блоков roles: всех плеев — по порядку, без повторов (только их можно выбрать для запуска)."""
    try:
        document = yaml.load(text, Loader=_TolerantLoader)
    except yaml.YAMLError:
        return []
    result = []
    for play in document if isinstance(document, list) else []:
        if isinstance(play, dict) and isinstance(play.get("roles"), list):
            for item in play["roles"]:
                ref = _role_ref(item if isinstance(item, str) else (item.get("role") or item.get("name")) if isinstance(item, dict) else None)
                if ref and ref not in result:
                    result.append(ref)
    return result

def playbook_role_entries(path):
    return role_entries_text(read(path))

def _partial_playbook(path, selected):
    """Временная копия плейбука только с выбранными ролями — рядом с ним (относительные пути и roles/
    работают так же). Невыбранные роли убираются правкой текста: hosts, vars, !vault и прочее не меняются."""
    text = read(path)
    entries = role_entries_text(text)
    keep = [role for role in entries if role in set(selected)]
    if not keep:
        raise ValueError("ни одна из выбранных ролей не найдена в плейбуке")
    for role in entries:
        if role not in keep:
            text = _remove_role_text(text, role)
    if role_entries_text(text) != keep:
        raise ValueError("не удалось оставить в плейбуке только выбранные роли")
    stem = os.path.splitext(os.path.basename(path))[0]
    temp = os.path.join(os.path.dirname(path), f".awc-{stem}-{os.getpid()}-{int(time.time() * 1000) % 100000}.yml")
    write(temp, text)
    return temp, keep

def run_command(project, obj, names, hosts, verbosity="", check=False, roles=None):
    """Запускает выбранные плейбуки по очереди через ansible-playbook (опционально только на указанных узлах).
    roles — {плейбук: [роли]}: у такого плейбука выполняются только эти роли (через временную копию)."""
    file_paths = paths(project, obj)
    available = {item["name"]: item["path"] for item in get_playbooks(project, obj)}
    if not file_paths: return
    for name in names:
        if name not in available:
            continue
        target, title, temp = available[name], name, None
        selected = (roles or {}).get(name) if isinstance(roles, dict) else None
        if selected:
            try:
                temp, kept = _partial_playbook(available[name], selected)
            except ValueError as error:
                _mark_run_failed()
                log(f"=== {name}: {error} ===")
                continue
            target, title = temp, f"{name} (только роли: {', '.join(kept)})"
        command = ["ansible-playbook", "-i", file_paths["hosts"], target]
        if hosts: command += ["-l", ",".join(hosts)]
        if _verbosity_flag(verbosity): command.append(_verbosity_flag(verbosity))
        # Режим «Проверка»: ansible-playbook --check ничего не меняет на узлах, только показывает, что было бы изменено.
        if check: command.append("--check")
        try:
            run_playbook(command, project, obj, name, os.path.dirname(available[name]), file_paths["cfg"], f"{title} [--check]" if check else (title if temp else None))
        finally:
            if temp:
                try:
                    os.remove(temp)
                except OSError:
                    pass

# --- Переименование роли: папка и все ссылки на неё ---
def _rename_role_text(text, old, new):
    """Меняет ссылку на роль old → new только там, где это ссылка на роль: элементы блоков roles: и
    dependencies: (строкой, role:/name:, {role: …}), списки [..] и name: внутри include_role/import_role.
    Названия задач («- name: …» в tasks) не трогаются."""
    escaped = re.escape(old)
    item_re = re.compile(r"^(\s*-\s*(?:\{\s*)?(?:(?:role|name)\s*:\s*)?)(['\"]?)" + escaped + r"\2(?=\s*(?:[,}#]|$))")
    name_re = re.compile(r"^(\s*name:\s*)(['\"]?)" + escaped + r"\2(\s*(?:#.*)?)$")
    out, block_indent, include_indent = [], None, None
    for line in text.split("\n"):
        stripped = line.strip()
        indent = len(line) - len(line.lstrip())
        if stripped and not stripped.startswith("#"):
            if block_indent is not None and (indent < block_indent or (indent == block_indent and not stripped.startswith("-"))):
                block_indent = None
            if include_indent is not None and indent <= include_indent:
                include_indent = None
        flow = re.match(r"^(\s*-?\s*(?:roles|dependencies):\s*\[)(.*)(\].*)$", line)
        if flow:
            items = [re.sub(r"^(\s*['\"]?)" + escaped + r"(['\"]?\s*)$", lambda m: m.group(1) + new + m.group(2), item) for item in flow.group(2).split(",")]
            line = flow.group(1) + ",".join(items) + flow.group(3)
        elif re.match(r"^\s*-?\s*(?:roles|dependencies):\s*(?:#.*)?$", line):
            block_indent = indent
        elif block_indent is not None:
            line = item_re.sub(lambda m: m.group(1) + m.group(2) + new + m.group(2), line)
        if re.match(r"^\s*-?\s*(?:ansible\.builtin\.)?(?:include|import)_role:\s*(?:#.*)?$", line):
            include_indent = indent
        elif include_indent is not None:
            line = name_re.sub(lambda m: m.group(1) + m.group(2) + new + m.group(2) + m.group(3), line)
        out.append(line)
    return "\n".join(out)

def rename_role(project, obj, old, new, scope=None):
    """Переименовывает роль: папку и ссылки во всех плейбуках области, в зависимостях (meta) других ролей
    и в tests/test.yml самой роли. Возвращает список изменённых файлов."""
    old_ref, new_ref = _role_ref(old), _role_ref(new)
    if not old_ref or not new_ref:
        raise ValueError("Имя роли: латинские буквы, цифры, точка, дефис и подчёркивание (подроль — через «/»)")
    if old_ref == new_ref:
        raise ValueError("Новое имя совпадает со старым")
    old_dir = find_role_dir(project, obj, old_ref, scope)
    if not old_dir:
        raise ValueError(f"Папка роли «{old_ref}» не найдена")
    if find_role_dir(project, obj, new_ref, scope):
        raise ValueError(f"Роль «{new_ref}» уже есть")
    base = old_dir
    for _ in old_ref.split("/"):
        base = os.path.dirname(base)
    new_dir = os.path.join(base, *new_ref.split("/"))
    if not _inside(base, new_dir) or os.path.exists(new_dir):
        raise ValueError(f"Папка «{new_ref}» уже существует")
    os.makedirs(os.path.dirname(new_dir), exist_ok=True)
    os.rename(old_dir, new_dir)
    files = [autodeploy(project)] if scope == AUTODEPLOY_SCOPE else [item["path"] for item in get_playbooks(project, obj)]
    for root in role_search_paths(project, obj, scope):
        for directory, dirs, names in os.walk(root):
            dirs[:] = [d for d in dirs if not d.startswith(".") and d not in ("files", "templates", "library")]
            if os.path.basename(directory) in ("meta", "tests"):
                files += [os.path.join(directory, name) for name in names if name.lower().endswith((".yml", ".yaml"))]
    changed = []
    leaf_old, leaf_new = old_ref.split("/")[-1], new_ref.split("/")[-1]
    for path in dict.fromkeys(filter(None, files)):
        text = read(path)
        new_text = _rename_role_text(text, old_ref, new_ref)
        if os.path.dirname(os.path.dirname(path)) == new_dir and os.path.basename(os.path.dirname(path)) == "meta":
            new_text = re.sub(r"(?m)^(\s*role_name:\s*)" + re.escape(leaf_old) + r"\s*$", lambda m: m.group(1) + leaf_new, new_text)
        if new_text != text:
            relative = os.path.relpath(path, scope_dir(project, obj, scope) or os.path.dirname(path))
            _backup_file(project, scope_key(obj, scope), "rename", relative, text)
            write(path, new_text)
            changed.append(relative)
    log(f"Роль {old_ref} переименована в {new_ref}; ссылки изменены в: {', '.join(changed) or 'нигде'}")
    return changed

def run_autodeploy(project, obj, hosts, verbosity=""):
    """Запускает autodeploy.yml на отмеченных узлах — с inventory и ansible.cfg текущего проекта/объекта
    (раньше в проекте с объектами inventory не передавался, и узлы не находились)."""
    path = autodeploy(project)
    if not path: return
    file_paths = paths(project, obj)
    command = ["ansible-playbook"] + (["-i", file_paths["hosts"]] if file_paths else []) + [path]
    if hosts: command += ["-l", ",".join(hosts)]
    if _verbosity_flag(verbosity): command.append(_verbosity_flag(verbosity))
    run_playbook(command, project, obj, AUTODEPLOY_PLAYBOOK_NAME, os.path.dirname(path), file_paths["cfg"] if file_paths else "")

def stop():
    """Останавливает все запущенные подпроцессы ansible."""
    with PROC_LOCK:
        for process in PROCESSES:
            try: process.terminate()
            except OSError: pass
        PROCESSES.clear()
    log("=== EXECUTION STOPPED ===")

# --- Статические файлы: кэш в памяти (сбрасывается, когда файл на диске меняется) ---
STATIC_CACHE = {}
STATIC_CACHE_LOCK = threading.Lock()

def _static_entry(path):
    """Файл, его gzip-версия (для текстовых) и ETag; перечитывается только при изменении файла."""
    try:
        stat = os.stat(path)
    except OSError:
        return None
    key = (stat.st_mtime_ns, stat.st_size)
    with STATIC_CACHE_LOCK:
        entry = STATIC_CACHE.get(path)
        if entry and entry["key"] == key:
            return entry
    with open(path, "rb") as handle:
        body = handle.read()
    compressible = path.lower().endswith((".html", ".js", ".css", ".svg", ".json"))
    entry = {"key": key, "body": body, "etag": '"' + hashlib.md5(body).hexdigest() + '"',
             "gzip": gzip.compress(body, compresslevel=6) if compressible and len(body) > 1024 else None}
    with STATIC_CACHE_LOCK:
        STATIC_CACHE[path] = entry
    return entry

class Handler(BaseHTTPRequestHandler):
    def json(self, data, code=200):
        """Отправляет клиенту JSON-ответ с нужным HTTP-статусом."""
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json; charset=utf-8"); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)

    def file(self, path, content_type):
        """Отдаёт статический файл. Браузер каждый раз сверяет версию (no-cache + ETag): если файл не
        менялся — ответ 304 без тела; текст (HTML/JS/CSS) сжимается gzip, если браузер это умеет."""
        entry = _static_entry(path)
        if entry is None: self.send_error(404); return
        if self.headers.get("If-None-Match") == entry["etag"]:
            self.send_response(304); self.send_header("ETag", entry["etag"]); self.send_header("Cache-Control", "no-cache"); self.end_headers(); return
        use_gzip = entry["gzip"] is not None and "gzip" in (self.headers.get("Accept-Encoding") or "")
        body = entry["gzip"] if use_gzip else entry["body"]
        self.send_response(200); self.send_header("Content-Type", content_type); self.send_header("Cache-Control", "no-cache"); self.send_header("ETag", entry["etag"])
        if use_gzip: self.send_header("Content-Encoding", "gzip")
        if entry["gzip"] is not None: self.send_header("Vary", "Accept-Encoding")
        self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)

    def do_GET(self):
        """Обрабатывает GET; при любой ошибке отвечает JSON с её текстом, а не обрывает соединение."""
        try:
            self._handle_get()
        except Exception as error:
            log(f"Ошибка при обработке запроса {urlparse(self.path).path}: {error}")
            try:
                self.json({"ok": False, "error": f"Ошибка сервера: {error}"}, 500)
            except OSError:
                pass

    def _handle_get(self):
        """Статические файлы и JSON-эндпоинты данных/статусов."""
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
        if url.path == "/logo_mark": self.file(os.path.join(BASE_DIR, LOGO_MARK_IMAGE_NAME), "image/png"); return
        if url.path == "/data":
            projects = get_projects()
            if not project and projects:
                project = projects[0]
            objects = get_objects(project)
            single_object_mode = single_project(project)
            # Объект из адреса может быть от другого проекта (старая ссылка/закладка) —
            # тогда берём первый объект этого проекта, а не пустой несуществующий.
            if not single_object_mode and objects and obj not in objects:
                obj = objects[0]
            # Один раз читаем и парсим hosts.yml, вместо того чтобы делать это
            # отдельно для узлов и отдельно для групп — раньше оба вызова
            # независимо перечитывали один и тот же файл.
            inventory = load_inventory(project, obj)
            hosts = parse_hosts(project, obj, inventory)
            auto = autodeploy(project)
            self.json({"projects": projects, "objects": objects, "single_object_mode": single_object_mode, "selected_project": project, "selected_object": obj, "hosts": hosts, "status": status(project, obj), "groups": inventory_groups(project, obj, inventory), "template_schemas": template_schemas(project, obj, hosts), "playbooks": [dict(item, roles=playbook_role_entries(item["path"])) for item in get_playbooks(project, obj)], "autodeploy": bool(auto), "autodeploy_playbook": AUTODEPLOY_PLAYBOOK_NAME if auto else None, "hwtype_options": hwtype_options(project, obj), "repo_url": REPO_URL, "version": APP_VERSION}); return
        if url.path == "/roles":
            playbook = query.get("playbook", [""])[0]; self.json(playbook_roles(project, obj, playbook) if playbook else []); return
        if url.path == "/role_file":
            path = role_file(project, obj, query.get("path", [""])[0], scope_of(query.get("scope", [""])[0]))
            if not path: self.send_error(404); return
            self.json({"path": query.get("path", [""])[0], "content": read(path), "name": os.path.basename(path)}); return
        if url.path == "/status": self.json(status(project, obj)); return
        if url.path == "/system_status": self.json(system_status()); return
        if url.path == "/nmap_status": self.json(nmap_status()); return
        if url.path == "/nmap_interfaces": self.json(list_network_interfaces()); return
        if url.path == "/constants": self.json(constants_editor_list()); return
        if url.path == "/netmap_autobuild": self.json(netmap_autobuild_state(project, obj)); return
        if url.path == "/discovered_summary": self.json(discovered_summary()); return
        if url.path == "/roles_list": self.json({"roles": list_roles(project, obj, scope_of(query.get("scope", [""])[0]))}); return
        if url.path == "/autodeploy_sources": self.json({"sources": autodeploy_sources()}); return
        if url.path == "/subnet_scan": self.json(subnet_scan_get(project)); return
        if url.path == "/roles_tree": self.json({"roles": roles_tree(project, obj, scope_of(query.get("scope", [""])[0]))}); return
        if url.path == "/playbook_files":
            try: self.json(playbook_files(project, obj, query.get("name", [""])[0], scope_of(query.get("scope", [""])[0])))
            except ValueError as error: self.json({"ok": False, "error": str(error)}, 404)
            return
        if url.path == "/ansible_catalog": self.json(ansible_catalog_get()); return
        if url.path == "/ansible_module": self.json(ansible_module_doc(query.get("name", [""])[0])); return
        if url.path == "/ansible_context":
            self.json(ansible_context(project, obj, query.get("kind", [""])[0], query.get("path", [""])[0], scope_of(query.get("scope", [""])[0]))); return
        if url.path == "/netmap_status":
            try: self.json(netmap_status(project, obj))
            except ValueError as error: self.json({"ok": False, "error": str(error)}, 400)
            return
        if url.path == "/netmap":
            try: self.json(netmap_get(project, obj))
            except ValueError as error: self.json({"ok": False, "error": str(error)}, 400)
            return
        if url.path == "/log_new":
            try: start = int(query.get("start", ["0"])[0])
            except ValueError: start = 0
            with LOG_LOCK:
                local_start = max(0, start - LOG_OFFSET)
                lines = LOG[local_start:]
                next_index = LOG_OFFSET + len(LOG)
            with RUN_LOCK:
                running, failed = RUN_STATE["active"] > 0, RUN_STATE["failed"]
            self.json({"lines": lines, "next": next_index, "running": running, "failed": failed}); return
        if url.path == "/playbook":
            name = safe(query.get("name", [""])[0]); path = playbook_path(project, obj, name, scope_of(query.get("scope", [""])[0]))
            if not path: self.send_error(404); return
            self.json({"name": name, "content": read(path)}); return
        self.send_error(404)

    def do_POST(self):
        """Обрабатывает POST: действия над узлами, группами, плейбуками, запуском и прослушкой."""
        try:
            body = self.rfile.read(int(self.headers.get("Content-Length", 0))); data = json.loads(body.decode() or "{}")
        except Exception: data = {}
        project = data.get("project", ""); obj = data.get("object", "")
        try:
            if self.path == "/run":
                _run_in_background(run_command, project, obj, data.get("playbooks", []), data.get("hosts", []), data.get("verbosity", ""), data.get("check") is True,
                                   data.get("roles") if isinstance(data.get("roles"), dict) else None); self.json({"ok": True}); return
            if self.path == "/run_autodeploy":
                _run_in_background(run_autodeploy, project, obj, data.get("hosts", []), data.get("verbosity", "")); self.json({"ok": True}); return
            if self.path == "/stop": stop(); self.json({"ok": True}); return
            if self.path == "/nmap_start":
                nmap_start(data.get("mode", ""), data.get("switch_address", ""), data.get("interface", ""), data.get("switch_user", ""), data.get("switch_password", ""))
                self.json({"ok": True}); return
            if self.path == "/nmap_stop": nmap_stop(); self.json({"ok": True}); return
            if self.path == "/nmap_switch_hostkey": self.json(switch_hostkey_status(data.get("switch_address", ""))); return
            if self.path == "/nmap_switch_trust": switch_hostkey_trust(data.get("switch_address", "")); self.json({"ok": True}); return
            if self.path == "/nmap_switch_forget": switch_hostkey_forget(data.get("switch_address", "")); self.json({"ok": True}); return
            if self.path == "/constants":
                errors, restart = constants_editor_update(data.get("changes", {}))
                if errors:
                    self.json({"ok": False, "error": "Есть ошибки в значениях", "errors": errors}, 400); return
                self.json({"ok": True, "restart_required": restart}); return
            if self.path == "/netmap_autobuild": netmap_autobuild_start(project, obj, data.get("source", "hosts")); self.json({"ok": True}); return
            if self.path == "/discovered_clear": discovered_clear(); self.json({"ok": True}); return
            if self.path == "/netmap_reset": netmap_reset(project, obj); self.json({"ok": True}); return
            if self.path == "/netmap":
                netmap_save(project, obj, data.get("items", []), data.get("links", [])); self.json({"ok": True}); return
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
                problem = save_text_file(project, obj, "playbook", data.get("name", ""), data.get("content", ""), data.get("force") is True, scope_of(data.get("scope")))
                self.json({"ok": False, "yaml_error": problem} if problem else {"ok": True}); return
            if self.path == "/role_file_save":
                problem = save_text_file(project, obj, "role", data.get("path", ""), data.get("content", ""), data.get("force") is True, scope_of(data.get("scope")))
                self.json({"ok": False, "yaml_error": problem} if problem else {"ok": True}); return
            if self.path == "/role_file_create":
                self.json({"ok": True, "path": create_role_file(project, obj, data.get("folder", ""), data.get("name", ""), scope_of(data.get("scope")))}); return
            if self.path == "/project_create":
                created = create_project(data.get("name", ""), data.get("kind", ""), data.get("objects", []), data.get("roles", []),
                                         data.get("site_playbook") is not False, data.get("role_playbooks") is True, data.get("autodeploy") is True, data.get("autodeploy_source"))
                self.json({"ok": True, "files": created}); return
            if self.path == "/role_create": add_role(project, obj, data.get("role", ""), scope_of(data.get("scope"))); self.json({"ok": True}); return
            if self.path == "/playbook_delete": delete_playbook(project, obj, data.get("name", ""), scope_of(data.get("scope"))); self.json({"ok": True}); return
            if self.path == "/playbook_role_add": self.json({"ok": True, "created": playbook_role_add(project, obj, data.get("playbook", ""), data.get("role", ""), scope_of(data.get("scope")))}); return
            if self.path == "/subnet_scan_start": subnet_scan_start(project, data.get("subnet", ""), data.get("mask", "")); self.json({"ok": True}); return
            if self.path == "/subnet_scan_reset": subnet_scan_reset(project); self.json({"ok": True}); return
            if self.path == "/role_rename":
                self.json({"ok": True, "changed": rename_role(project, obj, data.get("old", ""), data.get("new", ""), scope_of(data.get("scope")))}); return
            if self.path == "/playbook_roles_add":
                self.json({"ok": True, **playbook_roles_add(project, obj, data.get("playbook", ""), data.get("roles", []), scope_of(data.get("scope")),
                                                            data.get("parts") if isinstance(data.get("parts"), list) else None)}); return
            if self.path == "/playbook_role_remove":
                playbook_role_remove(project, obj, data.get("playbook", ""), data.get("role", ""), data.get("delete_files") is True, scope_of(data.get("scope"))); self.json({"ok": True}); return
            if self.path == "/role_file_delete": delete_role_file(project, obj, data.get("path", ""), scope_of(data.get("scope"))); self.json({"ok": True}); return
            if self.path == "/object_file_open": self.json(object_file_open(project, obj, data.get("kind", ""))); return
            if self.path == "/object_file_save":
                if data.get("kind") not in OBJECT_FILE_KINDS: raise ValueError("Неизвестный файл")
                problem = save_text_file(project, obj, data.get("kind"), data.get("kind"), data.get("content", ""), data.get("force") is True)
                self.json({"ok": False, "yaml_error": problem} if problem else {"ok": True}); return
            if self.path == "/playbook_create":
                self.json({"ok": True, "name": add_playbook(project, obj, data.get("name", ""), data.get("roles", []), data.get("hosts", "all") or "all", data.get("become") is not False, data.get("new_roles", []))}); return
            if self.path == "/delete_hosts":
                names = data.get("hostnames", [])
                if not isinstance(names, list):
                    names = [names] if names else []
                delete_hosts(project, obj, names)
                self.json({"ok": True}); return
        except ValueError as error:      # неверные данные запроса: имя, путь, значение — ошибка клиента
            self.json({"ok": False, "error": str(error)}, 400); return
        except OSError as error:         # сбой файловой системы на сервере
            self.json({"ok": False, "error": str(error)}, 500); return
        except Exception as error:       # непредвиденное — понятный ответ и запись в журнал, а не обрыв соединения
            log(f"Ошибка при обработке запроса {self.path}: {error}")
            self.json({"ok": False, "error": f"Ошибка сервера: {error}"}, 500); return
        self.send_error(404)

if __name__ == "__main__":
    threading.Thread(target=status_worker, daemon=True).start()
    threading.Thread(target=system_status_worker, daemon=True).start()
    HTTPServer((SERVER_HOST, SERVER_PORT), Handler).serve_forever()
