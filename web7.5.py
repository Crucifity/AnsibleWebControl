#!/usr/bin/env python3

import os
import json
import yaml
import socket
import subprocess
import threading
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, unquote
from datetime import datetime

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.join(BASE_DIR, "public")

PROJECTS_ROOT = "/opt/home/projects"
BACKGROUND_IMAGE = os.path.join(BASE_DIR, "logo.png")

LOG = []
LOCK = threading.Lock()

CURRENT_PROCESSES = []
PROC_LOCK = threading.Lock()

HOST_STATUS = {}
HOST_STATUS_LOCK = threading.Lock()

def get_projects():
    result = []

    if not os.path.isdir(PROJECTS_ROOT):
        return result

    for name in sorted(os.listdir(PROJECTS_ROOT)):
        full = os.path.join(PROJECTS_ROOT, name)

        if not os.path.isdir(full):
            continue

        playbooks_dir = os.path.join(full, "playbooks")
        autodeploy_dir = os.path.join(full, "autodeploy")
        hosts_file = os.path.join(playbooks_dir, "hosts.yml")

        if os.path.isdir(playbooks_dir) and os.path.exists(hosts_file):
            result.append(name)

    return result


def get_project_paths(project_name):
    if not project_name:
        return None

    safe_name = os.path.basename(project_name)
    project_dir = os.path.join(PROJECTS_ROOT, safe_name)

    if not os.path.isdir(project_dir):
        return None

    playbook_dir = os.path.join(project_dir, "playbooks")
    autodeploy_dir = os.path.join(project_dir, "autodeploy")
    hosts_file = os.path.join(playbook_dir, "hosts.yml")
    defaults_file = os.path.join(playbook_dir, "defaults.yml")

    if not os.path.isdir(playbook_dir):
        return None

    return {
        "project": safe_name,
        "project_dir": project_dir,
        "playbook_dir": playbook_dir,
        "autodeploy_dir": autodeploy_dir,
        "hosts_file": hosts_file,
        "defaults_file": defaults_file
    }

def log(msg):
    with LOCK:
        LOG.append(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}")
        if len(LOG) > 300:
            LOG.pop(0)


def get_local_ip():
    try:
        ip = subprocess.check_output("hostname -I", shell=True, text=True).strip()
        if ip:
            return ip.split()[0]
    except:
        pass

    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except:
        return "UNKNOWN"


def mask_to_cidr(mask):
    try:
        parts = [int(x) for x in mask.strip().split(".")]
        if len(parts) != 4:
            return ""
        bits = "".join(bin(x)[2:].zfill(8) for x in parts)
        return str(bits.count("1"))
    except:
        return ""


def parse_hosts(project_name):
    paths = get_project_paths(project_name)
    if not paths or not os.path.exists(paths["hosts_file"]):
        return {"arm": [], "servers": []}

    with open(paths["hosts_file"], "r", encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}

    all_hosts = data.get("all", {}).get("hosts", {})
    arms = set(data.get("arms", {}).get("hosts", {}).keys())
    servers = set(data.get("servers", {}).get("hosts", {}).keys())

    result = {"arm": [], "servers": []}

    for hostname, vars in all_hosts.items():
        host = {
            "hostname": hostname,
            "name": vars.get("name", ""),
            "description": vars.get("description", ""),
            "ip": vars.get("ansible_host", ""),
            "mac": vars.get("mac", ""),
            "mask": vars.get("mask", ""),
            "mask_cidr": mask_to_cidr(str(vars.get("mask", ""))),
            "gate": vars.get("gate", ""),
            "hwtype": vars.get("hwtype", "")
        }

        if hostname in arms:
            result["arm"].append(host)
        elif hostname in servers:
            result["servers"].append(host)
        else:
            result["servers"].append(host)

    return result


