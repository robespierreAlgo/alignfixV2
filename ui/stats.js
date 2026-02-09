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

import { getProject } from "../backend/js/projects.js";
import { countFixes } from "../backend/js/fixes.js";
import { downloadBinaryProject } from "../backend/js/projects.js";
import { bindAsyncButton } from "./utils.js";

// helper HTML escapes
const escapeHtml = (s) => {
  if (s === undefined || s === null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
};

/**
 * renderStats(projectId)
 * - If projectId provided: renders a polished stats page for that project.
 * - If no projectId: shows a compact projects list with quick stats and link to each project's stats page.
 */
export async function renderStats(projectId) {
  const app = document.getElementById('app') || document.body;
  app.innerHTML = `<div class="container py-3"><div class="text-center">Loading...</div></div>`;

  let project;
  let num_fixes;
  try {
    project = await getProject(projectId);
    num_fixes = await countFixes(projectId);

  } catch (e) {
    app.innerHTML = `<div class="alert alert-danger">Failed to load stats: ${e.message}</div>`;
    return;
  }

  let projectStats = project ? project.stats || {} : null;

  // projectStats is a json strong, how to convert back to object
  if (projectStats && typeof projectStats === 'string') {
    try {
      projectStats = JSON.parse(projectStats);
    } catch (e) {
      console.error("Failed to parse project stats JSON:", e);
      projectStats = {};
    }
  }

  console.log(`Loading stats for project ${projectId}...`);
  // console.log(projectStats);
  
  const name = `Project ${projectId} - ${project.name || 'no name'}`;
  const created = project ? (project.created_at || '-') : (projectStats.created_at || '-');

  // build polished layout
  app.innerHTML = `
    <div class="py-3">
      <div class="d-flex justify-content-between align-items-start mb-3">
        <div>
          <h2 class="mb-1">${escapeHtml(name)}</h2>
          <div class="text-muted small">Created: ${escapeHtml(created)}</div>
        </div>
        <div class="text-end">
          <button id="download-binary" class="btn btn-primary"><i class="fas fa-file-archive me-2"></i> Download Project</button>
          <button id="download-stats" class="btn btn-secondary">
          <i class="fas fa-chart-line me-2"></i> Download Statistics</button>
        </div>
      </div>

      <div class="row g-3">
        <div class="col-12">
          <div class="card shadow-sm mb-3">
            <div class="card-body">
              <h5 class="card-title d-flex justify-content-between align-items-center">
                <span>Performance Profiler</span>
              </h5>
              <div id="stats-profiler" class="profiler-wrapper">
                <div class="table-responsive">
                  <table class="table table-hover table-sm">
                    <thead class="table-dark">
                      <tr>
                        <th>Function</th>
                        <th class="text-end">CPU Time (ms)</th>
                        <th class="text-end">Mem Δ (MB)</th>
                        <th class="text-end">Heap (MB)</th>
                      </tr>
                    </thead>
                    <tbody id="profiler-table-body"></tbody>
                 </table>
               </div>
               <div class="mt-3">
                 <small class="text-muted">
                   <i class="fas fa-info-circle"></i> 
                   Performance metrics are collected during phrase extraction and alignment operations.
                 </small>
               </div>
             </div>
            </div>
          </div>

          <div class="card shadow-sm">
            <div class="card-body">
              <h5 class="card-title">
                <i class="fas fa-chart-bar"></i> Processing Statistics
              </h5>
              <div class="row g-3">
                <div class="col-md-6">
                  <div class="bg-light p-3 rounded">
                    <div class="d-flex justify-content-between align-items-center">
                      <div>
                        <div class="small text-muted">Phrases Extracted</div>
                        <div class="h5 mb-0">${escapeHtml(String(projectStats.total_phrases_extracted ?? 0))}</div>
                      </div>
                      <div class="text-success">
                        <i class="fas fa-extract fa-2x"></i>
                      </div>
                    </div>
                  </div>
                </div>
                <div class="col-md-6">
                  <div class="bg-light p-3 rounded">
                    <div class="d-flex justify-content-between align-items-center">
                      <div>
                        <div class="small text-muted">Phrases Filtered</div>
                        <div class="h5 mb-0">${escapeHtml(String(projectStats.total_phrases_filtered ?? 0))}</div>
                      </div>
                      <div class="text-warning">
                        <i class="fas fa-filter fa-2x"></i>
                      </div>
                    </div>
                  </div>
                </div>
                <div class="col-md-6">
                  <div class="bg-light p-3 rounded">
                    <div class="d-flex justify-content-between align-items-center">
                      <div>
                        <div class="small text-muted">Phrases Ignored</div>
                        <div class="h5 mb-0">${escapeHtml(String(projectStats.total_ignored_phrases ?? 0))}</div>
                      </div>
                      <div class="text-secondary">
                        <i class="fas fa-eye-slash fa-2x"></i>
                      </div>
                    </div>
                  </div>
                </div>
                <div class="col-md-6">
                  <div class="bg-light p-3 rounded">
                    <div class="d-flex justify-content-between align-items-center">
                      <div>
                        <div class="small text-muted">Number of Fixes</div>
                        <div class="h5 mb-0">${escapeHtml(String(num_fixes))}</div>
                      </div>
                      <div class="text-success">
                        <i class="fas fa-tools fa-2x"></i>
                      </div>
                    </div>
                  </div>
                </div>
                <div class="col-md-6">
                  <div class="bg-light p-3 rounded">
                    <div class="d-flex justify-content-between align-items-center">
                      <div>
                        <div class="small text-muted">DB Delete Phrases Duration (s)</div>
                        <div class="h5 mb-0">${escapeHtml(String(projectStats.db_delete_duration_seconds.toFixed(2) ?? 0))}</div>
                      </div>
                      <div class="text-secondary">
                        <i class="fas fa-trash fa-2x"></i>
                      </div>
                    </div>
                  </div>
                </div>
                <div class="col-md-6">
                  <div class="bg-light p-3 rounded">
                    <div class="d-flex justify-content-between align-items-center">
                      <div>
                        <div class="small text-muted">DB Insert Phrases Duration (s)</div>
                        <div class="h5 mb-0">${escapeHtml(String(projectStats.db_insert_duration_seconds.toFixed(2) ?? 0))}</div>
                      </div>
                      <div class="text-success">
                        <i class="fas fa-plus fa-2x"></i>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  const sidebar = document.getElementById('sidebar-content');
  if (sidebar) {
    sidebar.innerHTML = `
      <div class="p-3">
        <h5 class="card-title mb-4">
          <i class="fas fa-project-diagram"></i> ${escapeHtml(name)}
        </h5>
        <div class="card shadow-sm project-card mb-3">
          <div class="card-body">
            <div class="mb-3">
              <div class="d-flex justify-content-between align-items-center mb-2">
                <span class="text-muted">
                  <i class="fas fa-database"></i> Corpus Size
                </span>
                <span class="badge bg-primary fs-6">${escapeHtml(String(projectStats.corpus_size ?? 0))}</span>
              </div>
              <div class="progress mb-2" style="height: 8px;">
                <div class="progress-bar bg-primary" role="progressbar" style="width: 100%"></div>
              </div>
            </div>
            
            <hr class="my-3">
            
            <div class="row text-center mb-3">
              <div class="col-6">
                <div class="border-end">
                  <div class="text-muted small mb-2">
                    <b><i class="fas fa-arrow-right"></i> Source</b>
                  </div>
                  <div class="fw-bold text-primary h6">
                    ${escapeHtml(projectStats.src_stats.longest ?? '-')}
                  </div>
                  <div class="small text-muted">max length</div>
                </div>
              </div>
              <div class="col-6">
                <div class="text-muted small mb-2">
                  <b><i class="fas fa-arrow-left"></i> Target</b>
                </div>
                <div class="fw-bold text-success h6">
                  ${escapeHtml(projectStats.tgt_stats.longest ?? '-')}
                </div>
                <div class="small text-muted">max length</div>
              </div>
            </div>
            
            <div class="row text-center mb-3">
              <div class="col-6">
                <div class="border-end">
                  <div class="fw-bold text-primary h6">
                    ${escapeHtml(projectStats.src_stats.shortest ?? '-')}
                  </div>
                  <div class="small text-muted">shortest</div>
                </div>
              </div>
              <div class="col-6">
                <div class="fw-bold text-success h6">
                  ${escapeHtml(projectStats.tgt_stats.shortest ?? '-')}
                </div>
                <div class="small text-muted">shortest</div>
              </div>
            </div>
            
            <div class="row text-center mb-3">
              <div class="col-6">
                <div class="border-end">
                  <div class="fw-bold text-primary h6">
                    ${escapeHtml(projectStats.src_stats.avg_length ?? '-')}
                  </div>
                  <div class="small text-muted">avg. tokens</div>
                </div>
              </div>
              <div class="col-6">
                <div class="fw-bold text-success h6">
                  ${escapeHtml(projectStats.tgt_stats.avg_length ?? '-')}
                </div>
                <div class="small text-muted">avg. tokens</div>
              </div>
            </div>

            <hr/>
            
            <div class="row text-center mb-3">
              <div class="col-6">
                <div class="border-end">
                  <div class="fw-bold text-primary h6">
                    ${escapeHtml(projectStats.src_stats.max_tokens ?? '-')}
                  </div>
                  <div class="small text-muted">max. tokens</div>
                </div>
              </div>
              <div class="col-6">
                <div class="fw-bold text-success h6">
                  ${escapeHtml(projectStats.tgt_stats.max_tokens ?? '-')}
                </div>
                <div class="small text-muted">max. tokens</div>
              </div>
            </div>
            
            <div class="row text-center mb-3">
              <div class="col-6">
                <div class="border-end">
                  <div class="fw-bold text-primary h6">
                    ${escapeHtml(projectStats.src_stats.avg_tokens ?? '-')}
                  </div>
                  <div class="small text-muted">avg. tokens</div>
                </div>
              </div>
              <div class="col-6">
                <div class="fw-bold text-success h6">
                  ${escapeHtml(projectStats.tgt_stats.avg_tokens ?? '-')}
                </div>
                <div class="small text-muted">avg. tokens</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  bindAsyncButton(
    document.getElementById('download-binary'),
    async () => {
      await downloadBinaryProject(projectId);
    },
    'Preparing download...'
  );

  // download
  document.getElementById('download-stats').addEventListener('click', () => {
    const dataStr = JSON.stringify({ id: projectId, name: name, stats: projectStats, created_at: created }, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `project-${projectId}-stats.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  // Add event listeners for new action buttons
  const refreshBtn = document.getElementById('refresh-stats');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      renderStats(projectId); // Reload the stats page
    });
  }

  const exportBtn = document.getElementById('export-stats');
  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      // Create a more detailed export
      const detailedStats = {
        project: {
          id: projectId,
          name: name,
          created_at: created
        },
        statistics: stats,
        profiling: {}
      };
      
      // Add profiling data
      profilerFunctions.forEach(key => {
        const entry = projectStats[key] && projectStats[key][0];
        if (entry) {
          detailedStats.profiling[key] = entry;
        }
      });
      
      const dataStr = JSON.stringify(detailedStats, null, 2);
      const blob = new Blob([dataStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `project-${projectId}-detailed-stats.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    });
  }

  // Populate profiler table with enhanced metrics
  const profilerTableBody = document.getElementById('profiler-table-body');
  const profilerFunctions = ['tokenize_src', 'tokenize_tgt', 'compute_alignments', 'extract_phrases'];

  let netMemBytes = 0;
  let posMemBytes = 0;
  let totalCpuTime = 0;
  let hasAny = false;

  // console.log(projectStats);
  profilerFunctions.forEach(key => {
    const row = document.createElement('tr');
    const entry = projectStats[key] && projectStats[key][0];

    const displayName = key.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase());

    if (!entry) {
      row.innerHTML = `
        <td><strong>${escapeHtml(displayName)}</strong><br><small class="text-muted">${escapeHtml(key)}</small></td>
        <td colspan="3" class="text-center text-muted"><i class="fas fa-info-circle"></i> No profiling data</td>
      `;
      profilerTableBody.appendChild(row);
      return;
    }

    hasAny = true;
    const cpu = Number(entry.cpu_ms || 0);
    const memDelta = (entry.mem_bytes !== undefined && entry.mem_bytes !== null) ? Number(entry.mem_bytes) : null; // bytes (signed)
    const endHeap = (entry.endMemUsed !== undefined && entry.endMemUsed !== null) ? Number(entry.endMemUsed) : null; // bytes

    totalCpuTime += cpu;
    if (memDelta !== null) {
      netMemBytes += memDelta;
      posMemBytes += Math.max(0, memDelta);
    }

    const memDeltaMB = memDelta !== null ? (memDelta / 1024 / 1024) : null;
    const endHeapMB = endHeap !== null ? (endHeap / 1024 / 1024) : null;

    row.innerHTML = `
      <td>
        <strong>${escapeHtml(displayName)}</strong><br><small class="text-muted">${escapeHtml(key)}</small>
      </td>
      <td class="text-end">${cpu.toFixed(2)}</td>
      <td class="text-end">${memDeltaMB !== null ? memDeltaMB.toFixed(3) : 'N/A'}</td>
      <td class="text-end">${endHeapMB !== null ? endHeapMB.toFixed(2) : 'N/A'}</td>
    `;

    row.title = `Function: ${key}\nCPU Time: ${cpu.toFixed(3)} ms\nMem Δ: ${memDeltaMB !== null ? memDeltaMB.toFixed(3) + ' MB' : 'N/A'}\nHeap: ${endHeapMB !== null ? endHeapMB.toFixed(2) + ' MB' : 'N/A'}`;
    row.style.cursor = 'help';

    profilerTableBody.appendChild(row);
  });

  if (hasAny) {
    const summaryRow = document.createElement('tr');
    summaryRow.className = 'table-warning';
    summaryRow.innerHTML = `
      <td><strong><i class="fas fa-calculator"></i> Summary</strong></td>
      <td class="text-end"><strong>${totalCpuTime.toFixed(2)}</strong></td>
      <td class="text-end"><strong>${(netMemBytes/1024/1024).toFixed(3)} MB</strong></td>
      <td class="text-end"><strong>${(posMemBytes/1024/1024).toFixed(3)} MB (allocated Δ)</strong></td>
    `;
    profilerTableBody.appendChild(summaryRow);
  }
}
