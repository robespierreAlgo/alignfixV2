from text import tokenise, detokenise, strip_nb_bl
from alignment import parse_alignment
from db import get_db

from collections import defaultdict
from itertools import islice

import sqlite3
import json
import string
import time

PHRASE_EXTRACTION_CHUNK_SIZE = 25_000
MAX_OCCURRENCES_PER_CHUNK = 300
MAX_NUM_PHRASES = 100_000

def chunked(iterable, size):
    it = iter(iterable)
    while True:
        chunk = list(islice(it, size))
        if not chunk:
            break
        yield chunk

def get_directed_phrases_from_texts_and_alignment(
    src_tokens, tgt_tokens, alignment_pairs, min_phrase_len=1, max_phrase_len=3, ignore_pairs=set()
):
    src_to_tgt = defaultdict(list)
    tgt_to_src = defaultdict(list)

    for s, t in alignment_pairs:
        src_to_tgt[s].append(t)
        tgt_to_src[t].append(s)

    def get_phrases(src_tokens, tgt_tokens, src_tgt_align_map, tgt_src_align_map, length, direction=1):

      len_src_tokens = len(src_tokens)
      phrases = []
      
      for start_src in range(len_src_tokens - length + 1):

        current_direction = direction

        end_src = start_src + length
        src_indices = range(start_src, end_src)

        aligned_tgts = []
        for i in src_indices:
            aligned_tgts.extend(src_tgt_align_map.get(i, []))

        if not aligned_tgts:
            continue

        start_tgt = min(aligned_tgts)
        end_tgt = max(aligned_tgts) + 1
        
        aligned_srcs = []
        for i in range(start_tgt, end_tgt):
            aligned_srcs.extend(tgt_src_align_map.get(i, []))

        aligned_start_src = min(aligned_srcs) if aligned_srcs else None
        aligned_end_src = max(aligned_srcs) + 1 if aligned_srcs else None

        if aligned_start_src == start_src and aligned_end_src == end_src:
            current_direction = 0

        src_phrase_tok = strip_nb_bl(src_tokens[start_src : end_src])
        tgt_phrase_tok = strip_nb_bl(tgt_tokens[start_tgt : end_tgt])

        src_phrase_strip = " ".join(src_phrase_tok)
        tgt_phrase_strip = " ".join(tgt_phrase_tok)

        if detokenise(src_phrase_strip.strip(string.punctuation)) and detokenise(tgt_phrase_strip.strip(
            string.punctuation
        )):
            

            if (src_phrase_strip, tgt_phrase_strip) in ignore_pairs:
                continue

            if direction == -1:
            
                phrases.append(
                    (tgt_phrase_strip, src_phrase_strip, current_direction, start_tgt, start_src)
                )
            
            else:
            
                phrases.append(
                    (src_phrase_strip, tgt_phrase_strip, current_direction, start_src, start_tgt)
                )

      return phrases

    phrases = []

    for length in range(min_phrase_len, max_phrase_len + 1):
        
        src_tgt_phrases = get_phrases(src_tokens, tgt_tokens, src_to_tgt, tgt_to_src, length, direction=1)
        for _tuple in src_tgt_phrases:
            phrases.append(_tuple)

        tgt_src_phrases = get_phrases(tgt_tokens, src_tokens, tgt_to_src, src_to_tgt, length, direction=-1)
        for _tuple in tgt_src_phrases:
            if _tuple[2] == 0:
                continue
            phrases.append(_tuple)

    return phrases

def process_line_pair(
    src_line,
    tgt_line,
    align_line,
    min_len=1,
    max_len=5,
    ignore_pairs=set()
):
    src_tokens = src_line.strip().split()
    tgt_tokens = tgt_line.strip().split()
    alignments = parse_alignment(align_line)

    return get_directed_phrases_from_texts_and_alignment(
        src_tokens,
        tgt_tokens,
        alignments,
        min_phrase_len=min_len,
        max_phrase_len=max_len,
        ignore_pairs=ignore_pairs
    )

