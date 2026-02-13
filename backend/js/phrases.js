/**
 * Copyright 2025 Samuel Frontull and Simon Haller-Seeber, University of Innsbruck
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { initPyodide } from "../../pyodide.js";
import { profiler } from '../../ui/profiler.js';
import { nextFrame } from "../../ui/utils.js";
import { getLinesStats } from "./stats.js"; 
import { safeSyncfs } from "./storage.js";

const SAVE_BATCH_SIZE = 100000; // adjust based on memory

// =======================
// Full Phrase Translation Table (CSV/JSON)
// Keeps tokens exactly as-is; includes multi-word phrases.
// =======================

// In-memory cache so downloads can happen synchronously on button click (no awaits).
// If user reloads the page, they need to re-run Extract phrases before downloading.
const _LAST_EXTRACTED_PHRASES_BY_PROJECT = new Map();

function cacheExtractedPhrases(projectId, phrasesArray) {
  _LAST_EXTRACTED_PHRASES_BY_PROJECT.set(String(projectId), phrasesArray);
}

function getCachedExtractedPhrases(projectId) {
  return _LAST_EXTRACTED_PHRASES_BY_PROJECT.get(String(projectId)) || null;
}

function _csvEscape(v) {
  const s = String(v ?? "");
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function _entropyFromCounts(counts) {
  // counts: number[]
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) return 0;
  let h = 0;
  for (const c of counts) {
    if (!c) continue;
    const p = c / total;
    h -= p * Math.log(p); // natural log
  }
  return h;
}

function buildPhraseTranslationTable(phrasesArray, opts = {}) {
  const {
    // include multi-word phrases by default (what you asked)
    includeMultiWord = true,

    // include single word phrases too
    includeSingleWord = true,

    // optional: filter on total counts per src phrase (after aggregating over tgts)
    minTotal = 1,

    // how many target alternatives to keep in topk
    topK = 10,

    // If true, compute separate rows per direction (recommended)
    // Rows will have a "direction" field ("0", "-1", "1", etc.)
    splitByDirection = true,
  } = opts;

  const isSingleWord = (s) => !/\s/.test((s || "").trim());

  // Map key: (direction + "\u0000" + src) OR just src
  // value: Map(tgt -> count)
  const agg = new Map();

  for (const p of phrasesArray || []) {
    const src = (p.src_phrase || "").trim();
    const tgt = (p.tgt_phrase || "").trim();
    const c = Number(p.num_occurrences || 0);
    const dir = String(p.direction ?? 0);

    if (!src || !tgt || !Number.isFinite(c) || c <= 0) continue;

    const single = isSingleWord(src);
    if (single && !includeSingleWord) continue;
    if (!single && !includeMultiWord) continue;

    const key = splitByDirection ? `${dir}\u0000${src}` : src;

    let tgtMap = agg.get(key);
    if (!tgtMap) {
      tgtMap = new Map();
      agg.set(key, tgtMap);
    }
    tgtMap.set(tgt, (tgtMap.get(tgt) || 0) + c);
  }

  const rows = [];
  const byDirCounts = {}; // direction -> row count

  for (const [key, tgtMap] of agg.entries()) {
    let dir = "all";
    let src = key;

    if (splitByDirection) {
      const idx = key.indexOf("\u0000");
      dir = key.slice(0, idx);
      src = key.slice(idx + 1);
    }

    const entries = Array.from(tgtMap.entries()).sort((a, b) => b[1] - a[1]);
    const total = entries.reduce((acc, [, c]) => acc + c, 0);
    if (total < minTotal) continue;

    const [topTgt, topCount] = entries[0];
    const topShare = total ? topCount / total : 0;

    const topk = entries.slice(0, topK).map(([tgt, count]) => ({
      tgt,
      count,
      share: total ? count / total : 0,
    }));

    const entropy = _entropyFromCounts(entries.map(([, c]) => c));

    const row = {
      direction: dir,
      src,
      total,
      top_tgt: topTgt,
      top_count: topCount,
      top_share: topShare,
      num_tgts: entries.length,
      entropy,
      topk,
    };

    rows.push(row);
    byDirCounts[dir] = (byDirCounts[dir] || 0) + 1;
  }

  // Sort: most frequent first
  rows.sort((a, b) => b.total - a.total);

  return {
    params: { includeMultiWord, includeSingleWord, minTotal, topK, splitByDirection },
    summary: {
      num_rows: rows.length,
      rows_by_direction: byDirCounts,
    },
    rows,
  };
}

function phraseTranslationTableToCSV(table) {
  const header = [
    "direction",
    "src",
    "total",
    "top_tgt",
    "top_count",
    "top_share",
    "num_tgts",
    "entropy",
    "topk",
  ].join(",");

  const lines = [header];

  for (const r of table.rows) {
    const topkStr = (r.topk || [])
      .map(x => `${x.tgt}(${x.count})`)
      .join("|");

    lines.push([
      _csvEscape(r.direction),
      _csvEscape(r.src),
      _csvEscape(r.total),
      _csvEscape(r.top_tgt),
      _csvEscape(r.top_count),
      _csvEscape(r.top_share.toFixed(6)),
      _csvEscape(r.num_tgts),
      _csvEscape(r.entropy.toFixed(6)),
      _csvEscape(topkStr),
    ].join(","));
  }

  return lines.join("\n");
}

// Exported downloaders (must be defined only once)
export function downloadPhraseTranslationTableCSV(project_id) {
  const phrases = getCachedExtractedPhrases(project_id);
  if (!phrases) {
    alert(`No extracted phrases cached for project ${project_id}.\nRun "Extract phrases" first (same session).`);
    return;
  }

  const table = buildPhraseTranslationTable(phrases, {
    includeSingleWord: true,
    includeMultiWord: true,
    minTotal: 1,
    topK: 10,
    splitByDirection: true,
  });

  const csv = phraseTranslationTableToCSV(table);
  const ts = new Date().toISOString().replace(/[:]/g, "-");
  downloadTextFile(`phrase_translation_table_project_${project_id}_${ts}.csv`, csv);
}

export function downloadPhraseTranslationTableJSON(project_id) {
  const phrases = getCachedExtractedPhrases(project_id);
  if (!phrases) {
    alert(`No extracted phrases cached for project ${project_id}.\nRun "Extract phrases" first (same session).`);
    return;
  }

  const table = buildPhraseTranslationTable(phrases, {
    includeSingleWord: true,
    includeMultiWord: true,
    minTotal: 1,
    topK: 10,
    splitByDirection: true,
  });

  const jsonStr = JSON.stringify(table, null, 2);
  const ts = new Date().toISOString().replace(/[:]/g, "-");
  downloadTextFile(`phrase_translation_table_project_${project_id}_${ts}.json`, jsonStr);
}

// =======================
// Filtered reports: DUBIOUS vs SURE
// =======================

function filterPhraseTranslationTable(table, predicate) {
  const rows = (table.rows || []).filter(predicate);
  const byDir = {};
  for (const r of rows) byDir[r.direction] = (byDir[r.direction] || 0) + 1;

  return {
    ...table,
    summary: {
      ...table.summary,
      num_rows: rows.length,
      rows_by_direction: byDir,
    },
    rows,
  };
}

// Tune these defaults as you like:
const DEFAULT_FILTER_MIN_TOTAL = 10;     // lower than 30 because multi-word phrases are rarer
const SURE_TOP_SHARE = 0.90;             // "sure" if top translation ≥ 90%
const DUBIOUS_TOP_SHARE = 0.60;          // "dubious" if top translation ≤ 60%
const DUBIOUS_MIN_VARIANTS = 2;          // require at least 2 target variants to be "dubious"

function buildBasePhraseTableForDownloads(phrases, opts = {}) {
  const {
    minTotal = 1,
    topK = 10,
  } = opts;

  return buildPhraseTranslationTable(phrases, {
    includeSingleWord: true,
    includeMultiWord: true,
    minTotal,
    topK,
    splitByDirection: true,
  });
}

export function downloadSurePhraseTableCSV(project_id) {
  const phrases = getCachedExtractedPhrases(project_id);
  if (!phrases) {
    alert(`No extracted phrases cached for project ${project_id}.\nRun "Extract phrases" first (same session).`);
    return;
  }

  const base = buildBasePhraseTableForDownloads(phrases, { minTotal: DEFAULT_FILTER_MIN_TOTAL, topK: 10 });

  const sure = filterPhraseTranslationTable(base, (r) =>
    r.total >= DEFAULT_FILTER_MIN_TOTAL &&
    r.top_share >= SURE_TOP_SHARE
  );

  const csv = phraseTranslationTableToCSV(sure);
  const ts = new Date().toISOString().replace(/[:]/g, "-");
  downloadTextFile(`sure_phrases_project_${project_id}_${ts}.csv`, csv);
}

export function downloadDubiousPhraseTableCSV(project_id) {
  const phrases = getCachedExtractedPhrases(project_id);
  if (!phrases) {
    alert(`No extracted phrases cached for project ${project_id}.\nRun "Extract phrases" first (same session).`);
    return;
  }

  const base = buildBasePhraseTableForDownloads(phrases, { minTotal: DEFAULT_FILTER_MIN_TOTAL, topK: 10 });

  const dubious = filterPhraseTranslationTable(base, (r) =>
    r.total >= DEFAULT_FILTER_MIN_TOTAL &&
    r.num_tgts >= DUBIOUS_MIN_VARIANTS &&
    r.top_share <= DUBIOUS_TOP_SHARE
  );

  const csv = phraseTranslationTableToCSV(dubious);
  const ts = new Date().toISOString().replace(/[:]/g, "-");
  downloadTextFile(`dubious_phrases_project_${project_id}_${ts}.csv`, csv);
}

// Optional JSON versions (handy later for automation)
export function downloadSurePhraseTableJSON(project_id) {
  const phrases = getCachedExtractedPhrases(project_id);
  if (!phrases) {
    alert(`No extracted phrases cached for project ${project_id}.\nRun "Extract phrases" first (same session).`);
    return;
  }

  const base = buildBasePhraseTableForDownloads(phrases, { minTotal: DEFAULT_FILTER_MIN_TOTAL, topK: 10 });
  const sure = filterPhraseTranslationTable(base, (r) =>
    r.total >= DEFAULT_FILTER_MIN_TOTAL &&
    r.top_share >= SURE_TOP_SHARE
  );

  const ts = new Date().toISOString().replace(/[:]/g, "-");
  downloadTextFile(`sure_phrases_project_${project_id}_${ts}.json`, JSON.stringify(sure, null, 2));
}

export function downloadDubiousPhraseTableJSON(project_id) {
  const phrases = getCachedExtractedPhrases(project_id);
  if (!phrases) {
    alert(`No extracted phrases cached for project ${project_id}.\nRun "Extract phrases" first (same session).`);
    return;
  }

  const base = buildBasePhraseTableForDownloads(phrases, { minTotal: DEFAULT_FILTER_MIN_TOTAL, topK: 10 });
  const dubious = filterPhraseTranslationTable(base, (r) =>
    r.total >= DEFAULT_FILTER_MIN_TOTAL &&
    r.num_tgts >= DUBIOUS_MIN_VARIANTS &&
    r.top_share <= DUBIOUS_TOP_SHARE
  );

  const ts = new Date().toISOString().replace(/[:]/g, "-");
  downloadTextFile(`dubious_phrases_project_${project_id}_${ts}.json`, JSON.stringify(dubious, null, 2));
}

// --- Robustness report cache keys (stored in localStorage) ---
const ROBUSTNESS_CACHE_KEY_TEXT = (projectId) =>
  `alignfix:robustness_report_text:${projectId}`;
const ROBUSTNESS_CACHE_KEY_JSON = (projectId) =>
  `alignfix:robustness_report_json:${projectId}`;

function cacheRobustnessReport(projectId, phrasesArray) {
  try {
    const report = buildTranslationRobustnessReport(phrasesArray, {
      singleWordOnly: true,
      minTotal: 30,
      robustTopShare: 0.85,
      nonRobustTopShare: 0.60,
      maxExamples: 25,
      maxAlternativesShown: 6,
    });

    const text = robustnessReportToText(report);

    localStorage.setItem(ROBUSTNESS_CACHE_KEY_JSON(projectId), JSON.stringify(report));
    localStorage.setItem(ROBUSTNESS_CACHE_KEY_TEXT(projectId), text);

    console.log(
      `✅ Robustness report cached for project ${projectId}. ` +
      `Use "Download Robustness Report" in the Project tab to export it.`
    );
  } catch (e) {
    console.warn("⚠️ Robustness report generation/caching failed:", e);
  }
}

// IMPORTANT: synchronous download (no awaits) so browsers allow it
export function downloadRobustnessReport(projectId) {
  const text = localStorage.getItem(ROBUSTNESS_CACHE_KEY_TEXT(projectId));
  if (!text) {
    alert(
      `No robustness report cached for project ${projectId}.\n\n` +
      `Run "Extract phrases" first, then try again.`
    );
    return;
  }
  const ts = new Date().toISOString().replace(/[:]/g, "-");
  downloadTextFile(`robustness_report_project_${projectId}_${ts}.txt`, text);
}

function downloadTextFile(filename, text) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function buildTranslationRobustnessReport(phrasesArray, opts = {}) {
  const {
    // Start simple: only analyze single-word sources
    singleWordOnly = true,

    // Ignore rare words so the stats mean something
    minTotal = 30,

    // "Robust": top translation dominates
    robustTopShare = 0.85,

    // "Non-robust": lots of competition
    nonRobustTopShare = 0.60,

    // How many examples to include
    maxExamples = 25,

    // How many alternative translations to show per source
    maxAlternativesShown = 6,
  } = opts;

  const isSingleWord = (s) => !/\s/.test((s || "").trim());

  // src -> (tgt -> count)
  const src2tgt = new Map();

  for (const p of phrasesArray || []) {
    const src = (p.src_phrase || "").trim();
    const tgt = (p.tgt_phrase || "").trim();
    const c = Number(p.num_occurrences || 0);

    if (!src || !tgt || !Number.isFinite(c) || c <= 0) continue;
    if (singleWordOnly && !isSingleWord(src)) continue;

    let m = src2tgt.get(src);
    if (!m) {
      m = new Map();
      src2tgt.set(src, m);
    }
    m.set(tgt, (m.get(tgt) || 0) + c);
  }

  const robust = [];
  const nonRobust = [];

  for (const [src, tgtMap] of src2tgt.entries()) {
    const entries = Array.from(tgtMap.entries()).sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) continue;

    const total = entries.reduce((acc, [, c]) => acc + c, 0);
    if (total < minTotal) continue;

    const [topTgt, topCount] = entries[0];
    const topShare = topCount / total;

    const record = {
      src,
      topTgt,
      topCount,
      topShare,
      total,
      numTranslations: entries.length,
      alternatives: entries.slice(1, 1 + maxAlternativesShown), // [ [tgt, count], ... ]
      topAll: entries.slice(0, maxAlternativesShown),            // include top list for non-robust
    };

    if (topShare >= robustTopShare) {
      robust.push(record);
    } else if (entries.length >= 2 && topShare <= nonRobustTopShare) {
      nonRobust.push(record);
    }
  }

  robust.sort((a, b) => b.total - a.total);
  nonRobust.sort((a, b) => b.total - a.total);

  return {
    params: { singleWordOnly, minTotal, robustTopShare, nonRobustTopShare, maxExamples, maxAlternativesShown },
    counts: {
      candidates: src2tgt.size,
      robust_found: robust.length,
      nonrobust_found: nonRobust.length,
    },
    robust_examples: robust.slice(0, maxExamples),
    nonrobust_examples: nonRobust.slice(0, maxExamples),
  };
}

function robustnessReportToText(report) {
  const fmtPct = (x) => `${(x * 100).toFixed(1)}%`;

  const lines = [];
  lines.push("TRANSLATION ROBUSTNESS REPORT");
  lines.push("");
  lines.push("PARAMS:");
  lines.push(JSON.stringify(report.params, null, 2));
  lines.push("");
  lines.push("COUNTS:");
  lines.push(JSON.stringify(report.counts, null, 2));
  lines.push("");
  lines.push("✅ ROBUST EXAMPLES (top translation dominates):");
  lines.push("");

  for (const r of report.robust_examples) {
    const alts = r.alternatives.map(([t, c]) => `${t} (${c})`).join(", ");
    lines.push(
      `[ROBUST] ${r.src} → ${r.topTgt} | top=${fmtPct(r.topShare)} (${r.topCount}/${r.total}), variants=${r.numTranslations}` +
      (alts ? ` | alts: ${alts}` : "")
    );
  }

  lines.push("");
  lines.push("⚠️ NON-ROBUST EXAMPLES (competing translations):");
  lines.push("");

  for (const r of report.nonrobust_examples) {
    const tops = r.topAll.map(([t, c]) => `${t} (${c})`).join(", ");
    lines.push(
      `[NON-ROBUST] ${r.src} | top=${r.topTgt} ${fmtPct(r.topShare)} (${r.topCount}/${r.total}), variants=${r.numTranslations}` +
      (tops ? ` | top list: ${tops}` : "")
    );
  }

  lines.push("");
  return lines.join("\n");
}

function trimPhrase(phrase) {
  // trim #NB at start and end of phrases
  return phrase.replace(/^#NB\s+/, '').replace(/\s+#NB$/, '');
}

function getOccurrencesFromFile(content, direction) {

    const occurrences = {};
    const lines = content.split('\n');

    for (const line of lines) {
      if (line.trim() === '') continue;

      let [phrase1, phrase2, row_id] = line.split('|||').map(s => s.trim());

      // trim #NB at start and end of phraeses
      phrase1 = trimPhrase(phrase1);
      phrase2 = trimPhrase(phrase2);

      const key = `${phrase1}|||${phrase2}`;

      if (!occurrences[key]) {
        occurrences[key] = { 
          direction: direction, 
          rows: []
        };
      }
      occurrences[key].rows.push(parseInt(row_id));
    }

    return occurrences;

}

function separateCommonIds(src2tgt, tgt2src) {
  const common = {};

  if (!src2tgt || !tgt2src) {
    return common;
  }

  for (const key of Object.keys(src2tgt)) {
    if (key in tgt2src) {
      const srcObj = src2tgt[key];
      const tgtObj = tgt2src[key];

      const srcIds = srcObj.rows;
      const tgtIds = tgtObj.rows;

      // Find intersection
      const commonIds = srcIds.filter(id => tgtIds.includes(id));

      if (commonIds.length > 0) {
        common[key] = { rows: commonIds };

        // Remove common IDs from originals
        srcObj.rows = srcIds.filter(id => !commonIds.includes(id));
        tgtObj.rows = tgtIds.filter(id => !commonIds.includes(id));

        // Optional: update counts after filtering
        srcObj.count = srcObj.rows.length;
        tgtObj.count = tgtObj.rows.length;
      } else {
        common[key] = { rows: [] };
      }
    }
  }

  return common;
}

async function extractDirectedPhrases(module, src_lines, tgt_lines, align_lines, score_lines, direction, min_phrase_length, max_phrase_length, threshold, numCores, ignore_pairs) {

    // File paths for WASM processing
    const srcFilename = "/src.txt";
    const tgtFilename = "/tgt.txt";
    const alignFilename = "/align.txt";
    const scoreFilename = "/score.txt";
    const ignoreFilename = "/ignore.txt";

    console.log(`🔄 Processing ${src_lines.length.toLocaleString()} lines in single pass (direction: ${direction})`);

    // Write all data to virtual filesystem at once
    module.FS.writeFile(srcFilename, src_lines.join("\n"));
    module.FS.writeFile(tgtFilename, tgt_lines.join("\n"));
    module.FS.writeFile(alignFilename, align_lines.join("\n"));
    module.FS.writeFile(scoreFilename, score_lines.join("\n"));
    
    // TODO check if direction is ok
    if (ignore_pairs && ignore_pairs.length > 0) {
        const ignore_content = ignore_pairs.map(pair => pair.join('|||')).join('\n');
        module.FS.writeFile(ignoreFilename, ignore_content);
        console.log(`🚫 Written ${ignore_pairs.length.toLocaleString()} phrases to ignore to WASM filesystem`);
    } else {
        module.FS.writeFile(ignoreFilename, "");
        console.log(`🚫 No phrases to ignore provided, created empty ignore file in WASM filesystem`);
    }

    const numPhrasesToIgnore = ignore_pairs ? ignore_pairs.length : 0;

    console.log(`📁 Written all files to WASM filesystem`);
    
    // Allow UI to update after file writing
    console.log(`Calling extract_phrases_parallel_main (numCores: ${numCores})...`);
    await nextFrame();

    const start_idx = 0;
    const end_idx = src_lines.length;

    // Single extraction call for all data
    await profiler.measure(`extract_phrases_parallel_main_full`, async () => {
        await module.ccall(
            "extract_phrases_parallel_main",
            null,
            [
                "string", "string", "string", "string", "string", "string", "string",
                "number", "number", "number", "number", "number", "number", "number", "number"
            ],
            [
                srcFilename, tgtFilename, scoreFilename, alignFilename, ignoreFilename,
                "phrases", "ignore-phrases",
                start_idx, end_idx, numPhrasesToIgnore,
                direction, threshold, min_phrase_length, max_phrase_length, numCores
            ]
        );
    });

    const content = module.FS.readFile("phrases", { encoding: 'utf8' });
    const occurrences = getOccurrencesFromFile(content, direction);

    // Process ignore list from WASM output
    let ignore_set = new Set();
    try {
        const ignore_content = module.FS.readFile("ignore-phrases", { encoding: 'utf8' });
        const ignore_lines = ignore_content.split('\n').filter(line => line.trim() !== '');
        ignore_set = new Set(ignore_lines);
        console.log(`🚫 Loaded ${ignore_set.size.toLocaleString()} additional phrases to ignore from extraction`);
    } catch (err) {
        console.log('ℹ️ No additional ignore phrases found during extraction');
    }

    // Cleanup files
    try { module.FS.unlink(srcFilename); } catch(e){}
    try { module.FS.unlink(tgtFilename); } catch(e){}
    try { module.FS.unlink(alignFilename); } catch(e){}
    try { module.FS.unlink(scoreFilename); } catch(e){}
    try { module.FS.unlink("phrases"); } catch(e){}
    try { module.FS.unlink("ignore-phrases"); } catch(e){}

    console.log(`✅ Extraction complete: ${Object.keys(occurrences).length.toLocaleString()} phrases extracted`);
    
    return [occurrences, ignore_set];
}

async function extractPhrasesBatch(module, src_lines, tgt_lines, align_lines, score_lines, min_phrase_length, max_phrase_length, threshold, numCores, ignore_pairs) {
    console.log(`🚀 extractPhrasesBatch: Processing ${src_lines.length.toLocaleString()} lines`);
    const startTime = performance.now();
    
    // Use a Map for efficient key-based access
    const occurrences = new Map();

    // Allow UI to update before starting extraction
    await nextFrame();

    console.log(`🔄 Extracting src→tgt phrases...`);
    const [occurrences_src_tgt, ignore_src_tgt] = await extractDirectedPhrases(
        module,
        src_lines,
        tgt_lines,
        align_lines,
        score_lines,
        0,
        min_phrase_length,
        max_phrase_length,
        threshold,
        numCores,
        ignore_pairs
    );

    console.log(`🔄 Extracting tgt→src phrases...`);
    const [occurrences_tgt_src, ignore_tgt_src] = await extractDirectedPhrases(
        module,
        src_lines,
        tgt_lines,
        align_lines,
        score_lines,
        -1,
        min_phrase_length,
        max_phrase_length,
        threshold,
        numCores,
        ignore_pairs
    );

    console.log(`📊 Extracted ${Object.keys(occurrences_src_tgt || {}).length} src→tgt and ${Object.keys(occurrences_tgt_src || {}).length} tgt→src phrases`);

    // Convert to Map if needed
    const map_src_tgt = occurrences_src_tgt instanceof Map
        ? occurrences_src_tgt
        : new Map(Object.entries(occurrences_src_tgt));

    const map_tgt_src = occurrences_tgt_src instanceof Map
        ? occurrences_tgt_src
        : new Map(Object.entries(occurrences_tgt_src));

    // Find common phrases in both directions
    console.log('🔍 Identifying bidirectional phrase pairs');

    const occurrences_bidir = new Map();

    try {
        for (const [key, src_tgt_value] of map_src_tgt.entries()) {
            if (map_tgt_src.has(key)) {
                const tgt_src_value = map_tgt_src.get(key);
                occurrences_bidir.set(key, {
                    direction: 0, // both directions
                    rows: new Set([...src_tgt_value.rows, ...tgt_src_value.rows]),
                });

                // Optionally remove duplicates to avoid reprocessing
                map_src_tgt.delete(key);
                map_tgt_src.delete(key);
            }
        }

        console.log(`🔄 Found ${occurrences_bidir.size.toLocaleString()} phrases appearing in both directions`);
    } catch (err) {
        console.error('❌ Error finding common phrases:', err.message || err);
    }

    // Allow UI to update after bidirectional processing
    await nextFrame();

    console.log(`🔄 Merging occurrence maps...`);
    // Helper to merge occurrence maps
    const mergeOccurrences = (source) => {
      for (const [key, value] of Object.entries(source)) {
        if (occurrences.has(key)) {
          const currentValue = occurrences.get(key);
          // Use concat with Array.from to avoid spreading large arrays into function args
          currentValue.rows = currentValue.rows.concat(Array.from(value.rows));
        } else {
          // Make a shallow copy to avoid modifying the original; use Array.from to support Sets/Arrays
          occurrences.set(key, { ...value, rows: Array.from(value.rows) });
        }
      }
    };

    mergeOccurrences(occurrences_src_tgt);
    mergeOccurrences(occurrences_tgt_src);
    mergeOccurrences(occurrences_bidir);

    console.log(`📊 Total merged phrases: ${occurrences.size.toLocaleString()}`);

    const endTime = performance.now();
    const duration = (endTime - startTime) / 1000;
    console.log(`✅ extractPhrasesBatch completed in ${duration.toFixed(2)}s: ${occurrences.size.toLocaleString()} phrases`);

    return occurrences;
}

// BATCH SIZE rules based on max_phrase_length:
// 1 → 500k
// 2 → 300k
// 3 → 100k
// 4 → 50k
// 5 → 20k

const getBatchSize = (max_phrase_length) => {
  switch (max_phrase_length) {
    case 1: return 500_000;
    case 2: return 300_000;
    case 3: return 100_000;
    case 4: return 50_000;
    case 5: return 20_000;
    default: return 10_000; // fallback for unexpected values
  }
};

async function _extractPhrases(module, pyodide, src_lines, tgt_lines, align_lines, score_lines, numCores, ignore_pairs){
    // Use Maps for efficient accumulation

    const occurrences = new Map();
    const chunk_processing_times = [];
    const startTime = performance.now();
    // Get configuration parameters
    const value = parseFloat(document.getElementById("threshold-input")?.value);
    const threshold = isNaN(value) ? 1.0 : value;
    const min_phrase_length = parseInt(document.getElementById("min-phrase-length-input")?.value) || 1;
    const max_phrase_length = parseInt(document.getElementById("max-phrase-length-input")?.value) || 3;
    let min_occ = parseInt(document.getElementById("min-occurrences-input")?.value) || 3;
    let max_occ = parseInt(document.getElementById("max-occurrences-input")?.value) || 300;
    const max_phrases = parseInt(document.getElementById("max-phrases-input")?.value) || 500_000;

    const BATCH_SIZE = getBatchSize(max_phrase_length);
    console.log(`Batch size for phrase length ${max_phrase_length}:`, BATCH_SIZE);

    const totalLines = src_lines.length;
    const numBatches = Math.ceil(totalLines / BATCH_SIZE);
            
    // Filter entries based on min/max occurrences (one full pass)
    let filteredCount = 0;

    for (let batchIdx = 0; batchIdx < numBatches; batchIdx++) {
        const start = batchIdx * BATCH_SIZE;
        const end = Math.min(start + BATCH_SIZE, totalLines);
        const batchStartTime = performance.now();

        console.log(`📦 Processing batch ${batchIdx + 1}/${numBatches} (${(end - start).toLocaleString()} lines)`);
        // log current min_occ 
        console.log(`🔍 Current min_occ: ${min_occ}, max_occ: ${max_occ}`);
        
        // Allow UI to update before starting batch
        await nextFrame();

        // Slice on-the-fly, no precomputed chunk arrays
        try {
            console.log(`🔄 Calling extractPhrasesBatch for lines ${start}-${end}`);
            const occurrences_batch = await extractPhrasesBatch(
                module,
                src_lines.slice(start, end),
                tgt_lines.slice(start, end),
                align_lines.slice(start, end),
                score_lines.slice(start, end),
                min_phrase_length,
                max_phrase_length,
                threshold, 
                numCores,
                ignore_pairs
            );

            // 🔄 Merge occurrences_batch into occurrences
            let newCount = 0;
            let mergedCount = 0;
            for (const [key, value] of occurrences_batch.entries()) {
              let row_ids = Array.from(value.rows);

              row_ids = row_ids.map(id => id + start);

              if (occurrences.has(key)) {
                const currentValue = occurrences.get(key);
                currentValue.rows = currentValue.rows.concat(row_ids);
                mergedCount++;
              } else {
                occurrences.set(key, { ...value, rows: row_ids});
                newCount++;
              }
            }

            // If we still exceed the hard limit, use a bucketed approach to remove low/high counts
            // Build count buckets so we can delete only the keys that fall into a given count
            if (occurrences.size > max_phrases) {
              const countBuckets = new Map(); // count -> Set(keys)
              for (const [key, value] of occurrences.entries()) {
                const c = value.rows.length;
                let s = countBuckets.get(c);
                if (!s) {
                  s = new Set();
                  countBuckets.set(c, s);
                }
                s.add(key);
              }

              
              // Remove by increasing counts (lowest counts first) until under LIMIT
              const countsAsc = Array.from(countBuckets.keys()).sort((a,b) => a - b);
              for (const c of countsAsc) {
                if (occurrences.size <= max_phrases) break;
                
                const bucket = countBuckets.get(c);
                if (!bucket || bucket.size === 0) continue;
                const removed = bucket.size;
                for (const key of bucket) {
                  occurrences.delete(key);
                  filteredCount++;
                }
                bucket.clear();
                min_occ = c + 1; // reflect the raised minimum
                console.log(`⚠️ Occurrences exceed ${max_phrases.toLocaleString()}, increased min_occ to ${min_occ}, removed ${removed} keys with count ${c}`);
              }
            }

            const batchEndTime = performance.now();
            const batchDuration = (batchEndTime - batchStartTime) / 1000;
            console.log(`✅ Batch ${batchIdx + 1}/${numBatches} completed in ${batchDuration.toFixed(2)}s`);
            console.log(`📈 Total phrases accumulated: ${occurrences.size.toLocaleString()}`);
            // wait to flush
            await nextFrame();
            
        } catch (err) {
            console.log('ℹ️ No additional ignore phrases found during extraction');
            console.error(`❌ Error in batch ${batchIdx + 1}:`, err);
        }

        console.log(`🎯 Batch ${batchIdx + 1}/${numBatches} completed with ${(end - start).toLocaleString()} lines processed`);
        
        // Allow UI to update after batch completion
        await new Promise(r => setTimeout(r, 25));
    }

    for (const [key, value] of occurrences.entries()) {
      const count = value.rows.length;
      if (count < min_occ || count > max_occ) {
        occurrences.delete(key);
        filteredCount++;
      }
    }

    console.log(`✅ All batches processed. Total phrases: ${occurrences.size.toLocaleString()}`);
    // Convert occurrences Map into an array of phrase objects for saving/consumption
    const phrasesArray = Array.from(occurrences.entries()).map(([key, value]) => {
      const [src_phrase, tgt_phrase] = key.split('|||');
      return {
        src_phrase: src_phrase || '',
        tgt_phrase: tgt_phrase || '',
        direction: value.direction ?? 0,
        num_occurrences: Array.isArray(value.rows) ? value.rows.length : (value.rows instanceof Set ? value.rows.size : 0),
        occurrences: Array.from(value.rows)
      };
    });

    const endTime = performance.now();
    const startStatsTime = performance.now();
    const srcStats = getLinesStats(src_lines);
    const tgtStats = getLinesStats(tgt_lines);

    let stats_obj = {
        total_phrases_extracted: phrasesArray.length + filteredCount,
        total_phrases_filtered: phrasesArray.length,
        total_ignored_phrases: 0,
        corpus_size: src_lines.length,
        src_stats: srcStats,
        tgt_stats: tgtStats,
        extraction_duration_seconds: (endTime - startTime) / 1000,
        chunks_processed: numBatches
    };
    const endStatsTime = performance.now();
    console.log(`⏱️ Statistics computed in ${(endStatsTime - startStatsTime).toFixed(2)} ms`);

    pyodide.globals.set("threshold", threshold);
    pyodide.globals.set("min_phrase_length", min_phrase_length);
    pyodide.globals.set("max_phrase_length", max_phrase_length);
    pyodide.globals.set("min_occurrences", min_occ);
    pyodide.globals.set("max_occurrences", max_occ);
      
    await pyodide.runPythonAsync(`
        from projects import update_project_metadata
        update_project_metadata(project_id, threshold, min_phrase_length, max_phrase_length, min_occurrences, max_occurrences)
    `);
    console.log(`✅ Project metadata updated successfully`);

  await safeSyncfs(pyodide);
  return [phrasesArray, stats_obj];
}

export async function extractPhrases(project_id) {
    const startTime = performance.now();
    console.log(`operation:Starting phrase extraction for project ${project_id}`);
    console.log('progress:0');
    
    const pyodide = await initPyodide(); 
    pyodide.globals.set("project_id", project_id);

    // Load alignments and ignored phrases
    console.log('operation:Loading alignments and ignored phrases');
    const result = await profiler.measure('load_alignments_py', async () => {
      return pyodide.runPythonAsync(`
        from projects import get_alignments
        from phrases import get_all_phrases_to_ignore

        src_lines, tgt_lines, align_lines, score_lines = get_alignments(project_id)
        ignore_pairs = set(get_all_phrases_to_ignore(project_id))

        (src_lines, tgt_lines, align_lines, score_lines, list(ignore_pairs))
      `);
    });
    const [src_lines, tgt_lines, align_lines, score_lines, ignore_pairs] = result;
    
    console.log(`📊 Loaded ${src_lines.length.toLocaleString()} alignment pairs`);
    console.log(`🚫 Found ${ignore_pairs.length.toLocaleString()} phrases to ignore`);
    console.log('progress:5');


    const numCores = parseInt(document.getElementById("num-cores-input")?.value) || window.navigator.hardwareConcurrency || 1;

    // Initialize WASM module
    console.log('operation:Initializing WASM extraction module');

    const { createModule, config } = await window.WasmModuleLoader.loadPhraseExtraction();
    const poolSize = Math.min(config.poolSize, numCores);
    const module = await createModule({ pthreadPoolSize: poolSize });
    console.log('progress:10');

    // Prepare data chunks
    console.log('operation:Preparing data chunks for processing');
    const [phrases, stats_obj] = await _extractPhrases(
      module,
      pyodide,
      src_lines, 
      tgt_lines, 
      align_lines, 
      score_lines, 
      poolSize,
      ignore_pairs
    );
    
    cacheExtractedPhrases(project_id, phrases);

    // --- Build + cache robustness report (download happens via a dedicated button) ---
    cacheRobustnessReport(project_id, phrases);
    
    try {
        pyodide.globals.set("project_id", project_id);
        const startDeleteTime = performance.now();
        await pyodide.runPythonAsync(`
            from phrases import delete_phrases
            delete_phrases(project_id)
        `);
        const endDeleteTime = performance.now();
        console.log(`🗑️ Deleted existing phrases for project ${project_id} before saving new ones`);
        
        const startSaveTime = performance.now();
        for (let i = 0; i < phrases.length; i += SAVE_BATCH_SIZE) {
            const batch = phrases.slice(i, i + SAVE_BATCH_SIZE);
            pyodide.globals.set("phrases_batch", pyodide.toPy(batch));
            await pyodide.runPythonAsync(`
              from phrases import save_phrases
              save_phrases(project_id, phrases_batch)
            `);
            pyodide.globals.delete("phrases_batch");
            console.log(`💾 Saved batch ${i / SAVE_BATCH_SIZE + 1} / ${Math.ceil(phrases.length / SAVE_BATCH_SIZE)}`);
        }
        const endSaveTime = performance.now();
        console.log(`⏱️ Phrases saved in ${(endSaveTime - startSaveTime) / 1000} seconds`);

        // add to stats duration of delete and save
        stats_obj.db_delete_duration_seconds = (endDeleteTime - startDeleteTime) / 1000;
        stats_obj.db_insert_duration_seconds = (endSaveTime - startSaveTime) / 1000;
        console.log('progress:100');

    } catch (err) {
        console.error('❌ Critical error during phrase processing:', err.message || err);
        throw err;
    }
    
    await safeSyncfs(pyodide);
    return stats_obj;
}


export async function fetchPhrases(data) {

  const pyodide = await initPyodide();

  const response = await pyodide.runPythonAsync(`
      import json
      from phrases import fetch_phrases

      ids, src_phrases, tgt_phrases, directions, num_occurrences, total_records, filtered_records = fetch_phrases(
          ${data.project_id}, 
          ${data.start}, 
          ${data.length}, 
          """${data.search.value  || ''}""",
          ${data.direction || 0},
          ${data.min_phrase_len || 1}
      )
      json.dumps({
          "ids": ids,
          "src_phrases": src_phrases,
          "tgt_phrases": tgt_phrases,
          "directions": directions,
          "num_occurrences": num_occurrences,
          "total_records": total_records,
          "filtered_records": filtered_records
      })
  `);

  const parsed = JSON.parse(response);
  
  const datatable_data = parsed.ids.map((id, i) => ({
    id,
    src_phrase: parsed.src_phrases[i],
    tgt_phrase: parsed.tgt_phrases[i],
    direction: parsed.directions[i],
    num_occurrences: parsed.num_occurrences[i],
  }));

  return {
    draw: data.draw,
    recordsTotal: parsed.total_records,
    recordsFiltered: parsed.filtered_records,
    data: datatable_data,
  };
}

export async function fetchIgnoredPhrases(data) {

  const pyodide = await initPyodide();

  const response = await pyodide.runPythonAsync(`
      import json
      from phrases import fetch_ignored_phrases

      ids, src_phrases, tgt_phrases, imported, total_records = fetch_ignored_phrases(
          ${data.project_id}, 
          ${data.start}, 
          ${data.length}
      )
      json.dumps({
          "ids": ids,
          "src_phrases": src_phrases,
          "tgt_phrases": tgt_phrases,
          "imported": imported,
          "total_records": total_records,
          "filtered_records": total_records
      })
  `);

  const parsed = JSON.parse(response);

  const datatable_data = parsed.ids.map((id, i) => ({
    id,
    src_phrase: parsed.src_phrases[i],
    tgt_phrase: parsed.tgt_phrases[i],
    imported: parsed.imported[i],
  }));

  return {
    draw: data.draw,
    recordsTotal: parsed.total_records,
    recordsFiltered: parsed.filtered_records,
    data: datatable_data,
  };
}

export async function deleteAllIgnoredPhrases(project_id) {
  const pyodide = await initPyodide();
    
  pyodide.globals.set("project_id", project_id);

  await pyodide.runPythonAsync(`
      import json
      from phrases import delete_all_ignored_phrases

      delete_all_ignored_phrases(project_id)
  `);

  await safeSyncfs(pyodide);
}

export async function setIgnorePhrase(project_id, phrase_id, ignore, imported) {
  const pyodide = await initPyodide();
    
  pyodide.globals.set("project_id", project_id);
  pyodide.globals.set("phrase_id", phrase_id);
  pyodide.globals.set("ignore", ignore);

  if (imported=="1") {
    console.log("Removing imported phrase to ignore with id", phrase_id);
    await pyodide.runPythonAsync(`
        import json
        from phrases import remove_phrase_to_ignore

        remove_phrase_to_ignore(
            project_id, phrase_id
        )
    `);

  } else {

    console.log("Removing ignored phrase with id", phrase_id);

    await pyodide.runPythonAsync(`
        import json
        from phrases import set_ignore_phrase

        set_ignore_phrase(
            project_id, phrase_id, ignore
        )
    `);

  }

  await safeSyncfs(pyodide);
}

export async function importIgnoredFromFile(project_id, fileContent) {
  const pyodide = await initPyodide();

  pyodide.globals.set("file_content", fileContent);
  pyodide.globals.set("project_id", project_id);

  await pyodide.runPythonAsync(`
      from phrases import import_ignored_from_file
      import_ignored_from_file(project_id, file_content)
  `);

  await safeSyncfs(pyodide);
  return;
}

export async function downloadIgnoredPhrases(project_id) {
  
  const pyodide = await initPyodide();

  pyodide.globals.set("project_id", project_id);
  
  const response = await pyodide.runPythonAsync(`
      from phrases import get_all_phrases_to_ignore
      data = get_all_phrases_to_ignore(project_id)
      list(data)
`);

  // Convert PyProxy to JS array of arrays
  const dataObj = response.toJs().map(t => Array.from(t));  // each tuple -> JS array

  // dataObj is a list of tuples (src_phrase, tgt_phrase), trasnform to list of dicts with src and tgt key
  const transformedData = dataObj.map(item => ({
    src: item[0],
    tgt: item[1]
  }));

  // create JSON file and download
  const jsonStr = JSON.stringify(transformedData, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });

  // create a link to download the JSON file
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `ignored_phrases_project_${project_id}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

}

export async function downloadPhrases(project_id) {
  
  const pyodide = await initPyodide();

  pyodide.globals.set("project_id", project_id);
  
  const response = await pyodide.runPythonAsync(`
      import json
      from phrases import get_symmetric_phrases
      data = get_symmetric_phrases(project_id)
      json.dumps(data)
 `);

  // Parse JSON string and transform to only include src and tgt keys
  const allPhrases = JSON.parse(response);
  const transformedData = allPhrases.map(item => ({
    src: item.src_phrase,
    tgt: item.tgt_phrase
  }));

  // create JSON file and download
  const jsonStr = JSON.stringify(transformedData, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });

  // create a link to download the JSON file
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `phrases_project_${project_id}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  // also download robustness report if available
  try {
    await downloadRobustnessReport(project_id);
  } catch (e) {
    console.warn("Could not download robustness report:", e);
  }

}


