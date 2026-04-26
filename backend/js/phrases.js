/**
 * Copyright 2025 Samuel Frontull, Simon Haller-Seeber, and Robert Sama, University of Innsbruck
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

// console.log("phrases.js loaded: v=2026-03-16-auto-refresh-ui");
const SAVE_BATCH_SIZE = 100000; // adjust based on memory

const UNALIGNED_SENTINEL = "__ALIGNFIX_UNALIGNED__";

async function _fetchUnalignedCountsForSources(projectId, srcPhrases) {
  const uniqueSrc = Array.from(new Set((srcPhrases || []).map(x => String(x || '').trim()).filter(Boolean)));
  if (!uniqueSrc.length) return {};

  const pyodide = await initPyodide();
  pyodide.globals.set("project_id", Number(projectId));
  pyodide.globals.set("src_phrases", uniqueSrc);

  const response = await pyodide.runPythonAsync(`
import json
from projects import get_unaligned_src_counts
json.dumps(get_unaligned_src_counts(project_id, src_phrases))
  `);

  return JSON.parse(response || '{}');
}

function _isUnalignedVariantEntry(v) {
  const tgt = String(v?.tgt || '').trim();
  return (
    Boolean(v?.is_unaligned) ||
    tgt === UNALIGNED_SENTINEL ||
    tgt.toLowerCase() === "unaligned"
  );
}

async function _augmentRowsWithUnaligned(projectId, rows) {
  if (!Array.isArray(rows) || !rows.length) return rows || [];
  const singleTokenRows = rows.filter(r => _isSingleToken(r?.src_phrase || r?.src || ''));
  if (!singleTokenRows.length) return rows;

  const countsBySrc = await _fetchUnalignedCountsForSources(projectId, singleTokenRows.map(r => r.src_phrase || r.src));

  return rows.map((row) => {
    const srcPhrase = String(row?.src_phrase || row?.src || '').trim();
    const fetchedUnalignedCount = Number(countsBySrc[srcPhrase] || 0);

    const topkRaw = Array.isArray(row?.topk) ? [...row.topk] : [];
    const existingUnalignedTopk = topkRaw.find(v => _isUnalignedVariantEntry(v));
    const existingUnalignedCount = Number(row?.unaligned_count ?? existingUnalignedTopk?.count ?? 0);

    let alignedTopk = topkRaw
      .filter(v => !_isUnalignedVariantEntry(v))
      .map((v) => ({
        ...v,
        count: Number(v?.count || 0),
      }))
      .sort((a, b) => Number(b?.count || 0) - Number(a?.count || 0));

    let alignedTotal = alignedTopk.reduce((acc, v) => acc + Number(v?.count || 0), 0);
    if (!alignedTotal) {
      const currentTotal = Number(row?.num_occurrences ?? row?.total ?? 0);
      alignedTotal = Math.max(0, currentTotal - existingUnalignedCount);
    }

    const total = alignedTotal + fetchedUnalignedCount;

    alignedTopk = alignedTopk.map((v) => ({
      ...v,
      share: total ? (Number(v?.count || 0) / total) : 0,
    }));

    const bestAligned = alignedTopk[0] || null;
    const bestAlignedCount = Number(bestAligned?.count || row?.top_count || 0);
    const bestAlignedTgt = String(bestAligned?.tgt || row?.tgt_phrase || row?.top_tgt || '').trim();

    const topk = [...alignedTopk];
    if (fetchedUnalignedCount > 0) {
      topk.push({
        tgt: UNALIGNED_SENTINEL,
        count: fetchedUnalignedCount,
        share: total ? fetchedUnalignedCount / total : 0,
        is_unaligned: true,
      });
    }

    return {
      ...row,
      num_occurrences: total,
      total,
      top_tgt: bestAlignedTgt,
      tgt_phrase: bestAlignedTgt || row?.tgt_phrase || '',
      top_count: bestAlignedCount,
      top_share: total ? bestAlignedCount / total : 0,
      // Count only aligned translation variants. The unaligned bucket is shown in topk,
      // but it is not a translation variant and must not increase the variant count.
      num_tgts: alignedTopk.length,
      topk,
      unaligned_count: fetchedUnalignedCount,
      unaligned_share: total ? fetchedUnalignedCount / total : 0,
    };
  });
}

// =======================
// Full Phrase Translation Table (CSV/JSON)
// Keeps tokens exactly as-is; includes multi-word phrases.
// =======================

// In-memory cache so downloads can happen synchronously on button click (no awaits).
// If user reloads the page, raw extracted phrases are not restored, but the compact overview rows are.
const _LAST_EXTRACTED_PHRASES_BY_PROJECT = new Map();
const _LAST_PHRASE_OVERVIEW_ROWS_BY_PROJECT = new Map();
const PHRASE_OVERVIEW_CACHE_KEY = (projectId) => `alignfix:v2:phrase_overview_rows:${projectId}`;

function cacheExtractedPhrases(projectId, phrasesArray) {
  _LAST_EXTRACTED_PHRASES_BY_PROJECT.set(String(projectId), phrasesArray);
}

function getCachedExtractedPhrases(projectId) {
  return _LAST_EXTRACTED_PHRASES_BY_PROJECT.get(String(projectId)) || null;
}

function cachePhraseOverviewRows(projectId, rows) {
  const projectKey = String(projectId);
  const payload = Array.isArray(rows) ? rows : [];
  _LAST_PHRASE_OVERVIEW_ROWS_BY_PROJECT.set(projectKey, payload);
  try {
    localStorage.setItem(PHRASE_OVERVIEW_CACHE_KEY(projectKey), JSON.stringify(payload));
  } catch (e) {
    console.warn("⚠️ Could not persist phrase overview rows to localStorage:", e);
  }
}

function getCachedPhraseOverviewRows(projectId) {
  const projectKey = String(projectId);
  const mem = _LAST_PHRASE_OVERVIEW_ROWS_BY_PROJECT.get(projectKey);
  if (mem) return mem;
  try {
    const raw = localStorage.getItem(PHRASE_OVERVIEW_CACHE_KEY(projectKey));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const rows = Array.isArray(parsed) ? parsed : [];
    _LAST_PHRASE_OVERVIEW_ROWS_BY_PROJECT.set(projectKey, rows);
    return rows;
  } catch (e) {
    console.warn("⚠️ Could not restore phrase overview rows from localStorage:", e);
    return null;
  }
}

// Cache form-aligned candidates from the last extraction.
// Also persist them so the report still works after a reload.
const _LAST_FORM_ALIGNED_BY_PROJECT = new Map(); // projectId -> { pairs: [{src,tgt}], examples: [...], params: {...} }
const _LAST_DICTIONARY_HIDDEN_BY_PROJECT = new Map(); // projectId -> { pairs: [{src,tgt}], examples: [...], params: {...} }
const FORM_ALIGNED_CACHE_KEY = (projectId) => `alignfix:v2:form_aligned_candidates:${projectId}`;
const DICTIONARY_HIDDEN_CACHE_KEY = (projectId) => `alignfix:v2:dictionary_hidden_candidates:${projectId}`;

function cacheFormAlignedCandidates(projectId, data) {
  const projectKey = String(projectId);
  const payload = data || { pairs: [], examples: [], params: {} };
  _LAST_FORM_ALIGNED_BY_PROJECT.set(projectKey, payload);
  try {
    localStorage.setItem(FORM_ALIGNED_CACHE_KEY(projectKey), JSON.stringify(payload));
  } catch (e) {
    console.warn("⚠️ Could not persist form-aligned candidates to localStorage:", e);
  }
}

function getCachedFormAlignedCandidates(projectId) {
  const projectKey = String(projectId);
  const mem = _LAST_FORM_ALIGNED_BY_PROJECT.get(projectKey);
  if (mem) return mem;
  try {
    const raw = localStorage.getItem(FORM_ALIGNED_CACHE_KEY(projectKey));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    _LAST_FORM_ALIGNED_BY_PROJECT.set(projectKey, parsed);
    return parsed;
  } catch (e) {
    console.warn("⚠️ Could not restore form-aligned candidates from localStorage:", e);
    return null;
  }
}

function cacheDictionaryHiddenCandidates(projectId, data) {
  const projectKey = String(projectId);
  const payload = data || { pairs: [], examples: [], params: {} };
  _LAST_DICTIONARY_HIDDEN_BY_PROJECT.set(projectKey, payload);
  try {
    localStorage.setItem(DICTIONARY_HIDDEN_CACHE_KEY(projectKey), JSON.stringify(payload));
  } catch (e) {
    console.warn("⚠️ Could not persist dictionary candidates to localStorage:", e);
  }
}

function getCachedDictionaryHiddenCandidates(projectId) {
  const projectKey = String(projectId);
  const mem = _LAST_DICTIONARY_HIDDEN_BY_PROJECT.get(projectKey);
  if (mem) return mem;
  try {
    const raw = localStorage.getItem(DICTIONARY_HIDDEN_CACHE_KEY(projectKey));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    _LAST_DICTIONARY_HIDDEN_BY_PROJECT.set(projectKey, parsed);
    return parsed;
  } catch (e) {
    console.warn("⚠️ Could not restore dictionary candidates from localStorage:", e);
    return null;
  }
}

// =======================
// Morphology-driven auto-hide (Ladin -> Italian) using local_data/
// - Ladin:  local_data/formario_lavb.csv   (id,tag,form)
// - Italian: local_data/morphit_it.txt     (Morph-it: form<TAB>lemma<TAB>features)
// =======================

let _FORMARIO_LAVB_TEXT_PROMISE = null;
let _MORPHIT_TEXT_PROMISE = null;
let _LAVB_ITA_TEXT_PROMISE = null;

function _normTok(s) {
  return (s || "").normalize("NFC").trim().toLowerCase();
}

function _isSingleToken(s) {
  return !!s && !/\s/.test(String(s).trim());
}

const _IT_DET_PREFIX = new Set([
  "il","lo","la","i","gli","le",
  "un","uno","una",
  "del","dello","della","dei","degli","delle",
  "al","allo","alla","ai","agli","alle",
  "nel","nello","nella","nei","negli","nelle",
  "sul","sullo","sulla","sui","sugli","sulle",
  "da","di","a","in","su","per","con","tra","fra"
]);

function _cleanItToken(tok) {
  let t = _normTok(tok);
  // strip leading/trailing punctuation
  t = t.replace(/^[^a-zàèéìòóù]+/i, "").replace(/[^a-zàèéìòóù]+$/i, "");
  // handle l' / un' style elision inside single token
  t = t.replace(/^(l|un|una|lo|la|d|c|s|m|t)['’]/, "");
  return t;
}

function _extractItalianHeadToken(tgtPhrase) {
  const toks = String(tgtPhrase || "").trim().split(/\s+/).filter(Boolean);
  if (!toks.length) return null;

  if (toks.length === 1) return _cleanItToken(toks[0]);

  // 2 tokens: article/prep + head
  if (toks.length === 2 && _IT_DET_PREFIX.has(_normTok(toks[0]))) return _cleanItToken(toks[1]);

  // 3 tokens: e.g. "della buona cosa" (rare) – keep conservative: det+det+head
  if (toks.length === 3 && _IT_DET_PREFIX.has(_normTok(toks[0])) && _IT_DET_PREFIX.has(_normTok(toks[1])))
    return _cleanItToken(toks[2]);

  return null; // otherwise skip (avoid false positives)
}

// Minimal CSV splitter for "id,tag,form" (3 columns).
// Tag and form in your data do not contain commas, so this is safe.
function _split3csv(line) {
  const a = line.indexOf(",");
  if (a < 0) return [null, null, null];
  const b = line.indexOf(",", a + 1);
  if (b < 0) return [line.slice(0, a), line.slice(a + 1).trim(), ""];
  return [line.slice(0, a), line.slice(a + 1, b).trim(), line.slice(b + 1).trim()];
}

/**
 * Parse Ladin formario tag scheme.
 * Examples:
 * - sost.masch.sing
 * - agg.femm.plur
 * - v.imper.2p-Dat/Acc-A_VOI-LUI/CIO  -> base tag = v.imper.2p
 */
