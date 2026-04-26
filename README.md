![AlignFix Logo](ui/img/alignfix-logo.png)

# AlignFix

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![WebAssembly](https://img.shields.io/badge/WebAssembly-654FF0?logo=webassembly&logoColor=white)](https://webassembly.org/)
[![Python](https://img.shields.io/badge/Python-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![Bootstrap](https://img.shields.io/badge/Bootstrap-5-7952B3?logo=bootstrap&logoColor=white)](https://getbootstrap.com/)

**AlignFix** is a browser-based tool for augmenting and refining parallel text corpora. Built entirely with WebAssembly (WASM), it provides desktop-class performance for word alignment, phrase extraction, and quality assessment while running locally in the browser.

## Phrase Consistency Overview

After phrase extraction, AlignFix analyzes how consistently a source phrase is translated.

For each source phrase, the overview keeps track of:

- `total` — total number of occurrences of the source phrase
- aligned target variants and their counts
- optional `unaligned` occurrences, when the source phrase appears without an aligned target phrase

### Consistency

Consistency is defined as:

`consistency = (count of the best aligned variant) / (total occurrences)`

Interpretation:

- `1.0` means the source phrase is always aligned the same way
- `0.5` means the best aligned variant covers half of all occurrences
- if many occurrences are unaligned, consistency drops accordingly

Important details:

- the displayed number of `variants` counts **aligned** target variants only
- in the word overview, the search icon count reflects **all** occurrences, including unaligned ones
- clicking the search icon shows **all occurrences** of the source phrase, not only the top aligned translation

### Variant Display

For single-token source words, the overview can display:

- aligned target variants
- an extra `unaligned` entry, if relevant

Variant percentages are always computed over the full `total`.

Example:

- total = 12
- best aligned variant = 8
- unaligned = 4

Then:

- consistency = `8 / 12 = 66.7%`
- aligned variant share = `66.7%`
- unaligned share = `33.3%`

## Suspicious Words

A word is marked as **suspicious** if at least one of these holds:

- consistency `< 75%` with `10+` occurrences
- `4+` aligned variants with `10+` occurrences
- high unaligned share `>= 20%` with `10+` occurrences

This flag is meant as a review hint, not as a hard error label.

## Form-Aligned Candidates (Morphology)

In addition to consistency-based review, AlignFix computes **form-aligned candidates** that can be used in the hidden-phrases workflow.

Rules:

- only **single-token** source forms are considered
- Ladin morphology is taken from `backend/local_data/formario_lavb.csv`
- Italian morphology is taken from `backend/local_data/morphit_it.txt`
- the Italian **head token** is extracted conservatively
- a pair is considered form-aligned if Ladin tag features match a compatible Morph-it feature for the Italian head

These candidates can optionally be hidden during export.

## Dictionary-Based Hiding

AlignFix can also use the bilingual dictionary file:

- `backend/local_data/lavb-ita.csv`

If a single-word Ladin → Italian phrase pair appears as a **1:1 dictionary match**, it can also be marked as hidden.

This gives a third hiding source in addition to:

- consistency-based hiding
- morphology-based form alignment
- dictionary-based matches

## Hidden Phrases Workflow

AlignFix supports dynamic hiding, so phrase categories can be included or excluded depending on the selected toggles.

Possible hidden categories are:

- **Consistent**
- **Form-aligned**
- **Dictionary-based**

Depending on the selected options, the hidden export is built from the union of the enabled categories.

Example:

`HIDDEN = CONSISTENT ∪ FORM-ALIGNED ∪ DICTIONARY`

with each part included only if its toggle is enabled.

The generated report explains:

- how many phrases were hidden in total
- how many were hidden due to consistency
- how many were hidden due to form alignment
- how many were hidden due to dictionary matches
- overlap patterns where relevant
- example phrases for each category

## Generated Files After Phrase Extraction

AlignFix can generate or download the following outputs:

- **Phrase Table (CSV / JSON)**  
  Complete table of extracted phrases with statistics and consistency scores

- **Sure / Consistent Phrases (CSV / JSON)**  
  High-consistency phrases with stable aligned translations

- **Dubious Phrases (CSV / JSON)**  
  Lower-consistency phrases that may need review

- **Translation Consistency Overview (TXT)**  
  Overview summary with example consistent and dubious phrases, plus hidden-phrase counts and examples

- **Hidden Phrases JSON**  
  Uploadable JSON built from the currently enabled hidden categories

## What the CSV / JSON Reports Contain

The phrase tables include fields such as:

- `total` — total number of occurrences
- `top_tgt` — best aligned translation
- `top_count` — number of times the best aligned translation occurs
- `top_share` — consistency score (`top_count / total`)
- `num_tgts` — number of distinct aligned translations
- `entropy` — how variable the aligned translations are
- `topk` — top aligned target alternatives with counts

In the GUI, `unaligned` can be displayed as an extra bucket, but it is not counted in `num_tgts`.

## Key Features

### Word Alignments

- FastAlign implementation compiled to WebAssembly
- bidirectional alignment (forward + reverse)

### Phrase Extraction

- parallel phrase pair extraction from aligned corpora
- multi-threaded processing using Web Workers
- configurable phrase length
- batch processing for large corpora

### Data Augmentation & Refinement

- fix propagation across corpus
- duplicate texts with replacements
- phrase-level consistency analysis
- suspicious-word detection
- toggle-based hidden phrase exports

## Quick Start

### Prerequisites

- modern web browser
- 4 GB RAM minimum
- multi-core CPU recommended for larger corpora

### Installation

1. Clone the repository:

```bash
git clone https://github.com/robespierreAlgo/alignfixV2.git
cd alignfixV2
```

2. Start the development server:

```bash
python serve.py
```

3. Open the browser at:

```text
http://127.0.0.1:8000
```

### First Project

1. Click **Start** to create a new project
2. Upload parallel text files
3. Click **Compute Alignments**
4. Review alignment quality in the **Scores** tab
5. Extract phrase pairs in the **Project** tab
6. Inspect consistency and suspicious words
7. Export results when complete

## Building from Source

### Prerequisites

- Emscripten SDK
- Python 3.x
- Bash shell

### Compile WebAssembly Modules

Compile all configurations:

```bash
bash compile_all_configs.sh
```

This generates optimized builds for different hardware profiles.

Compile a specific configuration:

```bash
bash compile.sh
```

Examples:

```bash
bash compile.sh 1 2GB
bash compile.sh 8 8GB
bash compile.sh 16 16GB
```

The dynamic module loader selects the best available configuration based on the detected hardware.

## Privacy & Security

- all processing happens locally in the browser
- files are not uploaded to a remote server
- no analytics or telemetry
- local storage only
- can be used offline after the initial load

This makes AlignFix suitable for confidential or proprietary corpora.

## Use Cases

### Machine Translation

Build phrase tables for statistical or neural MT workflows and inspect unstable translations.

### Linguistic Research

Analyze translation patterns, alignment behavior, and corpus variation.

### Data Quality Assessment

Identify noisy alignments, unstable source words, and phrases that should be reviewed or hidden.

### Education & Training

Use AlignFix to demonstrate alignment, phrase extraction, and translation consistency in practice.

## Debugging

- open browser DevTools
- check the console for logs and errors
- use the progress bar and log viewer
- enable profiling tools when needed

## Contributing

Contributions are welcome.

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push the branch
5. Open a pull request

## License

This project is licensed under the Apache 2.0 License. See `LICENSE` for details.

## Acknowledgments

- FastAlign
- Emscripten
- Pyodide
- Bootstrap
- Chart.js

## Support

For questions, issues, or feature requests, please open an issue on GitHub.
