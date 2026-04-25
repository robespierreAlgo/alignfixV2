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

import {
  extractPhrases,
  fetchPhraseOverview,
  fetchIgnoredPhrases,
  setIgnorePhrase,
  importIgnoredFromFile,
  ignorePhrasePair,
  downloadIgnoredPhrases,
  downloadPhrases,
  deleteAllIgnoredPhrases,
  downloadPhraseTranslationTableCSV,
  downloadPhraseTranslationTableJSON,
  downloadSurePhraseTableCSV,
  downloadDubiousPhraseTableCSV,
  downloadSurePhraseTableJSON,
  downloadDubiousPhraseTableJSON,
  downloadSurePhrasesAsHiddenJSON,
  downloadPhrasesExcludingReport
} from "../backend/js/phrases.js";
import { fetchTranslations, storeTranslation, deleteTranslation } from "../backend/js/alignments.js";
import { applyFixes } from "../backend/js/fixes.js";
import { getProject, saveProject, downloadProject, mergeProjectStats } from "../backend/js/projects.js";
import { recomputeAlignments } from "../backend/js/aligner.js";
import { bindAsyncButton } from "./utils.js";
import { profiler } from "./profiler.js";

let fixes = [];  // global list of fixes
let ignored = [];

const UNALIGNED_SENTINEL = "__ALIGNFIX_UNALIGNED__";

function getDirectionSymbol(direction) {
  switch (String(direction)) {
    case '1':
      return '→';
    case '-1':
      return '←';
    default:
      return '↔';
  }
}

function escapeForHtmlAttr(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r?\n/g, '\\n');
}

function formatPct(val) {
  const num = Number(val);
  return Number.isFinite(num) ? `${(num * 100).toFixed(1)}%` : '—';
}

