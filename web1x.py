#!/usr/bin/env python3
import os,json,yaml,socket,subprocess,threading,time
from http.server import HTTPServer,BaseHTTPRequestHandler
from urllib.parse import urlparse,parse_qs
from datetime import datetime

BASE_DIR=os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR=os.path.join(BASE_DIR,"public")
PROJECTS_ROOT=os.environ.get("ANSIBLE_PROJECTS_ROOT","/opt/home/projects")
BACKGROUND_IMAGE=os.path.join(BASE_DIR,"logo.png")
LOG=[]; LOG_LOCK=threading.Lock(); PROCESSES=[]; PROC_LOCK=threading.Lock(); HOST_STATUS={}; STATUS_LOCK=threading.Lock()

def safe(v): return os.path.basename(v or "")
def project_dir(project): return os.path.join(PROJECTS_ROOT,safe(project)) if safe(project) else None

def get_projects():
    if not os.path.isdir(PROJECTS_ROOT): return []
    out=[]
    for n in sorted(os.listdir(PROJECTS_ROOT)):
        p=project_dir(n)
        if os.path.isdir(p) and os.path.isdir(os.path.join(p,"global")) and os.path.isdir(os.path.join(p,"object")) and os.path.isdir(os.path.join(p,"roles")): out.append(n)
    return out

def get_objects(project):
    root=os.path.join(project_dir(project) or "","object")
    if not os.path.isdir(root): return []
    return [n for n in sorted(os.listdir(root)) if os.path.isdir(os.path.join(root,n))]

def object_dir(project,obj):
    if not project or not obj or obj not in get_objects(project): return None
    return os.path.join(project_dir(project),"object",safe(obj))

def find_file(root,names):
    for n in names:
        p=os.path.join(root,n)
        if os.path.isfile(p): return p
    return os.path.join(root,names[0])

def paths(project,obj):
    root=object_dir(project,obj)
    if not root: return None
    return {"object_dir":root,"hosts":find_file(root,["hosts.yml","hosts.yaml","hosts","inventory.yml"]),"defaults":find_file(root,["defaults.yml","defaults.yaml","defaults"]),"cfg":os.path.join(root,"ansible.cfg")}

def log(msg):
    with LOG_LOCK:
        LOG.append(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}")
        del LOG[:-500]

def read(p):
    try:
        with open(p,"r",encoding="utf-8") as f:return f.read()
    except:return ""

def write(p,s):
    os.makedirs(os.path.dirname(p),exist_ok=True)
    with open(p,"w",encoding="utf-8") as f:f.write(s)

def mask_cidr(mask):
    try:return str(sum(bin(int(x))[2:].zfill(8).count("1") for x in str(mask).split(".")))
    except:return ""

def parse_hosts(project,obj):
    ps=paths(project,obj)
    result={"servers":[],"arm":[]}
    if not ps or not os.path.exists(ps["hosts"]):return result
    try:
        data=yaml.safe_load(read(ps["hosts"])) or {}
    except Exception as e:
        log(f"HOSTS YAML ERROR: {e}"); return result
    all_hosts=data.get("all",{}).get("hosts",{}) or {}
    arms=set((data.get("arms",{}) or {}).get("hosts",{}) or {})
    servers=set((data.get("servers",{}) or {}).get("hosts",{}) or {})
    for hostname,vars in all_hosts.items():
        vars=vars or {}
        h={"hostname":hostname,"name":vars.get("name",""),"description":vars.get("description",""),"ip":vars.get("ansible_host",""),"mac":vars.get("mac",""),"mask":vars.get("mask",""),"mask_cidr":mask_cidr(vars.get("mask","")),"gate":vars.get("gate",""),"hwtype":vars.get("hwtype","")}
        result["arm" if hostname in arms else "servers"].append(h)
    return result

def get_playbooks(project,obj):
    root=object_dir(project,obj)
    if not root:return []
    out=[]
    for n in sorted(os.listdir(root)):
        p=os.path.join(root,n)
        if os.path.isfile(p) and n.lower().endswith((".yml",".yaml")) and n not in {"hosts.yml","hosts.yaml","defaults.yml","defaults.yaml","inventory.yml"} and not n.startswith("."):
            out.append({"name":n,"path":p})
    return out

def get_hwtypes(project):
    root=project_dir(project)
    if not root:return []
    out=[]
    for base,_,files in os.walk(os.path.join(root,"roles")):
        for f in files:
            if f.endswith(".j2") and f[:-3] not in out:out.append(f[:-3])
    return sorted(out)

