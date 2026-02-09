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

import { initPyodide } from "../pyodide.js";
import { computeAlignments, storeAlignments } from "../backend/js/aligner.js";
import { extractPhrases } from "../backend/js/phrases.js";
import { tokeniseLines, getLinesFromFiles } from "../backend/js/text.js";
import { importBinaryProject, updateProjectStats } from "../backend/js/projects.js";
import { getLinesStats } from "../backend/js/stats.js";
import { deleteProject } from "../backend/js/projects.js";
import { bindAsyncButton, nextFrame } from "./utils.js";
import { profiler } from "./profiler.js";

// Improve responsiveness: make touchstart/touchmove listeners passive by default
// when code calls addEventListener without options (patches third-party libs that don't set passive).
// This mitigates the "Added non-passive event listener" warning.
(function setDefaultPassiveForTouch() {
  if (typeof window === 'undefined' || !EventTarget || !EventTarget.prototype) return;
  try {
    const orig = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function(type, listener, options) {
      if ((type === 'touchstart' || type === 'touchmove') && (options === undefined || (typeof options === 'object' && options.passive === undefined))) {
        // if options was boolean (useCapture), preserve that but we prefer an options object
        const opts = (typeof options === 'boolean') ? { capture: options, passive: true } : Object.assign({}, options, { passive: true });
        return orig.call(this, type, listener, opts);
      }
      return orig.call(this, type, listener, options);
    };
  } catch (e) {
    // no-op on older environments or if this is not allowed
  }
})();

