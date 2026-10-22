"""Start Datanique in a desktop window from source (start-app.bat runs this).

The launcher itself is datanique_launcher.py; the frozen Datanique.exe is
built from it (datanique.spec). Run with --help for the options.
"""

from datanique_launcher import run

if __name__ == "__main__":
    run()