def process_chunk(
    src_lines,
    tgt_lines,
    align_lines,
    min_len=1,
    max_len=5,
    chunk_offset=0,
    chunk_scores=[],
    threshold=1,
    ignore_pairs=set()
):
    phrase_pairs = []    

    for chunk_index, (src_line, tgt_line, align_line) in enumerate(zip(src_lines, tgt_lines, align_lines)):
        if chunk_scores and chunk_scores[chunk_index] < threshold:
            chunk_phrases = process_line_pair(src_line, tgt_line, align_line, min_len=min_len, max_len=max_len)
            for (src, tgt, _, _, _) in chunk_phrases:
                ignore_pairs.add((src, tgt))


    for chunk_index, (src_line, tgt_line, align_line) in enumerate(zip(src_lines, tgt_lines, align_lines)):
        if chunk_scores and chunk_scores[chunk_index] >= threshold:
            chunk_phrases = process_line_pair(src_line, tgt_line, align_line, min_len=min_len, max_len=max_len, ignore_pairs=ignore_pairs)
            row_index = chunk_index + chunk_offset
            for (src, tgt, direction, start, tgt_min) in chunk_phrases:
                phrase_pairs.append((row_index, src, tgt, direction, start, tgt_min))

    return phrase_pairs, ignore_pairs

def extract_phrases(src_lines, tgt_lines, align_lines, scores,
                    min_phrase_len=1, 
                    max_phrase_len=5, 
                    file_offset=0, 
                    min_count=2, 
                    max_count=MAX_OCCURRENCES_PER_CHUNK, 
                    threshold=1,
                    all_ignore_pairs=set()):
    
    if not scores:
        scores = [1] * len(src_lines)

    max_phrase_len = max(min_phrase_len, max_phrase_len)

    # total_chunks = (len(src_lines) + PHRASE_EXTRACTION_CHUNK_SIZE - 1) // PHRASE_EXTRACTION_CHUNK_SIZE
    count_below_count = 0
    count_above_count = 0
    count_filtered = 0

    start_time = time.time()

    phrase_count = defaultdict(set)
    for index, chunk_src_lines in enumerate(chunked(src_lines, PHRASE_EXTRACTION_CHUNK_SIZE)):

        print(f"Processing chunk {index + 1}...")

        chunk_offset = index * PHRASE_EXTRACTION_CHUNK_SIZE

        chunk_scores = scores[chunk_offset:chunk_offset + PHRASE_EXTRACTION_CHUNK_SIZE]
        chunk_tgt_lines = tgt_lines[chunk_offset:chunk_offset + PHRASE_EXTRACTION_CHUNK_SIZE]
        chunk_align_lines = align_lines[chunk_offset:chunk_offset + PHRASE_EXTRACTION_CHUNK_SIZE]

        phrases, ignore_pairs = process_chunk(
            chunk_src_lines,
            chunk_tgt_lines,
            chunk_align_lines,
            min_len=min_phrase_len,
            max_len=max_phrase_len,
            chunk_offset=chunk_offset,
            chunk_scores=chunk_scores,
            threshold=threshold,
            ignore_pairs=all_ignore_pairs
        )

        all_ignore_pairs.update(ignore_pairs)

        for (row_id, src_phrase, tgt_phrase, direction, _, _) in phrases:
            row_id = row_id + file_offset
            phrase_count[(src_phrase, tgt_phrase, direction)].add(row_id)

        # for phrase, row_ids in local_phrase_count.items():

        #     num_alignments = len(row_ids)

        #     if num_alignments > max_count:
        #         count_above_count += 1
        #     elif num_alignments >= min_count:
        #         phrase_count[phrase].extend(row_ids)
        #     else:
        #         count_below_count += 1

        count_filtered = len(phrase_count.keys())
        
        if count_filtered > MAX_NUM_PHRASES:
            phrase_count = defaultdict(
                list,
                dict(sorted(phrase_count.items(), key=lambda x: len(x[1]), reverse=True)[:MAX_NUM_PHRASES])
            )

    chunked_phrase_count = []

    sorted_phrase_count = sorted(
        phrase_count.items(), key=lambda x: len(x[1]), reverse=True
    )

    count_taken = 0
    
    for i, (phrase, occurrences_set) in enumerate(sorted_phrase_count):

        occurrences = list(occurrences_set)

        if len(occurrences) > max_count:
            count_above_count += 1
            continue
        elif len(occurrences) < min_count:
            break
        
        chunked_phrase_count.append({
            "phrase1": phrase[0],
            "phrase2": phrase[1],
            "chunk": phrase[3],
            "direction": phrase[2],
            "num_occurrences": len(occurrences),
            "occurrences": occurrences
        })
        count_taken += 1

    # count scores above threshold
    scores_above_threshold = sum(1 for score in scores if score >= threshold)
    scores_below_threshold = sum(1 for score in scores if score < threshold)

    stats = {
        "count_taken": count_taken,
        "count_filtered": count_filtered,
        "count_below": count_below_count,
        "count_above": count_above_count,
        "scores_below_threshold": scores_below_threshold,
        "scores_above_threshold": scores_above_threshold,
        "duration": int(time.time() - start_time)
    }

    return sorted(chunked_phrase_count, key=lambda x: len(x['occurrences']), reverse=True), stats

