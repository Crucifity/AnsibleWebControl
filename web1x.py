#!/usr/bin/env python3

import concurrent.futures
import json
import os
import re
import socket
import subprocess
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

import yaml

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.join(BASE_DIR, "public")
PROJECTS_ROOT = os.environ.get("ANSIBLE_PROJECTS_ROOT", "/opt/home/projects")

LOG = []
LOG_LOCK = threading.Lock()
PROCESSES = []
PROC_LOCK = threading.Lock()
HOST_STATUS = {}
STATUS_LOCK = threading.Lock()

TEMPLATES = {
    14: "Хост шаблон-1",
    13: "Хост шаблон-2",
    11: "МД шаблон-1",
    5: "МД шаблон-2",
    7: "СИ шаблон-1",
}

def safe(value):
    return os.path.basename(value or "")

def project_dir(project):
    return os.path.join(PROJECTS_ROOT, safe(project)) if project else None

def single_project(project):
    return bool(project and os.path.isdir(os.path.join(project_dir(project), "playbooks")))

def get_projects():
    if not os.path.isdir(PROJECTS_ROOT):
        return []
    return sorted(name for name in os.listdir(PROJECTS_ROOT) if os.path.isdir(project_dir(name)))

def get_objects(project):
    if single_project(project):
        return []
    directory = os.path.join(project_dir(project) or "", "object")
    if not os.path.isdir(directory):
        return []
    return sorted(name for name in os.listdir(directory) if os.path.isdir(os.path.join(directory, name)))

def object_dir(project, obj):
    if single_project(project):
        return os.path.join(project_dir(project), "playbooks")
    if not project or not obj or obj not in get_objects(project):
        return None
    return os.path.join(project_dir(project), "object", safe(obj))

def read(path):
    try:
        with open(path, encoding="utf-8") as file:
            return file.read()
    except OSError:
        return ""

