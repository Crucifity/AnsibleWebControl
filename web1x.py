import os
import threading
from http.server import HTTPServer
import web1x_base
_original_do_get = web1x_base.Handler.do_GET

def do_GET_with_main_base(self):
    url = web1x_base.urlparse(self.path)
    if url.path == "/main-base.js":
        self.file(os.path.join(web1x_base.PUBLIC_DIR, "main-base.js"), "application/javascript; charset=utf-8")
        return
    return _original_do_get(self)

web1x_base.Handler.do_GET = do_GET_with_main_base

if __name__ == "__main__":
    threading.Thread(target=web1x_base.status_worker, daemon=True).start()
    HTTPServer(("0.0.0.0", 8000), web1x_base.Handler).serve_forever()