function _parseLadinTag(tagStr) {
  const raw = (tagStr || "").trim();
  if (!raw) return null;

  // only keep base morph tag before clitic/argument decorations:
  // v.imper.2p-Dat/...  -> v.imper.2p
  const base = raw.split(/[-_]/)[0].trim();

  const parts = base
    .split(".")
    .map(x => x.trim())
    .filter(x => x.length > 0);

  if (!parts.length) return null;

  const pos = parts[0]; // 'sost', 'agg', 'v', ...

  const gender =
    parts.includes("femm") ? "f" :
    parts.includes("masch") ? "m" :
    null;

  let number =
    parts.includes("sing") ? "sing" :
    parts.includes("plur") ? "plur" :
    null;

  // Verb details (if present)
  let mood = null;
  let person = null;

  if (pos === "v") {
    mood = parts[1] || null; // e.g. imper, ind, con, inf, part, ger, ...

    // Find token like "2p" or "3s"
    const pn = parts.find(x => /^\d[ps]$/.test(x));
    if (pn) {
      person = parseInt(pn[0], 10);
      number = pn[1] === "p" ? "plur" : "sing";
    }
  }

  return { pos, gender, number, mood, person, parts, raw, base };
}

// ---- Load text files from local_data/ ----

async function _loadFormarioLavbTextOnce() {
  if (!_FORMARIO_LAVB_TEXT_PROMISE) {
    // phrases.js is /backend/js/phrases.js -> ../../local_data/... = /backend/local_data/...
    const url = new URL("../../local_data/formario_lavb.csv", import.meta.url);
    _FORMARIO_LAVB_TEXT_PROMISE = fetch(url).then(r => {
      if (!r.ok) throw new Error(`Cannot fetch formario_lavb.csv (${r.status})`);
      return r.text();
    });
  }
  return _FORMARIO_LAVB_TEXT_PROMISE;
}

async function _loadMorphItTextOnce() {
  if (!_MORPHIT_TEXT_PROMISE) {
    const url = new URL("../../local_data/morphit_it.txt", import.meta.url);
    _MORPHIT_TEXT_PROMISE = fetch(url).then(r => {
      if (!r.ok) throw new Error(`Cannot fetch morphit_it.txt (${r.status})`);
      return r.text();
    });
  }
  return _MORPHIT_TEXT_PROMISE;
}


async function _loadLavbItaTextOnce() {
  if (!_LAVB_ITA_TEXT_PROMISE) {
    const url = new URL("../../local_data/lavb-ita.csv", import.meta.url);
    _LAVB_ITA_TEXT_PROMISE = fetch(url).then(r => {
      if (!r.ok) throw new Error(`Cannot fetch lavb-ita.csv (${r.status})`);
      return r.text();
    });
  }
  return _LAVB_ITA_TEXT_PROMISE;
}

// Build small indexes only for forms we need in THIS extraction (fast + memory-light).
async function _buildLadinFormIndex(neededSrcFormsSet) {
  const text = await _loadFormarioLavbTextOnce();
  const map = new Map(); // norm(form) -> [ladinFeat...]

  for (const line of text.split(/\r?\n/)) {
    const ln = line.trim();
    if (!ln) continue;

    const [, tag, form] = _split3csv(ln);
    if (!tag || !form) continue;

    const key = _normTok(form);
    if (!neededSrcFormsSet.has(key)) continue;

    const feat = _parseLadinTag(tag);
    if (!feat) continue;

    if (!map.has(key)) map.set(key, []);
    map.get(key).push(feat);
  }
  return map;
}

async function _buildMorphItIndex(neededItFormsSet) {
  const text = await _loadMorphItTextOnce();
  const map = new Map(); // norm(form) -> [featureStr...]

  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;

    const form = parts[0];
    const feats = parts[2];

    const key = _normTok(form);
    if (!neededItFormsSet.has(key)) continue;

    if (!map.has(key)) map.set(key, []);
    map.get(key).push(feats);
  }
  return map;
}

function _parseLavbItaRow(line) {
  const parts = String(line || "").split(",");
  if (parts.length < 13) return null;

  const src = (parts[1] || "").trim();
  const srcTag = (parts[3] || "").trim();
  const tgtTag = (parts[10] || "").trim();
  const tgt = (parts[12] || "").trim();

  if (!src || !tgt) return null;
  return { src, tgt, srcTag, tgtTag };
}

