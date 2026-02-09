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

import { importScoresFromFile, assignAutoScores, assignStabilityScores, getScores, getAlignmentsWithScores } from "../backend/js/scores.js";
import { bindAsyncButton } from "./utils.js";

/**
 * renderScores(projectId)
 * - Renders a scores page showing histogram, distribution table, and file upload
 */
export async function renderScores(projectId) {
  const app = document.getElementById('app') || document.body;
  app.innerHTML = `<div class="container py-3"><div class="text-center">Loading...</div></div>`;

  let scoresData;
  try {
    scoresData = await getScores(projectId);
  } catch (e) {
    app.innerHTML = `<div class="alert alert-danger">Failed to load scores: ${e.message}</div>`;
    return;
  }

  app.innerHTML = `
    <div class="py-4">
      <div class="row">
        <div class="col-12">
          <div class="d-flex justify-content-between align-items-center mb-4">
            <h1 class="mb-0">
              <i class="fas fa-chart-bar text-primary me-2"></i>
              Scores
            </h1>
            <div class="badge bg-secondary">
              Project ${projectId}
            </div>
          </div>
        </div>

        <!-- File Upload Section -->
        <div class="col-12 col-lg-4 mb-4">
          <div class="card h-100">
            <div class="card-header">
              <h5 class="card-title mb-0">
                <i class="fas fa-upload me-2"></i>
                Score Management
              </h5>
            </div>
            <div class="card-body">
              <div class="mb-3">
                <label for="scores-file-input" class="form-label">Upload Scores File</label>
                <input class="form-control" type="file" id="scores-file-input" name="file" accept=".txt,.csv">
                <div class="form-text">Upload a text file with one score per line</div>
              </div>
              
              <div class="mb-3">
                <label class="form-label">Auto-Assign Scores</label>
                <div class="d-grid gap-2">
                  <button id="assign-difficulty-scores-btn" class="btn btn-secondary">
                    <i class="fas fa-brain me-2"></i>
                    Translation Difficulty
                  </button>
                  <button id="assign-stability-scores-btn" class="btn btn-secondary">
                    <i class="fas fa-link me-2"></i>
                    Alignment Stability
                  </button>
                </div>
              </div>
              
              <div class="d-grid">
                <button id="refresh-scores-btn" class="btn btn-outline-primary">
                  <i class="fas fa-sync-alt me-2"></i>
                  Refresh Data
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- Histogram Section -->
        <div class="col-12 col-lg-8 mb-4">
          <div class="card h-100">
            <div class="card-header">
              <h5 class="card-title mb-0">
                <i class="fas fa-chart-histogram me-2"></i>
                Score Histogram
              </h5>
            </div>
            <div class="card-body">
              <div class="text-center" id="histogram-container">
                <canvas id="scores-histogram" width="600" height="400"></canvas>
              </div>
            </div>
          </div>
        </div>

        <!-- Alignments Viewer - Always Visible -->
        <div class="col-12 my-4">
          <div class="card">
            <div class="card-header">
              <h5 class="mb-0">
                <i class="fas fa-align-left me-2"></i>
                Alignments with Scores
              </h5>
            </div>
            <div class="card-body">
              <!-- Filters and Controls -->
              <div class="row mb-3">
                <div class="col-md-4">
                  <label class="form-label">Min Score</label>
                  <input type="number" id="min-score-filter" class="form-control" step="0.1" placeholder="Min">
                </div>
                <div class="col-md-4">
                  <label class="form-label">Max Score</label>
                  <input type="number" id="max-score-filter" class="form-control" step="0.1" placeholder="Max">
                </div>
                <div class="col-md-4">
                  <label class="form-label">Sort By</label>
                  <select id="sort-order" class="form-select">
                    <option value="desc">Score (High to Low)</option>
                    <option value="asc">Score (Low to High)</option>
                    <option value="id">ID (Ascending)</option>
                  </select>
                </div>
              </div>

              <div class="row mb-3">
                <div class="col-12">
                  <button id="apply-filters-btn" class="btn btn-primary">
                    <i class="fas fa-filter me-2"></i>Apply Filters
                  </button>
                  <button id="reset-filters-btn" class="btn btn-secondary">
                    <i class="fas fa-undo me-2"></i>Reset
                  </button>
                </div>
              </div>

              <!-- Alignments Table -->
              <div class="table-responsive">
                <table id="alignments-table" class="table table-sm table-hover">
                  <thead>
                    <tr>
                      <th style="width: 5%;">ID</th>
                      <th style="width: 10%;">Score</th>
                      <th style="width: 35%;">Source</th>
                      <th style="width: 35%;">Target</th>
                      <th style="width: 15%;">Actions</th>
                    </tr>
                  </thead>
                  <tbody id="alignments-tbody">
                    <tr>
                      <td colspan="5" class="text-center text-muted">
                        <i class="fas fa-spinner fa-spin me-2"></i>Loading alignments...
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <!-- Pagination Controls -->
              <div class="d-flex justify-content-between align-items-center mt-3">
                <div>
                  <span class="text-muted">Page: </span>
                  <span id="current-page">1</span> / <span id="total-pages">1</span>
                  <span class="ms-3 text-muted">Total: </span>
                  <span id="total-records">0</span> alignments
                </div>
                <div>
                  <label class="me-2">Per page:</label>
                  <select id="page-size" class="form-select form-select-sm d-inline-block" style="width: auto;">
                    <option value="30" selected>30</option>
                    <option value="50">50</option>
                    <option value="100">100</option>
                    <option value="500">500</option>
                    <option value="1000">1000</option>
                  </select>
                </div>
                <div class="btn-group">
                  <button id="first-page-btn" class="btn btn-sm btn-outline-secondary">
                    <i class="fas fa-angle-double-left"></i>
                  </button>
                  <button id="prev-page-btn" class="btn btn-sm btn-outline-secondary">
                    <i class="fas fa-angle-left"></i>
                  </button>
                  <button id="next-page-btn" class="btn btn-sm btn-outline-secondary">
                    <i class="fas fa-angle-right"></i>
                  </button>
                  <button id="last-page-btn" class="btn btn-sm btn-outline-secondary">
                    <i class="fas fa-angle-double-right"></i>
                  </button>
                </div>
              </div>
            </div>
          </div>
          </div>
        </div>


        <!-- Score Metrics Explanations -->
        <div class="col-12">
          <div class="card">
            <div class="card-header">
              <h5 class="mb-0">
                <i class="fas fa-info-circle me-2"></i>
                Score Metrics Explained
              </h5>
            </div>
            <div class="card-body">
              <ul class="nav nav-tabs" id="metricsTab" role="tablist">
                <li class="nav-item" role="presentation">
                  <button class="nav-link active" id="difficulty-tab" data-bs-toggle="tab" data-bs-target="#difficulty" type="button" role="tab">
                    <i class="fas fa-brain me-1"></i>Translation Clarity
                  </button>
                </li>
                <li class="nav-item" role="presentation">
                  <button class="nav-link" id="stability-tab" data-bs-toggle="tab" data-bs-target="#stability" type="button" role="tab">
                    <i class="fas fa-link me-1"></i>Alignment Stability Index
                  </button>
                </li>
              </ul>
              <div class="tab-content p-3" id="metricsTabContent">
                <!-- Translation Clarity Tab -->
                <div class="tab-pane fade show active" id="difficulty" role="tabpanel">
                  <h5>Translation Clarity Score</h5>
                  <p>This metric estimates how <strong>clear and unambiguous a sentence is to translate</strong> based on the translation options available for its words. Higher scores indicate clearer, less ambiguous translations.</p>
                  
                  <h6>How it works:</h6>
                  <ol>
                    <li><strong>Word-Level Ambiguity:</strong> For each word, the system counts how many different translations appear in the corpus.</li>
                    <li><strong>Sentence Difficulty:</strong> The difficulty is the average ambiguity across all words in the sentence.</li>
                    <li><strong>Normalization & Inversion:</strong> Raw difficulty scores are normalized to 0-1 and inverted so higher scores mean easier translations.</li>
                  </ol>
                  
                  <h6>Formula:</h6>
                  <div class="bg-light p-3 rounded mb-2">
                    <code>D(S) = (1 / |W(S)|) × Σ A(w) for w in W(S)</code>
                  </div>
                  <p class="small">
                    Where <code>D(S)</code> is raw difficulty, <code>W(S)</code> is the set of words, and <code>A(w)</code> is the ambiguity (number of translations) of word <code>w</code>.
                    The final score is normalized and inverted: <code>1 - (D - D_min) / (D_max - D_min)</code>
                  </p>
                  
                  <h6>Score Range:</h6>
                  <div class="d-flex align-items-center gap-3 mt-2">
                    <span class="badge bg-danger">0.0 - Very Ambiguous</span>
                    <span class="badge bg-warning">0.3 - Difficult</span>
                    <span class="badge bg-info">0.6 - Moderate</span>
                    <span class="badge bg-success">0.8+ - Easy</span>
                  </div>
                </div>
                
                <!-- Alignment Stability Tab -->
                <div class="tab-pane fade" id="stability" role="tabpanel">
                  <h5>Alignment Stability Index</h5>
                  <p>This metric measures the <strong>quality and reliability</strong> of word alignments between source and target sentences.</p>
                  
                  <h6>Components (weighted):</h6>
                  <ul>
                    <li><strong>Consistency (40%):</strong> Ratio of aligned words to total words. Higher coverage indicates more complete alignment.</li>
                    <li><strong>Agreement (40%):</strong> Balance between source and target coverage. Penalizes imbalanced alignments where one side has much better coverage.</li>
                    <li><strong>Connectivity (20%):</strong> Measures how densely packed alignment points are. Scattered alignments score lower than tightly connected ones.</li>
                  </ul>
                  
                  <h6>Formula:</h6>
                  <div class="bg-light p-3 rounded mb-2">
                    <code>Stability = 0.4 × Consistency + 0.4 × Agreement + 0.2 × Connectivity</code>
                  </div>
                  
                  <h6>Score Range:</h6>
                  <div class="d-flex align-items-center gap-3 mt-2">
                    <span class="badge bg-danger">0.0 - Bad</span>
                    <span class="badge bg-warning">0.3 - Fair</span>
                    <span class="badge bg-info">0.6 - Good</span>
                    <span class="badge bg-success">0.8+ - Excellent</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Alignment Detail Modal -->
    <div class="modal fade" id="alignmentModal" tabindex="-1" aria-labelledby="alignmentModalLabel" aria-hidden="true">
      <div class="modal-dialog modal-xl">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title" id="alignmentModalLabel">
              <i class="fas fa-align-justify me-2"></i>Alignment Details
            </h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
          </div>
          <div class="modal-body">
            <div class="row mb-3">
              <div class="col-md-6">
                <strong>ID:</strong> <span id="modal-alignment-id"></span>
              </div>
              <div class="col-md-6">
                <strong>Score:</strong> <span id="modal-alignment-score" class="badge bg-info"></span>
              </div>
            </div>
            <div class="row mb-3">
              <div class="col-12">
                <label class="form-label fw-bold">Source Text:</label>
                <div id="modal-source-text" class="p-3 bg-light border rounded"></div>
              </div>
            </div>
            <div class="row mb-3">
              <div class="col-12">
                <label class="form-label fw-bold">Target Text:</label>
                <div id="modal-target-text" class="p-3 bg-light border rounded"></div>
              </div>
            </div>
            <div class="row">
              <div class="col-12">
                <label class="form-label fw-bold">Alignment Visualization:</label>
                <div id="modal-alignment-viz" class="p-3 bg-white border rounded overflow-auto" style="font-family: monospace; max-height: 500px;">
                  <!-- Alignment visualization will be rendered here -->
                </div>
              </div>
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Close</button>
          </div>
        </div>
      </div>
    </div>
  `;

  const sidebar = document.getElementById('sidebar-content');
  if (sidebar) {
    sidebar.innerHTML = `
     <div class="p-3">
      <h4>About Scores</h4>
      <p>
        Scores should indicate the <strong>quality/difficulty of translations</strong> in your project. 
        You can <strong>upload your own scores</strong> or use automatic ones based on metrics like 
        <em>perplexity</em>, <em>BLEU</em>, or any custom measure.
      </p>
      <p>
        When extracting phrases, translations with <strong>low scores</strong> can be ignored to 
        focus on <strong>higher-quality data</strong> and reduce the number of phrases to review.
      </p>
      <p>
        Clicking <strong>"Assign Auto Scores"</strong> automatically estimates how 
        <strong>difficult a sentence is to translate</strong>, based on the <em>average ambiguity</em> 
        of its words.
      </p>
    </div>
    `;
  }

  // Initialize chart variable
  const ctx = document.getElementById('scores-histogram').getContext('2d');
  let scoreChart;

  // Function to plot histogram
  async function plotScoresHistogram() {
    try {
      const binned = await getScores(projectId);

      if (!binned || binned.length === 0) {
        document.getElementById('histogram-container').innerHTML = `
          <div class="text-center text-muted py-5">
            <i class="fas fa-chart-bar fa-3x mb-3"></i>
            <p>No scores available for histogram</p>
          </div>
        `;
        return;
      }

      // Convert pyodide objects to plain JavaScript
      const binnedObjects = binned.map(m => ({
        bin: m.get ? m.get('bin') : m.bin,
        count: m.get ? m.get('count') : m.count
      }));

      const labels = binnedObjects.map(b => b.bin);
      const data = binnedObjects.map(b => b.count);

      // Destroy existing chart
      if (scoreChart) scoreChart.destroy();

      // Create new chart
      scoreChart = new Chart(ctx, {
        type: 'bar',
        data: {
          labels,
          datasets: [{
            label: 'Score Distribution',
            data,
            backgroundColor: 'rgba(54, 162, 235, 0.6)',
            borderColor: 'rgba(54, 162, 235, 1)',
            borderWidth: 1
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            x: { 
              title: { display: true, text: 'Score Bins' },
              ticks: {
                callback: function(value, index, ticks) {
                  const label = this.getLabelForValue(value);
                  const num = parseFloat(label);
                  return isNaN(num) ? label : num.toFixed(2);
                }
              }
            },
            y: { 
              title: { display: true, text: 'Frequency' }, 
              beginAtZero: true 
            }
          },
          plugins: {
            legend: {
              display: true,
              position: 'top'
            },
            tooltip: {
              callbacks: {
                label: function(context) {
                  return `Count: ${context.parsed.y}`;
                }
              }
            }
          }
        }
      });

    } catch (error) {
      console.error('Error plotting histogram:', error);
      document.getElementById('histogram-container').innerHTML = `
        <div class="alert alert-danger">
          Error loading histogram: ${error.message}
        </div>
      `;
    }
  }

  // File upload handler
  document.getElementById("scores-file-input").addEventListener("change", async function(event) {
    const file = event.target.files[0]; 
    if (file) {
      console.log("Selected file:", file.name);

      const reader = new FileReader();
      reader.onload = async function(e) {
        try {
          const content = e.target.result;
          
          const scores = content.split('\n')
            .map(line => line.trim())
            .filter(line => line !== '')
            .map(score => parseFloat(score))
            .filter(score => !isNaN(score));

          await importScoresFromFile(projectId, scores);
          document.getElementById("scores-file-input").value = "";
          
          // Refresh the histogram and table
          await plotScoresHistogram();
          
          // Show success message
          const alertDiv = document.createElement('div');
          alertDiv.className = 'alert alert-success alert-dismissible fade show mt-2';
          alertDiv.innerHTML = `
            <i class="fas fa-check me-2"></i>
            Successfully imported ${scores.length} scores!
            <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
          `;
          document.querySelector('.card-body').appendChild(alertDiv);
          
          console.log("Scores imported successfully");
        } catch (error) {
          console.error('Error importing scores:', error);
          alert(`Error importing scores: ${error.message}`);
        }
      };
      reader.readAsText(file);
    }
  });

  // Assign difficulty scores button
  bindAsyncButton(
    document.getElementById("assign-difficulty-scores-btn"),
    async () => {
      await assignAutoScores(projectId);
      await plotScoresHistogram();
      await loadAlignments();
      console.log("Translation difficulty scores assigned successfully");
    }
  );

  // Assign stability scores button
  bindAsyncButton(
    document.getElementById("assign-stability-scores-btn"),
    async () => {
      await assignStabilityScores(projectId);
      await plotScoresHistogram();
      await loadAlignments();
      console.log("Alignment stability scores assigned successfully");
    }
  );

  // Refresh button
  bindAsyncButton(
    document.getElementById("refresh-scores-btn"),
    async () => {
      await plotScoresHistogram();
      await loadAlignments();
      console.log("Scores data refreshed");
    }
  );

  // Initial load
  await plotScoresHistogram();

  // Alignments pagination state
  let currentPage = 1;
  let pageSize = 30;
  let totalRecords = 0;
  let currentFilters = {
    minScore: null,
    maxScore: null,
    sortOrder: 'desc'
  };

  // Function to fetch and display alignments
  async function loadAlignments() {
    const tbody = document.getElementById('alignments-tbody');
    tbody.innerHTML = '<tr><td colspan="5" class="text-center"><i class="fas fa-spinner fa-spin me-2"></i>Loading...</td></tr>';

    try {
      
      const data = await getAlignmentsWithScores(projectId, currentPage, pageSize, currentFilters);
      totalRecords = data.total;

      // Update pagination info
      const totalPages = Math.max(1, Math.ceil(totalRecords / pageSize));
      document.getElementById('current-page').textContent = currentPage;
      document.getElementById('total-pages').textContent = totalPages;
      document.getElementById('total-records').textContent = totalRecords.toLocaleString();

      // Update pagination buttons state
      document.getElementById('first-page-btn').disabled = currentPage === 1;
      document.getElementById('prev-page-btn').disabled = currentPage === 1;
      document.getElementById('next-page-btn').disabled = currentPage >= totalPages;
      document.getElementById('last-page-btn').disabled = currentPage >= totalPages;

      // Populate table
      if (data.alignments.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted">No alignments found</td></tr>';
        return;
      }

      tbody.innerHTML = data.alignments.map(row => {
        const scoreClass = row.score >= 0.7 ? 'success' : row.score >= 0.4 ? 'warning' : 'danger';
        return `
          <tr>
            <td>${row.id}</td>
            <td><span class="badge bg-${scoreClass}">${row.score ? row.score.toFixed(3) : 'N/A'}</span></td>
            <td class="text-truncate" style="max-width: 300px;" title="${row.src_text_detok || ''}">${row.src_text_detok || ''}</td>
            <td class="text-truncate" style="max-width: 300px;" title="${row.tgt_text_detok || ''}">${row.tgt_text_detok || ''}</td>
            <td>
              <button class="btn btn-sm btn-outline-primary view-alignment-btn" 
                      data-id="${row.id}"
                      data-src="${(row.src_text || '').replace(/"/g, '&quot;')}"
                      data-tgt="${(row.tgt_text || '').replace(/"/g, '&quot;')}"
                      data-align="${row.alignment || ''}"
                      data-score="${row.score || 0}">
                <i class="fas fa-eye me-1"></i>View
              </button>
            </td>
          </tr>
        `;
      }).join('');

      // Attach view button handlers
      document.querySelectorAll('.view-alignment-btn').forEach(btn => {
        btn.addEventListener('click', function() {
          showAlignmentModal(
            this.dataset.id,
            this.dataset.src,
            this.dataset.tgt,
            this.dataset.align,
            parseFloat(this.dataset.score)
          );
        });
      });

    } catch (error) {
      console.error('Error loading alignments:', error);
      tbody.innerHTML = `<tr><td colspan="5" class="text-center text-danger">Error: ${error.message}</td></tr>`;
    }
  }

  // Function to visualize alignment
  function visualizeAlignment(srcText, tgtText, alignmentStr) {
    if (!alignmentStr || !srcText || !tgtText) {
      return '<div class="text-muted">No alignment data available</div>';
    }

    const srcTokens = srcText.split(' ');
    const tgtTokens = tgtText.split(' ');
    const alignPairs = alignmentStr.split(' ').map(pair => {
      const [s, t] = pair.split('-').map(Number);
      return { src: s, tgt: t };
    }).filter(p => !isNaN(p.src) && !isNaN(p.tgt));

    // Create alignment matrix with better sizing
    let html = '<div style="overflow-x: auto;"><table class="table table-bordered table-sm align-middle" style="font-size: 0.8em; min-width: 100%; width: max-content;"><thead><tr><th style="position: sticky; left: 0; background: white; z-index: 10;"></th>';
    
    // Header row with target tokens
    tgtTokens.forEach((token, idx) => {
      if (token == "#NB") { token = "_"; }
      html += `<th class="text-center align-middle" style="min-width: 50px; max-width: 80px; padding: 8px 4px;">
                <div style="font-weight: bold;">${idx}</div>
                <div style="font-size: 0.9em; word-break: break-word;">${token}</div>
              </th>`;
    });
    html += '</tr></thead><tbody>';

    // Rows for source tokens
    srcTokens.forEach((srcToken, srcIdx) => {
      if (srcToken == "#NB") { srcToken = "_"; }
      html += `<tr><th style="position: sticky; left: 0; background: white; z-index: 5; min-width: 50px; max-width: 120px; padding: 8px;">
                 <div style="font-weight: bold;">${srcIdx}</div>
                 <div style="font-size: 0.9em; word-break: break-word;">${srcToken}</div>
               </th>`;
      tgtTokens.forEach((tgtToken, tgtIdx) => {
        const isAligned = alignPairs.some(p => p.src === srcIdx && p.tgt === tgtIdx);
        const bgClass = isAligned ? 'bg-primary text-white' : '';
        html += `<td class="text-center align-middle ${bgClass} align-cell" data-src="${srcIdx}" data-tgt="${tgtIdx}" style="padding: 12px 4px;">${isAligned ? '●' : ''}</td>`;
      });
      html += '</tr>';
    });
    
    html += '</tbody></table></div>';
    return html;
  }

  // Function to render interactive text with clickable words
  function renderInteractiveText(text, type) {
    const tokens = text.split(' ');
    return tokens.map((token, idx) => {

      if (token == "#NB") { return '_'; }  // Skip rendering for #NB tokens

      return `<span class="word-token ${type}-word" data-idx="${idx}" style="cursor: pointer; padding: 2px 4px; margin: 2px; border-radius: 3px; transition: background-color 0.2s;">${token}</span>`;
    }).join(' ');
  }

  // Function to show alignment modal
  function showAlignmentModal(id, srcText, tgtText, alignment, score) {
    document.getElementById('modal-alignment-id').textContent = id;
    document.getElementById('modal-alignment-score').textContent = score.toFixed(3);
    
    // Render interactive text
    document.getElementById('modal-source-text').innerHTML = renderInteractiveText(srcText, 'src');
    document.getElementById('modal-target-text').innerHTML = renderInteractiveText(tgtText, 'tgt');
    
    // Render raw alignment string above the visualization
    const alignmentDisplay = alignment || 'No alignment data';
    document.getElementById('modal-alignment-viz').innerHTML = `
      <div class="mb-3">
        <label class="form-label fw-bold small">Raw Alignment String:</label>
        <pre class="bg-light p-2 border rounded" style="font-size: 0.85em; overflow-x: auto;"><code>${alignmentDisplay}</code></pre>
      </div>
      ${visualizeAlignment(srcText, tgtText, alignment)}
    `;

    // Parse alignment pairs
    const alignPairs = alignment ? alignment.split(' ').map(pair => {
      const [s, t] = pair.split('-').map(Number);
      return { src: s, tgt: t };
    }).filter(p => !isNaN(p.src) && !isNaN(p.tgt)) : [];

    // Add click handlers for source words
    document.querySelectorAll('.src-word').forEach(word => {
      word.addEventListener('click', function() {
        const srcIdx = parseInt(this.dataset.idx);
        
        // Clear previous highlights
        document.querySelectorAll('.src-word, .tgt-word').forEach(w => {
          w.style.backgroundColor = '';
          w.style.fontWeight = '';
          w.style.color = '#212529'; // Reset to default dark text color
        });
        document.querySelectorAll('.align-cell').forEach(cell => {
          cell.style.outline = '';
        });

        // Highlight clicked source word
        this.style.backgroundColor = '#ffc107';
        this.style.fontWeight = 'bold';
        this.style.color = '#212529'; // Keep dark text on yellow background

        // Find and highlight aligned target words
        const alignedTgtIndices = alignPairs
          .filter(p => p.src === srcIdx)
          .map(p => p.tgt);
        
        alignedTgtIndices.forEach(tgtIdx => {
          const tgtWord = document.querySelector(`.tgt-word[data-idx="${tgtIdx}"]`);
          if (tgtWord) {
            tgtWord.style.backgroundColor = '#28a745';
            tgtWord.style.fontWeight = 'bold';
            tgtWord.style.color = 'white';
          }
          
          // Highlight cells in matrix
          const cell = document.querySelector(`.align-cell[data-src="${srcIdx}"][data-tgt="${tgtIdx}"]`);
          if (cell) {
            cell.style.outline = '3px solid #ffc107';
          }
        });
      });
    });

    // Add click handlers for target words
    document.querySelectorAll('.tgt-word').forEach(word => {
      word.addEventListener('click', function() {
        const tgtIdx = parseInt(this.dataset.idx);
        
        // Clear previous highlights
        document.querySelectorAll('.src-word, .tgt-word').forEach(w => {
          w.style.backgroundColor = '';
          w.style.fontWeight = '';
          w.style.color = '#212529'; // Reset to default dark text color
        });
        document.querySelectorAll('.align-cell').forEach(cell => {
          cell.style.outline = '';
        });

        // Highlight clicked target word
        this.style.backgroundColor = '#28a745';
        this.style.fontWeight = 'bold';
        this.style.color = 'white';

        // Find and highlight aligned source words
        const alignedSrcIndices = alignPairs
          .filter(p => p.tgt === tgtIdx)
          .map(p => p.src);
        
        alignedSrcIndices.forEach(srcIdx => {
          const srcWord = document.querySelector(`.src-word[data-idx="${srcIdx}"]`);
          if (srcWord) {
            srcWord.style.backgroundColor = '#ffc107';
            srcWord.style.fontWeight = 'bold';
            srcWord.style.color = '#212529'; // Keep dark text on yellow background
          }
          
          // Highlight cells in matrix
          const cell = document.querySelector(`.align-cell[data-src="${srcIdx}"][data-tgt="${tgtIdx}"]`);
          if (cell) {
            cell.style.outline = '3px solid #28a745';
          }
        });
      });
    });

    const modalElement = document.getElementById('alignmentModal');
    const modal = new bootstrap.Modal(modalElement, {
      focus: false  // Prevent Bootstrap from focusing the modal element
    });
    
    // Fix accessibility issue: ensure focus is managed properly when modal closes
    modalElement.addEventListener('hide.bs.modal', function() {
      // Blur focused element BEFORE modal starts hiding to prevent aria-hidden warning
      if (document.activeElement && modalElement.contains(document.activeElement)) {
        document.activeElement.blur();
      }
    }, { once: true });
    
    modal.show();
  }

  // Pagination button handlers
  document.getElementById('first-page-btn').addEventListener('click', () => {
    currentPage = 1;
    loadAlignments();
  });

  document.getElementById('prev-page-btn').addEventListener('click', () => {
    if (currentPage > 1) {
      currentPage--;
      loadAlignments();
    }
  });

  document.getElementById('next-page-btn').addEventListener('click', () => {
    const totalPages = Math.ceil(totalRecords / pageSize);
    if (currentPage < totalPages) {
      currentPage++;
      loadAlignments();
    }
  });

  document.getElementById('last-page-btn').addEventListener('click', () => {
    currentPage = Math.ceil(totalRecords / pageSize);
    loadAlignments();
  });

  // Page size change handler
  document.getElementById('page-size').addEventListener('change', (e) => {
    pageSize = parseInt(e.target.value);
    currentPage = 1;
    loadAlignments();
  });

  // Filter handlers
  document.getElementById('apply-filters-btn').addEventListener('click', () => {
    const minScore = document.getElementById('min-score-filter').value;
    const maxScore = document.getElementById('max-score-filter').value;
    const sortOrder = document.getElementById('sort-order').value;

    currentFilters.minScore = minScore ? parseFloat(minScore) : null;
    currentFilters.maxScore = maxScore ? parseFloat(maxScore) : null;
    currentFilters.sortOrder = sortOrder;
    currentPage = 1;

    loadAlignments();
  });

  document.getElementById('reset-filters-btn').addEventListener('click', () => {
    document.getElementById('min-score-filter').value = '';
    document.getElementById('max-score-filter').value = '';
    document.getElementById('sort-order').value = 'desc';
    
    currentFilters = {
      minScore: null,
      maxScore: null,
      sortOrder: 'desc'
    };
    currentPage = 1;

    loadAlignments();
  });

  // Load alignments on initial page load
  await loadAlignments();
}