async function loadProjects() {

    // put loader while loading
    const container = document.getElementById("projects-table-container");
    container.innerHTML = `
      <div class="d-flex justify-content-center align-items-center py-5">
        <div class="text-center">
          <div class="spinner-border text-primary" role="status">
            <span class="visually-hidden">Loading...</span>
          </div>
          <div class="mt-2 text-muted">Loading projects...</div>
        </div>
      </div>
    `;
    const pyodide = await initPyodide();

    // fetch projects from pyodide/python
    const projects = await pyodide.runPythonAsync(`
        from projects import get_projects
        projects = get_projects()
        projects
    `);
    const list = projects.toJs();

    // Update projects count badge
    const countBadge = document.getElementById('projects-count');
    if (countBadge) {
        countBadge.textContent = list ? list.length : 0;
    }

    if (!list || list.length === 0) {
        container.innerHTML = `
          <div class="text-center py-5 text-muted">
            <i class="fas fa-folder-open fa-3x mb-3 opacity-50"></i>
            <h5>No projects yet</h5>
            <p class="mb-0">Create your first project by uploading source and target files above.</p>
          </div>
        `;
        return;
    }

    // Create table with improved styling
    container.innerHTML = `
      <div class="table-responsive">
        <table class="table table-hover mb-0">
          <thead class="table-light">
            <tr>
              <th class="border-0 ps-3">
                <i class="fas fa-tag me-1"></i>Project Name
              </th>
              <th class="border-0">
                <i class="fas fa-calendar me-1"></i>Created
              </th>
              <th class="border-0">
                <i class="fas fa-chart-bar me-1"></i>Corpus Size
              </th>
              <th class="border-0 text-end pe-3">
                <i class="fas fa-cogs me-1"></i>Actions
              </th>
            </tr>
          </thead>
          <tbody id="projects-tbody">
          </tbody>
        </table>
      </div>
    `;

    const tbody = document.createElement('tbody');

    
    list.forEach((project, index) => {
        const row = document.createElement('tr');
        row.style.cursor = 'pointer';
        
        // Project name with truncation
        const nameCell = document.createElement('td');
        nameCell.className = 'ps-3 fw-medium';
        nameCell.innerHTML = `
          <div class="d-flex align-items-center">
            <div class="me-2">
              <div class="rounded-circle bg-primary d-flex align-items-center justify-content-center" 
                   style="width: 32px; height: 32px; font-size: 12px; color: white;">
                ${(project[1] || project[0] || 'P').charAt(0).toUpperCase()}
              </div>
            </div>
            <div style="min-width: 0;">
              <div class="text-truncate" style="max-width: 200px;" title="${project[1] || project[0]}">
                ${project[1] || project[0]}
              </div>
              <small class="text-muted">ID: ${project[0]}</small>
            </div>
          </div>
        `;

        // Created date with better formatting
        const createdCell = document.createElement('td');
        const createdDate = project[2] ? new Date(project[2]).toLocaleDateString() : '-';
        const createdTime = project[2] ? new Date(project[2]).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : '';
        createdCell.innerHTML = `
          <div>
            <div class="fw-medium">${createdDate}</div>
            ${createdTime ? `<small class="text-muted">${createdTime}</small>` : ''}
          </div>
        `;

        // Stats cell (placeholder for now, can be enhanced with actual stats)
        const projectStats = project[3] ? JSON.parse(project[3]) : {};
        const statsCell = document.createElement('td');
        statsCell.innerHTML = `
          <div class="d-flex gap-2">
            <span class="badge bg-light text-dark" title="Corpus Size">
              ${projectStats.corpus_size || '-'}
            </span>
          </div>
        `;

        // Actions with improved buttons
        const actionsCell = document.createElement('td');
        actionsCell.className = 'text-end pe-3';
        actionsCell.innerHTML = `
          <div class="btn-group" role="group">
            <a href="#project-${project[0]}" class="btn btn-sm btn-outline-primary" title="Open project">
              <i class="fas fa-external-link-alt"></i> Open
            </a>
            <button class="btn btn-sm btn-outline-danger delete-project-btn" 
                    data-project-id="${project[0]}" 
                    data-project-name="${project[1] || project[0]}"
                    title="Delete project">
              <i class="fas fa-trash"></i>
            </button>
          </div>
        `;

        row.appendChild(nameCell);
        row.appendChild(createdCell);
        row.appendChild(statsCell);
        row.appendChild(actionsCell);
        
        // Add click to open project (except on buttons)
        row.addEventListener('click', (e) => {
          if (!e.target.closest('.btn-group')) {
            window.location.hash = `project-${project[0]}`;
          }
        });

        tbody.appendChild(row);
    });

    const tableBody = container.querySelector('#projects-tbody');
    if (tableBody) {
        tableBody.replaceWith(tbody);
    }

    // table.appendChild(tbody);
    // wrap.appendChild(table);
    // container.appendChild(wrap);

// Bind delete buttons
  document.querySelectorAll('.delete-project-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
          e.stopPropagation(); // Prevent row click
          const projectId = btn.dataset.projectId;
          const projectName = btn.dataset.projectName;
          
          if (!confirm(`Are you sure you want to delete "${projectName}"?\n\nThis action cannot be undone.`)) {
              return;
          }
          
          try {
              // Add loading state
              btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
              btn.disabled = true;
              
              await deleteProject(projectId);
              await loadProjects();
              
              // Show success message
              const success = document.createElement('div');
              success.className = 'alert alert-success alert-dismissible fade show m-3';
              success.innerHTML = `
                <i class="fas fa-check-circle me-2"></i>
                Project "${projectName}" has been deleted successfully.
                <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
              `;
              container.prepend(success);
              setTimeout(() => success.remove(), 4000);
              
          } catch (err) {
              console.error(err);
              alert('Error deleting project: ' + (err && err.message ? err.message : String(err)));
              
              // Reset button
              btn.innerHTML = '<i class="fas fa-trash"></i>';
              btn.disabled = false;
          }
      });
  });
}