function normalizePhraseDisplay(text) {
  if (text == null) return '';
  return String(text)
    .replace(/\s*#NB\s*/g, '')
    .replace(/\s*(["'’`])\s*/g, '$1')
    .replace(/\s+([,.;:!?%\]\)])/g, '$1')
    .replace(/([\[\(¿¡«])\s+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeVisibleHtml(html) {
  if (html == null) return '';
  return String(html)
    .replace(/\s*#NB\s*/g, '')
    .replace(/\s*(["'’`])\s*/g, '$1')
    .replace(/\s+([,.;:!?%\]\)])/g, '$1')
    .replace(/([\[\(¿¡«])\s+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function renderVariantPanel(row) {
  const rawTopk = Array.isArray(row.topk) ? row.topk : [];
  const topk = rawTopk.map(v => ({ ...v }));
  const srcPretty = normalizePhraseDisplay(row.src_phrase);

  const hasExplicitUnaligned = topk.some(v => String(v?.tgt || '').trim() === UNALIGNED_SENTINEL);
  const unalignedCount = Number(row?.unaligned_count || 0);
  if (unalignedCount > 0 && !hasExplicitUnaligned) {
    topk.push({
      tgt: UNALIGNED_SENTINEL,
      count: unalignedCount,
      share: Number(row?.unaligned_share || 0),
      is_unaligned: true,
    });
  }

  const alignedVariantsShown = topk.filter(v => String(v?.tgt || '').trim() !== UNALIGNED_SENTINEL && !v?.is_unaligned).length;
  const totalVariants = Number.isFinite(Number(row.num_tgts)) ? Number(row.num_tgts) : alignedVariantsShown;
  const hasUnaligned = topk.some(v => String(v?.tgt || '').trim() === UNALIGNED_SENTINEL || v?.is_unaligned);
  const canOpenPanel = topk.length > 0 && (totalVariants > 1 || hasUnaligned);

  if (!topk.length) {
    return `<span>variants: <strong>${totalVariants}</strong></span>`;
  }

  if (!canOpenPanel) {
    return `<span>variants: <strong>${totalVariants || 1}</strong></span>`;
  }

  const variantButtons = topk.map((variant, idx) => {
    const rawTgt = String(variant?.tgt || '').trim();
    const isUnaligned = rawTgt === UNALIGNED_SENTINEL || variant?.is_unaligned;
    const tgtPretty = isUnaligned ? 'unaligned' : normalizePhraseDisplay(rawTgt);
    const count = Number(variant?.count || 0);
    const share = formatPct(variant?.share || 0);
    const btnClass = idx === 0 ? 'btn-outline-primary' : 'btn-outline-secondary';
    const titleTail = isUnaligned
      ? `${escapeForHtmlAttr(srcPretty)} ${getDirectionSymbol(row.direction)} ∅`
      : `${escapeForHtmlAttr(srcPretty)} ${getDirectionSymbol(row.direction)} ${escapeForHtmlAttr(tgtPretty)}`;

    return `<button
      type="button"
      class="btn btn-sm ${btnClass} show-variant-btn"
      data-src="${escapeForHtmlAttr(row.src_phrase)}"
      data-tgt="${escapeForHtmlAttr(isUnaligned ? '' : rawTgt)}"
      data-direction="${escapeForHtmlAttr(row.direction)}"
      data-unaligned="${isUnaligned ? '1' : '0'}"
      title="Show sentence pairs for ${titleTail}"
    >${escapeForHtmlAttr(tgtPretty)} <span class="text-muted">(${count}, ${share})</span></button>`;
  }).join(' ');

  return `
    <button type="button" class="btn btn-sm btn-link p-0 align-baseline toggle-variants-btn text-decoration-none">
      <span class="text-body-secondary">variants:</span> <strong>${totalVariants}</strong>
    </button>
    <div class="variant-list-panel d-none mt-2 border rounded p-2 bg-light-subtle">
      <div class="small fw-semibold mb-2">Variants for <span class="text-body">${escapeForHtmlAttr(srcPretty)}</span></div>
      <div class="d-flex flex-wrap gap-2">${variantButtons}</div>
    </div>
  `;
}

function renderSuspicionSummary(row) {
  if (!row?.suspicious) return '';

  const reasons = Array.isArray(row.suspicious_reasons) ? row.suspicious_reasons.filter(Boolean) : [];
  const reasonsText = reasons.join(' · ');

  return `
    <div class="small mt-1">
      <span class="badge text-bg-warning" title="${escapeForHtmlAttr(reasonsText)}">
        <i class="fas fa-triangle-exclamation me-1"></i>Suspicious
      </span>
    </div>
  `;
}

function renderPhraseOverviewCell(row) {
  const confPct = formatPct(row.top_share);
  const variantsHtml = renderVariantPanel(row);
  const srcPretty = normalizePhraseDisplay(row.src_phrase);
  const tgtPretty = normalizePhraseDisplay(row.tgt_phrase);
  const suspicionHtml = renderSuspicionSummary(row);
  const pairCount = Number.isFinite(Number(row.num_occurrences)) ? Number(row.num_occurrences) : Number(row.top_count || 0);
  const totalCount = Number.isFinite(Number(row.num_occurrences)) ? Number(row.num_occurrences) : pairCount;

  return `
    <div class="phrase-overview-cell">
      <button
        class="btn btn-sm btn-outline show-phrases-btn"
        data-src="${escapeForHtmlAttr(row.src_phrase)}"
        data-tgt="${escapeForHtmlAttr(row.tgt_phrase)}"
        data-direction="${row.direction}"
        title="Show all matching sentence pairs for this source phrase (${pairCount} sentence pair${pairCount === 1 ? '' : 's'})"
      >
        <i class="fas fa-search"></i> ${pairCount}
      </button>
      <button class="btn btn-sm btn-clear show-src-phrase-btn" data-text="${escapeForHtmlAttr(row.src_phrase)}">${escapeForHtmlAttr(srcPretty)}</button>${getDirectionSymbol(row.direction)}<button class="btn btn-sm btn-clear search-tgt-phrase-btn" data-text="${escapeForHtmlAttr(row.tgt_phrase)}">${escapeForHtmlAttr(tgtPretty)}</button>
      <div class="small text-muted mt-1">
        consistency: <strong>${confPct}</strong> · total: <strong>${totalCount}</strong> · ${variantsHtml}
      </div>
      ${suspicionHtml}
    </div>
  `;
}

function closeVariantPanels(exceptPanel = null) {
  document.querySelectorAll('.variant-list-panel').forEach(panel => {
    if (panel !== exceptPanel) panel.classList.add('d-none');
  });
}

function markActiveVariantButton(activeButton) {
  document.querySelectorAll('.show-variant-btn').forEach(btn => {
    btn.classList.remove('btn-primary');
    if (!btn.classList.contains('btn-outline-primary') && !btn.classList.contains('btn-outline-secondary')) {
      btn.classList.add('btn-outline-secondary');
    }
  });

  if (!activeButton) return;
  activeButton.classList.remove('btn-outline-primary', 'btn-outline-secondary');
  activeButton.classList.add('btn-primary');
}

function debounce(fn, wait = 80) {
  let timeoutId = null;
  return (...args) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), wait);
  };
}

export async function renderProject(id) {
  const app = document.getElementById("app");

  const project = await getProject(id);
  const numCores = Math.min(4, navigator.hardwareConcurrency || 4);

  app.innerHTML = `
  <div class="d-flex flex-column flex-md-row align-items-start align-items-md-center justify-content-between mb-2">
    
    <!-- Title + Input -->
    <h1 class="mb-2 mb-md-0 d-flex align-items-center flex-grow-1">
      <a href="#home"></a>
      <input type="text" class="form-control" id="document_name" placeholder="Document Name" value="${project.name}" >
    </h1>

    <!-- Buttons -->
    <div class="d-flex flex-wrap gap-2 mt-2 mt-md-0">
      <button id="store-btn" class="btn btn-primary">
        <i class="fas fa-save"></i> Save
      </button>
      <button id="apply-fixes-btn" class="btn btn-success">
        <i class="fas fa-wrench"></i> Apply Fixes
      </button>
      <button id="download-btn" class="btn btn-secondary">
        <i class="fas fa-download"></i> Download
      </button>
    </div>
  </div>
  <div class="row">
    <div class="col-12 col-md-6 col-lg-4">
      <table id="phrases-table" class="display" style="width:100%">
        <thead>
          <tr>
            <th></th>
            <th></th>
          </tr>
        </thead>
      </table>
      <div class="mt-2">
        <button id="download-phrases-btn" class="btn btn-sm btn-secondary">
          <i class="fas fa-download"></i> Download Phrases
        </button>
        <button id="download-excluding-btn" class="btn btn-outline-secondary btn-sm">
          Download Excluding Report
        </button>
        <button id="download-phrase-table-csv-btn" class="btn btn-outline-secondary btn-sm">
          Download Phrase Table (CSV)
        </button>
        <button id="download-phrase-table-json-btn" class="btn btn-outline-secondary btn-sm">
          Download Phrase Table (JSON)
        </button>
        <button id="download-sure-phrases-btn" class="btn btn-outline-secondary btn-sm">
          Download Sure Phrases (CSV)
        </button>
        <button id="download-dubious-phrases-btn" class="btn btn-outline-secondary btn-sm">
          Download Dubious Phrases (CSV)
        </button>
        <button id="download-sure-phrases-json-btn" class="btn btn-outline-secondary btn-sm">
          Download Sure Phrases (JSON)
        </button>
        <button id="download-dubious-phrases-json-btn" class="btn btn-outline-secondary btn-sm">
          Download Dubious Phrases (JSON)
        </button>
        <button id="download-sure-hidden-btn" class="btn btn-warning btn-sm" title="Export selected categories as uploadable Hidden phrases JSON">
          <i class="fas fa-eye-slash me-1"></i> Download hidden phrases JSON
        </button>
        <div class="mt-2 border rounded p-2 bg-light-subtle" id="hidden-export-toggles">
          <div class="small fw-bold mb-1">Overview filters and hidden export</div>
          <div class="form-check form-switch">
            <input class="form-check-input" type="checkbox" id="toggle-hidden-consistency" checked>
            <label class="form-check-label" for="toggle-hidden-consistency">Hide consistency-based pairs</label>
          </div>
          <div class="form-check form-switch">
            <input class="form-check-input" type="checkbox" id="toggle-hidden-form" checked>
            <label class="form-check-label" for="toggle-hidden-form">Hide form-aligned pairs</label>
          </div>
          <div class="form-check form-switch">
            <input class="form-check-input" type="checkbox" id="toggle-hidden-dictionary" checked>
            <label class="form-check-label" for="toggle-hidden-dictionary">Hide dictionary pairs</label>
          </div>
          <div class="mt-2">
            <label for="phrase-overview-order" class="form-label form-label-sm mb-1">Order words by</label>
            <select id="phrase-overview-order" class="form-select form-select-sm">
              <option value="frequency" selected>Most occurrences</option>
              <option value="worst_consistency">Worst consistency</option>
              <option value="suspicious">Most suspicious</option>
            </select>
          </div>
          <div class="form-check form-switch mt-2">
            <input class="form-check-input" type="checkbox" id="toggle-suspicious-only">
            <label class="form-check-label" for="toggle-suspicious-only">Show suspicious only</label>
          </div>
          <details class="mt-2 small">
            <summary class="text-primary" style="cursor:pointer; user-select:none;">How “suspicious” is defined</summary>
            <div class="text-muted mt-2">
              <div>&gt; Suspicious if one of these holds:</div>
              <div class="mt-1">• consistency &lt; 65% with 10+ occurrences</div>
              <div>• 4+ aligned variants with 10+ occurrences</div>
              <div>• two strong options with 10+ occurrences: the second shown is still frequent (20%+) and close to the best (gap 15 pts or less)</div>
            </div>
          </details>
          <button id="refresh-overview-btn" class="btn btn-outline-primary btn-sm mt-2">
            <i class="fas fa-rotate-right me-1"></i> Refresh overview
          </button>
        </div>
      </div>
      <!-- Fixes Preview -->
      <div class="card mt-3 shadow-sm">
        <div class="card-header bg-success text-white d-flex justify-content-between align-items-center">
          <h6 class="card-title mb-0">
            <i class="fas fa-tools me-2"></i>Pending Edits
          </h6>
          <div class="d-flex align-items-center gap-2">
            <span class="badge bg-light text-dark" id="fixes-count">0</span>
            <button class="btn btn-sm btn-outline-light" type="button" data-bs-toggle="collapse" 
                    data-bs-target="#fixes-upload-section" aria-expanded="false" 
                    aria-controls="fixes-upload-section" title="Import fixes">
              <i class="fas fa-upload"></i>
            </button>
          </div>
        </div>
        <div class="card-body p-0">
          <!-- Upload Section (Hidden by default) -->
          <div class="collapse" id="fixes-upload-section">
            <div class="p-3 border-bottom bg-light">
              <div class="mb-2">
                <label for="fixes-file-input" class="form-label small fw-bold">
                  <i class="fas fa-file-import me-1"></i>Import Fixes
                </label>
                <input class="form-control form-control-sm" type="file" id="fixes-file-input" 
                       name="file" accept=".json">
                <div class="form-text">Upload a JSON file with fix definitions</div>
              </div>
            </div>
          </div>
          
          <!-- Fixes List -->
          <div class="p-2" id="fixes-container" style="max-height: 200px; overflow-y: auto;">
            <div class="text-center text-muted py-3">
              <i class="fas fa-info-circle me-2"></i>No changes pefnding
            </div>
          </div>
        </div>
      </div>
      <div id="ignored-phrases" class="accordion my-4">
        <div class="accordion-item">
          <h2 class="accordion-header" id="headingTwo">
            <button class="accordion-button" type="button" data-bs-toggle="collapse" data-bs-target="#collapseTwo"
              aria-expanded="false" aria-controls="collapseTwo">
              Hidden phrases
            </button>
          </h2>
          <div id="collapseTwo" class="accordion-collapse collapse" aria-labelledby="headingTwo"
            data-bs-parent="#ignored-phrases">
            <div class="accordion-body">

              <div class="mb-3">
                <label for="ignored-file-input" class="form-label">Upload file</label>
                <input class="form-control" type="file" id="ignored-file-input" name="file">
              </div>

              <table id="ignored-table" class="table table-striped">
                <thead>
                  <tr>
                    <th>phrase</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  <!-- Dynamically populated list of fixes -->
                </tbody>
              </table>
              <!-- create button to download ignore -->
              <button id="download-ignored-btn" class="btn btn-secondary">Download</button>
              <!-- create button to delete all ignored phrases -->
              <button id="delete-ignored-btn" class="btn btn-danger ms-2">Delete All</button>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div class="col-12 col-md-6 col-lg-8">
      <table id="translations-table" class="display" style="width:100%">
        <thead>
          <tr>
            <th></th>
          </tr>
        </thead>
      </table>
    </div>
  </div>
  `;

  const sidebar = document.getElementById("sidebar-content");
  sidebar.innerHTML = `
    <div class="col-12">
      <form id="fix-form" class="row g-3 align-items-end">
        <div class="mb-2">
          <div class="form-floating">
            <input type="text" id="fix-test1" class="form-control" placeholder="Phrase 1">
            <label for="fix-test1">Phrase 1</label>
          </div>
        </div>
        <div class="mb-4">
          <div class="form-floating">
            <input type="text" id="fix-fix1" class="form-control" placeholder="Fix 1">
            <label for="fix-fix1">Fix 1</label>
          </div>
        </div>
        <div class="mb-2">
          <div class="form-floating">
            <input type="text" id="fix-test2" class="form-control" placeholder="Phrase 2">
            <label for="fix-test2">Phrase 2</label>
          </div>
        </div>
        <div class="mb-2">
          <div class="form-floating">
            <input type="text" id="fix-fix2" class="form-control" placeholder="Fix 2">
            <label for="fix-fix2">Fix 2</label>
          </div>
        </div>
        <div class="mb-2">
          <label for="fix-percentage" class="form-label">Percentage of words to fix 
            <span id="fix-percentage-value" class="badge bg-secondary ms-2">100%</span>
          </label>
          <input type="range" class="form-range" id="fix-percentage" min="0" max="100" value="100">
        </div>
        <input type="hidden" id="fix-direction" value="0">
        <div class="d-grid gap-2 mb-2">
          <div class="row g-2 mb-2">
            <div class="col-6">
              <button class="btn btn-success w-100" type="button" id="augment-btn">
                <i class="fas fa-clone"></i> Augment
              </button>
            </div>
            <div class="col-6">
              <button class="btn btn-primary w-100" type="button" id="add-fix-btn">
                <i class="fas fa-plus"></i> Add Fix
              </button>
            </div>
          </div>
          <div class="row g-2 mb-2">
            <div class="col-6">
              <button class="btn btn-outline w-100 mb-2" type="button" id="clear-search-btn">
                Clear Search
              </button>
            </div>
            <div class="col-6">
              <button class="btn btn-secondary w-100" type="button" id="search-phrases-btn">
                <i class="fas fa-search"></i> Search
              </button>
            </div>
          </div>
        </div>
      </form>
    </div>
    <hr/>
    <div class="col-12 mt-2">
      <form id="set-metadata-form">
        <div class="mb-2">
          <label for="threshold-input" class="form-label">
            Score Threshold
            <i class="fas fa-info-circle ms-1 text-muted" 
               data-bs-toggle="tooltip" 
               data-bs-placement="right"
               title="Only phrase pairs occuring *only* in entries with scores below the threshold are collected."></i>
          </label>
          <input type="number" class="form-control" id="threshold-input" min="0" max="10000" placeholder="threshold" value="${project.threshold}">
        </div>
        <div class="row mb-2">
          <div class="col-12">
            <label class="form-label">Min./Max. phrase length</label>
          </div>
          <div class="col-6">
            <input type="number" class="form-control" id="min-phrase-length-input" min="1" max="10" value="${project.min_phrase_len}">
          </div>
          <div class="col-6">
            <input type="number" class="form-control" id="max-phrase-length-input" min="1" max="10" value="${project.max_phrase_len}">
          </div>
        </div>
        <div class="row mb-2">
          <div class="col-12">
            <label class="form-label">Min./Max. occurrences</label>
          </div>
          <div class="col-6">
            <input type="number" class="form-control" id="min-occurrences-input" min="1" max="100" value="${project.min_count}">
          </div>
          <div class="col-6">
            <input type="number" class="form-control" id="max-occurrences-input" min="1" value="${project.max_count}">
          </div>
        </div>
        <div class="row mb-4">
          <div class="col-12">
            <label class="form-label">Num. cores / Max. Phrases</label>
          </div>
          <div class="col-6">
            <input type="number" class="form-control" id="num-cores-input" min="1" max="16" value="${numCores}">
          </div>
          <div class="col-6">
            <input type="number" class="form-control" id="max-phrases-input" max="40000000" value="${project.max_phrases}">
          </div>
        </div>
        <div class="d-grid gap-2 mb-2">
          <button class="btn btn-primary" type="button" id="threshold-btn-soft">
            <i class="fas fa-refresh"></i> Extract phrases
          </button>
          <button class="btn btn-warning" type="button" id="threshold-btn-hard">
            <i class="fas fa-arrows-left-right"></i> Realign sentences
          </button>
        </div>
      </form>
    </div>
    `;

  bindAsyncButton(
    document.getElementById("threshold-btn-soft"),
    async () => {
      profiler.clear();
      const extractStats = await profiler.measureAsync('extractPhrases', () => extractPhrases(id));
      profiler.data = { ...profiler.data, ...(extractStats || {}) };
      mergeProjectStats(id, profiler.data);
      $('#phrases-table').DataTable().ajax.reload();
    }
  );

  bindAsyncButton(
    document.getElementById("threshold-btn-hard"),
    async () => { 
      await recomputeAlignments(id);
      profiler.clear();
      const extractStats = await profiler.measureAsync('extractPhrases', () => extractPhrases(id));
      profiler.data = { ...profiler.data, ...(extractStats || {}) };
      mergeProjectStats(id, profiler.data);
      $('#phrases-table').DataTable().ajax.reload();
    }
  );

  bindAsyncButton(
    document.getElementById("store-btn"),
    () => saveProject(id)
  );

  // Update percentage display when slider value changes
  document.getElementById("fix-percentage").addEventListener("input", (event) => {
    document.getElementById("fix-percentage-value").textContent = `${event.target.value}%`;
  });

  // NOTE: don't use bindAsyncButton here (it awaits nextFrame and can break downloads)
  const rb = document.getElementById("download-excluding-btn");
  if (rb) {
    rb.addEventListener("click", () => downloadPhrasesExcludingReport(id, getHiddenExportOptions()));
  }

  // Downloads should be direct click handlers (no bindAsyncButton), so browsers allow them reliably.
  const csvBtn = document.getElementById("download-phrase-table-csv-btn");
  if (csvBtn) csvBtn.addEventListener("click", () => downloadPhraseTranslationTableCSV(id));

  const jsonBtn = document.getElementById("download-phrase-table-json-btn");
  if (jsonBtn) jsonBtn.addEventListener("click", () => downloadPhraseTranslationTableJSON(id));

  const sureBtn = document.getElementById("download-sure-phrases-btn");
  if (sureBtn) sureBtn.addEventListener("click", () => downloadSurePhraseTableCSV(id));

  const dubBtn = document.getElementById("download-dubious-phrases-btn");
  if (dubBtn) dubBtn.addEventListener("click", () => downloadDubiousPhraseTableCSV(id));

  const sureJsonBtn = document.getElementById("download-sure-phrases-json-btn");
  if (sureJsonBtn) sureJsonBtn.addEventListener("click", () => downloadSurePhraseTableJSON(id));

  const dubJsonBtn = document.getElementById("download-dubious-phrases-json-btn");
  if (dubJsonBtn) dubJsonBtn.addEventListener("click", () => downloadDubiousPhraseTableJSON(id));

  const sureHiddenBtn = document.getElementById("download-sure-hidden-btn");
  if (sureHiddenBtn) sureHiddenBtn.addEventListener("click", () => downloadSurePhrasesAsHiddenJSON(id, getHiddenExportOptions()));

  // Initialize Bootstrap tooltips
  const tooltipTriggerList = [].slice.call(document.querySelectorAll('[data-bs-toggle="tooltip"]'));
  tooltipTriggerList.forEach(function (tooltipTriggerEl) {
    new bootstrap.Tooltip(tooltipTriggerEl);
  });

  function getHiddenExportOptions() {
    return {
      includeConsistency: document.getElementById('toggle-hidden-consistency')?.checked ?? true,
      includeFormAligned: document.getElementById('toggle-hidden-form')?.checked ?? true,
      includeDictionary: document.getElementById('toggle-hidden-dictionary')?.checked ?? true,
      directions: new Set(['0']),
    };
  }

  function getPhraseOverviewOptions() {
    return {
      hideConsistency: document.getElementById('toggle-hidden-consistency')?.checked ?? true,
      hideFormAligned: document.getElementById('toggle-hidden-form')?.checked ?? true,
      hideDictionary: document.getElementById('toggle-hidden-dictionary')?.checked ?? true,
      suspiciousOnly: document.getElementById('toggle-suspicious-only')?.checked ?? false,
      sortMode: document.getElementById('phrase-overview-order')?.value || 'frequency',
      directions: new Set(['0']),
      minTotal: 1,
      singleTokenOnly: true,
    };
  }

  const refreshOverviewBtn = document.getElementById("refresh-overview-btn");
  const reloadPhraseOverview = () => {
    const table = $('#phrases-table').DataTable();
    if (table) table.ajax.reload(null, true);
  };
  const debouncedReloadPhraseOverview = debounce(reloadPhraseOverview, 80);

  if (refreshOverviewBtn) {
    refreshOverviewBtn.addEventListener("click", () => {
      reloadPhraseOverview();
    });
  }

  [
    'toggle-hidden-consistency',
    'toggle-hidden-form',
    'toggle-hidden-dictionary',
    'toggle-suspicious-only',
    'phrase-overview-order'
  ].forEach(controlId => {
    const control = document.getElementById(controlId);
    if (!control) return;
    control.addEventListener('change', () => {
      debouncedReloadPhraseOverview();
    });
  });

  function clearSearch() {
    $('#fix-test1').val('');
    $('#fix-fix1').val('');
    $('#fix-test2').val('');
    $('#fix-fix2').val('');
    $('#fix-direction').val('0');
    $('#fix-fix1').prop('disabled', false);
    $('#fix-fix2').prop('disabled', false);
    // reset to first page
    $('#translations-table').DataTable().page('first').draw('page');
  }

  document.getElementById("clear-search-btn").addEventListener("click", () => {
    clearSearch();
  });

  bindAsyncButton(
    document.getElementById("search-phrases-btn"),
    () => {
      const input = getPhraseInput();
      showTranslations(
        input.src_phrase, 
        input.tgt_phrase, 
        input.direction, 
        input.src_fix, 
        input.tgt_fix
      );
    },
    ""
  );

  function addChange(type) {
    const input = getPhraseInput();
    input.type = type;
    // if input already in fixes, do not add
    const exists = fixes.find(f => 
      f.src_phrase === input.src_phrase && 
      f.tgt_fix === input.tgt_fix && 
      f.direction === input.direction
    );
    if (exists) {
      // change fix1 and fix2 to new values
      exists.src_fix = input.src_fix;
      exists.tgt_fix = input.tgt_fix;
    } else {
      fixes.push(input);
    }

    showTranslations(
      input.src_phrase, 
      input.tgt_phrase, 
      input.direction, 
      input.src_fix, 
      input.tgt_fix
    );

    updateFixesList();
  }

  bindAsyncButton(
    document.getElementById("add-fix-btn"), 
    () => {
      addChange('fix');
    },
    ""
  );

  bindAsyncButton(
    document.getElementById("augment-btn"), 
    () => {
      addChange('augment');
    },
    ""
  );


  bindAsyncButton(
    document.getElementById("apply-fixes-btn"), 
    async () => {
      await applyFixes(id, fixes);
      fixes = [];
      clearSearch();
      updateFixesList();
      $('#phrases-table').DataTable().ajax.reload();
    }
  );

  bindAsyncButton(
    document.getElementById("download-btn"), 
    () => {
      downloadProject(id)
    }
  );

  bindAsyncButton(
    document.getElementById("download-ignored-btn"), 
    () => {
      downloadIgnoredPhrases(id)
    }
  );

  bindAsyncButton(
    document.getElementById("download-phrases-btn"), 
    () => {
      downloadPhrases(id)
    }
  );


  document.getElementById("fixes-file-input").addEventListener("change", function(event) {
    const file = event.target.files[0]; 
    if (file) {
      console.log("Selected file:", file.name);

      const reader = new FileReader();
      reader.onload = function(e) {
        const importedFixes = JSON.parse(e.target.result);

        if (!Array.isArray(importedFixes)) {
          console.error("File content must be a JSON array");
          return;
        }

        // Add each entry to the global fixes array
        importedFixes.forEach(entry => {
          fixes.push(entry);
        });

        updateFixesList();

      };
      reader.readAsText(file);
    }
  });
  
  document.getElementById("ignored-file-input").addEventListener("change", function(event) {
    const file = event.target.files[0]; 
    if (file) {
      console.log("Selected file:", file.name);

      const reader = new FileReader();
      reader.onload = function(e) {
        const content = e.target.result;
        importIgnoredFromFile(id, content);
        // reload ignored phrases table
        ignoredTable.ajax.reload();
      };
      reader.readAsText(file);
    }
  });

  // Initialize DataTable with POST-based server-side processing
  const translationsTable = $("#translations-table").DataTable({
    processing: true,      // show "Processing…" while loading
    serverSide: true,      // server handles paging/filtering/sorting
    deferRender: true,
    scroller: false,
    scrollY: 800,
    paging: true,
    pageLength: 20,
    autoWidth: false,  // let columns take natural width
    ajax: async function (d, callback) {
      d.phrase1 = $('#fix-test1').val();
      d.phrase2 = $('#fix-test2').val();
      d.fix1 = $('#fix-fix1').val();
      d.fix2 = $('#fix-fix2').val();
      d.direction = $('#fix-direction').val();
      d.project_id = id;  // add project ID to request data
      d.unaligned_only = $('#translations-table').data('unaligned-only') === true;
      d.all_occurrences = $('#translations-table').data('all-occurrences') === true;
      const result = await fetchTranslations(d);
      callback(result); // DataTable expects JSON in correct format
    },
    columns: [
      { data: null, render: (data, type, row) => `
        <div class="translation-row">
          <div contenteditable="true" class="mb-2" 
          style="word-wrap: break-word; white-space: pre-wrap;" 
          id="translation-src-${row.row_id}">${normalizeVisibleHtml(row.line1)}</div>
          <div contenteditable="true" style="word-wrap: break-word; white-space: pre-wrap;" id="translation-tgt-${row.row_id}">${normalizeVisibleHtml(row.line2)}</div>
          <div class="btn-group-horizontal ms-2 my-2">
            <button class="store-translation-btn btn btn-sm btn-outline-success" data-id="${row.row_id}">
              <i class="fas fa-save"></i>
            </button>
            <button class="remove-translation-btn btn btn-sm btn-outline-danger" data-id="${row.row_id}">
              <i class="fas fa-trash"></i>
            </button>
            <span class="mx-2 score">Score: ${row.score}</span>
          </div>
        </div>` }
    ]
  });
  
  // Attach handlers every time the table draws
  translationsTable.on('draw', () => {
    document.querySelectorAll('.store-translation-btn').forEach(btn => {
      const id = btn.dataset.id;
      bindAsyncButton(
        btn,
        () => storeTranslationBtn(id),
        ""
      );
    });
    document.querySelectorAll('.remove-translation-btn').forEach(btn => {
      const id = btn.dataset.id;
      bindAsyncButton(
        btn,
        () => removeTranslationBtn(id),
        ""
      );
    });
  });

  // Phrase overview table (client-side overview built from cached extraction results)
  const phrasesTable = $("#phrases-table").DataTable({
    processing: true,
    serverSide: true,
    autoWidth: false,
    pageLength: 6,
    scrollY: 400,
    scroller: true,
    lengthChange: false,
    ajax: function (d, callback) {
      const params = {
        ...d,
        project_id: id,
        min_phrase_len: $("#min-phrase-length-input").val(),
        ...getPhraseOverviewOptions(),
      };
      fetchPhraseOverview(params).then(result => callback(result));
    },
    columns: [
      {
        data: null,
        render: (data, type, row) => renderPhraseOverviewCell(row)
      },
      {
        data: null,
        render: (data, type, row) => `<button class="btn btn-sm btn-outline ignore-phrase-btn" data-src="${escapeForHtmlAttr(row.src_phrase)}" data-tgt="${escapeForHtmlAttr(row.tgt_phrase)}"><i class="fas fa-eye-slash"></i></button>`
      }
    ]
  });

  phrasesTable.on('draw', () => {
    document.querySelectorAll('.ignore-phrase-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const src = btn.dataset.src;
        const tgt = btn.dataset.tgt;
        await ignorePhrasePair(id, src, tgt);
        ignoredTable.ajax.reload(null, false);
        phrasesTable.ajax.reload(null, false);
      });
    });
    document.querySelectorAll('.show-src-phrase-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const phrase = btn.dataset.text;
        $('#fix-test1').val(phrase);
        $('#fix-fix1').val(phrase);
        $('#fix-test2').val('');
        $('#fix-fix2').val('');
        $('#fix-direction').val('0');
        phrasesTable.search(phrase).draw();
      });
    });
    document.querySelectorAll('.search-tgt-phrase-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const phrase = btn.dataset.text;
        $('#fix-test1').val('');
        $('#fix-fix1').val('');
        $('#fix-test2').val(phrase);
        $('#fix-fix2').val(phrase);
        $('#fix-direction').val('0');
        phrasesTable.search(phrase).draw();
      });
    });
    document.querySelectorAll('.show-phrases-btn').forEach(btn => {
      const src = btn.dataset.src;
      const tgt = btn.dataset.tgt;
      const direction = btn.dataset.direction;
      btn.addEventListener('click', () => showTranslations(src, '', direction, '', '', { allOccurrences: true }));
    });
    document.querySelectorAll('.toggle-variants-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const container = btn.closest('.phrase-overview-cell');
        const panel = container?.querySelector('.variant-list-panel');
        if (!panel) return;
        const willOpen = panel.classList.contains('d-none');
        closeVariantPanels(willOpen ? panel : null);
        panel.classList.toggle('d-none', !willOpen);
      });
    });
    document.querySelectorAll('.show-variant-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const src = btn.dataset.src;
        const tgt = btn.dataset.tgt;
        const direction = btn.dataset.direction;
        const unalignedOnly = btn.dataset.unaligned === '1';
        markActiveVariantButton(btn);
        showTranslations(src, tgt, direction, '', '', { unalignedOnly });
      });
    });
  });

  // Initialize DataTable with POST-based server-side processing
  const ignoredTable = $("#ignored-table").DataTable({
    processing: true,      // show "Processing…" while loading
    serverSide: true,      // server handles paging/filtering/sorting
    autoWidth: false,  // let columns take natural width
    pageLength: 6,
    lengthChange: false,
    ajax: function (d, callback) {
      const params = { ...d, project_id: id };
      fetchIgnoredPhrases(params).then(result => callback(result));
    },
    columns: [
        { data: null, render: (data, type, row) => `${row.src_phrase} - ${row.tgt_phrase}` },
        { data: null, render: (data, type, row) => `<button class="btn btn-sm btn-outline undo-ignore-phrase-btn" data-id="${row.id}" data-imported="${row.imported}"><i class="fas fa-undo"></i></button>` }
    ]
  });

  // Attach handlers every time the table draws
  ignoredTable.on('draw', () => {
    document.querySelectorAll('.undo-ignore-phrase-btn').forEach(btn => {
      const phrase_id =  btn.dataset.id;
      const imported = btn.dataset.imported;
      btn.addEventListener('click', async () => {
        await setIgnorePhrase(id, phrase_id, 0, imported);
        ignoredTable.ajax.reload(null, false);
        phrasesTable.ajax.reload(null, false);
      });
    });
  });

  // bind delete all ignored phrases button
  bindAsyncButton(
    document.getElementById("delete-ignored-btn"), 
    async () => {
      if (!confirm("Are you sure you want to delete all ignored phrases?")) {
        return;
      }
      await deleteAllIgnoredPhrases(id);
      ignoredTable.ajax.reload(null, false);
      phrasesTable.ajax.reload(null, false);
    }
  );
}

