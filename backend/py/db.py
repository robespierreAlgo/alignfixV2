# global_db.py
import sqlite3

_conn = None
_cursor = None

def get_db():
    global _conn, _cursor
    if _conn is None:
        _conn = sqlite3.connect("/data/alignfix.db", check_same_thread=False)
        _cursor = _conn.cursor()
        # _cursor.execute("PRAGMA journal_mode = WAL")
        # # _cursor.execute("PRAGMA synchronous = NORMAL")
        # _cursor.execute("PRAGMA synchronous = OFF")  # fastest possible writes
        # _cursor.execute("PRAGMA busy_timeout = 5000")
        # _cursor.execute("PRAGMA temp_store = MEMORY")
    return _conn, _cursor