async function _buildLavbItaIndex(neededSrcFormsSet) {
  const text = await _loadLavbItaTextOnce();
  const map = new Map(); // norm(src) -> Map(norm(tgt/head) -> [row...])

  const addEntry = (srcKey, tgtKey, row) => {
    if (!srcKey || !tgtKey) return;
    let tgtMap = map.get(srcKey);
    if (!tgtMap) {
      tgtMap = new Map();
      map.set(srcKey, tgtMap);
    }
    if (!tgtMap.has(tgtKey)) tgtMap.set(tgtKey, []);
    tgtMap.get(tgtKey).push(row);
  };

  for (const line of text.split(/\r?\n/)) {
    const row = _parseLavbItaRow(line);
    if (!row) continue;

    const srcKey = _normTok(row.src);
    if (!neededSrcFormsSet.has(srcKey)) continue;

    const tgtNorm = _normTok(row.tgt);
    const tgtClean = _cleanItToken(row.tgt);
    const tgtHead = _extractItalianHeadToken(row.tgt);

    addEntry(srcKey, tgtNorm, row);
    if (tgtClean && tgtClean !== tgtNorm) addEntry(srcKey, tgtClean, row);
    if (tgtHead && tgtHead !== tgtNorm && tgtHead !== tgtClean) addEntry(srcKey, tgtHead, row);
  }

  return map;
}

/**
 * Parse Morph-it feature string.
 * Examples from Morph-it docs:
 * - NOUN-F:s
 * - ADJ:pos+f+p
 * - VER:imp+2+p
 */
function _parseMorphIt(featStr) {
  const [left, infl = ""] = (featStr || "").split(":");
  const leftParts = left.split("-");
  const pos = leftParts[0] || null;

  const inflParts = infl.split("+").filter(Boolean);

  // number
  let number = null;
  if (inflParts.includes("s")) number = "sing";
  if (inflParts.includes("p")) number = "plur";

  // gender
  let gender = null;
  if (leftParts.includes("F")) gender = "f";
  if (leftParts.includes("M")) gender = "m";
  if (inflParts.includes("f")) gender = "f";
  if (inflParts.includes("m")) gender = "m";

  // verb mood + person (if any)
  let mood = null;
  let person = null;

  if (pos === "VER") {
    const moodCand = inflParts.find(x =>
      ["ind", "con", "cnd", "imp", "inf", "part", "ger"].includes(x)
    );
    mood = moodCand || null;

    const persCand = inflParts.find(x => ["1", "2", "3"].includes(x));
    person = persCand ? parseInt(persCand, 10) : null;
  }

  return { pos, gender, number, mood, person, raw: featStr };
}

function _italMatchesLadinByMorphIt(ladinFeat, morphItFeatStrings) {
  if (!ladinFeat || !morphItFeatStrings?.length) return false;

  // POS mapping
  const okPos =
    ladinFeat.pos === "agg"  ? new Set(["ADJ", "VER"]) : // include participles
    ladinFeat.pos === "sost" ? new Set(["NOUN"]) :
    ladinFeat.pos === "v"    ? new Set(["VER"]) :
    null;

  // mood mapping Ladin -> Morph-it
  const moodMap = {
    imper: "imp",
    ind: "ind",
    con: "con",
    cnd: "cnd",
    inf: "inf",
    ger: "ger",
    part: "part",
  };

  for (const s of morphItFeatStrings) {
    const it = _parseMorphIt(s);
    if (okPos && !okPos.has(it.pos)) continue;

    // Nouns/adjectives: match gender+number (only if Ladin has them)
    if ((ladinFeat.pos === "sost" || ladinFeat.pos === "agg") &&
        ladinFeat.gender && ladinFeat.number) {
      if (it.gender === ladinFeat.gender && it.number === ladinFeat.number) return true;
      continue;
    }

    // Verbs: match mood/person/number when available
    if (ladinFeat.pos === "v") {
      const ladMood = ladinFeat.mood;
      const itMood = it.mood;

      const moodOk =
        !ladMood || !itMood ? true :
        (moodMap[ladMood] ? moodMap[ladMood] === itMood : ladMood === itMood);

      const personOk =
        ladinFeat.person == null || it.person == null ? true : ladinFeat.person === it.person;

      const numberOk =
        !ladinFeat.number || !it.number ? true : ladinFeat.number === it.number;

      if (moodOk && personOk && numberOk) return true;
    }
  }

  return false;
}

function _findMorphAlignment(ladinFeats, itFeatStrings) {
  if (!ladinFeats?.length || !itFeatStrings?.length) return null;
  for (const lf of ladinFeats) {
    for (const itRaw of itFeatStrings) {
      // reuse your matcher but return the “witness” features
      if (_italMatchesLadinByMorphIt(lf, [itRaw])) {
        return { ladin_tag: lf.base || lf.raw, italian_feat: itRaw };
      }
    }
  }
  return null;
}

/**
 * Auto-add morphology-matching single-token src->tgt pairs to "ignored" (hidden phrases).
 * Uses existing Python importer: import_ignored_from_file(project_id, json_string)
 */
async function _autoAddMorphHiddenPhrases(project_id, phrasesArray, pyodide, opts = {}) {
  const {
    allowedDirections = new Set(["0"]),
    singleTokenOnly = true,
    maxAdded = 200000,
    maxExamplePairs = 20,
    doImport = false, // if false, only compute + return pairs
  } = opts;

  const candidates = [];
  const neededSrc = new Set();
  const neededIt = new Set();

  for (const p of phrasesArray || []) {
    const dir = String(p.direction ?? "0");
    if (allowedDirections && !allowedDirections.has(dir)) continue;

    const src = (p.src_phrase || "").trim();
    const tgt = (p.tgt_phrase || "").trim();
    if (!src || !tgt) continue;

    if (singleTokenOnly && !_isSingleToken(src)) continue;

    const tgtHead = _extractItalianHeadToken(tgt);
    if (!tgtHead) continue;

    const ns = _normTok(src);
    const nt = _normTok(tgtHead);

    neededSrc.add(ns);
    neededIt.add(nt);
    candidates.push([src, tgt, ns, nt, tgtHead]);
  }

  if (!candidates.length) {
    return { found: 0, imported: 0, pairs: [], examples: [], params: { allowedDirections: Array.from(allowedDirections), singleTokenOnly } };
  }

  const ladinIndex = await _buildLadinFormIndex(neededSrc);
  const itIndex = await _buildMorphItIndex(neededIt);

  const toIgnore = [];
  const seen = new Set();
  const examples = [];

  for (const [src, tgt, ns, nt, tgtHead] of candidates) {
    const ladFeats = ladinIndex.get(ns);
    const itFeats = itIndex.get(nt);
    if (!ladFeats || !itFeats) continue;

    const matchInfo = _findMorphAlignment(ladFeats, itFeats);
    if (!matchInfo) continue;

    const key = `${src}\u0000${tgt}`;
    if (seen.has(key)) continue;
    seen.add(key);

    toIgnore.push({ src, tgt });

    if (examples.length < maxExamplePairs) {
      examples.push({
        src,
        tgt,
        tgt_head: tgtHead,
        ladin_tag: matchInfo.ladin_tag,
        italian_feat: matchInfo.italian_feat,
      });
    }

    if (toIgnore.length >= maxAdded) break;
  }

  if (!toIgnore.length) {
    return { found: 0, imported: 0, pairs: [], examples: [], params: { allowedDirections: Array.from(allowedDirections), singleTokenOnly } };
  }

  if (doImport) {
    pyodide.globals.set("project_id", project_id);
    pyodide.globals.set("file_content", JSON.stringify(toIgnore));
    await pyodide.runPythonAsync(`
from phrases import import_ignored_from_file
import_ignored_from_file(project_id, file_content)
    `);
    pyodide.globals.delete("file_content");
  }

  return {
    found: toIgnore.length,
    imported: doImport ? toIgnore.length : 0,
    pairs: toIgnore,
    examples,
    params: { allowedDirections: Array.from(allowedDirections), singleTokenOnly, maxAdded, maxExamplePairs, doImport }
  };
}