async function loadDocuments() {
  const btn = document.getElementById("button-load-documents");
  try {
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> Loading...`;
    await nextFrame();

    const sourceFileEl = document.getElementById("sourceFile");
    const targetFileEl = document.getElementById("targetFile");

    if (!sourceFileEl.files.length || !targetFileEl.files.length) {
      alert("Please select both source and target files.");
      return;
    }

    console.log('📂 Loading files...');
    const { src_lines: srcLinesRaw, tgt_lines: tgtLinesRaw } = await getLinesFromFiles(sourceFileEl.files[0], targetFileEl.files[0]);
    
    if (srcLinesRaw.length === 0 || tgtLinesRaw.length === 0) {
      alert('Input files appear empty.');
      return;
    }

    if (srcLinesRaw.length !== tgtLinesRaw.length) {
      alert("Source and target files must have the same number of lines.");
      return;
    }

    // Store in global scope
    window._loadedDocuments = {
      srcLinesRaw,
      tgtLinesRaw,
      sourceFileName: sourceFileEl.files[0].name,
      targetFileName: targetFileEl.files[0].name
    };

    // Show quick stats
    const srcStats = getLinesStats(srcLinesRaw);
    const tgtStats = getLinesStats(tgtLinesRaw);
    
    console.log(`✓ Loaded: ${srcStats.lines.toLocaleString()} line pairs | Src avg: ${srcStats.avg_tokens} tok | Tgt avg: ${tgtStats.avg_tokens} tok`);

    const statsContent = document.getElementById("stats-content");
    if (statsContent) {
      const statsContainer = document.getElementById('stats-container');
      if (statsContainer) statsContainer.style.display = 'block';
      const toggleStatsBtn = document.getElementById('toggle-stats');
      if (toggleStatsBtn) toggleStatsBtn.textContent = 'Hide';

      statsContent.innerHTML = `
        <div class="row g-3">
          <div class="col-md-6">
            <div class="d-flex align-items-center mb-2">
              <i class="fas fa-file-alt text-primary me-2"></i>
              <strong>Source</strong>
              <span class="ms-2 text-muted small">${sourceFileEl.files[0].name}</span>
            </div>
            <div class="bg-light p-2 rounded mb-2">
              <div class="d-flex justify-content-between small">
                <span><i class="fas fa-list-ol me-1"></i>${srcStats.lines.toLocaleString()} lines</span>
                <span><i class="fas fa-text-width me-1"></i>Avg: ${srcStats.avg_length} chars</span>
                <span><i class="fas fa-font me-1"></i>Avg: ${srcStats.avg_tokens} tokens</span>
              </div>
            </div>
            <div class="border rounded p-2" style="max-height: 360px; overflow-y: auto; font-size: 1rem;">
              <div class="text-muted small mb-1"><i class="fas fa-eye me-1"></i>Sample (first 3 lines):</div>
              <div style="white-space: pre-wrap; word-break: break-word;">
${srcStats.sample.join('\n--\n')}</div>
            </div>
          </div>

          <div class="col-md-6">
            <div class="d-flex align-items-center mb-2">
              <i class="fas fa-file-alt text-success me-2"></i>
              <strong>Target</strong>
              <span class="ms-2 text-muted small">${targetFileEl.files[0].name}</span>
            </div>
            <div class="bg-light p-2 rounded mb-2">
              <div class="d-flex justify-content-between small">
                <span><i class="fas fa-list-ol me-1"></i>${tgtStats.lines.toLocaleString()} lines</span>
                <span><i class="fas fa-text-width me-1"></i>Avg: ${tgtStats.avg_length} chars</span>
                <span><i class="fas fa-font me-1"></i>Avg: ${tgtStats.avg_tokens} tokens</span>
              </div>
            </div>
            <div class="border rounded p-2" style="max-height: 360px; overflow-y: auto; font-size: 1rem;">
              <div class="text-muted small mb-1"><i class="fas fa-eye me-1"></i>Sample (first 3 lines):</div>
              <div style="white-space: pre-wrap; word-break: break-word;">
${tgtStats.sample.join('\n--\n')}</div>
            </div>
          </div>
        </div>
      `;
    }

    // Show processing options panel
    const processingOptions = document.getElementById('processing-options');
    if (processingOptions) {
      processingOptions.style.display = 'block';
      
      // Set default values
      const maxLinesInput = document.getElementById('max-lines-input');
      
      if (maxLinesInput) {
        maxLinesInput.max = srcLinesRaw.length;
        maxLinesInput.value = srcLinesRaw.length;
        maxLinesInput.placeholder = `Max: ${srcLinesRaw.length.toLocaleString()}`;
      }
    }

  } catch (err) {
    console.error('❌ Load error:', err);
    alert('Error loading documents: ' + (err?.message || String(err)));
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-upload me-2"></i>Load Documents';
  }

  return false;
}

async function _setupAlignments(numCores) {
  if (!window._loadedDocuments) {
    alert("Please load documents first.");
    return;
  }

  const { srcLinesRaw, tgtLinesRaw } = window._loadedDocuments;

  // Validate max lines
  const maxLinesInput = document.getElementById('max-lines-input');
  const maxLines = maxLinesInput ? parseInt(maxLinesInput.value, 10) : srcLinesRaw.length;
  if (isNaN(maxLines) || maxLines < 1 || maxLines > srcLinesRaw.length) {
    alert(`Please enter a valid number of lines (1 to ${srcLinesRaw.length.toLocaleString()})`);
    return;
  }

  // Slice to requested number of lines
  const srcLinesRawSliced = srcLinesRaw.slice(0, maxLines);
  const tgtLinesRawSliced = tgtLinesRaw.slice(0, maxLines);

  console.log(`📊 Processing: ${maxLines.toLocaleString()}/${srcLinesRaw.length.toLocaleString()} lines | Cores: ${numCores}`);
  console.log('progress:5');

  // Tokenize
  console.log('🔤 Tokenizing...');
  let srcLines = await profiler.measureAsync('tokenize_src', () => tokeniseLines(srcLinesRawSliced));
  await nextFrame();
  let tgtLines = await profiler.measureAsync('tokenize_tgt', () => tokeniseLines(tgtLinesRawSliced));
  await nextFrame();
  console.log(`✓ Tokenized: ${srcLines.length.toLocaleString()} pairs`);
  console.log('progress:30');

  // Compute alignments
  console.log('🔗 Computing alignments...');
  let resultLines = await profiler.measureAsync('compute_alignments', () => computeAlignments(srcLines, tgtLines, numCores));
  console.log(`✓ Aligned: ${resultLines.length.toLocaleString()} pairs`);
  console.log('progress:70');
  await nextFrame();

  return { srcLines, tgtLines, resultLines };
}

async function setupProject() {
  profiler.clear();
  await nextFrame();

  // Get processing parameters
  const numCoresInput = document.getElementById('num-cores-input');
  const numCores = numCoresInput ? parseInt(numCoresInput.value, 10) : 4;
  
  // Validate num cores
  if (isNaN(numCores) || numCores < 1 || numCores > 16) {
    alert('Please enter a valid number of cores (1 to 16)');
    return;
  }

  const btn = document.getElementById("button-setup-project");
  const maxLinesInput = document.getElementById('max-lines-input');
  const maxLines = maxLinesInput ? parseInt(maxLinesInput.value, 10) : window._loadedDocuments?.srcLinesRaw?.length || 0;

  let project_id = null;

  try {
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner-border spinner-border-sm"></span> Processing...`;
    await nextFrame();

    console.log('🚀 Starting project setup...');
    
    // Compute alignments
    let { srcLines, tgtLines, resultLines } = await _setupAlignments(numCores);

    // Store alignments
    console.log('💾 Storing alignments...');
    let scoreLines = Array(srcLines.length).fill(1);
    project_id = await storeAlignments(srcLines, tgtLines, resultLines, scoreLines);
    console.log(`✓ Stored: project_id=${project_id}`);
    console.log('progress:85');
    await nextFrame();

    if (!project_id) {
      throw new Error('Project ID is null after storing alignments.');
    }

    const limitPhrasesInput = document.getElementById('limit-num-phrases-input');
    const limitPhrases = limitPhrasesInput ? parseInt(limitPhrasesInput.value, 10) : 1000000;
    
    console.log(`📝 Extracting phrases (limit: ${limitPhrases.toLocaleString()})...`);
    const extractStats = await profiler.measureAsync('extract_phrases', () => extractPhrases(project_id, numCores));
    console.log(`✓ Extracted: ${extractStats?.total_phrases_filtered?.toLocaleString() || 'N/A'} phrases`);
    console.log('progress:95');
    await nextFrame();

    // Update metrics
    profiler.data = { ...profiler.data, ...(extractStats || {}) };
    updateProjectStats(project_id, profiler.data);
    console.log('progress:100');
    
    // Refresh projects list
    await loadProjects();

    // Success message
    const success = document.createElement('div');
    success.className = 'alert alert-success mt-3';
    success.innerHTML = `
      <i class="fas fa-check-circle me-2"></i>
      ✓ Project created: ${maxLines.toLocaleString()} lines, ${extractStats?.total_phrases_filtered?.toLocaleString() || 'N/A'} phrases
    `;
    document.getElementById('projects-table-container').prepend(success);
    setTimeout(() => success.remove(), 5000);

    // Clear loaded documents
    window._loadedDocuments = null;

    // Hide processing options
    const processingOptions = document.getElementById('processing-options');
    if (processingOptions) {
      processingOptions.style.display = 'none';
    }

    console.log('✅ Project setup complete');

  } catch (err) {
    console.error('❌ Error during project setup:', err);
    alert('Error: ' + (err?.message || String(err)));
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-play me-2"></i>Compute Alignments & Extract Phrases';
    console.log('progress:0');
  }

  return false;
}

