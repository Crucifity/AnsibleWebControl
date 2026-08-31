#!/usr/bin/env python3
import os,json,yaml,socket,subprocess,threading,time
from http.server import HTTPServer,BaseHTTPRequestHandler
from urllib.parse import urlparse,parse_qs
from datetime import datetime
BASE_DIR=os.path.dirname(os.path.abspath(__file__)); PUBLIC_DIR=os.path.join(BASE_DIR,'public'); PROJECTS_ROOT=os.environ.get('ANSIBLE_PROJECTS_ROOT','/opt/home/projects')
LOG=[];LOG_LOCK=threading.Lock();PROCESSES=[];PROC_LOCK=threading.Lock();HOST_STATUS={};STATUS_LOCK=threading.Lock()
def safe(v):return os.path.basename(v or '')
def project_dir(p):return os.path.join(PROJECTS_ROOT,safe(p)) if safe(p) else None
def get_projects():
 r=[]
 if os.path.isdir(PROJECTS_ROOT):
  for n in sorted(os.listdir(PROJECTS_ROOT)):
   d=project_dir(n)
   if os.path.isdir(d) and all(os.path.isdir(os.path.join(d,x)) for x in ('global','object','roles')):r.append(n)
 return r
def get_objects(p):
 r=os.path.join(project_dir(p) or '','object');return sorted(x for x in os.listdir(r) if os.path.isdir(os.path.join(r,x))) if os.path.isdir(r) else []
def object_dir(p,o):return os.path.join(project_dir(p),'object',safe(o)) if p and o and o in get_objects(p) else None
def read(p):
 try:
  with open(p,encoding='utf-8') as f:return f.read()
 except:return ''
def write(p,s):os.makedirs(os.path.dirname(p),exist_ok=True);open(p,'w',encoding='utf-8').write(s)
def paths(p,o):
 r=object_dir(p,o)
 if not r:return None
 def first(ns):
  for n in ns:
   q=os.path.join(r,n)
   if os.path.isfile(q):return q
  return os.path.join(r,ns[0])
 return {'object_dir':r,'hosts':first(['hosts.yml','hosts.yaml','hosts','inventory.yml']),'defaults':first(['defaults.yml','defaults.yaml','defaults']),'cfg':os.path.join(r,'ansible.cfg')}
def log(s):
 with LOG_LOCK:LOG.append(f'[{datetime.now():%H:%M:%S}] {s}');del LOG[:-1000]
def load_hosts(project,obj):
 ps=paths(project,obj)
 if not ps or not os.path.exists(ps['hosts']):return {}
 try:
  data=yaml.safe_load(read(ps['hosts'])) or {};return data.get('all',{}).get('hosts',{}) or {}
 except Exception as e:log(f'HOSTS YAML ERROR: {e}');return {}
def parse_hosts(project,obj):
 result=[]
 for hostname,raw in load_hosts(project,obj).items():
  params=dict(raw) if isinstance(raw,dict) else {}
  result.append({'hostname':hostname,'parameters':params})
 return result
def save_hosts(path,data):
 text=yaml.safe_dump(data,allow_unicode=True,sort_keys=False,default_flow_style=False)
 # Insert a blank line between top-level host entries under all.hosts.
 lines=text.splitlines();out=[];in_all_hosts=False
 for line in lines:
  if line=='  hosts:':in_all_hosts=True
  elif in_all_hosts and line.startswith('    ') and line.endswith(':') and not line.startswith('      '):
   if out and out[-1]!='':out.append('')
  out.append(line)
 write(path,'\n'.join(out)+'\n')
def scalar(v):
 if not isinstance(v,str):return v
 s=v.strip();lo=s.lower()
 if lo in ('true','false'):return lo=='true'
 if lo in ('null','~'):return None
 try:return int(s) if s and (s.isdigit() or s[0]=='-' and s[1:].isdigit()) else v
 except:return v
def save_host(project,obj,old_name,new_name,values):
 ps=paths(project,obj);data=yaml.safe_load(read(ps['hosts'])) or {};hosts=data.setdefault('all',{}).setdefault('hosts',{})
 if old_name not in hosts:raise ValueError('Хост не найден')
 if new_name!=old_name and new_name in hosts:raise ValueError('Хост с таким именем уже существует')
 old=hosts[old_name] if isinstance(hosts[old_name],dict) else {};merged=dict(old)
 for k,v in values.items():merged[k]=scalar(v)
 hosts.pop(old_name);hosts[new_name]=merged;save_hosts(ps['hosts'],data)
def add_host(project,obj,name,values):
 ps=paths(project,obj);data=yaml.safe_load(read(ps['hosts'])) or {};hosts=data.setdefault('all',{}).setdefault('hosts',{})
 if not name:raise ValueError('Имя хоста не указано')
 if name in hosts:raise ValueError('Хост уже существует')
 hosts[name]={k:scalar(v) for k,v in values.items()};save_hosts(ps['hosts'],data)
def delete_host(project,obj,name):
 ps=paths(project,obj);data=yaml.safe_load(read(ps['hosts'])) or {};hosts=data.setdefault('all',{}).setdefault('hosts',{})
 if name not in hosts:raise ValueError('Хост не найден')
 hosts.pop(name);save_hosts(ps['hosts'],data)
def get_playbooks(p,o):
 r=object_dir(p,o);out=[]
 if r:
  for n in sorted(os.listdir(r)):
   if os.path.isfile(os.path.join(r,n)) and n.lower().endswith(('.yml','.yaml')) and n not in ('hosts.yml','hosts.yaml','inventory.yml','defaults.yml','defaults.yaml'):out.append({'name':n,'path':os.path.join(r,n)})
 return out
