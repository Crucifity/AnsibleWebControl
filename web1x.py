#!/usr/bin/env python3
import json,os,socket,subprocess,threading,time
from datetime import datetime
from http.server import BaseHTTPRequestHandler,HTTPServer
from urllib.parse import parse_qs,urlparse
import yaml
BASE_DIR=os.path.dirname(os.path.abspath(__file__));PUBLIC_DIR=os.path.join(BASE_DIR,'public');PROJECTS_ROOT=os.environ.get('ANSIBLE_PROJECTS_ROOT','/opt/home/projects')
LOG=[];LOG_LOCK=threading.Lock();PROCESSES=[];PROC_LOCK=threading.Lock();HOST_STATUS={};STATUS_LOCK=threading.Lock();TEMPLATES={14:'Хост шаблон-1',13:'Хост шаблон-2',11:'МД шаблон-1',5:'МД шаблон-2',7:'СИ шаблон-1'}
def safe(v):return os.path.basename(v or '')
def project_dir(p):return os.path.join(PROJECTS_ROOT,safe(p)) if p else None
def single_project(p):return bool(p and os.path.isdir(os.path.join(project_dir(p),'playbooks')))
def get_projects():return sorted(n for n in os.listdir(PROJECTS_ROOT) if os.path.isdir(project_dir(n))) if os.path.isdir(PROJECTS_ROOT) else []
def get_objects(p):
 if single_project(p):return []
 d=os.path.join(project_dir(p) or '','object');return sorted(n for n in os.listdir(d) if os.path.isdir(os.path.join(d,n))) if os.path.isdir(d) else []
def object_dir(p,o):
 if single_project(p):return os.path.join(project_dir(p),'playbooks')
 if not p or not o or o not in get_objects(p):return None
 return os.path.join(project_dir(p),'object',safe(o))
def read(path):
 try:
  with open(path,encoding='utf-8') as f:return f.read()
 except OSError:return ''
def write(path,content):
 os.makedirs(os.path.dirname(path),exist_ok=True)
 with open(path,'w',encoding='utf-8') as f:f.write(content)
def paths(p,o):
 d=object_dir(p,o)
 if not d:return None
 def first(names):
  for n in names:
   x=os.path.join(d,n)
   if os.path.isfile(x):return x
  return os.path.join(d,names[0])
 return {'object_dir':d,'hosts':first(['hosts.yml','hosts.yaml','hosts','inventory.yml']),'defaults':first(['defaults.yml','defaults.yaml','defaults']),'cfg':os.path.join(d,'ansible.cfg')}
def roles_dir(p,o):
 d=object_dir(p,o);return os.path.join(d,'roles') if d else None
def log(msg):
 with LOG_LOCK:LOG.append(f'[{datetime.now():%H:%M:%S}] {msg}');del LOG[:-1000]
def load_inventory(p,o):
 fp=paths(p,o)
 if not fp or not os.path.exists(fp['hosts']):return {}
 try:return yaml.safe_load(read(fp['hosts'])) or {}
 except yaml.YAMLError as e:log(f'HOSTS YAML ERROR: {e}');return {}
def load_hosts(p,o):return load_inventory(p,o).get('all',{}).get('hosts',{}) or {}
def classify_node(params):
 keys=list(params) if isinstance(params,dict) else [];c=len(keys)
 if c in TEMPLATES:
  t=TEMPLATES[c];return ('md' if t.startswith('МД') else 'si' if t.startswith('СИ') else 'host'),t
 last=keys[-1] if keys else '';return ('host','Хост') if last=='uefi' else ('md','МД') if last=='Description' else ('unknown','Узел')
def parse_hosts(p,o):
 out=[]
 for name,raw in load_hosts(p,o).items():
  params=dict(raw) if isinstance(raw,dict) else {};typ,tpl=classify_node(params);out.append({'hostname':name,'parameters':params,'node_type':typ,'template':tpl,'ip':params.get('ansible_host',params.get('ip',''))})
 return out
def template_schemas(p,o):
 out={}
 for n in parse_hosts(p,o):
  if n['template'] not in ('Хост','МД','Узел') and n['template'] not in out:out[n['template']]=list(n['parameters'])
 return out
def inventory_groups(p,o):
 data=load_inventory(p,o);wanted={'arms','servers','md'};out={}
 def collect(v):
  found=set()
  if isinstance(v,dict):
   h=v.get('hosts',{});found.update(h.keys() if isinstance(h,dict) else [])
   for c in (v.get('children',{}) or {}).values():found.update(collect(c))
  return found
 for n,v in data.items():
  if n in wanted:out[n]=sorted(collect(v))
 a=data.get('all',{}) if isinstance(data,dict) else {}
 for n,v in (a.get('children',{}) or {}).items():
  if n in wanted:out[n]=sorted(collect(v))
 return [{'name':n,'hosts':h} for n,h in out.items() if h]