def get_playbooks(project_name):
    pb = []
    paths = get_project_paths(project_name)

    if not paths or not os.path.isdir(paths["playbook_dir"]):
        return pb

    for f in sorted(os.listdir(paths["playbook_dir"])):
        full = os.path.join(paths["playbook_dir"], f)

        if os.path.isfile(full) and f[0].isdigit() and f.endswith(".yml"):
            pb.append({
                "name": f,
                "path": full,
                "local": False
            })

    return pb


def get_autodeploy(project_name):
    pb = []
    paths = get_project_paths(project_name)

    if not paths:
        return pb

    target = os.path.join(paths["autodeploy_dir"], "autodeploy.yml")

    if os.path.isfile(target):
        pb.append({
            "name": "autodeploy.yml",
            "path": target,
            "local": True
        })

    return pb

def get_hwtype_templates(project_name):
    paths = get_project_paths(project_name)
    if not paths:
        return []

    templates_dir = os.path.join(
        paths["project_dir"],
        "autodeploy",
        "roles",
        "auto",
        "templates"
    )

    result = []

    if not os.path.isdir(templates_dir):
        return result

    for f in sorted(os.listdir(templates_dir)):
        if f.endswith(".j2"):
            result.append(f[:-3])

    return result


def clean_value(v):
    if v is None:
        return ""
    return str(v).strip()


def build_host_dict(old_host, values):
    result = {}

    result["ansible_host"] = clean_value(values.get("ip", old_host.get("ansible_host", "")))
    result["ansible_port"] = old_host.get("ansible_port", 22)
    result["ansible_user"] = old_host.get("ansible_user", "")
    result["ansible_password"] = old_host.get("ansible_password", "")
    result["ansible_become"] = old_host.get("ansible_become", True)
    result["ansible_become_pass"] = old_host.get("ansible_become_pass", "")

    description = clean_value(values.get("description", old_host.get("description", "")))
    mac = clean_value(values.get("mac", old_host.get("mac", "")))
    gate = clean_value(values.get("gate", old_host.get("gate", "")))
    mask = clean_value(values.get("mask", old_host.get("mask", "")))
    hwtype = clean_value(values.get("hwtype", old_host.get("hwtype", "")))
    uefi = old_host.get("uefi", True)
    name = clean_value(values.get("name", old_host.get("name", "")))

    if description:
        result["description"] = description
    if mac:
        result["mac"] = mac
    if gate:
        result["gate"] = gate
    if mask:
        result["mask"] = mask
    if hwtype:
        result["hwtype"] = hwtype

    result["uefi"] = uefi

    if name:
        result["name"] = name

    return result


def save_hosts_yaml(path, data):
    class Quoted(str):
        pass

    def quoted_presenter(dumper, value):
        return dumper.represent_scalar('tag:yaml.org,2002:str', value, style="'")

    yaml.add_representer(Quoted, quoted_presenter)

    all_hosts = data.get("all", {}).get("hosts", {})
    for hname, hvars in all_hosts.items():
        if "mac" in hvars and hvars["mac"] not in ("", None):
            hvars["mac"] = Quoted(str(hvars["mac"]).replace("'", "").strip())

    with open(path, "w", encoding="utf-8") as f:
        yaml.safe_dump(
            data,
            f,
            allow_unicode=True,
            sort_keys=False,
            default_flow_style=False
        )