function showTranslations(phrase1, phrase2, direction, fix1 = '', fix2 = '', opts = {}) {
  const unalignedOnly = opts?.unalignedOnly === true;
  const allOccurrences = opts?.allOccurrences === true;

  let fix = (unalignedOnly || allOccurrences)
    ? null
    : fixes.find(f => f.phrase1 === phrase1 && f.phrase2 === phrase2 && f.direction === direction);

  if (fix) {
    fix1 = fix.fix1;
    fix2 = fix.fix2;
  } else {
    fix1 = fix1 ? fix1 : phrase1;
    fix2 = fix2 ? fix2 : phrase2;
  }

  $('#fix-test1').val(phrase1);
  $('#fix-fix1').val(fix1);
  $('#fix-test2').val((unalignedOnly || allOccurrences) ? '' : phrase2);
  $('#fix-fix2').val((unalignedOnly || allOccurrences) ? '' : fix2);
  $('#fix-direction').val(direction);
  $('#translations-table').data('unaligned-only', unalignedOnly);
  $('#translations-table').data('all-occurrences', allOccurrences);

  if (unalignedOnly || allOccurrences) {
    $('#fix-fix1').prop('disabled', false);
    $('#fix-fix2').prop('disabled', true);
  } else if (direction == 1) {
    $('#fix-fix1').prop('disabled', true);
    $('#fix-fix2').prop('disabled', false);
  } else if (direction == -1) {
    $('#fix-fix1').prop('disabled', false);
    $('#fix-fix2').prop('disabled', true);
  } else {
    $('#fix-fix1').prop('disabled', false);
    $('#fix-fix2').prop('disabled', false);
  }

  $('#translations-table').DataTable().page('first').draw('page');

  const translationsEl = document.getElementById('translations-table');
  if (translationsEl && window.innerWidth < 992) {
    translationsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function getPhraseInput() {
  return {
    src_phrase: $('#fix-test1').val(),
    tgt_phrase: $('#fix-test2').val(),
    src_fix: $('#fix-fix1').val(),
    tgt_fix: $('#fix-fix2').val(),
    direction: $('#fix-direction').val(),
    percentage: $('#fix-percentage').val()
  };
}

function storeTranslationBtn(row_id) {
  const line1 = $(`#translation-src-${row_id}`).text();
  const line2 = $(`#translation-tgt-${row_id}`).text();
  storeTranslation(row_id, line1, line2);
}

function removeTranslationBtn(row_id) {

  // ask alert to confirm
  if (!confirm("Are you sure you want to remove this translation?")) {
    return;
  }

  // store empty translation
  deleteTranslation(row_id);
  // redraw table
  $('#translations-table').DataTable().ajax.reload(null, false); // false to stay on current page
}

function updateFixesList() {
  const container = $('#fixes-container');
  const fixesCount = $('#fixes-count');
  
  fixesCount.text(fixes.length);
  
  if (fixes.length === 0) {
    container.html(`
      <div class="text-center text-muted py-3">
        <i class="fas fa-info-circle me-2"></i>No changes pending
      </div>
    `);
    return;
  }

  container.empty();
  fixes.forEach(function (fix, index) {
    const fix1_text = fix.src_fix ? `${fix.src_fix}` : fix.src_phrase;
    const fix2_text = fix.tgt_fix ? `${fix.tgt_fix}` : fix.tgt_phrase;
    const directionSymbol = getDirectionSymbol(fix.direction);

    container.append(`
      <div class="fix-entry border rounded p-2 mb-2 bg-light">
        <div class="d-flex justify-content-between align-items-start">
          <div class="flex-grow-1">
            <div class="text-muted mb-1">
              <span class="fw-bold">${fix.src_phrase}</span> 
              <span class="mx-1">${directionSymbol}</span> 
              <span class="fw-bold">${fix.tgt_phrase}</span>
            </div>
            <div class="text-success">
              ${fix1_text ? `<span>${fix1_text}</span>` : ''}
              <span class="mx-1">${directionSymbol}</span> 
              ${fix2_text ? `<span>${fix2_text}</span>` : ''}
              <span class="badge bg-info">${fix.type}</span>
            </div>
          </div>
          <div class="text-end ms-2">
            <span class="badge bg-secondary d-block mb-1">${fix.percentage}%</span>
            <button class="btn btn-sm btn-outline-danger remove-fix-btn" data-idx="${index}"
                    title="Remove fix">
              <i class="fas fa-times"></i>
            </button>
          </div>
        </div>
      </div>
    `);
  });

  // Reattach event handlers
  $('.remove-fix-btn').on('click', function() {
    const index = $(this).data('idx');
    removeFix(index);
  });
}

function removeFix(index) {
  fixes.splice(index, 1);
  updateFixesList();
}