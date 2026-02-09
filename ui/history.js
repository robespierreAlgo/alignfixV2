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

import { getFixes } from "../backend/js/fixes.js";

/**
 * renderHistory(projectId)
 * - Renders a history page showing all fixes for the given project
 */
export async function renderHistory(projectId) {
  const app = document.getElementById('app') || document.body;
  app.innerHTML = `<div class="container py-3"><div class="text-center">Loading...</div></div>`;

  let fixesHistory;
  try {
    fixesHistory = await getFixes(projectId);
  } catch (e) {
    app.innerHTML = `<div class="alert alert-danger">Failed to load history: ${e.message}</div>`;
    return;
  }

  app.innerHTML = `
    <div class="py-4">
      <div class="row">
        <div class="col-12">
          <div class="d-flex justify-content-between align-items-center mb-4">
            <h1 class="mb-0">
              <i class="fas fa-history text-primary me-2"></i>
              Fixes History
            </h1>
            <div class="badge bg-secondary">
              ${fixesHistory.length} fixes
            </div>
          </div>
        </div>
        
        <div class="col-12">
          <div id="stored-history" class="accordion">
            <div class="accordion-item">
              <h2 class="accordion-header" id="headingHistory">
                <button class="accordion-button" type="button" data-bs-toggle="collapse" data-bs-target="#collapseHistory"
                  aria-expanded="true" aria-controls="collapseHistory">
                  <i class="fas fa-list me-2"></i>
                  Applied Fixes (${fixesHistory.length})
                </button>
              </h2>
              <div id="collapseHistory" class="accordion-collapse collapse show" aria-labelledby="headingHistory"
                data-bs-parent="#stored-history">
                <div class="accordion-body">
                  <div id="history-list" class="list-group list-group-flush">
                    <!-- History items will be populated here -->
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  // Populate the history list
  const historyList = document.getElementById("history-list");
  
  if (fixesHistory.length === 0) {
    historyList.innerHTML = `
      <div class="text-center text-muted py-4">
        <i class="fas fa-history fa-3x mb-3"></i>
        <p>No fixes have been applied yet.</p>
      </div>
    `;
  } else {
    fixesHistory.forEach((entry, index) => {
      const fix1 = entry.src_fix ? entry.src_fix : entry.src_phrase;
      const fix2 = entry.tgt_fix ? entry.tgt_fix : entry.tgt_phrase;
      const fixType = entry.type || 'fix';
      const typeBadge = fixType === 'augment' 
        ? '<span class="badge bg-success ms-2">Augment</span>' 
        : '<span class="badge bg-primary ms-2">Fix</span>';
      
      const item = document.createElement("div");
      item.className = "list-group-item list-group-item-action";
      item.innerHTML = `
        <div class="mb-2 d-flex w-100 justify-content-between">
          <h6 class="mb-1">${typeBadge} #${index + 1}</h6>
          <div class="text-end">
            <small class="text-muted d-block">
              ${entry.created_at || 'Unknown time'}
            </small>
          </div>
        </div>
        <div class="d-flex w-100 justify-content-between">
          <h6 class="mb-1"><span class="text-muted">Original:</span>
          <code class="bg-light px-2 py-1 rounded">${entry.src_phrase}</code> 
          ↔ 
          <code class="bg-light px-2 py-1 rounded">${entry.tgt_phrase}</code>     
          </h6>
          <div class="text-end">
            <span class="badge bg-primary mt-1">${entry.num_occurrences || 1} occurrences</span>
          </div>
        </div>
        <div class="d-flex w-100 justify-content-between">
          <h6 class="mb-1">
            <span class="text-muted">${fixType === 'augment' ? 'Augmented to:' : 'Fixed to:'}</span>
            <code class="bg-warning text-black px-2 py-1 rounded">${fix1}</code> 
            ↔
            <code class="bg-warning text-black px-2 py-1 rounded">${fix2}</code>
          </h6>
          <div class="text-end">
             <span class="badge bg-secondary mt-1">${entry.percentage || 100}%</span>
          </div>
        </div>
      `;
      historyList.appendChild(item);
    });
  }
}