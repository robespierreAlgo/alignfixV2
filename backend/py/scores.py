# py/scores.py
import sqlite3
import json

from db import get_db
from collections import Counter

def import_scores_from_file(project_id, scores):
    
    try:
        conn, cursor = get_db()
        for row_id, score in enumerate(scores):
            
            score = float(score)
            score = round(score, 2)

            cursor.execute("""
                UPDATE alignments
                SET score = ?
                WHERE project_id = ? AND row_id = ?
            """, (score, project_id, row_id))

        conn.commit()

        return True
    
    except json.JSONDecodeError:
        pass
    
    return False


def assign_auto_scores(project_id):
    try:
        conn, cursor = get_db()
        
        # get all src and tgt lines for the given project
        cursor.execute("""
            SELECT row_id, line1, line2
            FROM alignments
            WHERE project_id = ?
        """, (project_id,))

        alignments = cursor.fetchall()

        # get all phrases of length 1 for the given project
        cursor.execute("""
            SELECT src_phrase, tgt_phrase, num_occurrences
            FROM phrases
            WHERE project_id = ?
                AND src_phrase NOT LIKE '% %'
                AND tgt_phrase NOT LIKE '% %'
        """, (project_id,))

        phrases = cursor.fetchall()

        print(f"Calculating automatic scores for {len(alignments)} alignments using {len(phrases)} single-word phrases.")

        raw_scores = []
        # build maps of phrase -> number of entries (faster lookups)
        src_phrase_counts = Counter()
        tgt_phrase_counts = Counter()
        for src_phrase, tgt_phrase, _ in phrases:
            src_phrase_counts[src_phrase] += 1
            tgt_phrase_counts[tgt_phrase] += 1

        for row_id, src_line, tgt_line in alignments:
            src_words = set(src_line.split())
            tgt_words = set(tgt_line.split())

            # lookup counts per unique word (O(1) per word)
            src_counts = [src_phrase_counts.get(w, 5) for w in src_words]
            tgt_counts = [tgt_phrase_counts.get(w, 5) for w in tgt_words]

            src_score = sum(src_counts) / len(src_counts) if src_counts else 1
            tgt_score = sum(tgt_counts) / len(tgt_counts) if tgt_counts else 1

            raw_score = (src_score + tgt_score) / 2
            raw_scores.append(raw_score)

        # Normalize scores to 0-1 range
        # Invert so 1 = clear (low ambiguity), 0 = ambiguous (high ambiguity)
        # This matches the Alignment Stability Index where higher is better
        if raw_scores:
            min_score = min(raw_scores)
            max_score = max(raw_scores)
            score_range = max_score - min_score
            
            if score_range > 0:
                # Normalize and invert: 1 - normalized score
                scores = [round(1 - ((score - min_score) / score_range), 5) for score in raw_scores]
            else:
                # All scores are the same
                scores = [0.5] * len(raw_scores)
        else:
            scores = []

        # Start a single transaction (optional if get_db() already wraps in one)
        cursor.execute("BEGIN")

        # Build list of (score, project_id, row_id) tuples
        update_records = [(score, project_id, row_id) for row_id, score in enumerate(scores)]

        # Use executemany to update all rows at once
        cursor.executemany("""
            UPDATE alignments
            SET score = ?
            WHERE project_id = ? AND row_id = ?
        """, update_records)

        conn.commit()

        return True

    except sqlite3.Error as e:
        print("Error occurred while assigning automatic scores:", e)
        pass

    return False

def get_scores(project_id):
    conn, cursor = get_db()
    cursor.execute("""
        SELECT score
        FROM alignments
        WHERE project_id = ?
    """, (project_id,))
    scores = cursor.fetchall()
    return scores

def bin_scores(scores, bin_count=20):
    if not scores:
        return []
    
    min_score = min(scores)
    max_score = max(scores)
    bin_size = (max_score - min_score) / bin_count

    bins = [0] * bin_count

    for score in scores:
        if score == max_score:
            bin_index = bin_count - 1
        else:
            bin_index = int((score - min_score) / bin_size)
        bins[bin_index] += 1

    binned_scores = [
        {
            "bin": min_score + i * bin_size, 
            "count": count
        } for i, count in enumerate(bins)
    ]

    return binned_scores

def save_scores(project_id, scores):
    conn, cursor = get_db()
    for row_id, score in enumerate(scores):
        cursor.execute("""
            UPDATE alignments
            SET score = ?
            WHERE project_id = ? AND row_id = ?
        """, (score, project_id, row_id))
    conn.commit()