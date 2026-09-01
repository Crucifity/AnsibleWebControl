#!/usr/bin/env python3

import json
import os
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
    return sorted(
        name for name in os.listdir(PROJECTS_ROOT)
        if os.path.isdir(project_dir(name))
    )


def get_objects(project):
    if single_project(project):
        return []

    directory = os.path.join(project_dir(project) or "", "object")
    if not os.path.isdir(directory):
        return []

    return sorted(
        name for name in os.listdir(directory)
        if os.path.isdir(os.path.join(directory, name))
    )


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
        result.append({
            "hostname": name,
            "parameters": params,
            "node_type": node_type,
            "template": template,
            "ip": params.get("ansible_host", params.get("ip", "")),
        })

    return result


def template_schemas(project, obj):
    schemas = {}

    for node in parse_hosts(project, obj):
        template = node["template"]
        if template not in ("Хост", "МД", "Узел") and template not in schemas:
            schemas[template] = list(node["parameters"])

    return schemas


def inventory_groups(project, obj):
    data = load_inventory(project, obj)
    wanted = {"arms", "servers", "md"}
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

    for name, value in data.items():
        if name in wanted:
            groups[name] = sorted(collect(value))

    all_group = data.get("all", {}) if isinstance(data, dict) else {}
    for name, value in (all_group.get("children", {}) or {}).items():
        if name in wanted:
            groups[name] = sorted(collect(value))

    return [
        {"name": name, "hosts": hosts}
        for name, hosts in groups.items()
        if hosts
    ]


def save_hosts(path, data):
    write(
        path,
        yaml.safe_dump(
            data,
            allow_unicode=True,
            sort_keys=False,
            default_flow_style=False,
        ),
    )


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


def save_host(project, obj, old_name, new_name, values):
    file_paths = paths(project, obj)
    data = load_inventory(project, obj)
    hosts = data.setdefault("all", {}).setdefault("hosts", {})

    if old_name not in hosts:
        raise ValueError("Узел не найден")
    if new_name != old_name and new_name in hosts:
        raise ValueError("Узел с таким именем уже существует")

    updated = dict(hosts[old_name]) if isinstance(hosts[old_name], dict) else {}
    for key, value in values.items():
        updated[key] = scalar(value)

    hosts.pop(old_name)
    hosts[new_name] = updated
    save_hosts(file_paths["hosts"], data)


def add_host(project, obj, name, values):
    file_paths = paths(project, obj)
    data = load_inventory(project, obj)
    hosts = data.setdefault("all", {}).setdefault("hosts", {})

    if not name:
        raise ValueError("Имя узла не указано")
    if name in hosts:
        raise ValueError("Узел уже существует")

    hosts[name] = {key: scalar(value) for key, value in values.items()}
    save_hosts(file_paths["hosts"], data)


def delete_host(project, obj, name):
    file_paths = paths(project, obj)
    data = load_inventory(project, obj)
    hosts = data.setdefault("all", {}).setdefault("hosts", {})

    if name not in hosts:
        raise ValueError("Узел не найден")

    hosts.pop(name)
    save_hosts(file_paths["hosts"], data)


def get_playbooks(project, obj):
    directory = object_dir(project, obj)
    if not directory or not os.path.isdir(directory):
        return []

    excluded = {
        "hosts.yml", "hosts.yaml", "inventory.yml",
        "defaults.yml", "defaults.yaml", "ansible.cfg",
    }

    return [
        {"name": name, "path": os.path.join(directory, name), "type": "playbook"}
        for name in sorted(os.listdir(directory))
        if os.path.isfile(os.path.join(directory, name))
        and name.lower().endswith((".yml", ".yaml"))
        and name not in excluded
    ]


def playbook_roles(project, obj, playbook_name):
    """Return a tree containing only roles referenced by this playbook."""
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
            for item in value:
                inspect(item)
        elif isinstance(value, dict):
            roles = value.get("roles")
            if isinstance(roles, list):
                for role in roles:
                    if isinstance(role, str):
                        names.append(role)
                    elif isinstance(role, dict):
                        role_name = role.get("role") or role.get("name")
                        if isinstance(role_name, str):
                            names.append(role_name)
            for key, child in value.items():
                if key != "roles":
                    inspect(child)

    inspect(document)

    root = roles_dir(project, obj)
    if not root or not os.path.isdir(root):
        return []

    result = []
    seen = set()

    for role_name in names:
        role_path = os.path.abspath(os.path.join(root, role_name))
        root_abs = os.path.abspath(root)
        if not role_path.startswith(root_abs + os.sep) or not os.path.isdir(role_path):
            continue
        if role_name in seen:
            continue
        seen.add(role_name)

        def walk(directory):
            items = []
            for name in sorted(os.listdir(directory), key=str.lower):
                path = os.path.join(directory, name)
                relative = os.path.relpath(path, root)
                if os.path.isdir(path):
                    items.append({
                        "name": name,
                        "type": "dir",
                        "path": relative,
                        "children": walk(path),
                    })
                else:
                    items.append({
                        "name": name,
                        "type": "file",
                        "path": relative,
                    })
            return items

        result.append({
            "name": role_name,
            "type": "dir",
            "path": role_name,
            "children": walk(role_path),
        })

    return result