def update_host(project_name, old_hostname, new_values):
    paths = get_project_paths(project_name)
    if not paths or not os.path.exists(paths["hosts_file"]):
        raise Exception("hosts.yml not found")

    with open(paths["hosts_file"], "r", encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}

    all_hosts = data.setdefault("all", {}).setdefault("hosts", {})
    arms_hosts = data.setdefault("arms", {}).setdefault("hosts", {})
    servers_hosts = data.setdefault("servers", {}).setdefault("hosts", {})

    if old_hostname not in all_hosts:
        raise Exception(f"Host {old_hostname} not found")

    old_host = all_hosts[old_hostname]
    new_hostname = clean_value(new_values.get("name", old_hostname)) or old_hostname
    group = clean_value(new_values.get("group", "")).lower()

    old_in_arms = old_hostname in arms_hosts
    old_in_servers = old_hostname in servers_hosts

    new_host_data = build_host_dict(old_host, new_values)

    if new_hostname != old_hostname:
        all_hosts.pop(old_hostname, None)
        all_hosts[new_hostname] = new_host_data

        if old_in_arms:
            arms_hosts.pop(old_hostname, None)
        if old_in_servers:
            servers_hosts.pop(old_hostname, None)
    else:
        all_hosts[old_hostname] = new_host_data

    target_hostname = new_hostname

    arms_hosts.pop(target_hostname, None)
    servers_hosts.pop(target_hostname, None)

    if group == "arm":
        arms_hosts[target_hostname] = {}
    elif group == "servers":
        servers_hosts[target_hostname] = {}
    else:
        if old_in_arms:
            arms_hosts[target_hostname] = {}
        elif old_in_servers:
            servers_hosts[target_hostname] = {}

    save_hosts_yaml(paths["hosts_file"], data)


def add_host(project_name, values):
    paths = get_project_paths(project_name)
    if not paths or not os.path.exists(paths["hosts_file"]):
        raise Exception("hosts.yml not found")

    with open(paths["hosts_file"], "r", encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}

    all_hosts = data.setdefault("all", {}).setdefault("hosts", {})
    arms_hosts = data.setdefault("arms", {}).setdefault("hosts", {})
    servers_hosts = data.setdefault("servers", {}).setdefault("hosts", {})

    hostname = clean_value(values.get("name", ""))
    if not hostname:
        raise Exception("Имя хоста не указано")

    if hostname in all_hosts:
        raise Exception(f"Хост {hostname} уже существует")

    host_data = build_host_dict({}, values)
    all_hosts[hostname] = host_data

    group = clean_value(values.get("group", "")).lower()
    if group == "arm":
        arms_hosts[hostname] = {}
    elif group == "servers":
        servers_hosts[hostname] = {}
    else:
        raise Exception("Не указана группа host: arm или servers")

    save_hosts_yaml(paths["hosts_file"], data)


def delete_host(project_name, hostname):
    paths = get_project_paths(project_name)
    if not paths or not os.path.exists(paths["hosts_file"]):
        raise Exception("hosts.yml not found")

    with open(paths["hosts_file"], "r", encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}

    data.setdefault("all", {}).setdefault("hosts", {}).pop(hostname, None)
    data.setdefault("arms", {}).setdefault("hosts", {}).pop(hostname, None)
    data.setdefault("servers", {}).setdefault("hosts", {}).pop(hostname, None)

    save_hosts_yaml(paths["hosts_file"], data)

def read_file(path):
    if not os.path.exists(path):
        return ""

    with open(path, "r", encoding="utf-8") as f:
        return f.read()

def get_hosts_file_content(project_name):
    paths = get_project_paths(project_name)
    if not paths:
        return ""
    return read_file(paths["hosts_file"])


def get_defaults_file_content(project_name):
    paths = get_project_paths(project_name)
    if not paths:
        return ""
    return read_file(paths["defaults_file"])


def save_project_files(project_name, hosts_content, defaults_content):
    paths = get_project_paths(project_name)
    if not paths:
        raise Exception("Project not found")

    write_file(paths["hosts_file"], hosts_content)
    write_file(paths["defaults_file"], defaults_content)


def write_file(path, content):
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)


def is_host_up(ip):
    if not ip:
        return False

    try:
        result = subprocess.run(
            ["ping", "-c", "1", "-W", "1", ip],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL
        )
        return result.returncode == 0
    except:
        return False