async function _autoAddDictionaryHiddenPhrases(project_id, phrasesArray, pyodide, opts = {}) {
  const {
    allowedDirections = new Set(["0"]),
    singleTokenOnly = true,
    maxAdded = 200000,
    maxExamplePairs = 20,
    doImport = false,
  } = opts;

  const candidates = [];
  const neededSrc = new Set();

  for (const p of phrasesArray || []) {
    const dir = String(p.direction ?? "0");
    if (allowedDirections && !allowedDirections.has(dir)) continue;

    const src = (p.src_phrase || "").trim();
    const tgt = (p.tgt_phrase || "").trim();
    if (!src || !tgt) continue;
    if (singleTokenOnly && !_isSingleToken(src)) continue;

    const tgtHead = _extractItalianHeadToken(tgt);
    if (!tgtHead) continue;

    const ns = _normTok(src);
    const nt = _normTok(tgtHead);
    neededSrc.add(ns);
    candidates.push([src, tgt, ns, nt, tgtHead]);
  }

  if (!candidates.length) {
    return { found: 0, imported: 0, pairs: [], examples: [], params: { allowedDirections: Array.from(allowedDirections), singleTokenOnly } };
  }

  const dictIndex = await _buildLavbItaIndex(neededSrc);
  const toIgnore = [];
  const seen = new Set();
  const examples = [];

  for (const [src, tgt, ns, nt, tgtHead] of candidates) {
    const tgtMap = dictIndex.get(ns);
    const matches = tgtMap?.get(nt);
    if (!matches?.length) continue;

    const key = `${src}${tgt}`;
    if (seen.has(key)) continue;
    seen.add(key);

    toIgnore.push({ src, tgt });

    if (examples.length < maxExamplePairs) {
      const witness = matches[0];
      examples.push({
        src,
        tgt,
        tgt_head: tgtHead,
        dictionary_tgt: witness.tgt,
        src_tag: witness.srcTag,
        tgt_tag: witness.tgtTag,
      });
    }

    if (toIgnore.length >= maxAdded) break;
  }

  if (!toIgnore.length) {
    return { found: 0, imported: 0, pairs: [], examples: [], params: { allowedDirections: Array.from(allowedDirections), singleTokenOnly } };
  }

  if (doImport) {
    pyodide.globals.set("project_id", project_id);
    pyodide.globals.set("file_content", JSON.stringify(toIgnore));
    await pyodide.runPythonAsync(`
from phrases import import_ignored_from_file
import_ignored_from_file(project_id, file_content)
    `);
    pyodide.globals.delete("file_content");
  }

  return {
    found: toIgnore.length,
    imported: doImport ? toIgnore.length : 0,
    pairs: toIgnore,
    examples,
    params: { allowedDirections: Array.from(allowedDirections), singleTokenOnly, maxAdded, maxExamplePairs, doImport }
  };
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
const SPLIT_TOP_SHARE = 0.75;   // split point
const SURE_TOP_SHARE = SPLIT_TOP_SHARE;

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
    r.top_share < SURE_TOP_SHARE
  );

  const csv = phraseTranslationTableToCSV(dubious);
  const ts = new Date().toISOString().replace(/[:]/g, "-");
  downloadTextFile(`dubious_phrases_project_${project_id}_${ts}.csv`, csv);
}

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

export function downloadSurePhrasesAsHiddenJSON(project_id, opts = {}) {
  const { union } = buildHiddenPhraseArtifacts(project_id, {
    includeConsistency: opts.includeConsistency !== false,
    includeFormAligned: opts.includeFormAligned !== false,
    includeDictionary: opts.includeDictionary !== false,
    consistencyDirections: opts.directions || new Set(["0"]),
    consistencySingleTokenOnly: false,
    consistencyMinTotal: DEFAULT_FILTER_MIN_TOTAL,
    consistencyConfidenceSplit: SURE_TOP_SHARE,
    maxExamplesPerGroup: 12,
  });

  const ts = new Date().toISOString().replace(/[:]/g, "-");
  downloadTextFile(
    `hidden_phrases_selection_project_${project_id}_${ts}.json`,
    JSON.stringify(union, null, 2)
  );
}

function _buildConsistencyHiddenCandidatesFromCachedPhrases(project_id, opts = {}) {
  const {
    directions = new Set(["0"]),
    singleTokenOnly = false,
    minTotal = DEFAULT_FILTER_MIN_TOTAL,
    confidenceSplit = SURE_TOP_SHARE,
  } = opts;

  const phrases = getCachedExtractedPhrases(project_id);
  if (!phrases) return { rows: [], pairs: [], rowInfoByKey: new Map(), params: { directions: Array.from(directions), singleTokenOnly, minTotal, confidenceSplit } };

  const base = buildBasePhraseTableForDownloads(phrases, { minTotal, topK: 15 });
  const sure = filterPhraseTranslationTable(base, (r) =>
    r.total >= minTotal && r.top_share >= confidenceSplit
  );

  const pairs = [];
  const rowInfoByKey = new Map();

  for (const r of (sure.rows || [])) {
    const dir = String(r.direction ?? "");
    if (directions && !directions.has(dir)) continue;

    const src = (r.src || "").trim();
    const tgt = (r.top_tgt || "").trim();
    if (!src || !tgt) continue;

    if (singleTokenOnly && !_isSingleToken(src)) continue;

    const key = `${src}${tgt}`;
    if (!rowInfoByKey.has(key)) {
      pairs.push({ src, tgt });
      rowInfoByKey.set(key, {
        direction: dir,
        src,
        tgt,
        total: r.total,
        top_share: r.top_share,
        top_count: r.top_count,
        num_tgts: r.num_tgts,
        topk: r.topk || [],
      });
    }
  }

  pairs.sort((a, b) => {
    const ka = `${a.src}${a.tgt}`;
    const kb = `${b.src}${b.tgt}`;
    return (rowInfoByKey.get(kb)?.total || 0) - (rowInfoByKey.get(ka)?.total || 0);
  });

  return {
    rows: sure.rows || [],
    pairs,
    rowInfoByKey,
    params: { directions: Array.from(directions), singleTokenOnly, minTotal, confidenceSplit }
  };
}

const _buildRobustHiddenCandidatesFromCachedPhrases = _buildConsistencyHiddenCandidatesFromCachedPhrases;

function _setFromPairs(pairs) {
  return new Set((pairs || []).map(p => `${p.src}${p.tgt}`));
}

function _groupMembership(k, groups) {
  return groups.filter(g => g.enabled && g.set.has(k)).map(g => g.label);
}

function _countExactMembership(groups) {
  const allKeys = new Set();
  for (const g of groups) {
    if (!g.enabled) continue;
    for (const k of g.set) allKeys.add(k);
  }
  const out = new Map();
  for (const k of allKeys) {
    const sig = _groupMembership(k, groups).sort().join("+");
    out.set(sig, (out.get(sig) || 0) + 1);
  }
  return out;
}

