# py/projects.py
import random
import time
import json

from collections import defaultdict

from text import tokenise, detokenise
from alignment import parse_alignment, repair_alignment, alignment_to_string
from phrases import get_directed_phrases_from_texts_and_alignment, get_phrase_occurrences, get_phrase_id
from projects import search_translations
from utils import find_all_sublists
from db import get_db

def update_row(project_id, row_id, updates):
    _, cursor = get_db()

    set_clause = ', '.join([f"{key} = ?" for key in updates.keys()])
    values = list(updates.values()) + [project_id, row_id]

    query = f"UPDATE alignments SET {set_clause} WHERE project_id = ? AND row_id = ?"
    cursor.execute(query, values)

def import_fixes_from_file(project_id, file_content):
    try:
        fixes = json.loads(file_content)
        if isinstance(fixes, list):
            valid_fixes = []
            for fix in fixes:
                if all(key in fix for key in ["phrase1", "phrase2", "fix1", "fix2", "direction", "percentage", "type"]):
                    valid_fixes.append(fix)
            if valid_fixes:
                save_fixes(project_id, valid_fixes)
                return True
    except json.JSONDecodeError:
        pass
    return False

def get_rows(project_id, row_ids):
    if not row_ids:
        return []

    _, cursor = get_db()

    placeholders = ', '.join(['?'] * len(row_ids))
    query = f"SELECT row_id, line1, line2, alignment, score FROM alignments WHERE project_id = ? AND row_id IN ({placeholders})"
    cursor.execute(query, [project_id] + row_ids)

    rows = cursor.fetchall()

    result = []
    for row in rows:
        result.append({
            "row_id": row[0],
            "line1": row[1],
            "line2": row[2],
            "alignment": row[3],
            "score": row[4]
        })
    
    return result

def add_phrase_occurrences(project_id, pairs_to_add):
    conn, cursor = get_db()

    # Wrap the whole thing in a single transaction
    cursor.execute("BEGIN")

    insert_phrase_stmt = """
        INSERT INTO phrases (src_phrase, tgt_phrase, direction, project_id, num_occurrences)
        VALUES (?, ?, ?, ?, ?)
    """
    select_phrase_stmt = """
        SELECT id FROM phrases 
        WHERE src_phrase=? AND tgt_phrase=? AND direction=? AND project_id=?
    """
    insert_occ_stmt = """
        INSERT OR IGNORE INTO occurrences (row_id, id_phrases, project_id)
        VALUES (?, ?, ?)
    """

    for (src, tgt, direction), row_ids in pairs_to_add.items():
        # Fetch or insert phrase efficiently
        cursor.execute(select_phrase_stmt, (src, tgt, direction, project_id))
        row = cursor.fetchone()
        if row:
            phrase_id = row[0]
        else:
            cursor.execute(insert_phrase_stmt, (src, tgt, direction, project_id, len(row_ids)))
            phrase_id = cursor.lastrowid

        # Batch insert occurrences using executemany()
        cursor.executemany(
            insert_occ_stmt,
            [(row_id, phrase_id, project_id) for row_id in row_ids]
        )

    conn.commit()

    return True

def remove_occurrences_for_rows(project_id, rows):    
    conn, cursor = get_db()
    cursor.executemany(
        "DELETE FROM occurrences WHERE row_id=? AND project_id=?",
        [(rid, project_id) for rid in rows]
    )

    conn.commit()
    
def get_phrases_for_row(project_id, row_id):
    _, cursor = get_db()

    cursor.execute("""
        SELECT p.src_phrase, p.tgt_phrase, p.direction, o.start_src, o.start_tgt
        FROM phrases p
        JOIN occurrences o ON p.id = o.id_phrases
        WHERE o.row_id = ? AND o.project_id = ?
    """, (row_id, project_id))

    phrases = cursor.fetchall()

    return phrases

def delete_phrases_without_occurrence(project_id):
    _, cursor = get_db()

    # Delete phrases for a specific project
    cursor.execute("""
        DELETE FROM phrases
        WHERE project_id = ?
          AND num_occurrences = 0
    """, (project_id,))