def delete_phrases(project_id):
    conn, cursor = get_db()

    cursor.execute('DELETE FROM occurrences WHERE project_id=?', (project_id,))
    cursor.execute('DELETE FROM phrases WHERE project_id=?', (project_id,))
    conn.commit()

def save_phrases(project_id, phrases,
                 phrase_chunk_size=10000,
                 occ_chunk_size=100000,
                 busy_timeout_ms=5000):
    """
    Bulk load phrases + occurrences for project_id into SQLite, in a way that
    is more concurrency-friendly (multiple writers/readers).
    
    Parameters:
      constructor: a callable that returns a new sqlite3.Connection
      project_id: int
      phrases: list of dicts with keys src_phrase, tgt_phrase, direction,
               num_occurrences, occurrences (iterable of row_ids)
      phrase_chunk_size: number of phrases to insert per batch
      occ_chunk_size: number of occurrence tuples to insert per batch
      busy_timeout_ms: how long to wait for locked database before failing
    """
    conn, cursor = get_db()
    conn.execute(f"PRAGMA busy_timeout = {busy_timeout_ms}")

    # Prepare the statement once
    insert_occ_sql = '''
      INSERT OR IGNORE INTO occurrences (row_id, id_phrases, project_id)
      VALUES (?, ?, ?)
    '''

    # Function to process a chunk of phrases
    def process_phrase_chunk(chunk):
        # Insert phrases one-by-one inside the transaction so we can reliably obtain each phrase id.
        # This avoids using cursor.lastrowid after executemany (which can be unreliable and produce negative start ids).
        for p in chunk:
            src = p.get('src_phrase', '')
            tgt = p.get('tgt_phrase', '')
            direction = int(p.get('direction', 0))
            real_num_occ = 0
            # Use INSERT OR REPLACE to ensure a single row per (project_id, src, tgt, direction).
            # executor.execute will set lastrowid for each insert.
            cursor.execute(
                "INSERT OR REPLACE INTO phrases (src_phrase, tgt_phrase, direction, project_id) VALUES (?, ?, ?, ?)",
                (src, tgt, direction, project_id)
            )
            pid = cursor.lastrowid
            if not pid:
                # Fallback: try to lookup the id (should be rare)
                cursor.execute(
                    "SELECT id FROM phrases WHERE src_phrase=? AND tgt_phrase=? AND direction=? AND project_id=?",
                    (src, tgt, direction, project_id)
                )
                row = cursor.fetchone()
                pid = row[0] if row else None

            # Prepare occurrences (deduplicate with set)
            if pid:
                occ_set = set(p.get('occurrences', []))
                occ_data = []
                for row_id in occ_set:
                    occ_data.append((int(row_id), pid, project_id))

                    # flush occurrences in chunks to keep memory low
                    if len(occ_data) >= occ_chunk_size:
                        cursor.executemany(insert_occ_sql, occ_data)
                        occ_data = []

                # final flush of remaining occurrences
                if occ_data:
                    cursor.executemany(insert_occ_sql, occ_data)
                
                # update phrases and set num_occurrences to actual inserted count
                real_num_occ = len(occ_set)
                cursor.execute(
                    "UPDATE phrases SET num_occurrences=? WHERE id=? AND project_id=?",
                    (real_num_occ, pid, project_id)
                )

    # Break phrases into chunks and do each in its own transaction
    for i in range(0, len(phrases), phrase_chunk_size):
        chunk = phrases[i : i + phrase_chunk_size]

        try:
            cursor.execute("BEGIN IMMEDIATE;")
            process_phrase_chunk(chunk)
            conn.commit()
        except sqlite3.OperationalError as e:
            conn.rollback()
            if "database is locked" in str(e).lower():
                # simple retry logic
                time.sleep(0.1)
                return save_phrases(project_id, chunk) 
            else:
                raise
                 

def add_phrases_to_ignore(project_id, phrases):
    conn, cursor = get_db()

    for phrase in phrases:
        cursor.execute('INSERT INTO ignored (src_phrase, tgt_phrase, project_id) VALUES (?, ?, ?)',
                  (phrase['src_phrase'], phrase['tgt_phrase'], project_id))
    
    conn.commit()