function buildHiddenPhraseArtifacts(project_id, opts = {}) {
  const {
    includeConsistency = true,
    includeFormAligned = true,
    includeDictionary = true,
    consistencyDirections = new Set(["0"]),
    consistencySingleTokenOnly = false,
    consistencyMinTotal = DEFAULT_FILTER_MIN_TOTAL,
    consistencyConfidenceSplit = SURE_TOP_SHARE,
    maxExamplesPerGroup = 12,
  } = opts;

  const phrases = getCachedExtractedPhrases(project_id);
  if (!phrases) {
    throw new Error(
      `No extracted phrases cached for project ${project_id}. Run "Extract phrases" first (same session).`
    );
  }

  const consistency = includeConsistency
    ? _buildConsistencyHiddenCandidatesFromCachedPhrases(project_id, {
        directions: consistencyDirections,
        singleTokenOnly: consistencySingleTokenOnly,
        minTotal: consistencyMinTotal,
        confidenceSplit: consistencyConfidenceSplit,
      })
    : { pairs: [], rowInfoByKey: new Map(), params: {} };

  const formCache = includeFormAligned ? getCachedFormAlignedCandidates(project_id) : null;
  const formPairs = (formCache?.pairs || []).filter(p => p?.src && p?.tgt);
  const formExamples = formCache?.examples || [];

  const dictCache = includeDictionary ? getCachedDictionaryHiddenCandidates(project_id) : null;
  const dictPairs = (dictCache?.pairs || []).filter(p => p?.src && p?.tgt);
  const dictExamples = dictCache?.examples || [];

  const groups = [
    { key: "consistency", label: "CONSISTENCY", enabled: includeConsistency, set: _setFromPairs(consistency.pairs) },
    { key: "form", label: "FORM", enabled: includeFormAligned, set: _setFromPairs(formPairs) },
    { key: "dictionary", label: "DICTIONARY", enabled: includeDictionary, set: _setFromPairs(dictPairs) },
  ];

  const membershipCounts = _countExactMembership(groups);
  const consistencySet = groups[0].set;
  const formSet = groups[1].set;
  const dictionarySet = groups[2].set;

  const union = [];
  const seen = new Set();
  const orderedSources = [];
  if (includeConsistency) orderedSources.push(...consistency.pairs);
  if (includeFormAligned) orderedSources.push(...formPairs);
  if (includeDictionary) orderedSources.push(...dictPairs);

  for (const p of orderedSources) {
    const k = `${p.src}${p.tgt}`;
    if (seen.has(k)) continue;
    seen.add(k);
    union.push({ src: p.src, tgt: p.tgt });
  }

  const fmtPct = (x) => `${(x * 100).toFixed(1)}%`;
  const lines = [];

  const pushConsistencyExample = (k, label) => {
    const info = consistency.rowInfoByKey.get(k);
    if (!info) return;
    const topList = (info.topk || []).slice(0, 6).map(x => `${x.tgt}(${x.count})`).join(", ");
    lines.push(
      `${label}: ${info.src} → ${info.tgt} | conf=${fmtPct(info.top_share)} | total=${info.total} | variants=${info.num_tgts}` +
      (topList ? ` | top: ${topList}` : "")
    );
  };

  const pushSection = (title, emitter) => {
    lines.push(title);
    const before = lines.length;
    emitter();
    if (lines.length === before) lines.push("(none)");
    lines.push("");
  };

  lines.push("HIDDEN PHRASE CANDIDATES");
  lines.push("");
  lines.push("COUNTS");
  lines.push(`- consistency candidates: ${consistencySet.size.toLocaleString()}`);
  lines.push(`- form-aligned candidates: ${formSet.size.toLocaleString()}`);
  lines.push(`- dictionary candidates: ${dictionarySet.size.toLocaleString()}`);
  lines.push(`- consistency only: ${(membershipCounts.get("CONSISTENCY") || 0).toLocaleString()}`);
  lines.push(`- form only: ${(membershipCounts.get("FORM") || 0).toLocaleString()}`);
  lines.push(`- dictionary only: ${(membershipCounts.get("DICTIONARY") || 0).toLocaleString()}`);
  lines.push(`- consistency + form: ${(membershipCounts.get("CONSISTENCY+FORM") || 0).toLocaleString()}`);
  lines.push(`- consistency + dictionary: ${(membershipCounts.get("CONSISTENCY+DICTIONARY") || 0).toLocaleString()}`);
  lines.push(`- form + dictionary: ${(membershipCounts.get("FORM+DICTIONARY") || membershipCounts.get("DICTIONARY+FORM") || 0).toLocaleString()}`);
  lines.push(`- all three: ${(membershipCounts.get("CONSISTENCY+FORM+DICTIONARY") || membershipCounts.get("CONSISTENCY+DICTIONARY+FORM") || 0).toLocaleString()}`);
  lines.push(`- union size: ${union.length.toLocaleString()}`);
  lines.push("");

  pushSection("CONSISTENCY-ONLY EXAMPLES", () => {
    let n = 0;
    for (const p of consistency.pairs) {
      if (n >= maxExamplesPerGroup) break;
      const k = `${p.src}${p.tgt}`;
      const sig = _groupMembership(k, groups).sort().join("+");
      if (sig !== "CONSISTENCY") continue;
      pushConsistencyExample(k, `${n + 1}.`);
      n++;
    }
  });

  pushSection("FORM-ALIGNED ONLY EXAMPLES", () => {
    let n = 0;
    for (const ex of formExamples) {
      if (n >= maxExamplesPerGroup) break;
      const k = `${(ex.src || "").trim()}${(ex.tgt || "").trim()}`;
      const sig = _groupMembership(k, groups).sort().join("+");
      if (sig !== "FORM") continue;
      lines.push(`${n + 1}. ${ex.src} → ${ex.tgt} | head=${ex.tgt_head} | ${ex.ladin_tag} ⇄ ${ex.italian_feat}`);
      n++;
    }
  });

  pushSection("DICTIONARY-ONLY EXAMPLES", () => {
    let n = 0;
    for (const ex of dictExamples) {
      if (n >= maxExamplesPerGroup) break;
      const k = `${(ex.src || "").trim()}${(ex.tgt || "").trim()}`;
      const sig = _groupMembership(k, groups).sort().join("+");
      if (sig !== "DICTIONARY") continue;
      lines.push(`${n + 1}. ${ex.src} → ${ex.tgt} | head=${ex.tgt_head || "?"} | ${ex.src_tag || "?"} ⇄ ${ex.tgt_tag || "?"}`);
      n++;
    }
  });

  pushSection("OVERLAP EXAMPLES", () => {
    const formByKey = new Map();
    for (const ex of formExamples) {
      const k = `${(ex.src || "").trim()}${(ex.tgt || "").trim()}`;
      if (!formByKey.has(k)) formByKey.set(k, ex);
    }
    const dictByKey = new Map();
    for (const ex of dictExamples) {
      const k = `${(ex.src || "").trim()}${(ex.tgt || "").trim()}`;
      if (!dictByKey.has(k)) dictByKey.set(k, ex);
    }

    let n = 0;
    for (const p of union) {
      if (n >= maxExamplesPerGroup) break;
      const k = `${p.src}${p.tgt}`;
      const labels = _groupMembership(k, groups).sort();
      if (labels.length < 2) continue;

      lines.push(`${n + 1}. ${p.src} → ${p.tgt} | ${labels.join(" + ")}`);
      const info = consistency.rowInfoByKey.get(k);
      if (info) {
        const topList = (info.topk || []).slice(0, 6).map(x => `${x.tgt}(${x.count})`).join(", ");
        lines.push(`   consistency: conf=${fmtPct(info.top_share)} | total=${info.total} | variants=${info.num_tgts}` + (topList ? ` | top: ${topList}` : ""));
      }
      const formEx = formByKey.get(k);
      if (formEx) {
        lines.push(`   form: head=${formEx.tgt_head} | ${formEx.ladin_tag} ⇄ ${formEx.italian_feat}`);
      }
      const dictEx = dictByKey.get(k);
      if (dictEx) {
        lines.push(`   dictionary: head=${dictEx.tgt_head || "?"} | ${dictEx.src_tag || "?"} ⇄ ${dictEx.tgt_tag || "?"}`);
      }
      n++;
    }
  });

  lines.push("PARAMETERS");
  lines.push(`- include consistency: ${includeConsistency}`);
  lines.push(`- include form-aligned: ${includeFormAligned}`);
  lines.push(`- include dictionary: ${includeDictionary}`);
  lines.push(`- consistency directions: ${JSON.stringify(Array.from(consistencyDirections || []))}`);
  lines.push(`- consistency single-token only: ${consistencySingleTokenOnly}`);
  lines.push(`- consistency minimum occurrences: ${consistencyMinTotal}`);
  lines.push(`- consistency threshold: ${consistencyConfidenceSplit}`);
  lines.push(`- max examples per section: ${maxExamplesPerGroup}`);
  lines.push("");

  return {
    union,
    reportText: lines.join("\n"),
  };
}

function buildRobustAndFormHiddenArtifacts(project_id, opts = {}) {
  return buildHiddenPhraseArtifacts(project_id, {
    includeConsistency: true,
    includeFormAligned: true,
    includeDictionary: true,
    consistencyDirections: opts.robustDirections || new Set(["0"]),
    consistencySingleTokenOnly: opts.robustSingleTokenOnly || false,
    consistencyMinTotal: opts.robustMinTotal || DEFAULT_FILTER_MIN_TOTAL,
    consistencyConfidenceSplit: opts.robustConfidenceSplit || SURE_TOP_SHARE,
    maxExamplesPerGroup: opts.maxExamplesPerGroup || 12,
  });
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
    r.top_share < SURE_TOP_SHARE
  );

  const ts = new Date().toISOString().replace(/[:]/g, "-");
  downloadTextFile(`dubious_phrases_project_${project_id}_${ts}.json`, JSON.stringify(dubious, null, 2));
}

// --- Consistency report cache keys (stored in localStorage) ---
const CONSISTENCY_CACHE_KEY_TEXT = (projectId) =>
  `alignfix:v2:consistency_report_text:${projectId}`;
const CONSISTENCY_CACHE_KEY_JSON = (projectId) =>
  `alignfix:v2:consistency_report_json:${projectId}`;

const ROBUSTNESS_CACHE_KEY_TEXT = CONSISTENCY_CACHE_KEY_TEXT;
const ROBUSTNESS_CACHE_KEY_JSON = CONSISTENCY_CACHE_KEY_JSON;

