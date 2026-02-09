import unicodedata
import ftfy
import re

from utils import find_all_sublists

SPLIT_SYMBOLS = [
    "'",
    "!",
    '"',
    "$",
    "%",
    "&",
    "\\",
    "(",
    ")",
    ".",
    "*",
    "+",
    ";",
    "@",
    "^",
    "`",
    "_",
    "|",
    "~",
    "-",
    "]",
    "[",
    "}",
    "{",
    "€",
    "§",
    "<",
    ">",
    ";",
    "!",
    "'",
    "?",
    ",",
    "/",
    ":",
    '"',
    "=",
    "»",
    "«",
]

NO_BLANK_TOKEN = "#NB"
BLANK_TOKEN = "#BLANK"

SKIP_SYMBOLS = SPLIT_SYMBOLS + [BLANK_TOKEN, NO_BLANK_TOKEN]


def clean_text(text):
    text = ftfy.fix_text(text)
    clean = unicodedata.normalize("NFKC", text)
    return clean

def detokenise(text, as_list=False):
    if isinstance(text, list):
        text = " ".join([str(x) for x in text])

    text = re.sub(rf'\s*{NO_BLANK_TOKEN}\s*', '', text)
    text = re.sub(rf'\s*{BLANK_TOKEN}\s*', ' ', text)

    if as_list:
        return text.split()

    return text

def create_content_search(text):

    words = tokenise(text)
    words = [w for w in words if w not in SKIP_SYMBOLS]
    return words

def remove_nb_bl_pairs_stack(tokens):
    stack = []

    for t in tokens:
        if stack and ((stack[-1], t) in [(NO_BLANK_TOKEN, BLANK_TOKEN), (BLANK_TOKEN, NO_BLANK_TOKEN)]):
            stack.pop()  # remove previous NB/BL
        else:
            stack.append(t)

    return stack

def strip_nb_bl(tokens):
    # if first token is Blank or no blank, strip
    if tokens and (tokens[0] == BLANK_TOKEN or tokens[0] == NO_BLANK_TOKEN):
        tokens = tokens[1:]

    # if last token is Blank or no blank, strip
    if tokens and (tokens[-1] == BLANK_TOKEN or tokens[-1] == NO_BLANK_TOKEN):
        tokens = tokens[:-1]

    return tokens

def tokenise(text, as_string=False):

    if isinstance(text, list):
        text = " ".join(text)

    if not text.strip():
        return ''

    text = clean_text(text)

    if text == " ":
        return NO_BLANK_TOKEN if as_string else [NO_BLANK_TOKEN]

    for sym in SPLIT_SYMBOLS:
        text = text.replace(sym, f" {NO_BLANK_TOKEN} {sym} {NO_BLANK_TOKEN} ")

    # replace multiple blankss
    tokens = text.split(" ")
    # replace empty tokens with BLANK_TOKEN
    tokens = [BLANK_TOKEN if not token.strip() else token for token in tokens]

    tokens = remove_nb_bl_pairs_stack(tokens)

    if as_string:
        text = " ".join(tokens)
        text = re.sub(r"\s+", " ", text).strip()
        return text

    return tokens


def highlight_tokens(tok_str, tok_to_highlight, replace_with_str):

    raw_tok = tok_str.split()
    #src_raw = src_raw.replace(f"{search_value_1}", src_highlight)
    indices = find_all_sublists(raw_tok, tok_to_highlight)

    for start in indices:
        if raw_tok[start:start + len(tok_to_highlight)] == tok_to_highlight:
            raw_tok[start:start + len(tok_to_highlight)] = [f"<span class='occurrence src-occurrence'>{replace_with_str}</span>"]
            tok_str = raw_tok

    return tok_str