def remove_phrase_to_ignore(project_id, phrase_id):
    conn, cursor = get_db()
    cursor.execute('DELETE FROM ignored WHERE id=? AND project_id=?', (phrase_id, project_id))
    conn.commit()
    

def get_phrases_to_ignore(project_id):
    _, cursor = get_db()
    cursor.execute('SELECT id, src_phrase, tgt_phrase FROM ignored WHERE project_id=?', (project_id,))
    rows = cursor.fetchall()

    return rows

def delete_all_ignored_phrases(project_id):
    conn, cursor = get_db()

    cursor.execute('DELETE FROM ignored WHERE project_id=?', (project_id,))
    conn.commit()


def get_all_phrases_to_ignore(project_id):
    imported_phrase = get_phrases_to_ignore(project_id)
    rows = set()
    for (id, src, tgt) in imported_phrase:
        rows.add((src, tgt))

    _, cursor = get_db()

    ignore = 0  # only fetch non-ignored phrases
    # 1) Count total rows for this project (before LIMIT/OFFSET)
    cursor.execute("SELECT src_phrase, tgt_phrase FROM phrases WHERE project_id=? AND ignore=1", (project_id,))
    res = cursor.fetchall()
    for (src, tgt) in res:
       rows.add((src, tgt))

    return rows

def set_ignore_phrase(project_id, phrase_id, ignore=1):
    conn, cursor = get_db()

    cursor.execute("""
        UPDATE phrases
        SET ignore = ?
        WHERE id = ? AND project_id = ?
    """, (ignore, phrase_id, project_id))

    conn.commit()

def get_phrase_id(project_id, phrase1_tok_str, phrase2_tok_str, direction):
    
    _, cursor = get_db()

    cursor.execute('SELECT id FROM phrases WHERE src_phrase=? AND tgt_phrase=? AND direction=? AND project_id=?',
                (phrase1_tok_str, phrase2_tok_str, direction, project_id))
    row = cursor.fetchone()

    if row:
        return row[0]
    
    return None

def get_phrase_occurrences(project_id, phrase1_tok_str, phrase2_tok_str, direction, limit=1000, offset=0):

    _, cursor = get_db()

    phrase_id = get_phrase_id(project_id, phrase1_tok_str, phrase2_tok_str, direction)
    if not phrase_id:
        return [], 0

    # get total count without limit/offset
    cursor.execute('SELECT COUNT(*) FROM occurrences WHERE id_phrases=? AND project_id=?',
              (phrase_id, project_id))
    total_count = cursor.fetchone()[0]

    # fetch paginated rows
    cursor.execute('SELECT row_id FROM occurrences WHERE id_phrases=? AND project_id=? LIMIT ? OFFSET ?',
              (phrase_id, project_id, limit, offset))
    rows = cursor.fetchall()

    return [row[0] for row in rows], total_count


# def fetch_phrases(project_id, start, length, search_value, direction=0, min_length=1):

#     _, cursor = get_db()

#     ignore = 0  # only fetch non-ignored phrases
#     # 1) Count total rows for this project (before LIMIT/OFFSET)
#     cursor.execute("SELECT COUNT(*) FROM phrases WHERE project_id=? AND ignore=? AND direction=? AND (LENGTH(src_phrase) - LENGTH(REPLACE(src_phrase, ' ', '')) = ? OR LENGTH(tgt_phrase) - LENGTH(REPLACE(tgt_phrase, ' ', '')) = ?)", (project_id, ignore, direction, min_length - 1, min_length - 1))
#     total_records = cursor.fetchone()[0]

#     # 2) Apply optional filtering
#     if search_value:

#         search_value_tok_str = tokenise(search_value, as_string=True)
#         like = f"%{search_value_tok_str}%"

#         print(f"Filtering phrases with search term: {search_value_tok_str}")

#         cursor.execute("""SELECT COUNT(*) 
#                      FROM phrases
#                      WHERE project_id=? 
#                      AND ignore=?
#                      AND (src_phrase LIKE ? OR tgt_phrase LIKE ?)""",
#                   (project_id, ignore, like, like))
#         filtered_records = cursor.fetchone()[0]

