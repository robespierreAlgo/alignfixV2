# py/projects.py
import sqlite3
import html 
from bs4 import BeautifulSoup
import json

from text import tokenise, detokenise, highlight_tokens
from alignment import parse_alignment
from phrases import get_directed_phrases_from_texts_and_alignment, get_phrase_occurrences
from db import get_db

def create_project(name="Project"):
    conn, cursor = get_db()
    cursor.execute("INSERT INTO projects (name) VALUES (?)", (name,))
    conn.commit()
    project_id = cursor.lastrowid
    return project_id

def delete_project(project_id):
    conn, cursor = get_db()
    cursor.execute("DELETE FROM projects WHERE id=?", (project_id,))
    cursor.execute("DELETE FROM alignments WHERE project_id=?", (project_id,))
    cursor.execute("DELETE FROM phrases WHERE project_id=?", (project_id,))
    cursor.execute("DELETE FROM occurrences WHERE project_id=?", (project_id,))
    cursor.execute("DELETE FROM fixes WHERE project_id=?", (project_id,))
    cursor.execute("DELETE FROM ignored WHERE project_id=?", (project_id,))
    conn.commit()

def get_projects():
    conn, cursor = get_db()
    cursor.execute("SELECT id, name, created_at, stats FROM projects WHERE deleted_at IS NULL ORDER BY created_at DESC")
    projects = cursor.fetchall()
    return projects

def update_project_name(id, name):
    conn, cursor = get_db()
    cursor.execute("""
        UPDATE projects 
        SET name=?
        WHERE id=?
    """, (name, id))
    conn.commit()

def update_project_stats(id, stats):
    conn, cursor = get_db()
    cursor.execute("""
        UPDATE projects 
        SET stats=?, updated_at=CURRENT_TIMESTAMP 
        WHERE id=?
    """, (json.dumps(stats), id))
    conn.commit()

def merge_project_stats(id, new_stats):
    current_stats = get_project(id)["stats"]
    merged_stats = {**current_stats, **new_stats}
    update_project_stats(id, merged_stats)

def update_project_metadata(id, threshold, min_phrase_len, max_phrase_len, min_count, max_count):
    conn, cursor = get_db()
    cursor.execute("""
        UPDATE projects 
        SET threshold=?, min_phrase_len=?, max_phrase_len=?, min_count=?, max_count=?, updated_at=CURRENT_TIMESTAMP 
        WHERE id=?
    """, (threshold, min_phrase_len, max_phrase_len, min_count, max_count, id))
    conn.commit()

def get_project(id):
    conn, cursor = get_db()
    cursor.execute("SELECT id, name, min_phrase_len, max_phrase_len, file_offset, min_count, max_count, threshold, max_phrases, stats, created_at FROM projects WHERE id=?", (id,))
    project = cursor.fetchone()

    stats = json.loads(project[9]) if project[9] else {}

    return {
        "id": project[0],
        "name": project[1],
        "min_phrase_len": project[2],
        "max_phrase_len": project[3],
        "file_offset": project[4],
        "min_count": project[5],
        "max_count": project[6],
        "threshold": project[7],
        "max_phrases": project[8],
        "stats": stats,
        "created_at": project[10],
    }

def get_alignments(project_id):
    _, cursor = get_db()
    cursor.execute("SELECT row_id, line1, line2, alignment, score FROM alignments WHERE project_id=? AND deleted_at IS NULL", (project_id,))
    alignments = cursor.fetchall()

    row_ids = []
    src_lines = []
    tgt_lines = []
    align_lines = []
    score_lines = []
    for row in alignments:
        row_ids.append(row[0])
        src_lines.append(row[1])
        tgt_lines.append(row[2])
        align_lines.append(row[3])
        score_lines.append(row[4])

    return src_lines, tgt_lines, align_lines, score_lines

def save_alignments(project_id, src_lines, tgt_lines, align_lines, score_lines):
    conn, cursor = get_db()
    for row_id, (src, tgt, align, score) in enumerate(zip(src_lines, tgt_lines, align_lines, score_lines)):
        cursor.execute('INSERT INTO alignments (row_id, line1, line2, alignment, score, synced_at, project_id) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)',
                  (row_id, src, tgt, align, score, project_id))
    conn.commit()

def update_alignments(project_id, align_lines):
    conn, cursor = get_db()
    for row_id, (align) in enumerate(align_lines):
        cursor.execute('UPDATE alignments SET alignment=?, synced_at=CURRENT_TIMESTAMP WHERE row_id=? AND project_id=?',
                  (align, row_id, project_id))
    conn.commit()

def find_entry(xs, a, b):
    for entry in xs:
        if entry[0] == a and entry[1] == b:
            return entry
        
    return None

