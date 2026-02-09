import sqlite3

db_path = "/data/alignfix.db"

# # DEBUG: delete existing db
# try:
#     import os
#     os.remove(db_path)
# except FileNotFoundError:
#     pass

conn = sqlite3.connect(db_path)
c = conn.cursor()
c.execute("""
CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY, 
    name TEXT, 
    min_phrase_len INTEGER DEFAULT 1, 
    max_phrase_len INTEGER DEFAULT 3, 
    file_offset INTEGER DEFAULT 0, 
    min_count INTEGER DEFAULT 2, 
    max_count INTEGER DEFAULT 300, 
    threshold INTEGER DEFAULT 1, 
    max_phrases INTEGER DEFAULT 500000,
    stats TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP
)
""")
c.execute("""
CREATE TABLE IF NOT EXISTS alignments (
    row_id INTEGER, 
    line1 TEXT, 
    line2 TEXT, 
    alignment TEXT,
    score FLOAT, 
    synced_at TIMESTAMP,
    project_id INTEGER,
    deleted_at TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(project_id) REFERENCES projects(id),
    PRIMARY KEY (project_id, row_id)
)
""")
c.execute("""
CREATE TABLE IF NOT EXISTS phrases (
    id INTEGER PRIMARY KEY, 
    src_phrase TEXT, 
    tgt_phrase TEXT, 
    direction TEXT,
    num_occurrences INTEGER,
    project_id INTEGER,     
    is_synced INTEGER,     
    ignore INTEGER DEFAULT 0,
    deleted_at TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(project_id) REFERENCES projects(id)
)
""")
c.execute("""
CREATE TABLE IF NOT EXISTS fixes (
    id INTEGER PRIMARY KEY, 
    src_phrase TEXT,
    src_fix TEXT,
    tgt_phrase TEXT,
    tgt_fix TEXT,
    direction TEXT,
    percentage INTEGER,
    num_occurrences INTEGER,
    type TEXT,
    project_id INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(project_id) REFERENCES projects(id)
)
""")
c.execute("""
CREATE TABLE IF NOT EXISTS occurrences (
    row_id INTEGER,
    id_phrases INTEGER, 
    project_id INTEGER,
    FOREIGN KEY(id_phrases) REFERENCES phrases(id),
    FOREIGN KEY(row_id) REFERENCES alignments(id),
    PRIMARY KEY (row_id, id_phrases, project_id)
)
""")
c.execute("""
CREATE TABLE IF NOT EXISTS ignored (
    id INTEGER PRIMARY KEY, 
    src_phrase TEXT,
    tgt_phrase TEXT,
    imported INTEGER DEFAULT 0,
    project_id INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(project_id) REFERENCES projects(id)
)
""")

c.execute("""
CREATE INDEX IF NOT EXISTS idx_phrases_lookup
ON phrases (src_phrase, tgt_phrase, direction, project_id)
""")

c.execute("""
CREATE INDEX IF NOT EXISTS idx_occurrences_phrase
ON occurrences (id_phrases, project_id)
""")

c.execute("""
CREATE INDEX IF NOT EXISTS idx_occurrences_row
ON occurrences (row_id, project_id)
""")

c.execute("""
CREATE INDEX IF NOT EXISTS idx_fixes_lookup
ON fixes (src_phrase, tgt_phrase, direction, project_id)
""")


conn.commit()
conn.close()