def roles_tree(project, obj):
    root = roles_dir(project, obj)
    if not root or not os.path.isdir(root):
        return []

    def walk(directory):
        result = []
        for name in sorted(os.listdir(directory), key=str.lower):
            path = os.path.join(directory, name)
            relative = os.path.relpath(path, root)
            result.append(
                {
                    "name": name,
                    "type": "dir",
                    "path": relative,
                    "children": walk(path),
                }
                if os.path.isdir(path)
                else {
                    "name": name,
                    "type": "file",
                    "path": relative,
                }
            )
        return result

    return walk(root)


def role_file(project, obj, relative_path):
    root = roles_dir(project, obj)
    if not root:
        return None

    root = os.path.abspath(root)
    path = os.path.abspath(os.path.join(root, relative_path))

    if path.startswith(root + os.sep) and os.path.isfile(path):
        return path
    return None


def autodeploy(project):
    path = os.path.join(project_dir(project) or "", "autodeploy", "autodeploy.yml")
    return path if os.path.isfile(path) else None


def host_up(ip):
    if not ip:
        return False
    try:
        return subprocess.run(
            ["ping", "-c", "1", "-W", "1", str(ip)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        ).returncode == 0
    except OSError:
        return False


def status_worker():
    """Populate real status immediately, then refresh periodically."""
    global HOST_STATUS

    while True:
        statuses = {}

        for project in get_projects():
            for obj in (get_objects(project) or [None]):
                key = obj or ""
                statuses.setdefault(project, {})[key] = {
                    node["hostname"]: host_up(node["ip"])
                    for node in parse_hosts(project, obj)
                }

        with STATUS_LOCK:
            HOST_STATUS = statuses

        time.sleep(15)


def status(project, obj):
    with STATUS_LOCK:
        return dict(HOST_STATUS.get(project, {}).get(obj or "", {}))


def run_playbook(command, project, obj, name, cwd, cfg, label=None):
    title = label or name
    log(f"=== START {title} [{project}{('/' + obj) if obj else ''}] ===")
    process = None

    try:
        environment = os.environ.copy()
        if os.path.isfile(cfg):
            environment["ANSIBLE_CONFIG"] = cfg

        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            cwd=cwd,
            env=environment,
        )

        with PROC_LOCK:
            PROCESSES.append(process)

        for line in process.stdout:
            log(line.rstrip())

        log(f"=== DONE {title}: rc={process.wait()} ===")
    except OSError as error:
        log(f"EXECUTION ERROR: {error}")
    finally:
        if process:
            with PROC_LOCK:
                if process in PROCESSES:
                    PROCESSES.remove(process)


def run_command(project, obj, names, hosts):
    file_paths = paths(project, obj)
    available = {item["name"]: item["path"] for item in get_playbooks(project, obj)}
    if not file_paths:
        return

    for name in names:
        if name in available:
            command = ["ansible-playbook", "-i", file_paths["hosts"], available[name]]
            if hosts:
                command += ["-l", ",".join(hosts)]
            run_playbook(
                command,
                project,
                obj,
                name,
                os.path.dirname(available[name]),
                file_paths["cfg"],
            )


def run_autodeploy(project, hosts):
    path = autodeploy(project)
    if not path:
        return

    file_paths = paths(project, None)
    command = ["ansible-playbook", path]
    if hosts:
        command += ["-l", ",".join(hosts)]

    run_playbook(
        command,
        project,
        None,
        "autodeploy.yml",
        os.path.dirname(path),
        file_paths["cfg"] if file_paths else "",
    )


def stop():
    with PROC_LOCK:
        for process in PROCESSES:
            try:
                process.terminate()
            except OSError:
                pass
        PROCESSES.clear()
    log("=== EXECUTION STOPPED ===")


