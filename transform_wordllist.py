import json, sys, pathlib

inp = pathlib.Path("wordlist").read_text(encoding="utf-8").splitlines()

out = []
for line in inp:
    w = line.strip()
    if not w or w.startswith("#"):
        continue
    out.append({"src": w, "tgt": ""})   # or {"tgt": w}

pathlib.Path("wordlist.json").write_text(
    json.dumps(out, ensure_ascii=False, indent=2),
    encoding="utf-8"
)
print("Wrote wordlist.json with", len(out), "entries")