def save_fixes(project_id, fixes):
    conn, cursor = get_db()

    print(f"Saving {len(fixes)} fixes for project {project_id}")
    
    for fix in fixes:
        src_phrase = fix.get("src_phrase", "").strip()
        tgt_phrase = fix.get("tgt_phrase", "").strip()
        src_fix = fix.get("src_fix", "").strip()
        tgt_fix = fix.get("tgt_fix", "").strip()
        direction = int(fix.get("direction", 0))
        num_occurrences = int(fix.get("num_occurrences", 0))
        percentage = int(fix.get("percentage", 100))
        change_type = fix.get("type", "").strip()

        if not src_phrase and not tgt_phrase:
            continue

        cursor.execute("""
            INSERT INTO fixes (src_phrase, tgt_phrase, src_fix, tgt_fix, direction, num_occurrences, percentage, type, project_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        """, (src_phrase, tgt_phrase, src_fix, tgt_fix, direction, num_occurrences, percentage, change_type, project_id))

    conn.commit()


def get_fixes(project_id):
    _, cursor = get_db()
    cursor.execute("SELECT id, src_phrase, src_fix, tgt_phrase, tgt_fix, direction, num_occurrences, percentage, type, created_at FROM fixes WHERE project_id=?", (project_id,))
    fixes = cursor.fetchall()

    fixes_arr = [
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
    ]

    return fixes_arr

def count_fixes(project_id):
    _, cursor = get_db()
    cursor.execute("SELECT COUNT(*) FROM fixes WHERE project_id=?", (project_id,))
    count = cursor.fetchone()[0]
    return count

def resync_pairs(project_id, pairs):
    conn, cursor = get_db()

    # Update each phrase with the count of matching occurrences
    for (src_phrase, tgt_phrase, direction) in pairs:
        cursor.execute("""
            UPDATE phrases
            SET num_occurrences = (
                SELECT COUNT(*)
                FROM occurrences o
                WHERE o.id_phrases = phrases.id
                AND o.project_id = phrases.project_id
            ), is_synced=1
            WHERE project_id = ? AND src_phrase = ? AND tgt_phrase = ? AND direction = ?
        """, (project_id, src_phrase, tgt_phrase, direction))
    
    conn.commit()

