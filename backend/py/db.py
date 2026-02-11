# global_db.py
import sqlite3

_conn = None
_cursor = None
_indexes_ready = False

def ensure_indexes(conn):
    cur = conn.cursor()

    # Speeds up NOT EXISTS lookups against ignored in fetch_phrases()
    cur.execute("""
      CREATE INDEX IF NOT EXISTS idx_ignored_proj_src_tgt
      ON ignored(project_id, src_phrase COLLATE NOCASE, tgt_phrase COLLATE NOCASE)
    """)

    # Speeds up phrase listing + ordering in fetch_phrases()
    cur.execute("""
      CREATE INDEX IF NOT EXISTS idx_phrases_proj_ignore_dir_occ
      ON phrases(project_id, ignore, direction, num_occurrences DESC)
    """)

    # (Optional) Speeds up ignore=1 listing in fetch_ignored_phrases()
    cur.execute("""
      CREATE INDEX IF NOT EXISTS idx_phrases_proj_ignore_occ
      ON phrases(project_id, ignore, num_occurrences DESC)
    """)

    conn.commit()

def get_db():
    global _conn, _cursor, _indexes_ready

    if _conn is None:
        _conn = sqlite3.connect("/data/alignfix.db", check_same_thread=False)
        _cursor = _conn.cursor()

        # Good defaults for performance (safe enough for this use)
        _cursor.execute("PRAGMA synchronous = OFF")
        _cursor.execute("PRAGMA temp_store = MEMORY")
        _cursor.execute("PRAGMA busy_timeout = 5000")

        # If you want WAL, enable it (often helps)
        # _cursor.execute("PRAGMA journal_mode = WAL")

    # Ensure indexes only once per session
    if not _indexes_ready:
        ensure_indexes(_conn)
        _indexes_ready = True

    return _conn, _cursor