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

import {
  extractPhrases,
  fetchPhrases,
  fetchIgnoredPhrases,
  setIgnorePhrase,
  importIgnoredFromFile,
  downloadIgnoredPhrases,
  downloadPhrases,
  deleteAllIgnoredPhrases,
  downloadRobustnessReport,
  downloadPhraseTranslationTableCSV,
  downloadPhraseTranslationTableJSON,
  downloadSurePhraseTableCSV,
  downloadDubiousPhraseTableCSV,
  downloadSurePhraseTableJSON,
  downloadDubiousPhraseTableJSON
} from "../backend/js/phrases.js";
import { fetchTranslations, storeTranslation, deleteTranslation } from "../backend/js/alignments.js";
import { applyFixes } from "../backend/js/fixes.js";
import { getProject, saveProject, downloadProject, mergeProjectStats } from "../backend/js/projects.js";
import { recomputeAlignments } from "../backend/js/aligner.js";
import { bindAsyncButton } from "./utils.js";
import { profiler } from "./profiler.js";

let fixes = [];  // global list of fixes
let ignored = [];

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

export async function renderProject(id) {
  const app = document.getElementById("app");

  const project = await getProject(id);
  const numCores = navigator.hardwareConcurrency || 1;

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
        <i class="fas fa-sync"></i> Apply Changes
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
        <button id="download-robustness-btn" class="btn btn-outline-secondary btn-sm">
          Download Robustness Report
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
  const rb = document.getElementById("download-robustness-btn");
  if (rb) {
    rb.addEventListener("click", () => downloadRobustnessReport(id));
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

  // Initialize Bootstrap tooltips
  const tooltipTriggerList = [].slice.call(document.querySelectorAll('[data-bs-toggle="tooltip"]'));
  tooltipTriggerList.forEach(function (tooltipTriggerEl) {
    new bootstrap.Tooltip(tooltipTriggerEl);
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
      const result = await fetchTranslations(d);
      callback(result); // DataTable expects JSON in correct format
    },
    columns: [
      { data: null, render: (data, type, row) => `
        <div class="translation-row">
          <div contenteditable="true" class="mb-2" 
          style="word-wrap: break-word; white-space: pre-wrap;" 
          id="translation-src-${row.row_id}">${row.line1}</div>
          <div contenteditable="true" style="word-wrap: break-word; white-space: pre-wrap;" id="translation-tgt-${row.row_id}">${row.line2}</div>
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

  // Initialize DataTable with POST-based server-side processing
  const phrasesTable = $("#phrases-table").DataTable({
    processing: true,      // show "Processing…" while loading
    serverSide: true,      // server handles paging/filtering/sorting
    autoWidth: false,  // let columns take natural width
    pageLength: 6,
    scrollY: 400,
    scroller: true,
    lengthChange: false,
    ajax: function (d, callback) {
      const min_phrase_len = $("#min-phrase-length-input").val();
      const params = { ...d, project_id: id, min_phrase_len: min_phrase_len };
      fetchPhrases(params).then(result => callback(result));
    },
    columns: [
        { data: null, render: (data, type, row) => `<button class="btn btn-sm btn-outline show-phrases-btn" data-src="${escapeForHtmlAttr(row.src_phrase)}" data-tgt="${escapeForHtmlAttr(row.tgt_phrase)}" data-direction="${row.direction}"><i class="fas fa-search"></i> ${row.num_occurrences}</button>
        <button class="btn btn-sm btn-clear show-src-phrase-btn" data-text="${escapeForHtmlAttr(row.src_phrase)}">${row.src_phrase}</button>${getDirectionSymbol(row.direction)}<button class="btn btn-sm btn-clear search-tgt-phrase-btn" data-text="${escapeForHtmlAttr(row.tgt_phrase)}">${row.tgt_phrase}</button>` },
        { data: null, render: (data, type, row) => `<button class="btn btn-sm btn-outline ignore-phrase-btn" data-id="${row.id}" data-src="${row.src_phrase}" data-tgt="${row.tgt_phrase}"><i class="fas fa-eye-slash"></i></button>` }
    ]
  });
  // Attach handlers every time the table draws
  phrasesTable.on('draw', () => {
    document.querySelectorAll('.ignore-phrase-btn').forEach(btn => {
      const phrase_id =  btn.dataset.id;
      btn.addEventListener('click', async () => {
        await setIgnorePhrase(id, phrase_id, 1);
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
      // get data-src, data-tgt, data-direction
      const src = btn.dataset.src;
      const tgt = btn.dataset.tgt;
      const direction = btn.dataset.direction;
      btn.addEventListener('click', () => showTranslations(src, tgt, direction));
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

function showTranslations(phrase1, phrase2, direction, fix1 = '', fix2 = '') {

  let fix = fixes.find(f => f.phrase1 === phrase1 && f.phrase2 === phrase2 && f.direction === direction);

  if (fix) {
    fix1 = fix.fix1;
    fix2 = fix.fix2;
  } else {
    fix1 = fix1 ? fix1 : phrase1;
    fix2 = fix2 ? fix2 : phrase2;
  }

  $('#fix-test1').val(phrase1);
  $('#fix-fix1').val(fix1);
  $('#fix-test2').val(phrase2);
  $('#fix-fix2').val(fix2);
  $('#fix-direction').val(direction);

  if (direction == 1) {
    // set fix-fix.1 disabled
    $('#fix-fix1').prop('disabled', true);
  } else if (direction == -1) {
    $('#fix-fix2').prop('disabled', true);
  } else {
    $('#fix-fix1').prop('disabled', false);
    $('#fix-fix2').prop('disabled', false);
  }

  // reset to first page
  $('#translations-table').DataTable().page('first').draw('page');
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