def write(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as file:
        file.write(content)

def paths(project, obj):
    directory = object_dir(project, obj)
    if not directory:
        return None
    def first(names):
        for name in names:
            path = os.path.join(directory, name)
            if os.path.isfile(path):
                return path
        return os.path.join(directory, names[0])
    return {
        "object_dir": directory,
        "hosts": first(["hosts.yml", "hosts.yaml", "hosts", "inventory.yml"]),
        "defaults": first(["defaults.yml", "defaults.yaml", "defaults"]),
        "cfg": os.path.join(directory, "ansible.cfg"),
    }

def roles_dir(project, obj):
    directory = object_dir(project, obj)
    return os.path.join(directory, "roles") if directory else None

def log(message):
    with LOG_LOCK:
        LOG.append(f"[{datetime.now():%H:%M:%S}] {message}")
        del LOG[:-1000]

def load_inventory(project, obj):
    file_paths = paths(project, obj)
    if not file_paths or not os.path.exists(file_paths["hosts"]):
        return {}
    try:
        return yaml.safe_load(read(file_paths["hosts"])) or {}
    except yaml.YAMLError as error:
        log(f"HOSTS YAML ERROR: {error}")
        return {}

def load_hosts(project, obj):
    return load_inventory(project, obj).get("all", {}).get("hosts", {}) or {}

def classify_node(params):
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

def parse_hosts(project, obj):
    result = []
    for name, raw in load_hosts(project, obj).items():
        params = dict(raw) if isinstance(raw, dict) else {}
        node_type, template = classify_node(params)
        result.append({"hostname": name, "parameters": params, "node_type": node_type, "template": template, "ip": params.get("ansible_host", params.get("ip", ""))})
    return result

def template_schemas(project, obj):
    schemas = {}
    for node in parse_hosts(project, obj):
        template = node["template"]
        if template not in ("Хост", "МД", "Узел") and template not in schemas:
            schemas[template] = list(node["parameters"])
    return schemas

def inventory_groups(project, obj):
    """Собирает все группы из инвентаря динамически (без жёстко заданных имён)."""
    data = load_inventory(project, obj)
    if not isinstance(data, dict):
        return []
    
    groups = {}
    
    def collect(value):
        found = set()
        if isinstance(value, dict):
            hosts = value.get("hosts", {})
            if isinstance(hosts, dict):
                found.update(hosts.keys())
            for child in (value.get("children", {}) or {}).values():
                found.update(collect(child))
        return found

    # Собираем все группы верхнего уровня (кроме "all")
    for name, value in data.items():
        if name != "all" and isinstance(value, dict) and ("hosts" in value or "children" in value):
            groups[name] = sorted(collect(value))

    # Также проверяем вложенные группы внутри all
    all_group = data.get("all", {})
    if isinstance(all_group, dict):
        for name, value in (all_group.get("children", {}) or {}).items():
            if isinstance(value, dict) and ("hosts" in value or "children" in value):
                groups[name] = sorted(collect(value))

    return [{"name": name, "hosts": hosts} for name, hosts in groups.items()]

def save_hosts(path, data):
    write(path, yaml.safe_dump(data, allow_unicode=True, sort_keys=False, default_flow_style=False))

def scalar(value):
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
    """Находит секцию hosts: с любым отступом и возвращает (hosts_index, end_index, indent)."""
    match_info = next(((index, len(line) - len(line.lstrip(" "))) 
                       for index, line in enumerate(lines) 
                       if re.match(r"^ *hosts:\s*(?:#.*)?$", line)), None)
    
    if match_info is None:
        return None, None, None
        
    hosts_index, indent = match_info
    end_index = len(lines)
    
    for index in range(hosts_index + 1, len(lines)):
        stripped = lines[index].rstrip("\r\n")
        if not stripped:
            continue
        current_indent = len(stripped) - len(stripped.lstrip(" "))
        # Секция заканчивается, если встретили строку с отступом <= отступа hosts:
        if current_indent <= indent:
            end_index = index
            break
            
    return hosts_index, end_index, indent

def _host_entry_indexes(lines, hosts_index, end_index, indent):
    """Находит индексы строк с определениями хостов (отступ = indent + 2)."""
    entry_indent = indent + 2
    return [index for index in range(hosts_index + 1, end_index) 
            if re.match(rf"^ {{{entry_indent}}}\S.*?:\s*(?:#.*)?(?:\r?\n)?$", lines[index])]

def _host_name_from_line(line, indent):
    """Извлекает имя хоста из строки с заданным отступом."""
    match = re.match(rf"^ {{{indent}}}(\S.*?):\s*(?:#.*)?(?:\r?\n)?$", line)
    return match.group(1) if match else None

def _host_yaml_block(name, values, newline, indent):
    """Формирует YAML-блок для хоста с правильным отступом."""
    block = yaml.safe_dump({name: values}, allow_unicode=True, sort_keys=False, default_flow_style=False)
    if newline != "\n":
        block = block.replace("\n", newline)
    return "".join(f"{' ' * indent}{line}" if line.strip() else line for line in block.splitlines(keepends=True))

def _group_hosts_bounds(lines, group_name):
    escaped = re.escape(group_name)
    for group_index, line in enumerate(lines):
        match = re.match(r"^( {0,2})" + escaped + r":\s*(?:#.*)?(?:\r?\n)?$", line)
        if not match:
            continue
        group_indent = len(match.group(1))
        for index in range(group_index + 1, len(lines)):
            stripped = lines[index].rstrip("\r\n")
            indent = len(stripped) - len(stripped.lstrip(" ")) if stripped else group_indent + 1
            if stripped and indent <= group_indent:
                break
            if indent == group_indent + 2 and stripped.strip() == "hosts:":
                hosts_index = index
                end_index = len(lines)
                for end in range(index + 1, len(lines)):
                    value = lines[end].rstrip("\r\n")
                    if value.strip():
                        value_indent = len(value) - len(value.lstrip(" "))
                        if value_indent <= group_indent:
                            end_index = end
                            break
                return hosts_index, end_index, indent
    return None, None, None

def _group_entry_indexes(lines, hosts_index, end_index, hosts_indent):
    entry_indent = hosts_indent + 2
    return [index for index in range(hosts_index + 1, end_index) if re.match(rf"^ {{{entry_indent}}}\S.*?:\s*(?:#.*)?(?:\r?\n)?$", lines[index])]

def _insert_host_into_group(path, group_name, name):
    if not group_name:
        return
    raw = read(path)
    lines = raw.splitlines(keepends=True)
    hosts_index, end_index, hosts_indent = _group_hosts_bounds(lines, group_name)
    if hosts_index is None:
        raise ValueError(f"Группа не найдена: {group_name}")

    newline = "\r\n" if "\r\n" in raw else "\n"
    entry_indexes = _group_entry_indexes(lines, hosts_index, end_index, hosts_indent)
    entry_indent = hosts_indent + 2
    host_line = f"{' ' * entry_indent}{name}:{newline}"

    if entry_indexes:
        insert_at = end_index
        while insert_at > hosts_index + 1 and not lines[insert_at - 1].strip():
            del lines[insert_at - 1]
            insert_at -= 1
        if insert_at > hosts_index + 1 and lines[insert_at - 1].strip():
            host_line = newline + host_line
    else:
        insert_at = hosts_index + 1
        while insert_at < end_index and not lines[insert_at].strip():
            insert_at += 1

    lines.insert(insert_at, host_line)
    write(path, "".join(lines))

def _remove_host_from_group(path, group_name, name):
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
    del lines[target:next_index]
    write(path, "".join(lines))

def add_host(project, obj, name, values, group=""):
    file_paths = paths(project, obj)
    if not file_paths:
        raise ValueError("Объект не найден")
    data = load_inventory(project, obj)
    hosts = data.setdefault("all", {}).setdefault("hosts", {})
    if not name:
        raise ValueError("Имя узла не указано")
    if name in hosts:
        raise ValueError("Узел уже существует")
    if group and group not in {item["name"] for item in inventory_groups(project, obj)}:
        raise ValueError(f"Группа не найдена: {group}")

    normalized_values = {key: scalar(value) for key, value in values.items()}
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
            prefix = newline if lines[insert_at - 1].strip() else ""
        else:
            insert_at = hosts_index + 1
            while insert_at < end_index and not lines[insert_at].strip():
                insert_at += 1
            prefix = ""
        block = _host_yaml_block(name, normalized_values, newline, hosts_indent + 2)
        lines[insert_at:insert_at] = [prefix + block]
        write(file_paths["hosts"], "".join(lines))

    if group:
        _insert_host_into_group(file_paths["hosts"], group, name)

def delete_host(project, obj, name):
    file_paths = paths(project, obj)
    if not file_paths:
        raise ValueError("Объект не найден")
    data = load_inventory(project, obj)
    hosts = data.get("all", {}).get("hosts", {}) if isinstance(data, dict) else {}
    if name not in hosts:
        raise ValueError("Узел не найден")
    hosts.pop(name, None)

    raw = read(file_paths["hosts"])
    lines = raw.splitlines(keepends=True)
    hosts_index, end_index, hosts_indent = _hosts_section_bounds(lines)
    if hosts_index is not None:
        entry_indexes = _host_entry_indexes(lines, hosts_index, end_index, hosts_indent)
        target_index = next((index for index in entry_indexes if _host_name_from_line(lines[index], hosts_indent + 2) == name), None)
        if target_index is not None:
            next_index = next((index for index in entry_indexes if index > target_index), end_index)
            del lines[target_index:next_index]
            write(file_paths["hosts"], "".join(lines))

    for group in inventory_groups(project, obj):
        _remove_host_from_group(file_paths["hosts"], group["name"], name)

def save_host(project, obj, old_name, new_name, values):
    """Обновляет хост с сохранением форматирования и обновлением групп при переименовании."""
    file_paths = paths(project, obj)
    if not file_paths:
        raise ValueError("Объект не найден")
    
    data = load_inventory(project, obj)
    hosts = data.setdefault("all", {}).setdefault("hosts", {})
    if old_name not in hosts:
        raise ValueError("Узел не найден")
    if new_name != old_name and new_name in hosts:
        raise ValueError("Узел с таким именем уже существует")

    # Подготовка обновлённых значений
    updated = dict(hosts[old_name]) if isinstance(hosts[old_name], dict) else {}
    for key, value in values.items():
        updated[key] = scalar(value)

    # Построчное обновление файла для сохранения форматирования
    raw = read(file_paths["hosts"])
    lines = raw.splitlines(keepends=True)
    hosts_index, end_index, hosts_indent = _hosts_section_bounds(lines)
    
    if hosts_index is not None:
        entry_indexes = _host_entry_indexes(lines, hosts_index, end_index, hosts_indent)
        target_index = next((index for index in entry_indexes if _host_name_from_line(lines[index], hosts_indent + 2) == old_name), None)
        
        if target_index is not None:
            # Удаляем старую запись
            next_index = next((index for index in entry_indexes if index > target_index), end_index)
            del lines[target_index:next_index]
            
            # Вставляем новую запись
            normalized_values = {key: scalar(value) for key, value in values.items()}
            newline = "\r\n" if "\r\n" in raw else "\n"
            insert_at = target_index
            while insert_at < end_index and not lines[insert_at].strip():
                insert_at += 1
            
            prefix = newline if (insert_at > hosts_index + 1 and lines[insert_at - 1].strip()) else ""
            block = _host_yaml_block(new_name, normalized_values, newline, hosts_indent + 2)
            lines[insert_at:insert_at] = [prefix + block]
            write(file_paths["hosts"], "".join(lines))
        else:
            # Фоллбэк, если построчное редактирование не сработало
            hosts.pop(old_name)
            hosts[new_name] = updated
            save_hosts(file_paths["hosts"], data)
    else:
        # Фоллбэк, если секция hosts не найдена
        hosts.pop(old_name)
        hosts[new_name] = updated
        save_hosts(file_paths["hosts"], data)

    # Обновляем членство в группах при переименовании
    if new_name != old_name:
        for group in inventory_groups(project, obj):
            if old_name in group["hosts"]:
                _remove_host_from_group(file_paths["hosts"], group["name"], old_name)
                _insert_host_into_group(file_paths["hosts"], group["name"], new_name)

def get_playbooks(project, obj):
    directory = object_dir(project, obj)
    if not directory or not os.path.isdir(directory):
        return []
    excluded = {"hosts.yml", "hosts.yaml", "inventory.yml", "defaults.yml", "defaults.yaml", "ansible.cfg"}
    return [
        {"name": name, "path": os.path.join(directory, name), "type": "playbook"}
        for name in sorted(os.listdir(directory))
        if os.path.isfile(os.path.join(directory, name)) and name.lower().endswith((".yml", ".yaml")) and name not in excluded
    ]

def playbook_roles(project, obj, playbook_name):
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
    root = roles_dir(project, obj)
    if not root: return None
    root = os.path.abspath(root)
    path = os.path.abspath(os.path.join(root, relative_path))
    return path if path.startswith(root + os.sep) and os.path.isfile(path) else None

def autodeploy(project):
    path = os.path.join(project_dir(project) or "", "autodeploy", "autodeploy.yml")
    return path if os.path.isfile(path) else None

def host_up(ip):
    if not ip: return False
    try:
        return subprocess.run(["ping", "-c", "1", "-W", "1", str(ip)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    except OSError:
        return False

def status_worker():
    """Параллельный опрос хостов для ускорения проверки статусов."""
    global HOST_STATUS
    while True:
        statuses = {}
        for project in get_projects():
            for obj in (get_objects(project) or [None]):
                key = obj or ""
                nodes = parse_hosts(project, obj)
                
                def check_node(node):
                    return node["hostname"], host_up(node["ip"])
                
                with concurrent.futures.ThreadPoolExecutor(max_workers=20) as executor:
                    results = dict(executor.map(check_node, nodes))
                
                statuses.setdefault(project, {})[key] = results
                
        with STATUS_LOCK:
            HOST_STATUS = statuses
        time.sleep(10)

def status(project, obj):
    with STATUS_LOCK:
        return dict(HOST_STATUS.get(project, {}).get(obj or "", {}))

def run_playbook(command, project, obj, name, cwd, cfg, label=None):
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

def run_command(project, obj, names, hosts):
    file_paths = paths(project, obj)
    available = {item["name"]: item["path"] for item in get_playbooks(project, obj)}
    if not file_paths: return
    for name in names:
        if name in available:
            command = ["ansible-playbook", "-i", file_paths["hosts"], available[name]]
            if hosts: command += ["-l", ",".join(hosts)]
            run_playbook(command, project, obj, name, os.path.dirname(available[name]), file_paths["cfg"])

def run_autodeploy(project, hosts):
    path = autodeploy(project)
    if not path: return
    file_paths = paths(project, None)
    command = ["ansible-playbook", path]
    if hosts: command += ["-l", ",".join(hosts)]
    run_playbook(command, project, None, "autodeploy.yml", os.path.dirname(path), file_paths["cfg"] if file_paths else "")

def stop():
    with PROC_LOCK:
        for process in PROCESSES:
            try: process.terminate()
            except OSError: pass
        PROCESSES.clear()
    log("=== EXECUTION STOPPED ===")

class Handler(BaseHTTPRequestHandler):
    def json(self, data, code=200):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json; charset=utf-8"); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)

    def file(self, path, content_type):
        if not os.path.isfile(path): self.send_error(404); return
        with open(path, "rb") as file: body = file.read()
        self.send_response(200); self.send_header("Content-Type", content_type); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)

    def do_GET(self):
        url = urlparse(self.path); query = parse_qs(url.query)
        project = query.get("project", [""])[0]; obj = query.get("object", [""])[0]
        static = {"/main": "main.html", "/hosts_info": "hosts_info.html", "/editor": "editor.html", "/style.css": "style.css", "/common.js": "common.js", "/main.js": "main.js", "/hosts_info.js": "hosts_info.js", "/editor.js": "editor.js", "/5x-fixes.css": "5x-fixes.css", "/5x-fixes.js": "5x-fixes.js", "/3x-fixes.css": "3x-fixes.css", "/3x-fixes.js": "3x-fixes.js", "/status-fix.js": "status-fix.js"}
        if url.path in static:
            filename = static[url.path]
            content_type = "text/html; charset=utf-8" if filename.endswith(".html") else "text/css; charset=utf-8" if filename.endswith(".css") else "application/javascript; charset=utf-8"
            self.file(os.path.join(PUBLIC_DIR, filename), content_type); return
        if url.path == "/background": self.file(os.path.join(BASE_DIR, "logo.png"), "image/png"); return
        if url.path == "/data":
            hosts = parse_hosts(project, obj); auto = autodeploy(project)
            self.json({"projects": get_projects(), "objects": get_objects(project), "single_object_mode": single_project(project), "selected_project": project, "selected_object": obj, "hosts": hosts, "status": status(project, obj), "groups": inventory_groups(project, obj), "template_schemas": template_schemas(project, obj), "playbooks": get_playbooks(project, obj), "autodeploy": bool(auto), "autodeploy_playbook": "autodeploy.yml" if auto else None}); return
        if url.path == "/roles":
            playbook = query.get("playbook", [""])[0]; self.json(playbook_roles(project, obj, playbook) if playbook else []); return
        if url.path == "/role_file":
            path = role_file(project, obj, query.get("path", [""])[0])
            if not path: self.send_error(404); return
            self.json({"path": query.get("path", [""])[0], "content": read(path), "name": os.path.basename(path)}); return
        if url.path == "/status": self.json(status(project, obj)); return
        if url.path == "/log_new":
            try: start = int(query.get("start", ["0"])[0])
            except ValueError: start = 0
            with LOG_LOCK: lines = LOG[start:]; next_index = len(LOG)
            self.json({"lines": lines, "next": next_index}); return
        if url.path == "/playbook":
            name = safe(query.get("name", [""])[0]); file_paths = paths(project, obj)
            self.json({"name": name, "content": read(os.path.join(file_paths["object_dir"], name)) if file_paths else ""}); return
        if url.path == "/files":
            file_paths = paths(project, obj)
            self.json({"hosts": read(file_paths["hosts"]) if file_paths else "", "defaults": read(file_paths["defaults"]) if file_paths else ""}); return
        self.send_error(404)

    def do_POST(self):
        try:
            body = self.rfile.read(int(self.headers.get("Content-Length", 0))); data = json.loads(body.decode() or "{}")
        except Exception: data = {}
        project = data.get("project", ""); obj = data.get("object", "")
        try:
            if self.path == "/run":
                threading.Thread(target=run_command, args=(project, obj, data.get("playbooks", []), data.get("hosts", [])), daemon=True).start(); self.json({"ok": True}); return
            if self.path == "/run_autodeploy":
                threading.Thread(target=run_autodeploy, args=(project, data.get("hosts", [])), daemon=True).start(); self.json({"ok": True}); return
            if self.path == "/stop": stop(); self.json({"ok": True}); return
            if self.path == "/update_host":
                save_host(project, obj, data.get("hostname", ""), data.get("new_hostname", data.get("hostname", "")), data.get("values", {})); self.json({"ok": True}); return
            if self.path == "/add_host":
                add_host(project, obj, data.get("hostname", ""), data.get("values", {}), data.get("group", "")); self.json({"ok": True}); return
            if self.path == "/delete_host":
                delete_host(project, obj, data.get("hostname", "")); self.json({"ok": True}); return
            if self.path == "/save_playbook":
                file_paths = paths(project, obj)
                if file_paths: write(os.path.join(file_paths["object_dir"], safe(data.get("name"))), data.get("content", ""))
                self.json({"ok": True}); return
            if self.path == "/save_files":
                # Защита от случайной перезаписи пустым содержимым
                hosts_content = data.get("hosts", "")
                if not hosts_content.strip():
                    self.json({"ok": False, "error": "Файл hosts.yml не может быть пустым"}, 400)
                    return
                file_paths = paths(project, obj)
                if file_paths: 
                    write(file_paths["hosts"], hosts_content)
                    write(file_paths["defaults"], data.get("defaults", ""))
                self.json({"ok": True}); return
        except (OSError, ValueError) as error:
            self.json({"ok": False, "error": str(error)}, 500); return
        self.send_error(404)

if __name__ == "__main__":
    threading.Thread(target=status_worker, daemon=True).start()
    HTTPServer(("0.0.0.0", 8000), Handler).serve_forever()