def save_hosts(path,data):write(path,yaml.safe_dump(data,allow_unicode=True,sort_keys=False,default_flow_style=False))
def scalar(v):
 if not isinstance(v,str):return v
 s=v.strip();low=s.lower()
 if low in ('true','false'):return low=='true'
 if low in ('null','~'):return None
 try:return int(s) if s else v
 except ValueError:return v
def save_host(p,o,old,new,values):
 fp=paths(p,o);data=load_inventory(p,o);hosts=data.setdefault('all',{}).setdefault('hosts',{})
 if old not in hosts:raise ValueError('Узел не найден')
 if new!=old and new in hosts:raise ValueError('Узел с таким именем уже существует')
 updated=dict(hosts[old]) if isinstance(hosts[old],dict) else {}
 for k,v in values.items():updated[k]=scalar(v)
 hosts.pop(old);hosts[new]=updated;save_hosts(fp['hosts'],data)
def add_host(p,o,name,values):
 fp=paths(p,o);data=load_inventory(p,o);hosts=data.setdefault('all',{}).setdefault('hosts',{})
 if not name:raise ValueError('Имя узла не указано')
 if name in hosts:raise ValueError('Узел уже существует')
 hosts[name]={k:scalar(v) for k,v in values.items()};save_hosts(fp['hosts'],data)
def delete_host(p,o,name):
 fp=paths(p,o);data=load_inventory(p,o);hosts=data.setdefault('all',{}).setdefault('hosts',{})
 if name not in hosts:raise ValueError('Узел не найден')
 hosts.pop(name);save_hosts(fp['hosts'],data)
def get_playbooks(p,o):
 d=object_dir(p,o)
 if not d or not os.path.isdir(d):return []
 excluded={'hosts.yml','hosts.yaml','inventory.yml','defaults.yml','defaults.yaml','ansible.cfg'}
 return [{'name':n,'path':os.path.join(d,n),'type':'playbook'} for n in sorted(os.listdir(d)) if os.path.isfile(os.path.join(d,n)) and n.lower().endswith(('.yml','.yaml')) and n not in excluded]
def roles_tree(p,o):
 root=roles_dir(p,o)
 if not root or not os.path.isdir(root):return []
 def walk(d):
  out=[]
  for n in sorted(os.listdir(d),key=str.lower):
   path=os.path.join(d,n);rel=os.path.relpath(path,root)
   out.append({'name':n,'type':'dir','path':rel,'children':walk(path)} if os.path.isdir(path) else {'name':n,'type':'file','path':rel})
  return out
 return walk(root)
def role_file(p,o,rel):
 root=roles_dir(p,o)
 if not root:return None
 root=os.path.abspath(root);path=os.path.abspath(os.path.join(root,rel))
 return path if path.startswith(root+os.sep) and os.path.isfile(path) else None
def autodeploy(p):
 x=os.path.join(project_dir(p) or '','autodeploy','autodeploy.yml');return x if os.path.isfile(x) else None