def get_translations(project_id, ids):
    conn, cursor = get_db()
    query = f"SELECT row_id, line1, line2, alignment, score FROM alignments WHERE row_id IN ({','.join(['?']*len(ids))}) AND project_id=? AND deleted_at IS NULL"
    cursor.execute(query, (*ids, project_id))
    rows = cursor.fetchall()

    data = []
    for row in rows:
        data.append({
            "row_id": row[0],
            "line1": row[1],
            "line2": row[2],
            "alignment": row[3],
            "score": row[4]
        })

    return data

def get_project_data_for_download(project_id, export_phrases=False):
    conn, cursor = get_db()

    cursor.execute("SELECT id, name, min_phrase_len, max_phrase_len, file_offset, min_count, max_count, threshold, max_phrases, stats, created_at FROM projects WHERE id=?", (project_id,))
    project = cursor.fetchone()

    cursor.execute("SELECT row_id, line1, line2, alignment, score FROM alignments WHERE project_id=? AND deleted_at IS NULL", (project_id,))
    alignments = cursor.fetchall()

    cursor.execute("SELECT id, src_phrase, src_fix, tgt_phrase, tgt_fix, direction, num_occurrences, percentage, type, created_at FROM fixes WHERE project_id=?", (project_id,))
    fixes = cursor.fetchall()

    phrases = []
    if export_phrases:
        cursor.execute("SELECT src_phrase, tgt_phrase, direction, num_occurrences, created_at FROM phrases WHERE project_id=?", (project_id,))
        phrases_entries = cursor.fetchall()
        for row in phrases_entries:

            # get all occurrences for this phrase pair
            phrase = {
                "src_phrase": detokenise(row[0]),
                "tgt_phrase": detokenise(row[1]),
                "direction": row[2],
                "num_occurrences": row[3],
                "created_at": row[4],
            }
            # get all occurrences for this phrase pair
            phrase["occurrences"] = get_phrase_occurrences(project_id, phrase["src_phrase"], phrase["tgt_phrase"], int(phrase["direction"]))[0]
            phrases.append(phrase) 

    project_data = {
        "project": {
            "id": project[0],
            "name": project[1],
            "min_phrase_len": project[2],
            "max_phrase_len": project[3],
            "file_offset": project[4],
            "min_count": project[5],
            "max_count": project[6],
            "threshold": project[7],
            "max_phrases": project[8],
            "stats": json.loads(project[9]) if project[9] else {},
            "created_at": project[10],
        },
        "lines1": [detokenise(row[1]) for row in alignments],
        "lines2": [detokenise(row[2]) for row in alignments],
        "alignments": [row[3] for row in alignments],
        "scores": [row[4] for row in alignments],
        "fixes": [
            {
                "id": row[0],
                "src_phrase": detokenise(row[1]),
                "src_fix": detokenise(row[2]),
                "tgt_phrase": detokenise(row[3]),
                "tgt_fix": detokenise(row[4]),
                "direction": row[5],
                "num_occurrences": row[6],
                "percentage": row[7],
                "type": row[8],
                "created_at": row[9]
            } for row in fixes
        ],
        "phrases": phrases
    }

    return project_data

def get_project_data_for_alignments(project_id):
    _, cursor = get_db()

    cursor.execute("SELECT row_id, line1, line2, alignment, score FROM alignments WHERE project_id=? AND deleted_at IS NULL", (project_id,))
    alignments = cursor.fetchall()

    project_data = {
        "lines1": [row[1] for row in alignments],
        "lines2": [row[2] for row in alignments],
        "scores": [row[4] for row in alignments]
    }

    return project_data

def update_translation(row_id, line1, line2):

    line1 = tokenise(line1, as_string=True)
    line2 = tokenise(line2, as_string=True)

    conn, cursor = get_db()
    cursor.execute("UPDATE alignments SET line1=?, line2=? WHERE row_id=?", (line1, line2, row_id))
    conn.commit()

def delete_translation(row_id):
    conn, cursor = get_db()
    cursor.execute("UPDATE alignments SET deleted_at=CURRENT_TIMESTAMP WHERE row_id=?", (row_id,))
    conn.commit()

def search_translations(project_id, phrase1, phrase2, search_value=None, start=0, length=10):
    conn, cursor = get_db()

    conditions = ["project_id=? AND deleted_at IS NULL"]
    params = [project_id]

    if phrase1 or phrase2:  # only add if not empty

        if phrase1:
            conditions.append("line1 LIKE ?")
            params.append(f"% {phrase1} %")
            
        if phrase2:  # only add if not empty
            conditions.append("line2 LIKE ?")
            params.append(f"% {phrase2} %")
            
        where_clause = " AND ".join(conditions)

    elif search_value:
        conditions.append("line1 LIKE ? OR line2 LIKE ?")
        params.append(f"%{search_value}%")
        params.append(f"%{search_value}%")

    where_clause = " AND ".join(conditions)

    query = f"""
        SELECT row_id, line1, line2, alignment, score
        FROM alignments
        WHERE {where_clause}
    """

    params_exec = list(params)  # copy of your params

    if length is not None:
        query += " LIMIT ? OFFSET ?"
        params_exec.extend([length, start])

    cursor.execute(query, params_exec)
    rows = cursor.fetchall()

    count_query = f"""SELECT COUNT(*) 
                      FROM alignments 
                      WHERE {where_clause}"""
    cursor.execute(count_query, params)
    total_records = cursor.fetchone()[0]

    data = []
    for row in rows:
        data.append({
            "row_id": row[0],
            "line1": row[1],
            "line2": row[2],
            "alignment": row[3],
            "score": row[4]
        })

    return data, total_records

