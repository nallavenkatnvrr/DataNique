"""
Programmatic uvicorn entry point for the Datanique backend.

This is used in two situations:

1. **PyInstaller-frozen desktop build** — the Electron app spawns the frozen
   ``datanique-backend(.exe)`` produced from this file. PyInstaller cannot use
   uvicorn's ``"app.main:app"`` import-string + reload machinery, so we import
   the FastAPI ``app`` object directly and hand it to ``uvicorn.run``.

2. **Plain python** — ``python run_server.py`` works the same as the batch
   script, honouring the ``DV_BIND_HOST`` / ``DV_BIND_PORT`` env vars.

Host/port come from the environment so the Electron launcher can pick a free
loopback port and pass it in (``DV_BIND_HOST`` / ``DV_BIND_PORT``). We bind to
127.0.0.1 by default because the app has no login and the SQL IDE runs
arbitrary SQL.
"""

from __future__ import annotations

import os
import sys


def _ensure_backend_on_path() -> None:
    """Make ``import app...`` work regardless of the current directory.

    When frozen, PyInstaller extracts everything under ``sys._MEIPASS``; when
    running from source, the backend dir (this file's parent) already holds the
    ``app`` package. Add both defensively.
    """
    here = os.path.dirname(os.path.abspath(__file__))
    for p in (here, getattr(sys, "_MEIPASS", "")):
        if p and p not in sys.path:
            sys.path.insert(0, p)


def main() -> None:
    _ensure_backend_on_path()

    # PYTHONDONTWRITEBYTECODE mirrors start-backend.bat: avoid .pyc churn.
    os.environ.setdefault("PYTHONDONTWRITEBYTECODE", "1")

    from app.config import settings

    host = settings.bind_host
    port = settings.bind_port

    import uvicorn
    from app.main import app

    # No reload / no import-string: pass the app object so this works frozen.
    uvicorn.run(app, host=host, port=port, log_level="info", workers=1)


if __name__ == "__main__":
    main()