def host_up(ip):
 try:return bool(ip) and subprocess.run(['ping','-c','1','-W','1',str(ip)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0
 except OSError:return False
def status_worker():
 global HOST_STATUS
 while True:
  r={}
  for p in get_projects():
   for o in (get_objects(p) or [None]):r.setdefault(p,{})[o or '']={n['hostname']:host_up(n['ip']) for n in parse_hosts(p,o)}
  with STATUS_LOCK:HOST_STATUS=r
  time.sleep(60)
def status(p,o):
 with STATUS_LOCK:return dict(HOST_STATUS.get(p,{}).get(o or '',{}))
def run_playbook(cmd,p,o,name,cwd,cfg,label=None):
 title=label or name;log(f'=== START {title} [{p}{("/"+o) if o else ""}] ===');proc=None
 try:
  env=os.environ.copy()
  if os.path.isfile(cfg):env['ANSIBLE_CONFIG']=cfg
  proc=subprocess.Popen(cmd,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,bufsize=1,cwd=cwd,env=env)
  with PROC_LOCK:PROCESSES.append(proc)
  for line in proc.stdout:log(line.rstrip())
  log(f'=== DONE {title}: rc={proc.wait()} ===')
 except OSError as e:log(f'EXECUTION ERROR: {e}')
 finally:
  if proc:
   with PROC_LOCK:
    if proc in PROCESSES:PROCESSES.remove(proc)
def run_command(p,o,names,hosts):
 fp=paths(p,o);available={x['name']:x['path'] for x in get_playbooks(p,o)}
 if not fp:return
 for n in names:
  if n in available:run_playbook(['ansible-playbook','-i',fp['hosts'],available[n]]+(['-l',','.join(hosts)] if hosts else []),p,o,n,os.path.dirname(available[n]),fp['cfg'])
def run_autodeploy(p,hosts):
 x=autodeploy(p)
 if not x:return
 fp=paths(p,None);run_playbook(['ansible-playbook',x]+(['-l',','.join(hosts)] if hosts else []),p,None,'autodeploy.yml',os.path.dirname(x),fp['cfg'])
def stop():
 with PROC_LOCK:
  for p in PROCESSES:
   try:p.terminate()
   except OSError:pass
  PROCESSES.clear()
 log('=== EXECUTION STOPPED ===')
class Handler(BaseHTTPRequestHandler):
 def json(self,d,code=200):
  b=json.dumps(d,ensure_ascii=False).encode();self.send_response(code);self.send_header('Content-Type','application/json; charset=utf-8');self.send_header('Content-Length',str(len(b)));self.end_headers();self.wfile.write(b)
 def file(self,path,typ):
  if not os.path.isfile(path):self.send_error(404);return
  with open(path,'rb') as f:b=f.read()
  self.send_response(200);self.send_header('Content-Type',typ);self.send_header('Content-Length',str(len(b)));self.end_headers();self.wfile.write(b)
 def do_GET(self):
  u=urlparse(self.path);q=parse_qs(u.query);p=q.get('project',[''])[0];o=q.get('object',[''])[0]
  static={'/main':'main.html','/hosts_info':'hosts_info.html','/editor':'editor.html','/style.css':'style.css','/common.js':'common.js','/main.js':'main.js','/hosts_info.js':'hosts_info.js','/editor.js':'editor.js'}
  if u.path in static:
   f=static[u.path];self.file(os.path.join(PUBLIC_DIR,f),'text/html; charset=utf-8' if f.endswith('.html') else 'text/css; charset=utf-8' if f.endswith('.css') else 'application/javascript; charset=utf-8');return
  if u.path=='/background':self.file(os.path.join(BASE_DIR,'logo.png'),'image/png');return
  if u.path=='/data':
   hosts=parse_hosts(p,o);a=autodeploy(p);self.json({'projects':get_projects(),'objects':get_objects(p),'single_object_mode':single_project(p),'selected_project':p,'selected_object':o,'hosts':hosts,'status':status(p,o),'groups':inventory_groups(p,o),'template_schemas':template_schemas(p,o),'playbooks':get_playbooks(p,o),'autodeploy':bool(a),'autodeploy_playbook':'autodeploy.yml' if a else None,'roles':roles_tree(p,o)});return
  if u.path=='/roles':self.json(roles_tree(p,o));return
  if u.path=='/role_file':
   path=role_file(p,o,q.get('path',[''])[0])
   if not path:self.send_error(404);return
   self.json({'path':q.get('path',[''])[0],'content':read(path),'name':os.path.basename(path)});return
  if u.path=='/status':self.json(status(p,o));return
  if u.path=='/log_new':
   try:s=int(q.get('start',['0'])[0])
   except ValueError:s=0
   with LOG_LOCK:lines=LOG[s:];n=len(LOG)
   self.json({'lines':lines,'next':n});return
  if u.path=='/playbook':
   n=safe(q.get('name',[''])[0]);fp=paths(p,o);items=get_playbooks(p,o);base=fp['object_dir'] if fp else ''
   self.json({'name':n,'content':read(os.path.join(base,n)) if base else ''});return
  if u.path=='/files':
   fp=paths(p,o);self.json({'hosts':read(fp['hosts']) if fp else '','defaults':read(fp['defaults']) if fp else ''});return
  self.send_error(404)
 def do_POST(self):
  try:d=json.loads(self.rfile.read(int(self.headers.get('Content-Length',0))).decode() or '{}')
  except Exception:d={}
  p=d.get('project','');o=d.get('object','')
  try:
   if self.path=='/run':threading.Thread(target=run_command,args=(p,o,d.get('playbooks',[]),d.get('hosts',[])),daemon=True).start();self.json({'ok':True});return
   if self.path=='/run_autodeploy':threading.Thread(target=run_autodeploy,args=(p,d.get('hosts',[])),daemon=True).start();self.json({'ok':True});return
   if self.path=='/stop':stop();self.json({'ok':True});return
   if self.path=='/update_host':save_host(p,o,d.get('hostname',''),d.get('new_hostname',d.get('hostname','')),d.get('values',{}));self.json({'ok':True});return
   if self.path=='/add_host':add_host(p,o,d.get('hostname',''),d.get('values',{}));self.json({'ok':True});return
   if self.path=='/delete_host':delete_host(p,o,d.get('hostname',''));self.json({'ok':True});return
   if self.path=='/save_playbook':
    fp=paths(p,o);write(os.path.join(fp['object_dir'],safe(d.get('name'))),d.get('content',''));self.json({'ok':True});return
   if self.path=='/save_files':
    fp=paths(p,o);write(fp['hosts'],d.get('hosts',''));write(fp['defaults'],d.get('defaults',''));self.json({'ok':True});return
  except (OSError,ValueError) as e:self.json({'ok':False,'error':str(e)},500);return
  self.send_error(404)
if __name__=='__main__':threading.Thread(target=status_worker,daemon=True).start();HTTPServer(('0.0.0.0',8000),Handler).serve_forever()