function cacheConsistencyReport(projectId, phrasesArray, extra = {}) {
  try {
    const report = buildTranslationConsistencyReport(phrasesArray, {
      directions: new Set(["0"]),
      singleWordOnly: true,
      minTotal: DEFAULT_FILTER_MIN_TOTAL,   // 10
      confidenceSplit: SURE_TOP_SHARE,      // 0.75
      maxExamples: 25,
      maxAlternativesShown: 6,
    });

    report.extra = { ...(extra || {}) };

    const text = consistencyReportToText(report);

    localStorage.setItem(CONSISTENCY_CACHE_KEY_JSON(projectId), JSON.stringify(report));
    localStorage.setItem(CONSISTENCY_CACHE_KEY_TEXT(projectId), text);

    console.log(`✅ Translation consistency overview cached for project ${projectId}.`);
  } catch (e) {
    console.warn("⚠️ Overview report generation/caching failed:", e);
  }
}

// IMPORTANT: synchronous download (no awaits) so browsers allow it
export function downloadConsistencyReport(projectId) {
  const text = localStorage.getItem(CONSISTENCY_CACHE_KEY_TEXT(projectId)) || localStorage.getItem(ROBUSTNESS_CACHE_KEY_TEXT(projectId));
  if (!text) {
    alert(
      `No consistency report cached for project ${projectId}.\n\n` +
      `Run "Extract phrases" first, then try again.`
    );
    return;
  }
  const ts = new Date().toISOString().replace(/[:]/g, "-");
  downloadTextFile(`translation_consistency_overview_project_${projectId}_${ts}.txt`, text);
}

export const downloadRobustnessReport = downloadConsistencyReport;


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

