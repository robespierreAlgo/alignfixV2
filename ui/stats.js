/**
 * Copyright 2025 Samuel Frontull, Simon Haller-Seeber, and Robert Sama,
 * University of Innsbruck
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

import { getProject, downloadBinaryProject } from "../backend/js/projects.js";
import { countFixes } from "../backend/js/fixes.js";
import { bindAsyncButton } from "./utils.js";

const escapeHtml = (value) => {
  if (value === undefined || value === null) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
};

const asObject = (value) => {
  if (!value) return {};
  if (typeof value === "object") return value;

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (error) {
      console.error("Failed to parse project stats JSON:", error);
      return {};
    }
  }

  return {};
};

const numberOrNull = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const fmtNumber = (value, fallback = "0") => {
  const n = numberOrNull(value);
  return n === null ? fallback : String(n);
};

const fmtInteger = (value, fallback = "0") => {
  const n = numberOrNull(value);
  return n === null ? fallback : String(Math.round(n));
};

const fmtSeconds = (value) => {
  const n = numberOrNull(value);
  return n === null ? "0.00" : n.toFixed(2);
};

const fmtFixed = (value, digits = 2, fallback = "N/A") => {
  const n = numberOrNull(value);
  return n === null ? fallback : n.toFixed(digits);
};

const humanName = (key) => (
  String(key)
    .replace(/_/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase())
);

const firstProfilerEntry = (stats, key) => {
  const value = stats ? stats[key] : null;
  if (Array.isArray(value)) return value[0] || null;
  if (value && typeof value === "object") return value;
  return null;
};

const statCard = (label, value) => `
  <div class="col-6 col-lg-3">
    <div class="card h-100">
      <div class="card-body py-3">
        <div class="text-muted small">${escapeHtml(label)}</div>
        <div class="fs-5 fw-semibold">${escapeHtml(value)}</div>
      </div>
    </div>
  </div>
`;

const sidebarItem = (label, value) => `
  <div class="d-flex justify-content-between gap-3 py-1">
    <span class="text-muted">${escapeHtml(label)}</span>
    <span class="text-end">${escapeHtml(value ?? "-")}</span>
  </div>
`;

export async function renderStats(projectId) {
  const app = document.getElementById("app") || document.body;

  if (!projectId) {
    app.innerHTML = `
      <div class="container py-4">
        <h2>Statistics</h2>
        <p class="text-muted">Open a project first to view its statistics.</p>
      </div>
    `;
    return;
  }

  app.innerHTML = `
    <div class="container py-4">
      <div class="text-muted">Loading stats...</div>
    </div>
  `;

  let project = null;
  let numFixes = 0;

  try {
    project = await getProject(projectId);
    numFixes = await countFixes(projectId);
  } catch (error) {
    app.innerHTML = `
      <div class="container py-4">
        <div class="alert alert-danger">
          Failed to load stats: ${escapeHtml(error?.message || error)}
        </div>
      </div>
    `;
    return;
  }

  const projectStats = asObject(project?.stats);
  const srcStats = asObject(projectStats.src_stats);
  const tgtStats = asObject(projectStats.tgt_stats);
  const profilerFunctions = [
    "tokenize_src",
    "tokenize_tgt",
    "compute_alignments",
    "extract_phrases",
  ];

  const name = `Project ${projectId} - ${project?.name || "no name"}`;
  const created = project?.created_at || projectStats.created_at || "-";

  app.innerHTML = `
    <div class="container-fluid py-3">
      <div class="d-flex flex-wrap justify-content-between align-items-start gap-2 mb-3">
        <div>
          <h2 class="mb-1">${escapeHtml(name)}</h2>
          <div class="text-muted small">Created: ${escapeHtml(created)}</div>
        </div>

        <div class="d-flex flex-wrap gap-2">
          <button id="download-binary" type="button" class="btn btn-primary btn-sm">
            Download Project
          </button>
          <button id="download-stats" type="button" class="btn btn-outline-secondary btn-sm">
            Download Statistics
          </button>
          <button id="export-stats" type="button" class="btn btn-outline-secondary btn-sm">
            Download Detailed Statistics
          </button>
          <button id="refresh-stats" type="button" class="btn btn-outline-secondary btn-sm">
            Refresh
          </button>
        </div>
      </div>

      <div class="row g-3 mb-3">
        ${statCard("Phrases Extracted", fmtInteger(projectStats.total_phrases_extracted))}
        ${statCard("Phrases Filtered", fmtInteger(projectStats.total_phrases_filtered))}
        ${statCard("Phrases Ignored", fmtInteger(projectStats.total_ignored_phrases))}
        ${statCard("Number of Fixes", fmtInteger(numFixes))}
        ${statCard("DB Delete Duration (s)", fmtSeconds(projectStats.db_delete_duration_seconds))}
        ${statCard("DB Insert Duration (s)", fmtSeconds(projectStats.db_insert_duration_seconds))}
        ${statCard("Corpus Size", fmtInteger(projectStats.corpus_size))}
      </div>

      <div class="card mb-3">
        <div class="card-header">
          <strong>Performance Profiler</strong>
        </div>
        <div class="card-body">
          <div class="table-responsive">
            <table class="table table-sm align-middle mb-2">
              <thead>
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
          <div class="text-muted small">
            Performance metrics are collected during phrase extraction and alignment operations.
          </div>
        </div>
      </div>
    </div>
  `;

  const sidebar = document.getElementById("sidebar-content");
  if (sidebar) {
    sidebar.innerHTML = `
      <h5 class="mb-2">${escapeHtml(name)}</h5>
      ${sidebarItem("Corpus size", fmtInteger(projectStats.corpus_size))}
      <hr>
      <div class="fw-semibold mb-1">Source</div>
      ${sidebarItem("Longest", srcStats.longest ?? "-")}
      ${sidebarItem("Shortest", srcStats.shortest ?? "-")}
      ${sidebarItem("Avg. length", srcStats.avg_length ?? "-")}
      ${sidebarItem("Max. tokens", srcStats.max_tokens ?? "-")}
      ${sidebarItem("Avg. tokens", srcStats.avg_tokens ?? "-")}
      <hr>
      <div class="fw-semibold mb-1">Target</div>
      ${sidebarItem("Longest", tgtStats.longest ?? "-")}
      ${sidebarItem("Shortest", tgtStats.shortest ?? "-")}
      ${sidebarItem("Avg. length", tgtStats.avg_length ?? "-")}
      ${sidebarItem("Max. tokens", tgtStats.max_tokens ?? "-")}
      ${sidebarItem("Avg. tokens", tgtStats.avg_tokens ?? "-")}
    `;
  }

  const downloadBinaryButton = document.getElementById("download-binary");
  if (downloadBinaryButton) {
    bindAsyncButton(
      downloadBinaryButton,
      async () => {
        await downloadBinaryProject(projectId);
      },
      "Preparing download..."
    );
  }

  const downloadStatsButton = document.getElementById("download-stats");
  if (downloadStatsButton) {
    downloadStatsButton.addEventListener("click", () => {
      const dataStr = JSON.stringify({
        id: projectId,
        name,
        stats: projectStats,
        created_at: created,
      }, null, 2);

      const blob = new Blob([dataStr], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `project-${projectId}-stats.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    });
  }

  const refreshButton = document.getElementById("refresh-stats");
  if (refreshButton) {
    refreshButton.addEventListener("click", () => {
      renderStats(projectId);
    });
  }

  const exportButton = document.getElementById("export-stats");
  if (exportButton) {
    exportButton.addEventListener("click", () => {
      const detailedStats = {
        project: {
          id: projectId,
          name,
          created_at: created,
        },
        statistics: projectStats,
        profiling: {},
      };

      profilerFunctions.forEach((key) => {
        const entry = firstProfilerEntry(projectStats, key);
        if (entry) detailedStats.profiling[key] = entry;
      });

      const dataStr = JSON.stringify(detailedStats, null, 2);
      const blob = new Blob([dataStr], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `project-${projectId}-detailed-stats.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    });
  }

  const profilerTableBody = document.getElementById("profiler-table-body");
  if (!profilerTableBody) return;

  let netMemBytes = 0;
  let posMemBytes = 0;
  let totalCpuTime = 0;
  let hasAnyProfilerData = false;

  profilerFunctions.forEach((key) => {
    const entry = firstProfilerEntry(projectStats, key);
    const displayName = humanName(key);
    const row = document.createElement("tr");

    if (!entry) {
      row.innerHTML = `
        <td>
          <div>${escapeHtml(displayName)}</div>
          <div class="text-muted small">${escapeHtml(key)}</div>
        </td>
        <td colspan="3" class="text-muted text-end">No profiling data</td>
      `;
      profilerTableBody.appendChild(row);
      return;
    }

    hasAnyProfilerData = true;

    const cpu = numberOrNull(entry.cpu_ms) ?? 0;
    const memDelta = numberOrNull(entry.mem_bytes);
    const endHeap = numberOrNull(entry.endMemUsed);

    totalCpuTime += cpu;

    if (memDelta !== null) {
      netMemBytes += memDelta;
      posMemBytes += Math.max(0, memDelta);
    }

    const memDeltaMB = memDelta === null ? null : memDelta / 1024 / 1024;
    const endHeapMB = endHeap === null ? null : endHeap / 1024 / 1024;

    row.innerHTML = `
      <td>
        <div>${escapeHtml(displayName)}</div>
        <div class="text-muted small">${escapeHtml(key)}</div>
      </td>
      <td class="text-end">${escapeHtml(fmtFixed(cpu, 2, "0.00"))}</td>
      <td class="text-end">${escapeHtml(memDeltaMB === null ? "N/A" : memDeltaMB.toFixed(3))}</td>
      <td class="text-end">${escapeHtml(endHeapMB === null ? "N/A" : endHeapMB.toFixed(2))}</td>
    `;

    row.title = [
      `Function: ${key}`,
      `CPU Time: ${cpu.toFixed(3)} ms`,
      `Mem Δ: ${memDeltaMB === null ? "N/A" : `${memDeltaMB.toFixed(3)} MB`}`,
      `Heap: ${endHeapMB === null ? "N/A" : `${endHeapMB.toFixed(2)} MB`}`,
    ].join("\n");

    row.style.cursor = "help";
    profilerTableBody.appendChild(row);
  });

  if (hasAnyProfilerData) {
    const summaryRow = document.createElement("tr");
    summaryRow.className = "table-warning";
    summaryRow.innerHTML = `
      <td><strong>Summary</strong></td>
      <td class="text-end"><strong>${escapeHtml(totalCpuTime.toFixed(2))}</strong></td>
      <td class="text-end"><strong>${escapeHtml((netMemBytes / 1024 / 1024).toFixed(3))}</strong></td>
      <td class="text-end"><strong>${escapeHtml((posMemBytes / 1024 / 1024).toFixed(3))} allocated Δ</strong></td>
    `;
    profilerTableBody.appendChild(summaryRow);
  }
}