def host_status_worker():
    global HOST_STATUS

    while True:
        try:
            all_result = {}

            for project in get_projects():
                hosts = parse_hosts(project)
                project_result = {}

                for group in ["servers", "arm"]:
                    for h in hosts[group]:
                        project_result[h["hostname"]] = is_host_up(h["ip"])

                all_result[project] = project_result

            with HOST_STATUS_LOCK:
                HOST_STATUS = all_result

        except Exception as e:
            log(f"HOST STATUS ERROR: {e}")

        time.sleep(60)


def get_host_status(project_name):
    with HOST_STATUS_LOCK:
        return dict(HOST_STATUS.get(project_name, {}))


def stop_all_processes():
    with PROC_LOCK:
        for p in CURRENT_PROCESSES:
            try:
                if p.poll() is None:
                    p.terminate()
            except:
                pass
        CURRENT_PROCESSES.clear()

    log("=== EXECUTION STOPPED ===")


def run(project_name, playbooks, hosts):
    paths = get_project_paths(project_name)

    if not paths:
        log(f"PROJECT NOT FOUND: {project_name}")
        return

    log(f"=== START [{project_name}] ===")

    for pb in playbooks:
        if pb["local"]:
            log(f"{pb['name']} (LOCAL)")

            cmd = ["ansible-playbook", "-i", "localhost,", "-c", "local", pb["path"], "-C"]
            p = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
                cwd=paths["project_dir"]
            )

            with PROC_LOCK:
                CURRENT_PROCESSES.append(p)

            for line in p.stdout:
                log(line.strip())

            p.wait()

            with PROC_LOCK:
                if p in CURRENT_PROCESSES:
                    CURRENT_PROCESSES.remove(p)

        else:
            if not hosts:
                log(f"Skipping {pb['name']} — no hosts selected")
                continue

            host_limit = ",".join(hosts)
            log(f"{pb['name']} → [{host_limit}]")

            cmd = ["ansible-playbook", "-i", paths["hosts_file"], pb["path"], "-l", host_limit, "-C"]
            p = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
                cwd=paths["project_dir"]
            )

            with PROC_LOCK:
                CURRENT_PROCESSES.append(p)

            for line in p.stdout:
                log(line.strip())

            p.wait()

            with PROC_LOCK:
                if p in CURRENT_PROCESSES:
                    CURRENT_PROCESSES.remove(p)

    log(f"=== DONE [{project_name}] ===")