function buildTranslationConsistencyReport(phrasesArray, opts = {}) {
  const {
    directions = new Set(["0"]),
    singleWordOnly = true,
    minTotal = DEFAULT_FILTER_MIN_TOTAL, // 10
    confidenceSplit = SURE_TOP_SHARE,    // 0.75
    maxExamples = 25,
    maxAlternativesShown = 6,
  } = opts;

  const isSingleWord = (s) => !/\s/.test((s || "").trim());

  const src2tgt = new Map();

  for (const p of phrasesArray || []) {
    const dir = String(p.direction ?? "0");
    if (directions && !directions.has(dir)) continue;

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

  const sure = [];
  const dubious = [];

  let belowMinTotal = 0;

  for (const [src, tgtMap] of src2tgt.entries()) {
    const entries = Array.from(tgtMap.entries()).sort((a, b) => b[1] - a[1]);
    if (!entries.length) continue;

    const total = entries.reduce((acc, [, c]) => acc + c, 0);
    if (total < minTotal) {
      belowMinTotal++;
      continue;
    }

    const [topTgt, topCount] = entries[0];
    const topShare = total ? (topCount / total) : 0;

    const record = {
      src,
      topTgt,
      topCount,
      topShare,  // confidence
      total,
      numTranslations: entries.length,
      topAll: entries.slice(0, maxAlternativesShown),
      alternatives: entries.slice(1, 1 + maxAlternativesShown),
    };

    if (topShare >= confidenceSplit) sure.push(record);
    else dubious.push(record);
  }

  sure.sort((a, b) => b.total - a.total);
  dubious.sort((a, b) => b.total - a.total);

  const classifiedTotal = sure.length + dubious.length;

  return {
    params: {
      directions: Array.from(directions || []),
      singleWordOnly,
      minTotal,
      confidenceSplit,
      maxExamples,
      maxAlternativesShown,
    },
    counts: {
      unique_src_considered: src2tgt.size,
      below_minTotal: belowMinTotal,
      classified_total: classifiedTotal,
      sure_found: sure.length,
      dubious_found: dubious.length,
    },
    sure_examples: sure.slice(0, maxExamples),
    dubious_examples: dubious.slice(0, maxExamples),
  };
}

function consistencyReportToText(report) {
  const fmtPct = (x) => `${(x * 100).toFixed(1)}%`;
  const extra = report.extra || {};
  const params = report.params || {};
  const counts = report.counts || {};

  const totalSrc = Number(counts.unique_src_considered ?? 0);
  const excludedSrc = Number(counts.below_minTotal ?? 0);
  const classifiedSrc = Number(counts.classified_total ?? 0);
  const consistentSrc = Number(counts.sure_found ?? 0);
  const dubiousSrc = Number(counts.dubious_found ?? 0);

  const totalPairs = Number(extra.total_phrase_pairs_extracted ?? 0);
  const formAligned = Number(extra.form_aligned_candidates ?? 0);
  const dictionaryAligned = Number(extra.dictionary_candidates ?? 0);

  const worstExamples = [...(report.dubious_examples || [])]
    .sort((a, b) =>
      a.topShare - b.topShare ||
      b.total - a.total ||
      b.numTranslations - a.numTranslations
    )
    .slice(0, params.maxExamples || 15);

  const mostFrequentConsistent = [...(report.sure_examples || [])]
    .sort((a, b) => b.total - a.total || b.topShare - a.topShare)
    .slice(0, params.maxExamples || 15);

  const topList = (items) =>
    (items || []).slice(0, params.maxAlternativesShown || 6)
      .map(([tgt, count]) => `${tgt}(${count})`)
      .join(", ");

  const lines = [];
  lines.push("TRANSLATION CONSISTENCY OVERVIEW");
  lines.push("");
  lines.push("OVERVIEW");
  lines.push(`- source words considered: ${totalSrc.toLocaleString()}`);
  lines.push(`- classified (>= ${params.minTotal ?? DEFAULT_FILTER_MIN_TOTAL} occurrences): ${classifiedSrc.toLocaleString()}`);
  lines.push(`- consistent: ${consistentSrc.toLocaleString()}`);
  lines.push(`- dubious: ${dubiousSrc.toLocaleString()}`);
  lines.push(`- below minimum occurrences: ${excludedSrc.toLocaleString()}`);
  lines.push(`- potentially to review: ${(dubiousSrc + excludedSrc).toLocaleString()}`);
  lines.push(`- extracted phrase pairs: ${totalPairs.toLocaleString()}`);
  lines.push("");
  lines.push("HIDDEN-PHRASE CANDIDATES");
  lines.push(`- due to form alignment: ${formAligned.toLocaleString()}`);
  lines.push(`- due to dictionary: ${dictionaryAligned.toLocaleString()}`);
  lines.push("");

  lines.push("WORST CONSISTENCY EXAMPLES");
  if (!worstExamples.length) {
    lines.push("(none)");
  } else {
    worstExamples.forEach((r, idx) => {
      lines.push(
        `${idx + 1}. ${r.src} → ${r.topTgt} | conf=${fmtPct(r.topShare)} | total=${r.total} | variants=${r.numTranslations}` +
        (r.topAll?.length ? ` | top: ${topList(r.topAll)}` : "")
      );
    });
  }
  lines.push("");

  lines.push("MOST FREQUENT CONSISTENT EXAMPLES");
  if (!mostFrequentConsistent.length) {
    lines.push("(none)");
  } else {
    mostFrequentConsistent.forEach((r, idx) => {
      lines.push(
        `${idx + 1}. ${r.src} → ${r.topTgt} | conf=${fmtPct(r.topShare)} | total=${r.total} | variants=${r.numTranslations}` +
        (r.topAll?.length ? ` | top: ${topList(r.topAll)}` : "")
      );
    });
  }
  lines.push("");

  lines.push("PARAMETERS");
  lines.push(`- directions: ${JSON.stringify(params.directions || [])}`);
  lines.push(`- single-word only: ${params.singleWordOnly ?? true}`);
  lines.push(`- minimum occurrences: ${params.minTotal ?? DEFAULT_FILTER_MIN_TOTAL}`);
  lines.push(`- consistency threshold: ${params.confidenceSplit ?? SURE_TOP_SHARE}`);
  lines.push(`- max examples shown: ${params.maxExamples ?? 25}`);
  lines.push(`- max alternatives shown: ${params.maxAlternativesShown ?? 6}`);
  lines.push("");

  return lines.join("\n");
}

function trimPhrase(phrase) {
  // trim #NB at start and end of phrases
  return phrase.replace(/^#NB\s+/, '').replace(/\s+#NB$/, '');
}

function _rowCollectionToSet(rows) {
  if (rows instanceof Set) return new Set(rows);
  if (Array.isArray(rows)) return new Set(rows);
  return new Set();
}

function _rowCollectionSize(rows) {
  return _rowCollectionToSet(rows).size;
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
          rows: new Set()
        };
      }
      const rid = parseInt(row_id, 10);
      if (!Number.isNaN(rid)) occurrences[key].rows.add(rid);
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

      const srcIds = _rowCollectionToSet(srcObj.rows);
      const tgtIds = _rowCollectionToSet(tgtObj.rows);

      const commonIds = new Set([...srcIds].filter(id => tgtIds.has(id)));

      if (commonIds.size > 0) {
        common[key] = { rows: commonIds };

        srcObj.rows = new Set([...srcIds].filter(id => !commonIds.has(id)));
        tgtObj.rows = new Set([...tgtIds].filter(id => !commonIds.has(id)));

        srcObj.count = srcObj.rows.size;
        tgtObj.count = tgtObj.rows.size;
      } else {
        common[key] = { rows: new Set() };
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
        const incomingRows = _rowCollectionToSet(value.rows);
        if (occurrences.has(key)) {
          const currentValue = occurrences.get(key);
          currentValue.rows = new Set([
            ..._rowCollectionToSet(currentValue.rows),
            ...incomingRows,
          ]);
        } else {
          occurrences.set(key, { ...value, rows: incomingRows });
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
              const row_ids = Array.from(_rowCollectionToSet(value.rows)).map(id => id + start);

              if (occurrences.has(key)) {
                const currentValue = occurrences.get(key);
                currentValue.rows = new Set([
                  ..._rowCollectionToSet(currentValue.rows),
                  ...row_ids,
                ]);
                mergedCount++;
              } else {
                occurrences.set(key, { ...value, rows: new Set(row_ids)});
                newCount++;
              }
            }

            // If we still exceed the hard limit, use a bucketed approach to remove low/high counts
            // Build count buckets so we can delete only the keys that fall into a given count
            if (occurrences.size > max_phrases) {
              const countBuckets = new Map(); // count -> Set(keys)
              for (const [key, value] of occurrences.entries()) {
                const c = _rowCollectionSize(value.rows);
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
      const count = _rowCollectionSize(value.rows);
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
        num_occurrences: _rowCollectionSize(value.rows),
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


    //const numCores = parseInt(document.getElementById("num-cores-input")?.value) || window.navigator.hardwareConcurrency || 1;
    const numCores = parseInt(document.getElementById("num-cores-input")?.value, 10) || 4;

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
        
        // --- Form-aligned candidates (DO NOT auto-hide; just compute + cache for download) ---
        try {
          const morphRes = await _autoAddMorphHiddenPhrases(project_id, phrases, pyodide, {
            allowedDirections: new Set(["0"]),
            singleTokenOnly: true,
            maxExamplePairs: 20,
            doImport: false, // ✅ important
          });

          cacheFormAlignedCandidates(project_id, {
            pairs: morphRes.pairs,
            examples: morphRes.examples,
            params: morphRes.params
          });

          stats_obj.form_aligned_candidates = morphRes.found;
          stats_obj.form_aligned_examples = morphRes.examples;

          console.log(`ℹ️ Form-aligned candidates (not hidden automatically): ${morphRes.found.toLocaleString()}`);
        } catch (e) {
          console.warn("⚠️ Morph form-alignment scan failed (continuing):", e);
        }

        try {
          const dictRes = await _autoAddDictionaryHiddenPhrases(project_id, phrases, pyodide, {
            allowedDirections: new Set(["0"]),
            singleTokenOnly: true,
            maxExamplePairs: 20,
            doImport: false,
          });

          cacheDictionaryHiddenCandidates(project_id, {
            pairs: dictRes.pairs,
            examples: dictRes.examples,
            params: dictRes.params
          });

          stats_obj.dictionary_candidates = dictRes.found;
          stats_obj.dictionary_examples = dictRes.examples;

          console.log(`ℹ️ Dictionary-based hidden candidates (not hidden automatically): ${dictRes.found.toLocaleString()}`);
        } catch (e) {
          console.warn("⚠️ Dictionary scan failed (continuing):", e);
        }

        cacheConsistencyReport(project_id, phrases, {
          // overall phrase pairs currently in memory (after extraction filters)
          total_phrase_pairs_extracted: Array.isArray(phrases) ? phrases.length : 0,

          form_aligned_candidates: stats_obj.form_aligned_candidates ?? 0,
          form_aligned_examples: stats_obj.form_aligned_examples ?? [],
          dictionary_candidates: stats_obj.dictionary_candidates ?? 0,
          dictionary_examples: stats_obj.dictionary_examples ?? [],
        });

        await _buildPhraseOverviewRowsFromExtracted(project_id, phrases);

    } catch (err) {
        console.error('❌ Critical error during phrase processing:', err.message || err);
        throw err;
    }
    
    await safeSyncfs(pyodide);
    return stats_obj;
}



function _normalizeDirectionsForOverview(directions) {
  if (directions instanceof Set) return directions;
  if (Array.isArray(directions)) return new Set(directions.map(String));
  return new Set(["0"]);
}

function _getVariantShareForSuspicion(variant, total) {
  if (!variant) return 0;
  const share = Number(variant.share);
  if (Number.isFinite(share) && share >= 0) return share;
  const count = Number(variant.count || 0);
  return total > 0 ? (count / total) : 0;
}

function _getSuspicionMeta(row) {
  const total = Number(row.num_occurrences || row.total || 0);
  const topShare = Number(row.top_share || 0);
  const numTgts = Number(row.num_tgts || 0);
  const topk = Array.isArray(row.topk) ? row.topk : [];
  const secondShare = _getVariantShareForSuspicion(topk[1], total);
  const gap = Math.max(0, topShare - secondShare);
  const unalignedShare = Number(row.unaligned_share || 0);
  const reasons = [];
  let score = 0;

  if (total >= 10 && topShare < SURE_TOP_SHARE) {
    reasons.push('low consistency');
    score += 3;
  }

  if (total >= 10 && numTgts >= 4) {
    reasons.push('many variants');
    score += 2;
  }
  if (total >= 10 && unalignedShare >= 0.20) {
    reasons.push('high unaligned share');
    score += 2;
  }

  return {
    suspicious: reasons.length > 0,
    suspicious_score: score,
    suspicious_reasons: reasons,
    top2_share: secondShare,
    top2_gap: gap,
  };
}


function _buildPhraseOverviewRowsFromStoredPairs(projectId, rawRows) {
  const grouped = new Map();

  for (const row of Array.isArray(rawRows) ? rawRows : []) {
    const src_phrase = String(row?.src_phrase || row?.src || '').trim();
    const tgt_phrase = String(row?.tgt_phrase || row?.tgt || '').trim();
    const direction = String(row?.direction ?? "0");
    const count = Number(row?.num_occurrences ?? row?.count ?? 0);

    if (!src_phrase || !tgt_phrase || count <= 0) continue;

    const key = `${direction}|||${src_phrase}`;
    let bucket = grouped.get(key);
    if (!bucket) {
      bucket = {
        src_phrase,
        direction,
        variants: new Map(),
      };
      grouped.set(key, bucket);
    }

    bucket.variants.set(
      tgt_phrase,
      Number(bucket.variants.get(tgt_phrase) || 0) + count
    );
  }

  const formSet = _setFromPairs((getCachedFormAlignedCandidates(projectId)?.pairs || []).filter(p => p?.src && p?.tgt));
  const dictionarySet = _setFromPairs((getCachedDictionaryHiddenCandidates(projectId)?.pairs || []).filter(p => p?.src && p?.tgt));

  const rows = [];
  for (const bucket of grouped.values()) {
    const entries = [...bucket.variants.entries()]
      .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0) || String(a[0]).localeCompare(String(b[0])));

    if (!entries.length) continue;

    const total = entries.reduce((acc, [, c]) => acc + Number(c || 0), 0);
    const [topTgt, topCount] = entries[0];
    const topk = entries.map(([tgt, count]) => ({
      tgt,
      count: Number(count || 0),
      share: total ? Number(count || 0) / total : 0,
    }));

    const key = `${bucket.src_phrase}${topTgt}`;
    const topShare = total ? Number(topCount || 0) / total : 0;

    rows.push({
      id: `${bucket.direction}|||${bucket.src_phrase}|||${topTgt}`,
      src_phrase: bucket.src_phrase,
      tgt_phrase: topTgt,
      top_tgt: topTgt,
      direction: bucket.direction,
      num_occurrences: total,
      total,
      top_share: topShare,
      top_count: Number(topCount || 0),
      num_tgts: entries.length,
      entropy: _entropyFromCounts(entries.map(([, c]) => Number(c || 0))),
      topk,
      hidden_by_consistency:
        _isSingleToken(bucket.src_phrase) &&
        total >= DEFAULT_FILTER_MIN_TOTAL &&
        topShare >= SURE_TOP_SHARE,
      hidden_by_form: formSet.has(key),
      hidden_by_dictionary: dictionarySet.has(key),
    });
  }

  return rows;
}