class Handler(BaseHTTPRequestHandler):
    def json(self, data, code=200):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def file(self, path, content_type):
        if not os.path.isfile(path):
            self.send_error(404)
            return

        with open(path, "rb") as file:
            body = file.read()

        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urlparse(self.path)
        query = parse_qs(url.query)
        project = query.get("project", [""])[0]
        obj = query.get("object", [""])[0]

        static = {
            "/main": "main.html",
            "/hosts_info": "hosts_info.html",
            "/editor": "editor.html",
            "/style.css": "style.css",
            "/common.js": "common.js",
            "/main.js": "main.js",
            "/hosts_info.js": "hosts_info.js",
            "/editor.js": "editor.js",
        }

        if url.path in static:
            filename = static[url.path]
            content_type = (
                "text/html; charset=utf-8" if filename.endswith(".html")
                else "text/css; charset=utf-8" if filename.endswith(".css")
                else "application/javascript; charset=utf-8"
            )
            self.file(os.path.join(PUBLIC_DIR, filename), content_type)
            return

        if url.path == "/background":
            self.file(os.path.join(BASE_DIR, "logo.png"), "image/png")
            return

        if url.path == "/data":
            hosts = parse_hosts(project, obj)
            auto = autodeploy(project)
            self.json({
                "projects": get_projects(),
                "objects": get_objects(project),
                "single_object_mode": single_project(project),
                "selected_project": project,
                "selected_object": obj,
                "hosts": hosts,
                "status": status(project, obj),
                "groups": inventory_groups(project, obj),
                "template_schemas": template_schemas(project, obj),
                "playbooks": get_playbooks(project, obj),
                "autodeploy": bool(auto),
                "autodeploy_playbook": "autodeploy.yml" if auto else None,
            })
            return

        if url.path == "/roles":
            playbook = query.get("playbook", [""])[0]
            self.json(playbook_roles(project, obj, playbook) if playbook else roles_tree(project, obj))
            return

        if url.path == "/role_file":
            path = role_file(project, obj, query.get("path", [""])[0])
            if not path:
                self.send_error(404)
                return
            self.json({
                "path": query.get("path", [""])[0],
                "content": read(path),
                "name": os.path.basename(path),
            })
            return

        if url.path == "/status":
            self.json(status(project, obj))
            return

        if url.path == "/log_new":
            try:
                start = int(query.get("start", ["0"])[0])
            except ValueError:
                start = 0

            with LOG_LOCK:
                lines = LOG[start:]
                next_index = len(LOG)

            self.json({"lines": lines, "next": next_index})
            return

        if url.path == "/playbook":
            name = safe(query.get("name", [""])[0])
            file_paths = paths(project, obj)
            self.json({
                "name": name,
                "content": read(os.path.join(file_paths["object_dir"], name)) if file_paths else "",
            })
            return

        if url.path == "/files":
            file_paths = paths(project, obj)
            self.json({
                "hosts": read(file_paths["hosts"]) if file_paths else "",
                "defaults": read(file_paths["defaults"]) if file_paths else "",
            })
            return

        self.send_error(404)

    def do_POST(self):
        try:
            body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            data = json.loads(body.decode() or "{}")
        except Exception:
            data = {}

        project = data.get("project", "")
        obj = data.get("object", "")

        try:
            if self.path == "/run":
                threading.Thread(
                    target=run_command,
                    args=(project, obj, data.get("playbooks", []), data.get("hosts", [])),
                    daemon=True,
                ).start()
                self.json({"ok": True})
                return

            if self.path == "/run_autodeploy":
                threading.Thread(
                    target=run_autodeploy,
                    args=(project, data.get("hosts", [])),
                    daemon=True,
                ).start()
                self.json({"ok": True})
                return

            if self.path == "/stop":
                stop()
                self.json({"ok": True})
                return

            if self.path == "/update_host":
                save_host(
                    project,
                    obj,
                    data.get("hostname", ""),
                    data.get("new_hostname", data.get("hostname", "")),
                    data.get("values", {}),
                )
                self.json({"ok": True})
                return

            if self.path == "/add_host":
                add_host(project, obj, data.get("hostname", ""), data.get("values", {}))
                self.json({"ok": True})
                return

            if self.path == "/delete_host":
                delete_host(project, obj, data.get("hostname", ""))
                self.json({"ok": True})
                return

            if self.path == "/save_playbook":
                file_paths = paths(project, obj)
                if file_paths:
                    write(
                        os.path.join(file_paths["object_dir"], safe(data.get("name"))),
                        data.get("content", ""),
                    )
                self.json({"ok": True})
                return

            if self.path == "/save_files":
                file_paths = paths(project, obj)
                if file_paths:
                    write(file_paths["hosts"], data.get("hosts", ""))
                    write(file_paths["defaults"], data.get("defaults", ""))
                self.json({"ok": True})
                return

        except (OSError, ValueError) as error:
            self.json({"ok": False, "error": str(error)}, 500)
            return

        self.send_error(404)


if __name__ == "__main__":
    threading.Thread(target=status_worker, daemon=True).start()
    HTTPServer(("0.0.0.0", 8000), Handler).serve_forever()
