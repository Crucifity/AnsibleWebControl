#!/usr/bin/env python3
from web1x import HTTPServer, Handler, status_worker
import threading

if __name__ == "__main__":
    threading.Thread(target=status_worker, daemon=True).start()
    print("OPEN http://127.0.0.1:8000")
    HTTPServer(("0.0.0.0", 8000), Handler).serve_forever()