export async function renderHome(container) {
    container.innerHTML = `
        <form id="load-documents-form">
            <div class="row g-3">
                <div class="col-md-6">
                    <label class="form-label">Source file</label>
                    <input type="file" class="form-control" id="sourceFile" required />
                </div>
                <div class="col-md-6">
                    <label class="form-label">Target file</label>
                    <input type="file" class="form-control" id="targetFile" required />
                </div>
            </div>

            <div class="mt-3">
                <button type="submit" id="button-load-documents" class="btn btn-secondary">
                  <i class="fas fa-upload me-2"></i>Load Documents
                </button>
            </div>
        </form>

        <!-- Documents Preview (shown after upload) -->
        <div id="stats-container" class="card mt-3" style="display:none;">
          <div class="card-header bg-light">
            <div class="d-flex justify-content-between align-items-center">
              <h6 class="mb-0">
                <i class="fas fa-chart-line me-2"></i>Documents Preview
              </h6>
              <button id="toggle-stats" class="btn btn-sm btn-outline-secondary">Hide</button>
            </div>
          </div>
          <div id="stats-content" class="card-body"></div>
        </div>

        <!-- Processing Options (shown after documents are loaded) -->
        <div id="processing-options" class="card mt-3" style="display:none;">
          <div class="card-header bg-primary text-white">
            <h5 class="mb-0">
              <i class="fas fa-cogs me-2"></i>Processing Options
            </h5>
          </div>
          <div class="card-body">
            <div class="row g-3">
              <div class="col-md-4">
                <label for="max-lines-input" class="form-label">
                  <i class="fas fa-file-alt me-1"></i>Number of Lines to Process
                </label>
                <input 
                  type="number" 
                  class="form-control" 
                  id="max-lines-input" 
                  min="1" 
                  step="1000"
                  placeholder="All lines"
                />
                <small class="text-muted">Leave empty or enter max available to process all lines</small>
              </div>
              <div class="col-md-4">
                <label for="limit-num-phrases-input" class="form-label">
                  <i class="fas fa-filter me-1"></i>Phrase Extraction Limit
                </label>
                <input 
                  type="number" 
                  class="form-control" 
                  id="limit-num-phrases-input" 
                  min="1000" 
                  step="100000" 
                  value="1000000"
                  placeholder="1,000,000"
                />
                <small class="text-muted">Maximum number of unique phrases to extract</small>
              </div>
              <div class="col-md-4">
                <label for="num-cores-input" class="form-label">
                  <i class="fas fa-microchip me-1"></i>CPU Cores
                </label>
                <input 
                  type="number" 
                  class="form-control" 
                  id="num-cores-input" 
                  min="1" 
                  max="16"
                  step="1" 
                  value="${Math.min(navigator.hardwareConcurrency || 4, 16)}"
                  placeholder="${Math.min(navigator.hardwareConcurrency || 4, 16)}"
                />
                <small class="text-muted">Number of parallel workers (1-16)</small>
              </div>
            </div>

            <div class="mt-3">
              <button type="button" id="button-setup-project" class="btn btn-primary">
                <i class="fas fa-play me-2"></i>Compute Alignments & Extract Phrases
              </button>
            </div>
          </div>
        </div>

        <hr/>

        <div class="card">
          <div class="card-header bg-secondary text-white">
            <div class="d-flex justify-content-between align-items-center">
              <h4 class="mb-0">
                <i class="fas fa-folder-open me-2"></i>Projects
              </h4>
              <div class="d-flex gap-2">
                <span class="badge bg-light text-dark" id="projects-count">0</span>
              </div>
            </div>
          </div>
          <div class="card-body p-0">
            <div id="projects-table-container" style="min-height: 200px;">
              <!-- Projects will be loaded here -->
            </div>
          </div>
        </div>

        <div class="card mt-3">
          <div class="card-body">
            <h5 class="card-title">
              <i class="fas fa-file-import me-2"></i>Import Project
            </h5>
            <div class="mb-3">
              <label for="binaryFile" class="form-label">Select .algf project file</label>
              <input type="file" class="form-control" id="binaryFile" accept=".algf" required />
            </div>
            <button type="submit" id="import-binary-button" class="btn btn-primary">
              <i class="fas fa-download me-2"></i>Import Project
            </button>
          </div>
        </div>
    `;

    // Sidebar description
    const sidebar = document.getElementById('sidebar-content');
    if (sidebar) {
      sidebar.innerHTML = `
        <div class="p-3">
          <h4>Welcome to AlignFix</h4>
          <p class="text-muted">AlignFix helps you identify and fix errors in bilingual text corpora via word-alignments.</p>
          <hr/>
          <h5>How it works</h5>
          <ol>
            <li><strong>Load Documents:</strong> Upload your source and target files.</li>
            <li><strong>Configure:</strong> Set the number of lines and phrase limits.</li>
            <li><strong>Process:</strong> Compute alignments and extract phrases.</li>
            <li><strong>Fix:</strong> Open the project to review and fix errors.</li>
          </ol>
          <hr/>
          <div>
            <a href="https://github.com/alignfix/alignfix" target="_blank">
              <i class="fab fa-github me-1"></i>View on GitHub
            </a>
            &nbsp;|&nbsp;
            <a href="#about">About</a>
          </div>
        </div>
      `;
    }

    // Stats toggle
    const toggleStatsBtn = document.getElementById('toggle-stats');
    const statsContent = document.getElementById('stats-content');
    if (toggleStatsBtn && statsContent) {
      toggleStatsBtn.addEventListener('click', () => {
        const hidden = getComputedStyle(statsContent).display === 'none';
        statsContent.style.display = hidden ? 'block' : 'none';
        toggleStatsBtn.textContent = hidden ? 'Hide' : 'Show';
      });
    }

    // Bind load documents button
    bindAsyncButton(
      document.getElementById("button-load-documents"),
      () => loadDocuments()
    );

    // Bind compute alignments button
    bindAsyncButton(
      document.getElementById("button-setup-project"),
      () => setupProject()
    );

    // Bind import button
    bindAsyncButton(
      document.getElementById("import-binary-button"),
      async (e) => {
        e.preventDefault();
        const fileInput = document.getElementById('binaryFile');
        if (!fileInput.files.length) {
          alert('Please select a binary project file.');
          return;
        }
        const file = fileInput.files[0];
        try {
          await importBinaryProject(file);
          await loadProjects();
          const success = document.createElement('div');
          success.className = 'alert alert-success mt-3';
          success.innerHTML = '<i class="fas fa-check-circle me-2"></i>Project imported successfully.';
          document.getElementById('projects-table-container').prepend(success);
          setTimeout(() => success.remove(), 4000);
        } catch (err) {
          console.error(err);
          alert('Error importing project: ' + (err && err.message ? err.message : String(err)));
        }
      }
    );

    // Load projects
    loadProjects();
}