def host_up(ip):
 try:return bool(ip) and subprocess.run(['ping','-c','1','-W','1',str(ip)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0
 except:return False
def status_worker():
 global HOST_STATUS
 while True:
  r={}
  for p in get_projects():
   for o in get_objects(p):r.setdefault(p,{})[o]={h['hostname']:host_up(h['parameters'].get('ansible_host',h['parameters'].get('ip',''))) for h in parse_hosts(p,o)}
  with STATUS_LOCK:HOST_STATUS=r
  time.sleep(60)
def status(p,o):
 with STATUS_LOCK:return dict(HOST_STATUS.get(p,{}).get(o,{}))
def run_playbooks(p,o,names,hosts):
 ps=paths(p,o)
 if not ps:return
 for name in names:
  if name not in [x['name'] for x in get_playbooks(p,o)]:continue
  log(f'=== START {name} [{p}/{o}] ===');cmd=['ansible-playbook','-i',ps['hosts'],os.path.join(ps['object_dir'],name)]+(['-l',','.join(hosts)] if hosts else [])
  try:
   proc=subprocess.Popen(cmd,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,bufsize=1,cwd=ps['object_dir'],env={**os.environ,'ANSIBLE_CONFIG':ps['cfg'] if os.path.isfile(ps['cfg']) else os.environ.get('ANSIBLE_CONFIG','')})
   with PROC_LOCK:PROCESSES.append(proc)
   for line in proc.stdout:log(line.rstrip())
   log(f'=== DONE {name}: rc={proc.wait()} ===')
  except Exception as e:log(f'EXECUTION ERROR: {e}')
  finally:
   with PROC_LOCK:
    if 'proc' in locals() and proc in PROCESSES:PROCESSES.remove(proc)
def stop():
 with PROC_LOCK:
  for p in PROCESSES:
   try:p.terminate()
   except:pass
  PROCESSES.clear()
 log('=== EXECUTION STOPPED ===')
class Handler(BaseHTTPRequestHandler):
 def json(self,d,code=200):
  b=json.dumps(d,ensure_ascii=False).encode();self.send_response(code);self.send_header('Content-Type','application/json; charset=utf-8');self.send_header('Content-Length',str(len(b)));self.end_headers();self.wfile.write(b)
 def file(self,p,ct):
  if not os.path.isfile(p):self.send_error(404);return
  b=open(p,'rb').read();self.send_response(200);self.send_header('Content-Type',ct);self.send_header('Content-Length',str(len(b)));self.end_headers();self.wfile.write(b)
 def do_GET(self):
  u=urlparse(self.path);q=parse_qs(u.query);p=q.get('project',[''])[0];o=q.get('object',[''])[0]
  static={'/main':'main.html','/hosts_info':'hosts_info.html','/editor':'editor.html','/style.css':'style.css','/common.js':'common.js','/main.js':'main.js','/hosts_info.js':'hosts_info.js','/editor.js':'editor.js'}
  if u.path in static:self.file(os.path.join(PUBLIC_DIR,static[u.path]),'text/html; charset=utf-8' if u.path in ('/main','/hosts_info','/editor') else 'text/plain; charset=utf-8');return
  if u.path=='/data':self.json({'projects':get_projects(),'objects':get_objects(p),'selected_project':p,'selected_object':o,'hosts':parse_hosts(p,o),'status':status(p,o),'playbooks':get_playbooks(p,o),'local_ip':socket.gethostbyname(socket.gethostname())});return
  if u.path=='/status':self.json(status(p,o));return
  if u.path=='/log_new':
   try:start=int(q.get('start',['0'])[0])
   except:start=0
   with LOG_LOCK:lines=LOG[start:];nxt=len(LOG)
   self.json({'lines':lines,'next':nxt});return
  if u.path=='/playbook':
   name=safe(q.get('name',[''])[0]);ps=paths(p,o);self.json({'name':name,'content':read(os.path.join(ps['object_dir'],name)) if ps else ''});return
  if u.path=='/files':
   ps=paths(p,o);self.json({'hosts':read(ps['hosts']) if ps else '','defaults':read(ps['defaults']) if ps else ''});return
  self.send_error(404)
 def do_POST(self):
  n=int(self.headers.get('Content-Length',0));raw=self.rfile.read(n)
  try:d=json.loads(raw.decode()) if raw else {}
  except:d={}
  p=d.get('project','');o=d.get('object','')
  try:
   if self.path=='/run':threading.Thread(target=run_playbooks,args=(p,o,d.get('playbooks',[]),d.get('hosts',[])),daemon=True).start();return self.json({'ok':True})
   if self.path=='/stop':stop();return self.json({'ok':True})
   if self.path=='/update_host':save_host(p,o,d.get('hostname',''),d.get('new_hostname',d.get('hostname','')),d.get('values',{}));return self.json({'ok':True})
   if self.path=='/add_host':add_host(p,o,d.get('hostname',''),d.get('values',{}));return self.json({'ok':True})
   if self.path=='/delete_host':delete_host(p,o,d.get('hostname',''));return self.json({'ok':True})
   if self.path=='/save_playbook':ps=paths(p,o);write(os.path.join(ps['object_dir'],safe(d.get('name'))),d.get('content',''));return self.json({'ok':True})
   if self.path=='/save_files':ps=paths(p,o);write(ps['hosts'],d.get('hosts',''));write(ps['defaults'],d.get('defaults',''));return self.json({'ok':True})
  except Exception as e:return self.json({'ok':False,'error':str(e)},500)
  self.send_error(404)
if __name__=='__main__':threading.Thread(target=status_worker,daemon=True).start();HTTPServer(('0.0.0.0',8000),Handler).serve_forever()
