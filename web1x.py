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


def safe(value):
    return os.path.basename(value or "")


def project_dir(project):
    project = safe(project)
    return os.path.join(PROJECTS_ROOT, project) if project else None


def get_projects():
    result = []
    if not os.path.isdir(PROJECTS_ROOT):
        return result

    for name in sorted(os.listdir(PROJECTS_ROOT)):
        directory = project_dir(name)
        if os.path.isdir(directory) and all(
            os.path.isdir(os.path.join(directory, folder))
            for folder in ("global", "object", "roles")
        ):
            result.append(name)

    return result


def get_objects(project):
    directory = os.path.join(project_dir(project) or "", "object")
    if not os.path.isdir(directory):
        return []

    return sorted(
        name
        for name in os.listdir(directory)
        if os.path.isdir(os.path.join(directory, name))
    )


def object_dir(project, obj):
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

    def first_existing(names):
        for name in names:
            path = os.path.join(directory, name)
            if os.path.isfile(path):
                return path
        return os.path.join(directory, names[0])

    return {
        "object_dir": directory,
        "hosts": first_existing(
            ["hosts.yml", "hosts.yaml", "hosts", "inventory.yml"]
        ),
        "defaults": first_existing(
            ["defaults.yml", "defaults.yaml", "defaults"]
        ),
        "cfg": os.path.join(directory, "ansible.cfg"),
    }


def log(message):
    with LOG_LOCK:
        LOG.append(f"[{datetime.now():%H:%M:%S}] {message}")
        del LOG[:-1000]


def load_hosts(project, obj):
    file_paths = paths(project, obj)
    if not file_paths or not os.path.exists(file_paths["hosts"]):
        return {}

    try:
        data = yaml.safe_load(read(file_paths["hosts"])) or {}
        return data.get("all", {}).get("hosts", {}) or {}
    except yaml.YAMLError as exc:
        log(f"HOSTS YAML ERROR: {exc}")
        return {}


def parse_hosts(project, obj):
    result = []

    for hostname, raw in load_hosts(project, obj).items():
        parameters = dict(raw) if isinstance(raw, dict) else {}
        result.append(
            {
                "hostname": hostname,
                "parameters": parameters,
            }
        )

    return result


def save_hosts(path, data):
    text = yaml.safe_dump(
        data,
        allow_unicode=True,
        sort_keys=False,
        default_flow_style=False,
    )

    lines = text.splitlines()
    output = []
    inside_hosts = False

    for line in lines:
        if line == "  hosts:":
            inside_hosts = True
        elif (
            inside_hosts
            and line.startswith("    ")
            and line.endswith(":")
            and not line.startswith("      ")
        ):
            if output and output[-1] != "":
                output.append("")

        output.append(line)

    write(path, "\n".join(output) + "\n")


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
        if stripped and (
            stripped.isdigit()
            or stripped.startswith("-") and stripped[1:].isdigit()
        ):
            return int(stripped)
    except ValueError:
        pass

    return value


def save_host(project, obj, old_name, new_name, values):
    file_paths = paths(project, obj)
    data = yaml.safe_load(read(file_paths["hosts"])) or {}
    hosts = data.setdefault("all", {}).setdefault("hosts", {})

    if old_name not in hosts:
        raise ValueError("Хост не найден")
    if new_name != old_name and new_name in hosts:
        raise ValueError("Хост с таким именем уже существует")

    original = hosts[old_name] if isinstance(hosts[old_name], dict) else {}
    updated = dict(original)

    for key, value in values.items():
        updated[key] = scalar(value)

    hosts.pop(old_name)
    hosts[new_name] = updated
    save_hosts(file_paths["hosts"], data)


def add_host(project, obj, name, values):
    file_paths = paths(project, obj)
    data = yaml.safe_load(read(file_paths["hosts"])) or {}
    hosts = data.setdefault("all", {}).setdefault("hosts", {})

    if not name:
        raise ValueError("Имя хоста не указано")
    if name in hosts:
        raise ValueError("Хост уже существует")

    hosts[name] = {key: scalar(value) for key, value in values.items()}
    save_hosts(file_paths["hosts"], data)


def delete_host(project, obj, name):
    file_paths = paths(project, obj)
    data = yaml.safe_load(read(file_paths["hosts"])) or {}
    hosts = data.setdefault("all", {}).setdefault("hosts", {})

    if name not in hosts:
        raise ValueError("Хост не найден")

    hosts.pop(name)
    save_hosts(file_paths["hosts"], data)


def get_playbooks(project, obj):
    directory = object_dir(project, obj)
    if not directory:
        return []

    excluded = {
        "hosts.yml",
        "hosts.yaml",
        "inventory.yml",
        "defaults.yml",
        "defaults.yaml",
    }

    return [
        {
            "name": name,
            "path": os.path.join(directory, name),
        }
        for name in sorted(os.listdir(directory))
        if (
            os.path.isfile(os.path.join(directory, name))
            and name.lower().endswith((".yml", ".yaml"))
            and name not in excluded
        )
    ]