def apply_directed_fixes(
    document_id,
    fixes,
    fix_direction=1
):
    direction_name = "forward (src→tgt)" if fix_direction == 1 else "reverse (tgt→src)"
    print(f"operation:Applying {len(fixes)} fixes in {direction_name} direction")
    print('progress:0')

    sort_key = "src_phrase" if fix_direction==1 else "tgt_phrase"

    fixes.sort(key=lambda x: len(x[sort_key]), reverse=True)
    print(f"📋 Fixes sorted by {sort_key} length (longest first)")

    pairs_to_add = defaultdict(list)
    rows_to_refresh = set()
    pairs_to_resync = set()

    total_fixes = len(fixes)
    applied_fixes = 0
    skipped_fixes = 0
    total_occurrences_modified = 0

    for fix_i, fix_obj in enumerate(fixes):
        # Progress through fixes (0-80%)
        fix_progress = int((fix_i / total_fixes) * 80)
        print(f'progress:{fix_progress}')
        print(f"operation:Processing fix {fix_i + 1}/{total_fixes}: {fix_obj.get('src_phrase', '')} → {fix_obj.get('tgt_phrase', '')}")

        src_phrase = fix_obj["src_phrase"]
        tgt_phrase = fix_obj["tgt_phrase"]
        direction = int(fix_obj["direction"])
        percentage = int(fix_obj["percentage"])
        change_type = fix_obj.get("type", "fix")

        print(f"🔧 Fix details: direction={direction}, percentage={percentage}%")

        if direction == -1 and fix_direction==1:
            print(f"⏭️ Skipping fix (direction mismatch: fix is reverse, applying forward)")
            skipped_fixes += 1
            continue

        if direction == 1 and fix_direction==-1:
            print(f"⏭️ Skipping fix (direction mismatch: fix is forward, applying reverse)")
            skipped_fixes += 1
            continue

        src_phrase_raw = src_phrase
        tgt_phrase_raw = tgt_phrase

        src_phrase_raw = tokenise(src_phrase, as_string=True)
        tgt_phrase_raw = tokenise(tgt_phrase, as_string=True)
            
        src_phrase_tokens = src_phrase_raw.split()
        tgt_phrase_tokens = tgt_phrase_raw.split()

        print(f"🔤 Tokenized phrases: src='{src_phrase_raw}' ({len(src_phrase_tokens)} tokens), tgt='{tgt_phrase_raw}' ({len(tgt_phrase_tokens)} tokens)")

        src_fix = fix_obj.get("src_fix", None)
        tgt_fix = fix_obj.get("tgt_fix", None)

        if src_fix == src_phrase:
            src_fix = None
        if tgt_fix == tgt_phrase:
            tgt_fix = None

        fix = tgt_fix if fix_direction==1 else src_fix

        if fix is None or fix == "":
            print(f"⏭️ Skipping fix (no fix text provided)")
            skipped_fixes += 1
            continue

        fix = tokenise(fix, as_string=True)
        fix_tokens = fix.split()

        print(f"🎯 Applying fix: '{fix}' ({len(fix_tokens)} tokens)")

        pairs_to_resync.add((src_phrase_raw, tgt_phrase_raw, fix_direction))

        matches = []
        num_matches = 0
        if src_phrase.strip() and tgt_phrase.strip():
            print(f"🔍 Searching for phrase occurrences...")
            matches, num_matches = get_phrase_occurrences(document_id, src_phrase_raw, tgt_phrase_raw, direction)
            res = get_rows(document_id, matches)
            print(f"📍 Found {num_matches} direct phrase matches")
            
        if not matches:
            print(f"🔍 No direct matches found, searching translations...")
            res, num_matches = search_translations(document_id, src_phrase_raw, tgt_phrase_raw, length=None)
            direction = 2  # both directions
            print(f"📍 Found {num_matches} translation matches")
            
        if not res:
            print(f"❌ No matches found for this fix, skipping")
            skipped_fixes += 1
            continue

        if percentage < 100:
            num_to_fix = max(1, (num_matches * percentage) // 100)
            res = random.sample(res, num_to_fix)
            print(f"📊 Applying to {percentage}% of matches: {num_to_fix}/{num_matches} occurrences")
        else:
            print(f"📊 Applying to all {len(res)} occurrences")

        if "num_occurrences" not in fix_obj:
            fix_obj["num_occurrences"] = len(res)
        else:
            fix_obj["num_occurrences"] += len(res)

        total_occurrences_modified += len(res)

        for di, doc in enumerate(res):
            if di % 100 == 0 and di > 0:
                print(f"⏳ Processing occurrence {di + 1}/{len(res)}")
            
            row_id = doc["row_id"]
            line1 = doc["line1"]
            line2 = doc["line2"]
            alignment = doc["alignment"]

            text1_text2_alignment = parse_alignment(alignment)
            max_phrase_len = max(len(src_phrase_tokens), len(tgt_phrase_tokens))
            max_phrase_len = max(max_phrase_len + 2, 5)

            text1_tokens = line1.split()
            text2_tokens = line2.split()

            phrases = get_directed_phrases_from_texts_and_alignment(
                text1_tokens, text2_tokens, text1_text2_alignment,
                max_phrase_len=max_phrase_len
            )

            if direction == 2:
                if fix_direction==1:
                    fixed_line = line2
                    tokens = text2_tokens
                    phrase_tokens = tgt_phrase_tokens
                    linestype = "line2"
                    key_idx = 1
                else:
                    fixed_line = line1
                    tokens = text1_tokens
                    phrase_tokens = src_phrase_tokens
                    linestype = "line1"
                    key_idx = 0
                
                indices = find_all_sublists(tokens, phrase_tokens)

                for start in indices:
                    if tokens[start:start + len(phrase_tokens)] == phrase_tokens:
                        tokens[start:start + len(phrase_tokens)] = fix_tokens
                        fixed_line = ' '.join(tokens)
                        text1_text2_alignment = repair_alignment(text1_text2_alignment, phrase_tokens, fix_tokens, key_idx, start)

                update_row(document_id, row_id, {
                    linestype: fixed_line,
                    "alignment": alignment_to_string(text1_text2_alignment)
                })

                if linestype == "line1":
                    line1 = fixed_line
                else:
                    line2 = fixed_line
            else:
                if fix_direction==1:
                    tokens = text2_tokens
                    phrase_tokens = tgt_phrase_tokens
                    linestype = "line2"
                    key_idx = 1
                    sort_key = 4
                else:
                    tokens = text1_tokens
                    phrase_tokens = src_phrase_tokens
                    linestype = "line1"
                    key_idx = 0
                    sort_key = 3

                phrases = sorted(phrases, key=lambda x: x[sort_key], reverse=True)
                for phrase in phrases:

                    (src_p, tgt_p, dir_p, _, _) = phrase

                    if (src_phrase.strip() and src_p != src_phrase_raw):
                        continue

                    if (tgt_phrase.strip() and tgt_p != tgt_phrase_raw):
                        continue

                    start = phrase[sort_key]
                    end = start + len(phrase_tokens)

                    if tokens[start:end] != phrase_tokens:
                        continue

                    tokens = tokens[:start] + fix_tokens + tokens[end:]
                    fixed_line = ' '.join(tokens)

                    if linestype == "line1":
                        line1 = fixed_line
                    else:
                        line2 = fixed_line

                    new_alignment = repair_alignment(text1_text2_alignment, phrase_tokens, fix_tokens, key_idx, start)
                    
                    update_row(document_id, row_id, {
                        linestype: fixed_line,
                        "alignment": alignment_to_string(new_alignment)
                    })
                    
                    text1_text2_alignment = new_alignment
            

            rows_to_refresh.add(row_id)
            text1_tokens = line1.split()
            text2_tokens = line2.split()
            new_phrases = get_directed_phrases_from_texts_and_alignment(
                text1_tokens, text2_tokens, text1_text2_alignment
            )

            for (src_p, tgt_p, dir_p, _, _) in new_phrases:
                pairs_to_add[(src_p, tgt_p, dir_p)].append(row_id)
                pairs_to_resync.add((src_p, tgt_p, dir_p))

            for (src_p, tgt_p, dir_p, _, _) in phrases:
                pairs_to_resync.add((src_p, tgt_p, dir_p))

        applied_fixes += 1
        print(f"✅ Fix applied successfully to {len(res)} occurrences")

    print('progress:80')
    print('operation:Refreshing phrase occurrences in database')
    print(f"🔄 Refreshing {len(rows_to_refresh)} rows for document {document_id}")        
    remove_occurrences_for_rows(document_id, rows_to_refresh)

    print('progress:85')
    print('operation:Adding new phrase occurrences')
    print(f"➕ Adding {len(pairs_to_add)} phrase occurrences for document {document_id}")
    add_phrase_occurrences(document_id, pairs_to_add)

    print('progress:90')
    print('operation:Resyncing phrase statistics')
    print(f"🔄 Resyncing {len(pairs_to_resync)} phrases for document {document_id}")
    resync_pairs(document_id, pairs_to_resync)

    print('progress:100')
    print(f"✅ {direction_name} fixes completed!")
    print(f"📊 Summary:")
    print(f"   • Total fixes processed: {total_fixes}")
    print(f"   • Fixes applied: {applied_fixes}")
    print(f"   • Fixes skipped: {skipped_fixes}")
    print(f"   • Total occurrences modified: {total_occurrences_modified}")
    print(f"   • Rows refreshed: {len(rows_to_refresh)}")
    print(f"   • Phrase pairs resynced: {len(pairs_to_resync)}")

    return True

def apply_fixes(project_id, fixes):
    start_time = time.time()
    
    print(f"operation:Starting fix application for document {project_id}")
    print('progress:0')
    print(f"🚀 Starting application of {len(fixes)} fixes to document {project_id}")

    # Separate fixes by type
    replacement_fixes = [f for f in fixes if f.get("type", "fix") == "fix"]
    duplication_fixes = [f for f in fixes if f.get("type") == "augment"]

    print(f"📊 Fixes breakdown: {len(replacement_fixes)} replacements, {len(duplication_fixes)} duplications")

    # Track duplicated rows to avoid duplicating them twice
    duplicated_rows = set()

    # Apply duplication fixes first (both directions together to avoid double duplication)
    if duplication_fixes:
        print('progress:5')
        print(f"operation:Applying {len(duplication_fixes)} duplication fixes")
        duplicated_rows = apply_duplication_fixes(project_id, duplication_fixes)

    # Apply replacement fixes by direction
    if replacement_fixes:
        print(f"operation:Applying replacement fixes in forward direction")
        print('progress:30')
        print(f"📋 Applying {len(replacement_fixes)} replacement fixes, forward direction")
        apply_directed_fixes(
            project_id,
            replacement_fixes,
            fix_direction=1
        )

        print(f"operation:Applying replacement fixes in reverse direction") 
        print('progress:65')
        print(f"📋 Applying {len(replacement_fixes)} replacement fixes, reverse direction")
        apply_directed_fixes(
            project_id,
            replacement_fixes,
            fix_direction=-1
        )

    if fixes:
        print('progress:95')
        print('operation:Saving fixes to database')
        print("💾 Saving fixes to database")
        save_fixes(project_id, fixes)
        
        print('operation:Cleaning up unused phrases')
        print("🧹 Cleaning up phrases without occurrences")
        delete_phrases_without_occurrence(project_id)

    end_time = time.time()
    total_duration = end_time - start_time
    
    print('progress:100')
    print(f"🎉 Fix application completed successfully!")
    print(f"⏱️ Total processing time: {total_duration:.2f} seconds")
    print(f"📊 Duplicated rows: {len(duplicated_rows)}")
    print(f"📊 Average time per fix: {(total_duration / len(fixes)):.3f} seconds" if fixes else "")

    return True


def apply_duplication_fixes(project_id, fixes):
    """
    Apply duplication fixes (augmentation). 
    Processes both directions together to avoid duplicating rows twice.
    Returns set of row IDs that were duplicated.
    """
    conn, cursor = get_db()
    
    print(f"operation:Applying {len(fixes)} duplication fixes")
    print('progress:0')

    duplicated_rows = set()
    pairs_to_add = defaultdict(list)
    pairs_to_resync = set()
    new_row_ids = []
    
    total_fixes = len(fixes)
    applied_fixes = 0
    skipped_fixes = 0
    total_duplications = 0

    num_rows = cursor.execute("SELECT COUNT(*) FROM alignments WHERE project_id=?", (project_id,)).fetchone()[0]

    for fix_i, fix_obj in enumerate(fixes):
        fix_progress = int((fix_i / total_fixes) * 20)  # 0-20% progress
        print(f'progress:{fix_progress}')
        print(f"operation:Processing duplication {fix_i + 1}/{total_fixes}")

        src_phrase = fix_obj["src_phrase"]
        tgt_phrase = fix_obj["tgt_phrase"]
        direction = int(fix_obj["direction"])
        percentage = int(fix_obj["percentage"])

        src_phrase_raw = tokenise(src_phrase, as_string=True)
        tgt_phrase_raw = tokenise(tgt_phrase, as_string=True)
        src_phrase_tokens = src_phrase_raw.split()
        tgt_phrase_tokens = tgt_phrase_raw.split()

        src_fix = fix_obj.get("src_fix", None)
        tgt_fix = fix_obj.get("tgt_fix", None)

        if src_fix == src_phrase:
            src_fix = None
        if tgt_fix == tgt_phrase:
            tgt_fix = None

        # Determine which side gets modified
        has_src_fix = src_fix is not None and src_fix != ""
        has_tgt_fix = tgt_fix is not None and tgt_fix != ""

        if not has_src_fix and not has_tgt_fix:
            print(f"⏭️ Skipping duplication (no fix text provided)")
            skipped_fixes += 1
            continue

        # Find matching rows
        matches = []
        num_matches = 0
        if src_phrase.strip() and tgt_phrase.strip():
            matches, num_matches = get_phrase_occurrences(project_id, src_phrase_raw, tgt_phrase_raw, direction)
            res = get_rows(project_id, matches)
            print(f"📍 Found {num_matches} phrase matches")
        
        if not matches:
            res, num_matches = search_translations(project_id, src_phrase_raw, tgt_phrase_raw, length=None)
            direction = 2
            print(f"📍 Found {num_matches} translation matches")
        
        if not res:
            print(f"❌ No matches found, skipping")
            skipped_fixes += 1
            continue

        if percentage < 100:
            num_to_duplicate = max(1, (num_matches * percentage) // 100)
            res = random.sample(res, num_to_duplicate)
            print(f"📊 Duplicating {percentage}%: {num_to_duplicate}/{num_matches} occurrences")
        else:
            print(f"📊 Duplicating all {len(res)} occurrences")

        if "num_occurrences" not in fix_obj:
            fix_obj["num_occurrences"] = len(res)
        else:
            fix_obj["num_occurrences"] += len(res)

        total_duplications += len(res)

        # Duplicate each matching row
        for doc_idx, doc in enumerate(res):
            row_id = doc["row_id"]
            line1 = doc["line1"]
            line2 = doc["line2"]
            alignment = doc["alignment"]

            # Create modified copy
            new_line1 = line1
            new_line2 = line2
            new_alignment = parse_alignment(alignment)

            text1_tokens = line1.split()
            text2_tokens = line2.split()

            # Apply modifications based on which fixes are provided
            if has_src_fix:
                src_fix_raw = tokenise(src_fix, as_string=True)
                src_fix_tokens = src_fix_raw.split()
                indices = find_all_sublists(text1_tokens, src_phrase_tokens)
                for start in indices:
                    if text1_tokens[start:start + len(src_phrase_tokens)] == src_phrase_tokens:
                        text1_tokens[start:start + len(src_phrase_tokens)] = src_fix_tokens
                        new_alignment = repair_alignment(new_alignment, src_phrase_tokens, src_fix_tokens, 0, start)
                        break
                new_line1 = ' '.join(text1_tokens)

            if has_tgt_fix:
                tgt_fix_raw = tokenise(tgt_fix, as_string=True)
                tgt_fix_tokens = tgt_fix_raw.split()
                indices = find_all_sublists(text2_tokens, tgt_phrase_tokens)
                for start in indices:
                    if text2_tokens[start:start + len(tgt_phrase_tokens)] == tgt_phrase_tokens:
                        text2_tokens[start:start + len(tgt_phrase_tokens)] = tgt_fix_tokens
                        new_alignment = repair_alignment(new_alignment, tgt_phrase_tokens, tgt_fix_tokens, 1, start)
                        break
                new_line2 = ' '.join(text2_tokens)

            new_row_id = num_rows + doc_idx + fix_i
            # Insert new row
            cursor.execute("""
                INSERT OR IGNORE INTO alignments (row_id, project_id, line1, line2, alignment, score)
                VALUES (?, ?, ?, ?, ?, ?)
            """, (new_row_id, project_id, new_line1, new_line2, alignment_to_string(new_alignment), 0))
            
            new_row_ids.append(new_row_id)
            duplicated_rows.add(row_id)

            # Extract phrases from new row
            text1_tokens = new_line1.split()
            text2_tokens = new_line2.split()
            new_phrases = get_directed_phrases_from_texts_and_alignment(
                text1_tokens, text2_tokens, new_alignment
            )

            for (src_p, tgt_p, dir_p, _, _) in new_phrases:
                pairs_to_add[(src_p, tgt_p, dir_p)].append(new_row_id)
                pairs_to_resync.add((src_p, tgt_p, dir_p))

        conn.commit()
        applied_fixes += 1
        print(f"✅ Duplication applied to {len(res)} occurrences")

    print('progress:20')
    print('operation:Adding phrase occurrences for duplicated rows')
    print(f"➕ Adding {len(pairs_to_add)} phrase occurrences")
    add_phrase_occurrences(project_id, pairs_to_add)
    
    print('progress:22')
    print('operation:Resyncing phrase statistics')
    print(f"🔄 Resyncing {len(pairs_to_resync)} phrases for project {project_id}")
    resync_pairs(project_id, pairs_to_resync)

    print('progress:25')
    print(f"✅ Duplication completed!")
    print(f"📊 Summary:")
    print(f"   • Total fixes processed: {total_fixes}")
    print(f"   • Fixes applied: {applied_fixes}")
    print(f"   • Fixes skipped: {skipped_fixes}")
    print(f"   • Total duplications: {total_duplications}")
    print(f"   • New rows created: {len(new_row_ids)}")
    print(f"   • Source rows duplicated: {len(duplicated_rows)}")

    return duplicated_rows