def host_up(ip):
    if not ip:return False
    try:return subprocess.run(["ping","-c","1","-W","1",str(ip)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0
    except:return False

def status_worker():
    global HOST_STATUS
    while True:
        result={}
        for p in get_projects():
            result[p]={}
            for o in get_objects(p):
                result[p][o]={h["hostname"]:host_up(h["ip"]) for g in parse_hosts(p,o).values() for h in g}
        with STATUS_LOCK:HOST_STATUS=result
        time.sleep(60)

def host_status(project,obj):
    with STATUS_LOCK:return dict(HOST_STATUS.get(project,{}).get(obj,{}))

def build_host(old,vals):
    old=old or {}; r={"ansible_host":str(vals.get("ip",old.get("ansible_host",""))).strip(),"ansible_port":old.get("ansible_port",22),"ansible_user":old.get("ansible_user",""),"ansible_password":old.get("ansible_password",""),"ansible_become":old.get("ansible_become",True),"ansible_become_pass":old.get("ansible_become_pass","")}
    for k in ("description","mac","gate","mask","hwtype"):
        v=str(vals.get(k,old.get(k,"")) or "").strip()
        if v:r[k]=v
    r["uefi"]=old.get("uefi",True); return r

def save_host(project,obj,old_name,vals):
    ps=paths(project,obj)
    if not ps:raise Exception("Object not found")
    data=yaml.safe_load(read(ps["hosts"])) or {}
    allh=data.setdefault("all",{}).setdefault("hosts",{}); arms=data.setdefault("arms",{}).setdefault("hosts",{}); servers=data.setdefault("servers",{}).setdefault("hosts",{})
    if old_name not in allh:raise Exception("Host not found")
    new_name=str(vals.get("name") or old_name).strip(); old=allh[old_name]
    allh.pop(old_name); allh[new_name]=build_host(old,vals); arms.pop(old_name,None); servers.pop(old_name,None)
    group=str(vals.get("group","servers")).lower(); (arms if group=="arm" else servers)[new_name]={}
    yaml.safe_dump(data,open(ps["hosts"],"w",encoding="utf-8"),allow_unicode=True,sort_keys=False)

def add_host(project,obj,vals):
    ps=paths(project,obj); data=yaml.safe_load(read(ps["hosts"])) or {}; allh=data.setdefault("all",{}).setdefault("hosts",{}); name=str(vals.get("name","")).strip()
    if not name:raise Exception("Имя хоста не указано")
    if name in allh:raise Exception("Хост уже существует")
    allh[name]=build_host({},vals); group=str(vals.get("group","servers")).lower(); data.setdefault("arms",{}).setdefault("hosts",{})[name]={} if group=="arm" else data.setdefault("arms",{}).setdefault("hosts",{}).get(name,{})
    if group!="arm": data.setdefault("arms",{}).setdefault("hosts",{}).pop(name,None); data.setdefault("servers",{}).setdefault("hosts",{})[name]={}
    yaml.safe_dump(data,open(ps["hosts"],"w",encoding="utf-8"),allow_unicode=True,sort_keys=False)

def delete_host(project,obj,name):
    ps=paths(project,obj); data=yaml.safe_load(read(ps["hosts"])) or {}
    for g in ("all","arms","servers"): data.setdefault(g,{}).setdefault("hosts",{}).pop(name,None)
    yaml.safe_dump(data,open(ps["hosts"],"w",encoding="utf-8"),allow_unicode=True,sort_keys=False)

def run_playbooks(project,obj,names,hosts):
    ps=paths(project,obj)
    if not ps:return
    root=ps["object_dir"]
    for name in names:
        if name not in [p["name"] for p in get_playbooks(project,obj)]:continue
        pb=os.path.join(root,name); log(f"=== START {name} [{project}/{obj}] ===")
        cmd=["ansible-playbook","-i",ps["hosts"],pb]
        if hosts:cmd += ["-l",",".join(hosts)]
        env=os.environ.copy(); env["ANSIBLE_CONFIG"]=ps["cfg"] if os.path.isfile(ps["cfg"]) else env.get("ANSIBLE_CONFIG","")
        try:
            p=subprocess.Popen(cmd,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,bufsize=1,cwd=root,env=env)
            with PROC_LOCK:PROCESSES.append(p)
            for line in p.stdout:log(line.rstrip())
            code=p.wait(); log(f"=== DONE {name}: rc={code} ===")
        except Exception as e:log(f"EXECUTION ERROR {name}: {e}")
        finally:
            with PROC_LOCK:
                if 'p' in locals() and p in PROCESSES:PROCESSES.remove(p)

def stop():
    with PROC_LOCK:
        for p in PROCESSES:
            try:p.terminate()
            except:pass
        PROCESSES.clear()
    log("=== EXECUTION STOPPED ===")

class Handler(BaseHTTPRequestHandler):
    def json(self,d,code=200):
        b=json.dumps(d,ensure_ascii=False).encode(); self.send_response(code); self.send_header("Content-Type","application/json; charset=utf-8"); self.send_header("Content-Length",str(len(b))); self.end_headers(); self.wfile.write(b)
    def file(self,p,ct):
        if not os.path.isfile(p):self.send_error(404);return
        b=open(p,"rb").read(); self.send_response(200); self.send_header("Content-Type",ct); self.send_header("Content-Length",str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        u=urlparse(self.path); q=parse_qs(u.query); project=q.get("project",[""])[0]; obj=q.get("object",[""])[0]
        static={"/":"main.html","/main":"main.html","/hosts_info":"hosts_info.html","/editor":"editor.html","/style.css":"style.css","/common.js":"common.js","/main.js":"main.js","/hosts_info.js":"hosts_info.js","/editor.js":"editor.js","/background":None}
        if u.path in static:
            if u.path=="/": self.send_response(302); self.send_header("Location","/main"); self.end_headers(); return
            if u.path=="/background":self.file(BACKGROUND_IMAGE,"image/png");return
            ct="text/html; charset=utf-8" if u.path in ("/main","/hosts_info","/editor") else "application/javascript; charset=utf-8" if u.path.endswith(".js") else "text/css; charset=utf-8"
            self.file(os.path.join(PUBLIC_DIR,static[u.path]),ct);return
        if u.path=="/data":
            hs=parse_hosts(project,obj); self.json({"projects":get_projects(),"objects":get_objects(project),"selected_project":project,"selected_object":obj,"hosts":hs,"playbooks":get_playbooks(project,obj),"local_ip":socket.gethostbyname(socket.gethostname()),"status":host_status(project,obj)});return
        if u.path=="/status":self.json(host_status(project,obj));return
        if u.path=="/hwtypes":self.json(get_hwtypes(project));return
        if u.path=="/log_new":
            try:start=int(q.get("start",[0])[0])
            except:start=0
            with LOG_LOCK:lines=LOG[start:]; nxt=len(LOG)
            self.json({"lines":lines,"next":nxt});return
        if u.path=="/files":
            ps=paths(project,obj); self.json({"hosts":read(ps["hosts"]) if ps else "","defaults":read(ps["defaults"]) if ps else ""});return
        if u.path=="/playbook":
            name=q.get("name",[""])[0]; ps=paths(project,obj); p=os.path.join(ps["object_dir"],safe(name)) if ps else ""; self.json({"name":name,"content":read(p) if os.path.isfile(p) else ""});return
        self.send_error(404)
    def do_POST(self):
        u=urlparse(self.path); n=int(self.headers.get("Content-Length",0)); raw=self.rfile.read(n)
        try:d=json.loads(raw.decode()) if raw else {}
        except:d={}
        project=d.get("project",""); obj=d.get("object","")
        try:
            if u.path=="/run":threading.Thread(target=run_playbooks,args=(project,obj,d.get("playbooks",[]),d.get("hosts",[])),daemon=True).start(); self.json({"ok":True});return
            if u.path=="/stop":stop();self.json({"ok":True});return
            if u.path=="/save_playbook":
                ps=paths(project,obj); name=safe(d.get("name")); p=os.path.join(ps["object_dir"],name); write(p,d.get("content","")); log(f"Saved {project}/{obj}/{name}");self.json({"ok":True});return
            if u.path=="/save_files":
                ps=paths(project,obj);write(ps["hosts"],d.get("hosts",""));write(ps["defaults"],d.get("defaults",""));self.json({"ok":True});return
            if u.path=="/update_host":save_host(project,obj,d.get("hostname",""),d.get("values",{}));self.json({"ok":True});return
            if u.path=="/add_host":add_host(project,obj,d.get("values",{}));self.json({"ok":True});return
            if u.path=="/delete_host":delete_host(project,obj,d.get("hostname",""));self.json({"ok":True});return
        except Exception as e:self.json({"ok":False,"error":str(e)},500);return
        self.send_error(404)

if __name__=="__main__":
    threading.Thread(target=status_worker,daemon=True).start()
    print("OPEN http://127.0.0.1:8000")
    HTTPServer(("0.0.0.0",8000),Handler).serve_forever()
