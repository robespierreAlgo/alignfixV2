<div align="center">
  <img src="ui/img/alignfix-logo.png" alt="AlignFix Logo" width="220"/>
  
  # AlignFix

  [![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
  [![WebAssembly](https://img.shields.io/badge/WebAssembly-654FF0?logo=webassembly&logoColor=white)](https://webassembly.org/)
  [![Python](https://img.shields.io/badge/Python-3776AB?logo=python&logoColor=white)](https://www.python.org/)
  [![Bootstrap](https://img.shields.io/badge/Bootstrap-5-7952B3?logo=bootstrap&logoColor=white)](https://getbootstrap.com/)
</div>

**AlignFix** is a browser-based tool for augmenting and refining parallel text corpora. Built entirely with WebAssembly (WASM), it provides desktop-class performance for word alignment, phrase extraction, and quality assessment—all running 100% locally in your browser with complete privacy.

## Phrase Confidence Reports

After phrase extraction, AlignFix analyzes how consistently each source phrase is translated.

For every source phrase (optionally per direction), we count:

- how often it appears in total (`total`)
- how often each target translation appears

From this we compute a simple confidence score:

`confidence = top_share = (most frequent translation count) / (total occurrences)`

The confidence value is between 0 and 1:

- `1.0` → always translated the same way
- `0.5` → two translations used equally often

### Sure / Consistent Phrases

A phrase is marked **Sure / Consistent** if:

- it appears at least `minTotal` times (default: `10`)
- its confidence is `>= confidenceSplit` (default: `0.75`)

Interpretation: the translation is consistent in the corpus.

### Dubious Phrases

A phrase is marked **Dubious** if:

- it appears at least `minTotal` times (default: `10`)
- its confidence is `< confidenceSplit` (default: `0.75`)

Interpretation: the phrase is translated less consistently and may need review.

> Note: we do **not** require “at least 2 different target translations” explicitly — low confidence already implies variation in practice.

---

## Form-Aligned Candidates (Morphology)

In addition to confidence-based consistency, AlignFix computes **form-aligned candidates** that can be used in the hidden-phrases workflow.

- only **single-token** source forms are considered
- Ladin morphology is taken from `backend/local_data/formario_lavb.csv`
- Italian morphology is taken from `backend/local_data/morphit_it.txt`
- the Italian **head token** is extracted conservatively (det+head, elisions like `l'`, etc.)
- a pair is considered *form-aligned* if Ladin tag features match a compatible Morph-it feature for the Italian head

These candidates can optionally be hidden during export.

---

## Dictionary-Based Hiding

AlignFix can also use a bilingual dictionary file:

- `backend/local_data/lavb-ita.csv`

If a single-word Ladin → Italian phrase pair appears as a **1:1 dictionary match**, it can also be marked as hidden.

This gives a third hiding source in addition to:

- confidence-based consistency
- morphology-based form alignment

Dictionary-hidden phrases are counted separately in the report.

---

## Hidden Phrases Workflow

AlignFix supports dynamic hiding, so phrase categories can be included or excluded depending on the selected toggles.

Possible hidden categories are:

- **Consistent** — derived from confidence (`minTotal`, `confidenceSplit`)
- **Form-aligned** — derived from morphology matching (single-token only)
- **Dictionary-based** — derived from exact 1:1 single-word dictionary matches

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

---

## Generated Files After Phrase Extraction

AlignFix can generate/download the following outputs:

- **Phrase Table (CSV / JSON)**  
  Complete table of extracted phrases with statistics and confidence scores.

- **Sure / Consistent Phrases (CSV / JSON)**  
  High-confidence phrases with stable translations.

- **Dubious Phrases (CSV / JSON)**  
  Low-confidence phrases with less stable translations.

- **Translation Confidence Overview (TXT)**  
  Overview summary with example consistent and dubious phrases, plus hidden-phrase counts and examples from the last extraction.

- **Hidden Phrases JSON**  
  Uploadable JSON built from the currently enabled hidden categories.

---

## What the CSV/JSON Reports Contain

The phrase tables include:

- `total` — total number of occurrences
- `top_tgt` — most frequent translation
- `top_count` — number of times the most frequent translation occurs
- `top_share` — confidence score (`top_count / total`)
- `num_tgts` — number of distinct translations
- `entropy` — how variable the translations are
- `topk` — list of top target alternatives with counts

The `top_share` value is the confidence used for classification.

---

## Key Features

### Word Alignments

- **FastAlign** implementation compiled to WebAssembly
- Bidirectional alignment (forward + reverse)

### Phrase Extraction

- Parallel phrase pair extraction from aligned corpora
- Multi-threaded processing using Web Workers
- Configurable phrase length (1–7 words)
- Batch processing for large corpora (300k+ sentences)

### Data Augmentation & Refinement

- Fix propagation across corpus
- Duplicate texts with replacements
- Phrase-level consistency analysis
- Toggle-based hidden phrase exports

---

## Quick Start

### Prerequisites

- Modern web browser (Chrome 90+, Edge 90+, Firefox 88+, or Safari 14+)
- 4GB RAM minimum (8GB+ recommended for large corpora)
- Multi-core CPU recommended for parallel processing

### Installation

1. **Clone the repository:**

```bash
git clone https://github.com/robespierreAlgo/alignfixV2.git
cd alignfixV2
```

2. **Start the development server:**

```bash
python serve.py
```

This starts a local server at `http://127.0.0.1:8000` with the required CORS headers for WebAssembly and SharedArrayBuffer support.

3. **Open in browser:**

Navigate to `http://127.0.0.1:8000` in your browser.

### First Project

1. Click **Start** to create a new project
2. Upload parallel text files (one sentence per line)
3. Click **Compute Alignments** to run FastAlign
4. Analyze quality metrics in the **Scores** tab
5. Extract phrase pairs in the **Project** tab
6. Export results when complete

---

## Building from Source

### Prerequisites

- [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html)
- Python 3.x
- Bash shell

### Compile WebAssembly Modules

The project includes pre-compiled WASM modules, but you can recompile them:

#### Compile all configurations:

```bash
bash compile_all_configs.sh
```

This generates optimized builds for different hardware:

- `_p1`: 1 thread, 2GB memory (minimal)
- `_p4`: 4 threads, 4GB memory (low)
- `_p8`: 8 threads, 8GB memory (medium)
- `_p16`: 16 threads, 16GB memory (high)

#### Compile specific configuration:

```bash
bash compile.sh

# Examples:
bash compile.sh 1 2GB
bash compile.sh 8 8GB
bash compile.sh 16 16GB
```

The dynamic module loader (`backend/module-loader.js`) automatically selects the optimal configuration based on detected hardware capabilities.

---

## Privacy & Security

- **100% Client-Side:** All processing happens in your browser
- **No Server Uploads:** Files never leave your device
- **No Tracking:** No analytics or telemetry
- **Offline Capable:** Works without internet after initial load
- **Local Storage Only:** Data stored in browser IndexedDB

Perfect for confidential documents, proprietary corpora, or sensitive data that cannot be uploaded to external servers.

---

## Use Cases

### Machine Translation

Build phrase tables for statistical and neural MT systems. Extract high-quality parallel phrases for training.

### Linguistic Research

Analyze translation patterns, study cross-lingual phenomena, and investigate alignment algorithms for low-resource language pairs.

### Data Quality Assessment

Evaluate parallel corpus quality, identify misalignments, and clean noisy data before training translation systems.

### Education & Training

Teach translation concepts, demonstrate alignment algorithms, and provide hands-on experience with parallel corpus processing.

---

## Debugging

- Open browser DevTools (F12)
- Check Console for logs and errors
- Use the built-in progress bar and log viewer
- Enable profiler for memory usage tracking

---

## Contributing

Contributions are welcome. Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

---

## License

This project is licensed under the Apache 2.0 License — see the [LICENSE](LICENSE) file for details.

---

## Acknowledgments

- **FastAlign** — [Chris Dyer et al.](https://github.com/clab/fast_align)
- **Emscripten** — for making C++ in the browser possible
- **Pyodide** — for Python in WebAssembly
- **Bootstrap** — for the UI framework
- **Chart.js** — for data visualization

---

## Support

For questions, issues, or feature requests, please open an issue on GitHub.
