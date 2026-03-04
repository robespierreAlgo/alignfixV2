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

### Sure / Robust Phrases

A phrase is marked **Sure / Robust** if:

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

In addition to confidence-based robustness, AlignFix computes **form-aligned candidates** (not automatically hidden):

- only **single-token** source forms are considered
- Ladin morphology is taken from `backend/local_data/formario_lavb.csv`
- Italian morphology is taken from `backend/local_data/morphit_it.txt` (Morph-it)
- the Italian **head token** is extracted conservatively (det+head, elisions like `l'`, etc.)
- a pair is considered *form-aligned* if Ladin tag features match a compatible Morph-it feature for the Italian head

These candidates are used in the **Hidden phrases** workflow described below.

---

## Generated Files After Phrase Extraction

AlignFix can generate/download the following outputs:

- **Phrase Table (CSV / JSON)**  
  Complete table of extracted phrases with statistics and confidence scores.

- **Sure / Robust Phrases (CSV / JSON)**  
  High-confidence phrases (consistent translations).

- **Dubious Phrases (CSV / JSON)**  
  Low-confidence phrases (inconsistent translations).

- **Translation Confidence Overview (TXT)**  
  Overview summary with example “sure/robust” and “dubious” phrases, plus
  form-aligned candidate counts and examples from the last extraction.

---

## Hidden Phrases Export (Robust + Form-Aligned)

AlignFix supports exporting a **Hidden phrases JSON** (uploadable) built as the union:

`HIDDEN = ROBUST ∪ FORM-ALIGNED`

- **ROBUST** is derived from confidence (`minTotal`, `confidenceSplit`)
- **FORM-ALIGNED** is derived from morphology matching (single-token only)
- A separate **report (TXT)** explains:
  - how many are robust-only, form-only, and **both**
  - examples for each category (including “both” with morph witnesses)

Depending on the UI wiring, the “report-only” download and the “hidden phrases JSON” download may be separate buttons.

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

## 🌟 Key Features

### 🔗 Word Alignments
- **FastAlign** implementation compiled to WebAssembly
- Bidirectional alignment (forward + reverse)

### 🔤 Phrase Extraction
- Parallel phrase pair extraction from aligned corpora
- Multi-threaded processing using Web Workers
- Configurable phrase length (1-7 words)
- Batch processing for large corpora (300k+ sentences)

### 🔧 Data Augmentation & Refinement
- Fix propagation across corpus
- Duplicate texts with replacements

## 🚀 Quick Start

### Prerequisites
- Modern web browser (Chrome 90+, Edge 90+, Firefox 88+, or Safari 14+)
- 4GB RAM minimum (8GB+ recommended for large corpora)
- Multi-core CPU recommended for parallel processing

### Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/alignfix/alignfix.git
   cd alignfix
   ```

2. **Start the development server:**
   ```bash
   python serve.py
   ```
   
   This starts a local server at `http://127.0.0.1:8000` with the required CORS headers for WebAssembly and SharedArrayBuffer support.

3. **Open in browser:**
   Navigate to `http://127.0.0.1:8000` in your browser.

### First Project

1. Click **"Start"** to create a new project
2. Upload parallel text files (one sentence per line)
3. Click **"Compute Alignments"** to run FastAlign
4. Analyze quality metrics in the **"Scores"** tab
5. Extract phrase pairs in the **"Project"** tab
6. Export results when complete

## 🔨 Building from Source

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
bash compile.sh <THREADS> <MEMORY>

# Examples:
bash compile.sh 1 2GB
bash compile.sh 8 8GB
bash compile.sh 16 16GB
```

The dynamic module loader (`backend/module-loader.js`) automatically selects the optimal configuration based on detected hardware capabilities.

## 🔒 Privacy & Security

- **100% Client-Side:** All processing happens in your browser
- **No Server Uploads:** Files never leave your device
- **No Tracking:** No analytics or telemetry
- **Offline Capable:** Works without internet after initial load
- **Local Storage Only:** Data stored in browser IndexedDB

Perfect for confidential documents, proprietary corpora, or sensitive data that cannot be uploaded to external servers.

## 🎯 Use Cases

### Machine Translation
Build phrase tables for statistical and neural MT systems. Extract high-quality parallel phrases for training.

### Linguistic Research
Analyze translation patterns, study cross-lingual phenomena, research alignment algorithms for low-resource language pairs.

### Data Quality Assessment
Evaluate parallel corpus quality, identify misalignments, clean noisy data before training translation systems.

### Education & Training
Teach translation concepts, demonstrate alignment algorithms, provide hands-on experience with parallel corpus processing.

### Debugging

- Open browser DevTools (F12)
- Check Console for logs and errors
- Use the built-in progress bar and log viewer
- Enable profiler for memory usage tracking

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## 📄 License

This project is licensed under the Apache 2.0 License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- **FastAlign** - [Chris Dyer et al.](https://github.com/clab/fast_align)
- **Emscripten** - For making C++ in the browser possible
- **Pyodide** - For Python in WebAssembly
- **Bootstrap** - For the UI framework
- **Chart.js** - For data visualization

## 📞 Support

For questions, issues, or feature requests, please [open an issue](https://github.com/alignfix/alignfix/issues) on GitHub.

---