#         query = """SELECT id, src_phrase, tgt_phrase, direction, num_occurrences
#                    FROM phrases
#                    WHERE project_id=? 
#                    AND ignore=?
#                    AND (src_phrase LIKE ? OR tgt_phrase LIKE ?)
#                    ORDER BY num_occurrences DESC 
#                    LIMIT ? OFFSET ?"""
#         cursor.execute(query, (project_id, ignore, like, like, length, start))
#     else:
#         # no filtering
#         filtered_records = total_records
#         query = """SELECT id, src_phrase, tgt_phrase, direction, num_occurrences
#                    FROM phrases
#                    WHERE project_id=?
#                    AND ignore=?
#                    AND direction=?
#                    ORDER BY num_occurrences DESC 
#                    LIMIT ? OFFSET ?"""
#         cursor.execute(query, (project_id, ignore, direction, length, start))
#         # cursor.execute(query, (project_id, ignore, direction, min_length - 1, min_length - 1, length, start))

#                 #    AND (LENGTH(src_phrase) - LENGTH(REPLACE(src_phrase, ' ', '')) = ?
#                 #    OR LENGTH(tgt_phrase) - LENGTH(REPLACE(tgt_phrase, ' ', '')) = ?)
#     phrases = cursor.fetchall()

#     phrase_ids = [row[0] for row in phrases]
#     src_phrases = [detokenise(row[1]) for row in phrases]
#     tgt_phrases = [detokenise(row[2]) for row in phrases]
#     directions = [row[3] for row in phrases]
#     num_occurrences = [row[4] for row in phrases]

#     return phrase_ids, src_phrases, tgt_phrases, directions, num_occurrences, total_records, filtered_records

# UPDATE 11.02.26
def fetch_phrases(project_id, start, length, search_value, direction=0, min_length=1):
    _, cursor = get_db()

    ignore = 0  # only fetch non-ignored phrases

    # Filter out anything that is in ignored table.
    # If ignored.tgt_phrase == '' => wildcard (ignore by src only).
    ignored_filter = """
      AND NOT EXISTS (
        SELECT 1 FROM ignored i
        WHERE i.project_id = p.project_id
          AND i.src_phrase COLLATE NOCASE = p.src_phrase COLLATE NOCASE
          AND (i.tgt_phrase = '' OR i.tgt_phrase COLLATE NOCASE = p.tgt_phrase COLLATE NOCASE)
      )
    """

    len_filter = """
      AND (
        (LENGTH(p.src_phrase) - LENGTH(REPLACE(p.src_phrase, ' ', '')) = ?)
        OR
        (LENGTH(p.tgt_phrase) - LENGTH(REPLACE(p.tgt_phrase, ' ', '')) = ?)
      )
    """

    # 1) Count total rows (before paging)
    cursor.execute(
        f"""
        SELECT COUNT(*)
        FROM phrases p
        WHERE p.project_id=?
          AND p.ignore=?
          AND p.direction=?
          {ignored_filter}
          {len_filter}
        """,
        (project_id, ignore, direction, min_length - 1, min_length - 1)
    )
    total_records = cursor.fetchone()[0]

    # 2) Filtering by search term
    if search_value:
        search_value_tok_str = tokenise(search_value, as_string=True)
        like = f"%{search_value_tok_str}%"
        print(f"Filtering phrases with search term: {search_value_tok_str}")

        cursor.execute(
            f"""
            SELECT COUNT(*)
            FROM phrases p
            WHERE p.project_id=?
              AND p.ignore=?
              AND p.direction=?
              {ignored_filter}
              AND (p.src_phrase LIKE ? OR p.tgt_phrase LIKE ?)
            """,
            (project_id, ignore, direction, like, like)
        )
        filtered_records = cursor.fetchone()[0]

        cursor.execute(
            f"""
            SELECT p.id, p.src_phrase, p.tgt_phrase, p.direction, p.num_occurrences
            FROM phrases p
            WHERE p.project_id=?
              AND p.ignore=?
              AND p.direction=?
              {ignored_filter}
              AND (p.src_phrase LIKE ? OR p.tgt_phrase LIKE ?)
            ORDER BY p.num_occurrences DESC
            LIMIT ? OFFSET ?
            """,
            (project_id, ignore, direction, like, like, length, start)
        )
    else:
        filtered_records = total_records
        cursor.execute(
            f"""
            SELECT p.id, p.src_phrase, p.tgt_phrase, p.direction, p.num_occurrences
            FROM phrases p
            WHERE p.project_id=?
              AND p.ignore=?
              AND p.direction=?
              {ignored_filter}
              {len_filter}
            ORDER BY p.num_occurrences DESC
            LIMIT ? OFFSET ?
            """,
            (project_id, ignore, direction, min_length - 1, min_length - 1, length, start)
        )

    phrases = cursor.fetchall()

    phrase_ids = [row[0] for row in phrases]
    src_phrases = [detokenise(row[1]) for row in phrases]
    tgt_phrases = [detokenise(row[2]) for row in phrases]
    directions = [row[3] for row in phrases]
    num_occurrences = [row[4] for row in phrases]

    return phrase_ids, src_phrases, tgt_phrases, directions, num_occurrences, total_records, filtered_records

