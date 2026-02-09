import numpy as np
from text import detokenise

def alignment_to_string(xs):
    return " ".join([f"{s}-{t}" for s, t in xs])

def parse_alignment(alignment_str):
    return  [tuple(map(int, x.split('-'))) for x in alignment_str.split()]

#@njit
def balance_alignment(xs, ys):

    xs_len = len(xs)
    ys_len = len(ys)

    if xs_len == ys_len:
        return list(zip(xs, ys))

    elif xs_len < ys_len:
        zs = np.array_split(np.array(ys), xs_len)
        return [(x, y) for i,x in enumerate(xs) for y in zs[i]]

    else:
        zs = np.array_split(np.array(xs), ys_len)
        return [(y, x) for i,x in enumerate(ys) for y in zs[i]]

def repair_alignment(alignment, phrase_tok, fix_tok, key_idx, start):

    delta = len(fix_tok) - len(phrase_tok)
    
    if delta == 0:
        return alignment

    end = start + len(phrase_tok)

    if key_idx == 1:
        balance_order = lambda rng, moved_ids: balance_alignment(moved_ids, rng)
        other_side = 0
    else:
        balance_order = lambda rng, moved_ids: balance_alignment(rng, moved_ids)
        other_side = 1

    new_alignment = []
    moved_ids = []
    for s, t in alignment:

        pair = [s, t]
        key = pair[key_idx]

        if key < start:
            new_alignment.append((s,t))

        elif key >= end:
            pair[key_idx] += delta
            new_alignment.append(tuple(pair))

        else:
            moved_ids.append(pair[other_side])

    rng = range(start, start + len(fix_tok))
    
    if moved_ids and rng:
        new_alignment.extend(balance_order(rng, moved_ids))

    return new_alignment


def get_alignments_with_scores(project_id, page=0, page_size=100, min_score=None, max_score=None, sort_order='desc'):
    """
    Fetch alignments with their stored scores (no recomputation).
    Supports pagination, filtering, and sorting.
    """
    from db import get_db

    conn, cursor = get_db()

    # Build WHERE clause
    where_clauses = ["project_id = ?"]
    params = [project_id]

    if min_score is not None:
        where_clauses.append("score >= ?")
        params.append(min_score)
    if max_score is not None:
        where_clauses.append("score <= ?")
        params.append(max_score)

    where_clause = " AND ".join(where_clauses)

    # Total count
    cursor.execute(f"SELECT COUNT(*) FROM alignments WHERE {where_clause}", params)
    total_count = cursor.fetchone()[0]

    # Sorting
    if sort_order == 'asc':
        order_by = "score ASC NULLS LAST"
    elif sort_order == 'desc':
        order_by = "score DESC NULLS LAST"
    else:
        order_by = "row_id ASC"

    # Pagination query
    offset = page * page_size
    cursor.execute(
        f"""
        SELECT row_id, line1, line2, alignment, COALESCE(score, 0.0) as score
        FROM alignments
        WHERE {where_clause}
        ORDER BY {order_by}
        LIMIT ? OFFSET ?
        """,
        params + [page_size, offset]
    )

    rows = cursor.fetchall()

    alignments = [
        {
            'id': row[0],
            'src_text': row[1],
            'src_text_detok': detokenise(row[1]),
            'tgt_text': row[2],
            'tgt_text_detok': detokenise(row[2]),
            'alignment': row[3],
            'score': row[4]
        }
        for row in rows
    ]

    return alignments, total_count