class Handler(BaseHTTPRequestHandler):

    def send_json(self, data, code=200):
        body = json.dumps(data).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, filepath, content_type="text/plain; charset=utf-8"):
        if not os.path.exists(filepath):
            self.send_error(404)
            return

        with open(filepath, "rb") as f:
            body = f.read()

        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        path_only = parsed.path

        if path_only == "/":
            self.send_response(302)
            self.send_header("Location", "/main")
            self.end_headers()

        elif path_only == "/main":
            self.send_file(os.path.join(PUBLIC_DIR, "main.html"), "text/html; charset=utf-8")

        elif path_only == "/hosts_info":
            self.send_file(os.path.join(PUBLIC_DIR, "hosts_info.html"), "text/html; charset=utf-8")

        elif path_only == "/editor":
            self.send_file(os.path.join(PUBLIC_DIR, "editor.html"), "text/html; charset=utf-8")

        elif path_only == "/style.css":
            self.send_file(os.path.join(PUBLIC_DIR, "style.css"), "text/css; charset=utf-8")

        elif path_only == "/common.js":
            self.send_file(os.path.join(PUBLIC_DIR, "common.js"), "application/javascript; charset=utf-8")

        elif path_only == "/main.js":
            self.send_file(os.path.join(PUBLIC_DIR, "main.js"), "application/javascript; charset=utf-8")

        elif path_only == "/hosts_info.js":
            self.send_file(os.path.join(PUBLIC_DIR, "hosts_info.js"), "application/javascript; charset=utf-8")

        elif path_only == "/editor.js":
            self.send_file(os.path.join(PUBLIC_DIR, "editor.js"), "application/javascript; charset=utf-8")

        elif path_only == "/data":
            q = parse_qs(parsed.query)
            project = q.get("project", [""])[0]

            self.send_json({
                "projects": get_projects(),
                "selected_project": project,
                "hosts": parse_hosts(project),
                "playbooks": get_playbooks(project),
                "autodeploy": get_autodeploy(project),
                "local_ip": get_local_ip(),
                "status": get_host_status(project)
            })

        elif path_only == "/status":
            q = parse_qs(parsed.query)
            project = q.get("project", [""])[0]
            self.send_json(get_host_status(project))

        elif path_only == "/log_new":
            try:
                q = parse_qs(parsed.query)
                start = int(q.get("start", [0])[0])
            except:
                start = 0

            with LOCK:
                lines = LOG[start:]
                next_index = len(LOG)

            self.send_json({
                "lines": lines,
                "next": next_index
            })

        elif path_only == "/files":
            q = parse_qs(parsed.query)
            project = q.get("project", [""])[0]

            self.send_json({
                "hosts": get_hosts_file_content(project),
                "defaults": get_defaults_file_content(project)
            })

        elif path_only == "/hwtypes":
            q = parse_qs(parsed.query)
            project = q.get("project", [""])[0]
            self.send_json(get_hwtype_templates(project))

        elif path_only == "/background":
            self.send_file(BACKGROUND_IMAGE, "image/png")

        else:
            self.send_error(404)

    def do_POST(self):
        parsed = urlparse(self.path)
        path_only = parsed.path

        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length)

        try:
            data = json.loads(raw.decode("utf-8")) if raw else {}
        except:
            data = {}

        if path_only == "/run":
            project = data.get("project", "")
            allpbs = get_playbooks(project) + get_autodeploy(project)
            selected = [x for x in allpbs if x["name"] in data.get("playbooks", [])]
            hosts = data.get("hosts", [])

            threading.Thread(target=run, args=(project, selected, hosts), daemon=True).start()
            self.send_json({"ok": True})

        elif path_only == "/run_autodeploy":
            project = data.get("project", "")
            autodeploy = get_autodeploy(project)
            threading.Thread(target=run, args=(project, autodeploy, []), daemon=True).start()
            self.send_json({"ok": True})

        elif path_only == "/stop":
            stop_all_processes()
            self.send_json({"ok": True})

        elif path_only == "/update_host":
            try:
                project = data.get("project", "")
                hostname = data.get("hostname", "")
                values = data.get("values", {})
                update_host(project, hostname, values)
                log(f"Host updated [{project}] {hostname}")
                self.send_json({"ok": True})
            except Exception as e:
                self.send_json({"ok": False, "error": str(e)}, 500)

        elif path_only == "/add_host":
            try:
                project = data.get("project", "")
                values = data.get("values", {})
                add_host(project, values)
                log(f"Host added [{project}] {values.get('name', '')}")
                self.send_json({"ok": True})
            except Exception as e:
                self.send_json({"ok": False, "error": str(e)}, 500)

        elif path_only == "/delete_host":
            try:
                project = data.get("project", "")
                hostname = data.get("hostname", "")
                values = data.get("values", {})
                update_host(project, hostname)
                log(f"Host deleted [{project}] {hostname}")
                self.send_json({"ok": True})
            except Exception as e:
                self.send_json({"ok": False, "error": str(e)}, 500)


        elif path_only == "/save_files":
            try:
                project = data.get("project", "")
                save_project_files(project, data.get("hosts", ""), data.get("defaults", ""))
                log(f"hosts.yml / defaults.yml updated [{project}]")
                self.send_json({"ok": True})
            except Exception as e:
                self.send_json({"ok": False, "error": str(e)}, 500)

        else:
            self.send_error(404)


if __name__ == "__main__":
    threading.Thread(target=host_status_worker, daemon=True).start()
    print("OPEN http://127.0.0.1:8000")
    HTTPServer(("0.0.0.0", 8000), Handler).serve_forever()