# def fetch_ignored_phrases(project_id, start, length):
#     _, cursor = get_db()

#     # Collect all ignored phrases from both sources
#     all_phrases = []

#     # 1) Get phrases from phrases table where ignore=1
#     cursor.execute("""SELECT id, src_phrase, tgt_phrase, 0 as imported
#                       FROM phrases
#                       WHERE project_id=? AND ignore=1
#                       ORDER BY num_occurrences DESC""", (project_id,))
#     phrases_ignored = cursor.fetchall()
#     all_phrases.extend(phrases_ignored)

#     # 2) Get additional phrases from ignored table
#     additional_phrases = get_phrases_to_ignore(project_id)
#     for (id, src, tgt) in additional_phrases:
#         all_phrases.append((id, src, tgt, 1))  # 1 = imported
    
#     # 3) Calculate total count
#     total_records = len(all_phrases)

#     # 4) Apply pagination
#     paginated_phrases = all_phrases[start:start + length]

#     # 5) Build result arrays
#     phrase_ids = []
#     src_phrases = []
#     tgt_phrases = []
#     imported = []

#     for row in paginated_phrases:
#         phrase_ids.append(row[0])
#         src_phrases.append(detokenise(row[1]))
#         tgt_phrases.append(detokenise(row[2]))
#         imported.append(row[3])

#     return phrase_ids, src_phrases, tgt_phrases, imported, total_records

def fetch_ignored_phrases(project_id, start, length):
    _, cursor = get_db()

    # total count = ignored in phrases + imported ignored table
    cursor.execute("""
        SELECT
          (SELECT COUNT(*) FROM phrases WHERE project_id=? AND ignore=1) +
          (SELECT COUNT(*) FROM ignored WHERE project_id=?)
    """, (project_id, project_id))
    total_records = cursor.fetchone()[0]

    # paginate in SQL (no huge Python lists)
    cursor.execute("""
        SELECT id, src_phrase, tgt_phrase, imported
        FROM (
          SELECT id, src_phrase, tgt_phrase, 0 AS imported, num_occurrences AS score
          FROM phrases
          WHERE project_id=? AND ignore=1

          UNION ALL

          SELECT id, src_phrase, tgt_phrase, 1 AS imported, NULL AS score
          FROM ignored
          WHERE project_id=?
        )
        ORDER BY (score IS NULL) ASC, score DESC
        LIMIT ? OFFSET ?
    """, (project_id, project_id, length, start))

    rows = cursor.fetchall()

    phrase_ids, src_phrases, tgt_phrases, imported = [], [], [], []
    for pid, src, tgt, imp in rows:
        phrase_ids.append(pid)
        src_phrases.append(detokenise(src))
        tgt_phrases.append(detokenise(tgt))
        imported.append(imp)

    return phrase_ids, src_phrases, tgt_phrases, imported, total_records

""" def import_ignored_from_file(project_id, file_content):
    
    try:
        ignored_phrases = json.loads(file_content)
        if not isinstance(ignored_phrases, list):
            print("Invalid format: JSON is not a list")
            return 0
        
        phrases = []
        for phrase in ignored_phrases:
            src_phrase = tokenise(phrase.get("src", ""), as_string=True)
            tgt_phrase = tokenise(phrase.get("tgt", ""), as_string=True)
            phrases.append({"src_phrase": src_phrase, "tgt_phrase": tgt_phrase})
        
        add_phrases_to_ignore(project_id, phrases)
        print(f"Imported {len(phrases)} ignored phrases for project {project_id}")

        return len(phrases)

    except json.JSONDecodeError as e:
        print(f"JSON decode error: {e}")
        return 0
 """