def fetch_translations(project_id, phrase1, phrase2, fix1, fix2, direction, start, length, search_value):

    data = []
    matches, recordsTotal = [], 0

    phrase1_raw = tokenise(phrase1, as_string=True)
    phrase1_tok = tokenise(phrase1)
    phrase2_raw = tokenise(phrase2, as_string=True)
    phrase2_tok = tokenise(phrase2)
    search_value_raw = tokenise(search_value, as_string=True)
    search_value_tok = tokenise(search_value)
    
    if phrase1.strip() or phrase2.strip():
        matches, recordsTotal = get_phrase_occurrences(
            project_id, phrase1_raw, phrase2_raw, direction, limit=length, offset=start
        )

    if not matches:

        rep1 = phrase1
        rep2 = phrase2

        if search_value:
            
            res, recordsTotal = search_translations(project_id, None, None, search_value=search_value_raw, start=start, length=length)

            phrase1 = search_value
            phrase2 = search_value
            phrase1_raw = search_value_raw
            phrase2_raw = search_value_raw
            phrase1_tok = search_value_tok
            phrase2_tok = search_value_tok
            rep1 = search_value
            rep2 = search_value

        else:

            res, recordsTotal = search_translations(project_id, phrase1_raw, phrase2_raw, start=start, length=length)
            print(f"No matches found for phrases. Falling back to search translations with phrases: [{phrase1_raw}] [{phrase2_raw}]")
            if phrase1_raw and fix1.strip():
                rep1 = fix1

            if phrase2_raw and fix2.strip():
                rep2 = fix2

        for doc in res:
            src_raw = doc["line1"]
            src_raw = highlight_tokens(src_raw, phrase1_tok, rep1)

            tgt_raw = doc["line2"]
            tgt_raw = highlight_tokens(tgt_raw, phrase2_tok, rep2)

            src = detokenise(src_raw)
            tgt = detokenise(tgt_raw)

            data.append({
                "row_id": doc["row_id"],
                "line1": src,
                "line2": tgt,
                "score": float(doc["score"])
            })

    else:

        soup = BeautifulSoup("", "html.parser")

        phrase1_num_tok = len(phrase1_tok)
        phrase2_num_tok = len(phrase2_tok)
        min_phrase_len = min(phrase1_num_tok, phrase2_num_tok)
        max_phrase_len = max(phrase1_num_tok, phrase2_num_tok) + 2 # if trimmed #NB
        
        docs = get_translations(project_id, matches)

        for doc in docs:
            src_text = doc['line1']
            tgt_text = doc['line2']

            src_text_tok = src_text.split()
            tgt_text_tok = tgt_text.split()

            text1_text2_alignment = parse_alignment(doc['alignment'])

            phrases = get_directed_phrases_from_texts_and_alignment(
                src_text_tok,
                tgt_text_tok,
                text1_text2_alignment,
                min_phrase_len=min_phrase_len,
                max_phrase_len=max_phrase_len,
            )

            # if any entry in phrases matches phrase1 and phrase2
            entry = find_entry(phrases, phrase1_raw, phrase2_raw)

            if entry:
                (_, _, direction, src_start, tgt_start) = entry

                src_end = src_start + phrase1_num_tok
                tgt_end = tgt_start + phrase2_num_tok

                if src_text_tok[src_start:src_end] == phrase1_tok:
                    rep1 = fix1 if fix1 else phrase1
                    span = soup.new_tag("span", **{"class": "occurrence src-occurrence"})
                    span.string = rep1  # this will be properly escaped
                    src_text_tok = (
                        [html.escape(x) for x in src_text_tok[:src_start]]
                        + [span]
                        + [html.escape(x) for x in src_text_tok[src_end:]]
                    )

                if tgt_text_tok[tgt_start:tgt_end] == phrase2_tok:

                    rep2 = fix2 if fix2 else phrase2
                    span = soup.new_tag("span", **{"class": "occurrence tgt-occurrence"})
                    span.string = rep2  # this will be properly escaped

                    tgt_text_tok = (
                        [html.escape(x) for x in tgt_text_tok[:tgt_start]]
                        + [span]
                        + [html.escape(x) for x in tgt_text_tok[tgt_end:]]
                    )

                src_text = detokenise(src_text_tok)
                tgt_text = detokenise(tgt_text_tok)

                data.append(
                    {
                        "row_id": doc['row_id'],
                        "line1": src_text,
                        "line2": tgt_text,
                        "score": float(doc['score']),
                    }
                )

    return data, recordsTotal