def host_up(ip):
    try:
        return bool(ip) and subprocess.run(
            ["ping", "-c", "1", "-W", "1", str(ip)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        ).returncode == 0
    except OSError:
        return False


def status_worker():
    global HOST_STATUS

    while True:
        result = {}

        for project in get_projects():
            for obj in get_objects(project):
                result.setdefault(project, {})[obj] = {
                    host["hostname"]: host_up(
                        host["parameters"].get(
                            "ansible_host",
                            host["parameters"].get("ip", ""),
                        )
                    )
                    for host in parse_hosts(project, obj)
                }

        with STATUS_LOCK:
            HOST_STATUS = result

        time.sleep(60)


def status(project, obj):
    with STATUS_LOCK:
        return dict(HOST_STATUS.get(project, {}).get(obj, {}))


def run_playbooks(project, obj, names, hosts):
    file_paths = paths(project, obj)
    if not file_paths:
        return

    available = {item["name"] for item in get_playbooks(project, obj)}

    for name in names:
        if name not in available:
            continue

        log(f"=== START {name} [{project}/{obj}] ===")

        command = [
            "ansible-playbook",
            "-i",
            file_paths["hosts"],
            os.path.join(file_paths["object_dir"], name),
        ]

        if hosts:
            command.extend(["-l", ",".join(hosts)])

        try:
            environment = os.environ.copy()
            if os.path.isfile(file_paths["cfg"]):
                environment["ANSIBLE_CONFIG"] = file_paths["cfg"]

            process = subprocess.Popen(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
                cwd=file_paths["object_dir"],
                env=environment,
            )

            with PROC_LOCK:
                PROCESSES.append(process)

            for line in process.stdout:
                log(line.rstrip())

            log(f"=== DONE {name}: rc={process.wait()} ===")

        except OSError as exc:
            log(f"EXECUTION ERROR: {exc}")

        finally:
            with PROC_LOCK:
                if process in PROCESSES:
                    PROCESSES.remove(process)


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
        self.send_header(
            "Content-Type",
            "application/json; charset=utf-8",
        )
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
            if filename.endswith(".html"):
                content_type = "text/html; charset=utf-8"
            elif filename.endswith(".css"):
                content_type = "text/css; charset=utf-8"
            else:
                content_type = "application/javascript; charset=utf-8"

            self.file(os.path.join(PUBLIC_DIR, filename), content_type)
            return

        # The original application serves the background through this endpoint.
        if url.path == "/background":
            background = os.path.join(PUBLIC_DIR, "background")
            if os.path.isfile(background):
                self.file(background, "image/jpeg")
            else:
                self.send_error(404)
            return

        if url.path == "/data":
            self.json(
                {
                    "projects": get_projects(),
                    "objects": get_objects(project),
                    "selected_project": project,
                    "selected_object": obj,
                    "hosts": parse_hosts(project, obj),
                    "status": status(project, obj),
                    "playbooks": get_playbooks(project, obj),
                    "local_ip": socket.gethostbyname(socket.gethostname()),
                }
            )
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
            content = (
                read(os.path.join(file_paths["object_dir"], name))
                if file_paths
                else ""
            )
            self.json({"name": name, "content": content})
            return

        if url.path == "/files":
            file_paths = paths(project, obj)
            self.json(
                {
                    "hosts": read(file_paths["hosts"]) if file_paths else "",
                    "defaults": read(file_paths["defaults"])
                    if file_paths
                    else "",
                }
            )
            return

        self.send_error(404)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length)

        try:
            data = json.loads(raw.decode()) if raw else {}
        except json.JSONDecodeError:
            data = {}

        project = data.get("project", "")
        obj = data.get("object", "")

        try:
            if self.path == "/run":
                threading.Thread(
                    target=run_playbooks,
                    args=(
                        project,
                        obj,
                        data.get("playbooks", []),
                        data.get("hosts", []),
                    ),
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
                    data.get(
                        "new_hostname",
                        data.get("hostname", ""),
                    ),
                    data.get("values", {}),
                )
                self.json({"ok": True})
                return

            if self.path == "/add_host":
                add_host(
                    project,
                    obj,
                    data.get("hostname", ""),
                    data.get("values", {}),
                )
                self.json({"ok": True})
                return

            if self.path == "/delete_host":
                delete_host(
                    project,
                    obj,
                    data.get("hostname", ""),
                )
                self.json({"ok": True})
                return

            if self.path == "/save_playbook":
                file_paths = paths(project, obj)
                write(
                    os.path.join(
                        file_paths["object_dir"],
                        safe(data.get("name")),
                    ),
                    data.get("content", ""),
                )
                self.json({"ok": True})
                return

            if self.path == "/save_files":
                file_paths = paths(project, obj)
                write(file_paths["hosts"], data.get("hosts", ""))
                write(file_paths["defaults"], data.get("defaults", ""))
                self.json({"ok": True})
                return

        except (OSError, ValueError) as exc:
            self.json({"ok": False, "error": str(exc)}, 500)
            return

        self.send_error(404)


if __name__ == "__main__":
    threading.Thread(target=status_worker, daemon=True).start()
    HTTPServer(("0.0.0.0", 8000), Handler).serve_forever()