# UPDATE 08.02.26
def import_ignored_from_file(project_id, file_content):
    try:
        ignored_phrases = json.loads(file_content)
    except json.JSONDecodeError as e:
        print(f"JSON decode error: {e}")
        return 0

    if not isinstance(ignored_phrases, list):
        print("Invalid format: JSON is not a list")
        return 0

    phrases = []
    skipped = 0

    for entry in ignored_phrases:
        # accept either {"src": "...", "tgt": "..."} or {"src": "..."} (tgt optional)
        if not isinstance(entry, dict):
            skipped += 1
            continue

        src_raw = entry.get("src", "")
        tgt_raw = entry.get("tgt", "")  # may be missing/empty

        # tokenise() returns "" for empty input; that's fine for tgt
        src_phrase = " ".join(strip_nb_bl((src_raw or "").strip().split()))
        tgt_phrase = " ".join(strip_nb_bl((tgt_raw or "").strip().split()))

        # IMPORTANT: require src to be non-empty, but allow empty tgt
        if not src_phrase:
            skipped += 1
            continue

        phrases.append({"src_phrase": src_phrase, "tgt_phrase": tgt_phrase})

    if not phrases:
        print("No valid ignored phrases found to import")
        return 0

    add_phrases_to_ignore(project_id, phrases)

    # actually hide phrases (and apply combination rule)
    apply_imported_ignored_to_phrases(project_id)
    print(f"Imported {len(phrases)} ignored phrases for project {project_id} (skipped {skipped})")

    return len(phrases)

# UPDATE 08.02.26
# import unicodedata
# import re
# import string

# # include extra punctuation that string.punctuation doesn't cover well
# _EXTRA_PUNCT = "«»“”„’‘–—…"
# _PUNCT = string.punctuation + _EXTRA_PUNCT

# def _norm_space(s: str) -> str:
#     s = unicodedata.normalize("NFC", s or "")
#     s = s.strip()
#     s = re.sub(r"\s+", " ", s)
#     return s

# def _norm_token(tok: str) -> str:
#     tok = _norm_space(tok).casefold()
#     return tok.strip(_PUNCT)

# def _norm_phrase(phrase: str) -> str:
#     toks = [_norm_token(t) for t in _norm_space(phrase).split()]
#     toks = [t for t in toks if t]
#     return " ".join(toks)

# def apply_imported_ignored_to_phrases(project_id):
#     conn, cursor = get_db()

#     # load ignored entries (tokenised)
#     cursor.execute(
#         "SELECT src_phrase, tgt_phrase FROM ignored WHERE project_id=?",
#         (project_id,)
#     )
#     ignored_rows = cursor.fetchall()

#     # Build ignore sets in NORMALISED (UI-like) form
#     ignored_src_any = set()   # src-only (tgt empty) => wildcard
#     ignored_pairs = set()     # exact src+tgt

#     for src_tok, tgt_tok in ignored_rows:
#         src_det = detokenise(src_tok or "")
#         tgt_det = detokenise(tgt_tok or "")

#         src_n = _norm_phrase(src_det)
#         tgt_n = _norm_phrase(tgt_det)

#         if not src_n:
#             continue

#         if tgt_n:
#             ignored_pairs.add((src_n, tgt_n))
#         else:
#             ignored_src_any.add(src_n)

#     # Apply ignores by scanning phrases and normalising them the same way
#     cursor.execute(
#         "SELECT id, src_phrase, tgt_phrase FROM phrases WHERE project_id=? AND ignore=0",
#         (project_id,)
#     )
#     phrase_rows = cursor.fetchall()

#     to_ignore = []
#     for pid, src_tok, tgt_tok in phrase_rows:
#         src_det = detokenise(src_tok or "")
#         tgt_det = detokenise(tgt_tok or "")

#         src_n = _norm_phrase(src_det)
#         tgt_n = _norm_phrase(tgt_det)

#         if not src_n:
#             continue

#         if (src_n in ignored_src_any) or ((src_n, tgt_n) in ignored_pairs):
#             to_ignore.append((pid, project_id))

#     if to_ignore:
#         cursor.executemany(
#             "UPDATE phrases SET ignore=1 WHERE id=? AND project_id=?",
#             to_ignore
#         )

#     # Combination rule (src side): hide multiword src if all tokens are hidden single words
#     hidden_words = {w for w in ignored_src_any if " " not in w}

#     if hidden_words:
#         cursor.execute(
#             "SELECT id, src_phrase FROM phrases WHERE project_id=? AND ignore=0",
#             (project_id,)
#         )
#         for pid, src_tok in cursor.fetchall():
#             src_det = detokenise(src_tok or "")
#             toks = [_norm_token(t) for t in _norm_space(src_det).split()]
#             toks = [t for t in toks if t]
#             if len(toks) > 1 and all(t in hidden_words for t in toks):
#                 cursor.execute(
#                     "UPDATE phrases SET ignore=1 WHERE id=? AND project_id=?",
#                     (pid, project_id)
#                 )
#     cursor.execute("SELECT COUNT(*) FROM phrases WHERE project_id=? AND ignore=1", (project_id,))
#     print("DEBUG phrases.ignore=1:", cursor.fetchone()[0])