async function _buildPhraseOverviewFallbackRows(projectId, rawRows) {
  let rows = _buildPhraseOverviewRowsFromStoredPairs(projectId, rawRows);
  rows = await _augmentRowsWithUnaligned(projectId, rows);
  rows = rows.map((row) => ({
    ...row,
    ..._getSuspicionMeta(row),
  }));
  cachePhraseOverviewRows(projectId, rows);
  return rows;
}

function _sortPhraseOverviewRows(rows, sortMode = "frequency") {
  const out = [...rows];
  if (sortMode === "worst_consistency") {
    out.sort((a, b) =>
      Number(a.top_share) - Number(b.top_share) ||
      Number(b.num_occurrences) - Number(a.num_occurrences) ||
      Number(b.num_tgts) - Number(a.num_tgts) ||
      String(a.src_phrase).localeCompare(String(b.src_phrase))
    );
    return out;
  }

  if (sortMode === "suspicious") {
    out.sort((a, b) =>
      Number(Boolean(b.suspicious)) - Number(Boolean(a.suspicious)) ||
      Number(b.suspicious_score || 0) - Number(a.suspicious_score || 0) ||
      Number(a.top_share) - Number(b.top_share) ||
      Number(b.num_occurrences) - Number(a.num_occurrences) ||
      Number(b.num_tgts) - Number(a.num_tgts) ||
      String(a.src_phrase).localeCompare(String(b.src_phrase))
    );
    return out;
  }

  out.sort((a, b) =>
    Number(b.num_occurrences) - Number(a.num_occurrences) ||
    Number(a.top_share) - Number(b.top_share) ||
    String(a.src_phrase).localeCompare(String(b.src_phrase))
  );
  return out;
}

async function _buildPhraseOverviewRowsFromExtracted(projectId, phrases) {
  const base = buildBasePhraseTableForDownloads(phrases, { minTotal: 1, topK: 1000 });

  const consistency = _buildConsistencyHiddenCandidatesFromCachedPhrases(projectId, {
    directions: new Set(["0"]),
    singleTokenOnly: true,
    minTotal: DEFAULT_FILTER_MIN_TOTAL,
    confidenceSplit: SURE_TOP_SHARE,
  });

  const consistencySet = _setFromPairs(consistency.pairs || []);
  const formSet = _setFromPairs((getCachedFormAlignedCandidates(projectId)?.pairs || []).filter(p => p?.src && p?.tgt));
  const dictionarySet = _setFromPairs((getCachedDictionaryHiddenCandidates(projectId)?.pairs || []).filter(p => p?.src && p?.tgt));

  let rows = (base.rows || []).map((r) => {
    const src_phrase = (r.src || "").trim();
    const tgt_phrase = (r.top_tgt || "").trim();
    const key = `${src_phrase}${tgt_phrase}`;
    return {
      id: `${String(r.direction ?? "0")}|||${src_phrase}|||${tgt_phrase}`,
      src_phrase,
      tgt_phrase,
      direction: String(r.direction ?? "0"),
      num_occurrences: Number(r.total || 0),
      top_share: Number(r.top_share || 0),
      top_count: Number(r.top_count || 0),
      num_tgts: Number(r.num_tgts || 0),
      entropy: Number(r.entropy || 0),
      topk: r.topk || [],
      hidden_by_consistency: consistencySet.has(key),
      hidden_by_form: formSet.has(key),
      hidden_by_dictionary: dictionarySet.has(key),
    };
  });

  rows = await _augmentRowsWithUnaligned(projectId, rows);
  rows = rows.map((row) => ({
    ...row,
    ..._getSuspicionMeta(row),
  }));

  cachePhraseOverviewRows(projectId, rows);
  return rows;
}

export async function fetchPhraseOverview(data) {
  const phrases = getCachedExtractedPhrases(data.project_id);

  const directions = _normalizeDirectionsForOverview(data.directions);
  const singleTokenOnly = data.singleTokenOnly !== false;
  const minTotal = Math.max(1, Number(data.minTotal || 1));
  const hideConsistency = data.hideConsistency === true;
  const hideFormAligned = data.hideFormAligned === true;
  const hideDictionary = data.hideDictionary === true;
  const suspiciousOnly = data.suspiciousOnly === true;
  const sortMode = data.sortMode || "frequency";
  const searchValue = String(data.search?.value || "").trim().toLowerCase();

  let rows = null;
  if (phrases) {
    rows = await _buildPhraseOverviewRowsFromExtracted(data.project_id, phrases);
  } else {
    rows = getCachedPhraseOverviewRows(data.project_id);
    if (!rows) {
      console.warn("Phrase overview rebuilding from stored phrase pairs because no cached extraction or overview is available.");
      const fallbackRaw = await fetchPhrases({
        ...data,
        start: 0,
        length: 1000000,
      });
      rows = await _buildPhraseOverviewFallbackRows(data.project_id, fallbackRaw?.data || []);
    }
  }

  rows = await _augmentRowsWithUnaligned(data.project_id, rows);
  rows = rows.map((row) => ({
    ...row,
    ..._getSuspicionMeta(row),
  }));

  rows = [...rows]
    .filter((r) => directions.has(String(r.direction ?? "0")))
    .filter((r) => Number(r.num_occurrences || 0) >= minTotal)
    .filter((r) => !singleTokenOnly || _isSingleToken(r.src_phrase || r.src));

  const recordsTotal = rows.length;

  if (hideConsistency) rows = rows.filter((r) => !r.hidden_by_consistency);
  if (hideFormAligned) rows = rows.filter((r) => !r.hidden_by_form);
  if (hideDictionary) rows = rows.filter((r) => !r.hidden_by_dictionary);
  if (suspiciousOnly) rows = rows.filter((r) => r.suspicious);

  if (searchValue) {
    rows = rows.filter((r) =>
      String(r.src_phrase).toLowerCase().includes(searchValue) ||
      String(r.tgt_phrase).toLowerCase().includes(searchValue)
    );
  }

  rows = _sortPhraseOverviewRows(rows, sortMode);

  const recordsFiltered = rows.length;
  const start = Math.max(0, Number(data.start || 0));
  const length = Math.max(1, Number(data.length || rows.length || 10));

  return {
    draw: data.draw,
    recordsTotal,
    recordsFiltered,
    data: rows.slice(start, start + length),
  };
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


export async function ignorePhrasePair(project_id, src_phrase, tgt_phrase) {
  const payload = JSON.stringify([{ src: src_phrase, tgt: tgt_phrase }], null, 2);
  await importIgnoredFromFile(project_id, payload);
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

}

export function downloadPhrasesExcludingReport(project_id, opts = {}) {
  const ts = new Date().toISOString().replace(/[:]/g, "-");

  // 1) Translation overview text (cached from last extraction)
  const overviewText =
    localStorage.getItem(CONSISTENCY_CACHE_KEY_TEXT(project_id)) || localStorage.getItem(ROBUSTNESS_CACHE_KEY_TEXT(project_id)) ||
    `No translation overview cached for project ${project_id}.\nRun "Extract phrases" first.\n`;

  // 2) Hidden-selection report (robust + form-aligned)
  //    (does NOT download anything, just returns text)
  let hiddenSelectionText = "";
  try {
    const { reportText } = buildHiddenPhraseArtifacts(project_id, {
      includeConsistency: opts.includeConsistency !== false,
      includeFormAligned: opts.includeFormAligned !== false,
      includeDictionary: opts.includeDictionary !== false,
      consistencyDirections: opts.directions || new Set(["0"]),
      consistencySingleTokenOnly: false,
      consistencyMinTotal: DEFAULT_FILTER_MIN_TOTAL,
      consistencyConfidenceSplit: SURE_TOP_SHARE,
      maxExamplesPerGroup: 12,
    });
    hiddenSelectionText = reportText;
  } catch (e) {
    hiddenSelectionText =
      `\n\n(Hidden-selection report unavailable: ${e?.message || e})\n`;
  }

  const combined =
    `${overviewText}\n` +
    `\n================================================================\n\n` +
    `${hiddenSelectionText}\n`;

  downloadTextFile(`excluding_report_project_${project_id}_${ts}.txt`, combined);
}