#     cursor.execute("SELECT src_phrase, tgt_phrase FROM ignored WHERE project_id=? LIMIT 3", (project_id,))
#     print("DEBUG ignored sample:", cursor.fetchall())
#     conn.commit()

def apply_imported_ignored_to_phrases(project_id):
    conn, cursor = get_db()

    # --- load imported ignored entries ---
    cursor.execute(
        "SELECT src_phrase, tgt_phrase FROM ignored WHERE project_id=?",
        (project_id,)
    )
    ignored_rows = cursor.fetchall()

    # Compare in the SAME form as the UI shows (detokenised),
    # and case-insensitive (so "ch" hides "Ch").
    ignored_src_any = set()   # src-only ignores (tgt empty) => wildcard on tgt
    ignored_pairs = set()     # exact src+tgt ignores

    for src_tok, tgt_tok in ignored_rows:
        src_det = detokenise(src_tok or "").strip()
        tgt_det = detokenise(tgt_tok or "").strip()

        if not src_det:
            continue

        if tgt_det:
            ignored_pairs.add((src_det.casefold(), tgt_det.casefold()))
        else:
            ignored_src_any.add(src_det.casefold())

    # --- 1) Apply direct ignores (single words + exact phrases) ---
    cursor.execute(
        "SELECT id, src_phrase, tgt_phrase FROM phrases WHERE project_id=? AND ignore=0",
        (project_id,)
    )
    phrase_rows = cursor.fetchall()

    to_ignore = []
    for pid, src_tok, tgt_tok in phrase_rows:
        src_det = detokenise(src_tok or "").strip()
        tgt_det = detokenise(tgt_tok or "").strip()

        if not src_det:
            continue

        s = src_det.casefold()
        t = tgt_det.casefold()

        if (s in ignored_src_any) or ((s, t) in ignored_pairs):
            to_ignore.append((pid, project_id))

    if to_ignore:
        cursor.executemany(
            "UPDATE phrases SET ignore=1 WHERE id=? AND project_id=?",
            to_ignore
        )

    # --- 2) Combination rule (src side): hide "es as" if "es" and "as" are hidden ---
    hidden_words = {w for w in ignored_src_any if " " not in w}

    if hidden_words:
        cursor.execute(
            "SELECT id, src_phrase FROM phrases WHERE project_id=? AND ignore=0",
            (project_id,)
        )
        for pid, src_tok in cursor.fetchall():
            src_det = detokenise(src_tok or "").strip()
            toks = [x.casefold() for x in src_det.split() if x.strip()]
            if len(toks) > 1 and all(t in hidden_words for t in toks):
                cursor.execute(
                    "UPDATE phrases SET ignore=1 WHERE id=? AND project_id=?",
                    (pid, project_id)
                )

    conn.commit()


def get_all_phrases(project_id):
    """
    Get all phrases for a project as a list of dictionaries.
    Returns phrases with src_phrase, tgt_phrase, direction, num_occurrences.
    """
    _, cursor = get_db()
    
    cursor.execute("""
        SELECT src_phrase, tgt_phrase, direction, num_occurrences
        FROM phrases
        WHERE project_id=?
        ORDER BY num_occurrences DESC
    """, (project_id,))
    
    phrases = cursor.fetchall()
    
    result = []
    for row in phrases:
        result.append({
            "src_phrase": detokenise(row[0]),
            "tgt_phrase": detokenise(row[1]),
            "direction": row[2],
            "num_occurrences": row[3]
        })
    
    return result

def get_symmetric_phrases(project_id):
    """
    Get all phrases for a project as a list of dictionaries.
    Returns phrases with src_phrase, tgt_phrase, direction, num_occurrences.
    """
    _, cursor = get_db()
    
    cursor.execute("""
        SELECT src_phrase, tgt_phrase, direction, num_occurrences
        FROM phrases
        WHERE project_id=? AND direction=0
        ORDER BY num_occurrences DESC
    """, (project_id,))
    
    phrases = cursor.fetchall()
    
    result = []
    for row in phrases:
        result.append({
            "src_phrase": detokenise(row[0]),
            "tgt_phrase": detokenise(row[1]),
            "direction": row[2],
            "num_occurrences": row[3]
        })
    
    return result