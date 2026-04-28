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

import { fetchPhraseOverview, ignorePhrasePair } from "../backend/js/phrases.js";
import { bindAsyncButton } from "./utils.js";

const DEFAULT_MIN_TOTAL = 10;
const DEFAULT_FETCH_LIMIT = 1000000;
const DEFAULT_PAGE_SIZE = 25;

const CONSISTENCY_SUSPICIOUS_MAX = 0.75;
const CONSISTENCY_AUTO_HIDE_MIN = 0.75;
const MANY_VARIANTS_THRESHOLD = 4;
const HIGH_UNALIGNED_THRESHOLD = 0.20;
const UNALIGNED_SENTINEL = "__ALIGNFIX_UNALIGNED__";

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatPct(value, digits = 1) {
  const num = Number(value);
  return Number.isFinite(num) ? `${(num * 100).toFixed(digits)}%` : "—";
}

function formatInt(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num.toLocaleString() : "—";
}

function normalizePhraseDisplay(text) {
  return String(text ?? "")
    .replace(/\s*#NB\s*/g, "")
    .replace(/\s*(['"’`])\s*/g, "$1")
    .replace(/\s+([,.;:!?%\]\)])/g, "$1")
    .replace(/([\[(¿¡«])\s+/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function getTotalCount(row) {
  return Number(row?.total ?? row?.num_occurrences ?? 0);
}

function getConsistency(row) {
  return Number(row?.top_share ?? 0);
}

function getUnalignedShare(row) {
  return Number(row?.unaligned_share ?? 0);
}

function getTopVariants(row) {
  const raw = Array.isArray(row?.topk) ? row.topk : [];
  return raw
    .map((item) => {
      const tgt = String(item?.tgt ?? "").trim();
      return {
        tgt,
        count: Number(item?.count ?? 0),
        share: Number(item?.share ?? 0),
        is_unaligned:
          Boolean(item?.is_unaligned) ||
          tgt === UNALIGNED_SENTINEL ||
          tgt.toLowerCase() === "unaligned",
      };
    })
    .filter((item) => item.tgt || item.is_unaligned || item.count > 0);
}

function getAlignedVariants(row) {
  return getTopVariants(row).filter((v) => !v.is_unaligned);
}

function getAlignedVariantCount(row) {
  return getAlignedVariants(row).length;
}

function hasAlignedTopVariant(row) {
  return getAlignedVariants(row).length > 0;
}

function isHideableByConsistency(row, minTotal = DEFAULT_MIN_TOTAL) {
  return (
    getTotalCount(row) >= minTotal &&
    hasAlignedTopVariant(row) &&
    getConsistency(row) >= CONSISTENCY_AUTO_HIDE_MIN
  );
}

function getHideableReasons(row, minTotal = DEFAULT_MIN_TOTAL) {
  const reasons = [];

  if (isHideableByConsistency(row, minTotal)) reasons.push("consistency");
  if (row?.hidden_by_form) reasons.push("form");
  if (row?.hidden_by_dictionary) reasons.push("dictionary");

  return reasons;
}

function computeSuspiciousReasons(row) {
  const reasons = [];
  const total = getTotalCount(row);
  const consistency = getConsistency(row);
  const numAlignedVariants = getAlignedVariantCount(row);
  const unalignedShare = getUnalignedShare(row);

  if (total >= DEFAULT_MIN_TOTAL && consistency < CONSISTENCY_SUSPICIOUS_MAX) {
    reasons.push(`low consistency ${formatPct(consistency)}`);
  }

  if (total >= DEFAULT_MIN_TOTAL && numAlignedVariants >= MANY_VARIANTS_THRESHOLD) {
    reasons.push(`${numAlignedVariants} aligned variants`);
  }

  if (total >= DEFAULT_MIN_TOTAL && unalignedShare >= HIGH_UNALIGNED_THRESHOLD) {
    reasons.push(`unaligned ${formatPct(unalignedShare)}`);
  }

  return reasons;
}

function isSuspicious(row) {
  return computeSuspiciousReasons(row).length > 0;
}

function summarizeRows(rows, minTotal = DEFAULT_MIN_TOTAL) {
  const totalRows = rows.length;
  const hideableConsistency = rows.filter((row) => isHideableByConsistency(row, minTotal)).length;
  const hideableForm = rows.filter((row) => row?.hidden_by_form).length;
  const hideableDictionary = rows.filter((row) => row?.hidden_by_dictionary).length;
  const hideableUnion = rows.filter((row) => getHideableReasons(row, minTotal).length > 0).length;
  const suspicious = rows.filter((row) => isSuspicious(row)).length;

  return {
    totalRows,
    hideableUnion,
    hideableConsistency,
    hideableForm,
    hideableDictionary,
    suspicious,
  };
}

function bucketRowsByConsistency(rows) {
  const buckets = [
    { label: "<50%", min: 0.0, max: 0.5, count: 0 },
    { label: "50–75%", min: 0.5, max: CONSISTENCY_SUSPICIOUS_MAX, count: 0 },
    { label: "75–80%", min: CONSISTENCY_SUSPICIOUS_MAX, max: 0.8, count: 0 },
    { label: "80–95%", min: 0.8, max: 0.95, count: 0 },
    { label: "95–100%", min: 0.95, max: 1.01, count: 0 },
  ];

  for (const row of rows) {
    const value = getConsistency(row);
    const bucket = buckets.find((b) => value >= b.min && value < b.max);
    if (bucket) bucket.count += 1;
  }

  return buckets;
}

function bucketRowsByOccurrence(rows) {
  const buckets = [
    { label: "10–19", count: 0 },
    { label: "20–49", count: 0 },
    { label: "50–99", count: 0 },
    { label: "100–199", count: 0 },
    { label: "200+", count: 0 },
  ];

  for (const row of rows) {
    const total = getTotalCount(row);

    if (total >= 200) buckets[4].count += 1;
    else if (total >= 100) buckets[3].count += 1;
    else if (total >= 50) buckets[2].count += 1;
    else if (total >= 20) buckets[1].count += 1;
    else if (total >= 10) buckets[0].count += 1;
  }

  return buckets;
}

function countSuspiciousReasons(rows) {
  const counts = {
    "low consistency": 0,
    "many variants": 0,
    "high unaligned": 0,
  };

  for (const row of rows) {
    const total = getTotalCount(row);
    const consistency = getConsistency(row);
    const numAlignedVariants = getAlignedVariantCount(row);
    const unalignedShare = getUnalignedShare(row);

    if (total >= DEFAULT_MIN_TOTAL && consistency < CONSISTENCY_SUSPICIOUS_MAX) {
      counts["low consistency"] += 1;
    }

    if (total >= DEFAULT_MIN_TOTAL && numAlignedVariants >= MANY_VARIANTS_THRESHOLD) {
      counts["many variants"] += 1;
    }

    if (total >= DEFAULT_MIN_TOTAL && unalignedShare >= HIGH_UNALIGNED_THRESHOLD) {
      counts["high unaligned"] += 1;
    }
  }

  return Object.entries(counts).map(([label, count]) => ({ label, count }));
}

function renderMetricCard(card) {
  return `
    <div class="col-12 col-md-4">
      <div class="card h-100 border-${escapeHtml(card.cls || "secondary")}">
        <div class="card-body py-3">
          <div class="text-muted small">${escapeHtml(card.label)}</div>
          <div class="fs-4 fw-semibold">${escapeHtml(card.value)}</div>
          <div class="text-muted small">${escapeHtml(card.hint || "")}</div>
        </div>
      </div>
    </div>
  `;
}

function renderSummaryCards(rows, minTotal = DEFAULT_MIN_TOTAL) {
  const summary = summarizeRows(rows, minTotal);
  const cards = [
    {
      label: "Project words",
      value: formatInt(summary.totalRows),
      hint: "single-word source phrases",
      cls: "primary",
    },
    {
      label: "Hideable",
      value: formatInt(summary.hideableUnion),
      hint: "at least one automatic hide reason",
      cls: "success",
    },
    {
      label: "Suspicious",
      value: formatInt(summary.suspicious),
      hint: "needs manual review signal",
      cls: "warning",
    },
  ];

  return `<div class="row g-2 mb-3">${cards.map(renderMetricCard).join("")}</div>`;
}

function renderBarList(items) {
  const maxCount = Math.max(1, ...items.map((item) => Number(item?.count ?? 0)));

  return items
    .map((item) => {
      const count = Number(item?.count ?? 0);
      const width = (count / maxCount) * 100;

      return `
        <div class="mb-2">
          <div class="d-flex justify-content-between small">
            <span>${escapeHtml(item.label)}</span>
            <span>${formatInt(count)}</span>
          </div>
          <div class="progress" style="height: 7px;">
            <div class="progress-bar" role="progressbar" style="width: ${width.toFixed(2)}%;"></div>
          </div>
        </div>
      `;
    })
    .join("");
}

function renderSegmentBar(items, total) {
  const safeTotal = Math.max(1, Number(total || 0));

  const classFor = (key) => {
    if (key === "hideable") return "bg-success";
    if (key === "review") return "bg-warning text-dark";
    return "bg-secondary";
  };

  return `
    <div class="progress mb-2" style="height: 14px;">
      ${items
        .map((item) => {
          const value = Math.max(0, Number(item.count || 0));
          const width = Math.max(0, Math.min(100, (value / safeTotal) * 100));

          return `
            <div
              class="progress-bar ${classFor(item.key)}"
              role="progressbar"
              style="width: ${width.toFixed(2)}%;"
              title="${escapeHtml(item.label)}: ${formatInt(item.count)}"
            ></div>
          `;
        })
        .join("")}
    </div>
    <div class="d-flex flex-wrap gap-2 small text-muted">
      ${items
        .map((item) => `<span>${escapeHtml(item.label)}: ${formatInt(item.count)}</span>`)
        .join("")}
    </div>
  `;
}

function renderCompactDiagramCard(title, items) {
  return `
    <div class="col-12 col-xl-3 col-md-6">
      <div class="card h-100">
        <div class="card-body py-3">
          <h6 class="mb-3">${escapeHtml(title)}</h6>
          ${renderBarList(items)}
        </div>
      </div>
    </div>
  `;
}

function renderOverview(rows, minTotal = DEFAULT_MIN_TOTAL) {
  const summary = summarizeRows(rows, minTotal);
  const hideableRows = rows.filter((row) => getHideableReasons(row, minTotal).length > 0);
  const reviewRows = rows.filter(
    (row) => isSuspicious(row) && getHideableReasons(row, minTotal).length === 0
  );
  const otherRows = rows.filter(
    (row) => !isSuspicious(row) && getHideableReasons(row, minTotal).length === 0
  );

  const projectSplit = [
    { key: "hideable", label: "hideable", count: hideableRows.length },
    { key: "review", label: "needs review", count: reviewRows.length },
    { key: "other", label: "other", count: otherRows.length },
  ];

  const hideableItems = [
    { label: "consistency", count: summary.hideableConsistency },
    { label: "form", count: summary.hideableForm },
    { label: "dictionary", count: summary.hideableDictionary },
  ];

  const consistencyBuckets = bucketRowsByConsistency(rows);
  const suspiciousReasonCounts = countSuspiciousReasons(rows);

  return `
    ${renderSummaryCards(rows, minTotal)}

    <div class="card mb-3">
      <div class="card-body py-3">
        <div class="d-flex justify-content-between align-items-center mb-2">
          <h6 class="mb-0">Project split</h6>
          <span class="text-muted small">${formatInt(summary.totalRows)} words</span>
        </div>
        ${renderSegmentBar(projectSplit, summary.totalRows)}
      </div>
    </div>

    <div class="row g-2 mb-3">
      ${renderCompactDiagramCard("Consistency", consistencyBuckets)}
      ${renderCompactDiagramCard("Hide reasons", hideableItems)}
      ${renderCompactDiagramCard("Suspicious signals", suspiciousReasonCounts)}
      ${renderCompactDiagramCard("Occurrence volume", bucketRowsByOccurrence(rows))}
    </div>
  `;
}

function getSortableRows(rows, sortMode) {
  const sorted = [...rows];

  const compare = {
    suspicious: (a, b) =>
      computeSuspiciousReasons(b).length - computeSuspiciousReasons(a).length ||
      getConsistency(a) - getConsistency(b) ||
      getTotalCount(b) - getTotalCount(a) ||
      String(a?.src_phrase || "").localeCompare(String(b?.src_phrase || "")),

    lowest_consistency: (a, b) =>
      getConsistency(a) - getConsistency(b) ||
      getTotalCount(b) - getTotalCount(a) ||
      computeSuspiciousReasons(b).length - computeSuspiciousReasons(a).length,

    highest_unaligned: (a, b) =>
      getUnalignedShare(b) - getUnalignedShare(a) ||
      getConsistency(a) - getConsistency(b) ||
      getTotalCount(b) - getTotalCount(a),

    most_variants: (a, b) =>
      getAlignedVariantCount(b) - getAlignedVariantCount(a) ||
      getConsistency(a) - getConsistency(b) ||
      getTotalCount(b) - getTotalCount(a),

    most_frequent: (a, b) =>
      getTotalCount(b) - getTotalCount(a) ||
      getConsistency(a) - getConsistency(b),
  }[sortMode];

  sorted.sort(compare || ((a, b) => getTotalCount(b) - getTotalCount(a)));
  return sorted;
}

function renderTableRows(rows, selectedIndex, startIndex, minTotal = DEFAULT_MIN_TOTAL) {
  if (!rows.length) {
    return `
      <tr>
        <td colspan="8" class="text-muted py-4 text-center">
          No words found for the current filters.
        </td>
      </tr>
    `;
  }

  return rows
    .map((row, localIndex) => {
      const absoluteIndex = startIndex + localIndex;
      const selectedClass = absoluteIndex === selectedIndex ? "table-active" : "";
      const reasons = computeSuspiciousReasons(row);
      const hideReasons = getHideableReasons(row, minTotal);
      const best = getAlignedVariants(row)[0] || getTopVariants(row)[0] || null;
      const bestLabel = best
        ? best.is_unaligned
          ? "unaligned"
          : normalizePhraseDisplay(best.tgt || "—")
        : "—";

      return `
        <tr class="review-row ${selectedClass}" data-row-index="${absoluteIndex}" style="cursor:pointer;">
          <td class="fw-semibold">${escapeHtml(normalizePhraseDisplay(row.src_phrase))}</td>
          <td>${escapeHtml(bestLabel)}</td>
          <td>${formatPct(getConsistency(row))}</td>
          <td>${formatInt(getTotalCount(row))}</td>
          <td>${formatInt(getAlignedVariantCount(row))}</td>
          <td>${formatPct(getUnalignedShare(row))}</td>
          <td>
            ${
              hideReasons.length
                ? hideReasons
                    .map((reason) => `<span class="badge text-bg-success me-1">${escapeHtml(reason)}</span>`)
                    .join("")
                : `<span class="text-muted">—</span>`
            }
          </td>
          <td>
            ${
              reasons.length
                ? `<span class="badge text-bg-warning text-dark">${reasons.length} flag${reasons.length === 1 ? "" : "s"}</span>`
                : `<span class="badge text-bg-light">ok</span>`
            }
          </td>
        </tr>
      `;
    })
    .join("");
}

function renderCriterionRow(label, isMet) {
  return `
    <div class="d-flex justify-content-between align-items-center border-bottom py-1">
      <span>${escapeHtml(label)}</span>
      ${
        isMet
          ? `<span class="badge rounded-pill text-dark" style="background:#facc15;">yes</span>`
          : `<span class="text-muted">no</span>`
      }
    </div>
  `;
}

function renderDetailPane(row, minTotal = DEFAULT_MIN_TOTAL) {
  if (!row) {
    return `
      <div class="text-muted">
        Select a word to inspect its variants and hide/review signals.
      </div>
    `;
  }

  const variants = getTopVariants(row);
  const aligned = getAlignedVariants(row);
  const bestAligned = aligned[0] || null;
  const hideReasons = getHideableReasons(row, minTotal);
  const total = getTotalCount(row);
  const consistency = getConsistency(row);
  const numAlignedVariants = getAlignedVariantCount(row);
  const unalignedShare = getUnalignedShare(row);
  const lowConsistency = total >= DEFAULT_MIN_TOTAL && consistency < CONSISTENCY_SUSPICIOUS_MAX;
  const manyVariants = total >= DEFAULT_MIN_TOTAL && numAlignedVariants >= MANY_VARIANTS_THRESHOLD;
  const highUnaligned = total >= DEFAULT_MIN_TOTAL && unalignedShare >= HIGH_UNALIGNED_THRESHOLD;
  const src = String(row?.src_phrase || "");
  const tgt = String(bestAligned?.tgt || "");
  const canHidePair = Boolean(src && tgt);

  return `
    <div class="d-flex justify-content-between align-items-start gap-2 mb-3">
      <div>
        <div class="text-muted small">Selected word</div>
        <div class="fs-5 fw-semibold">${escapeHtml(normalizePhraseDisplay(src))}</div>
      </div>
      <div class="d-flex gap-2">
        <button
          id="hide-top-pair-btn"
          type="button"
          class="btn btn-outline-secondary btn-sm"
          data-src="${escapeHtml(src)}"
          data-tgt="${escapeHtml(tgt)}"
          ${canHidePair ? "" : "disabled"}
        >
          Hide pair
        </button>
        <button
          id="jump-project-occurrences-btn"
          type="button"
          class="btn btn-outline-primary btn-sm"
        >
          Show in Project
        </button>
      </div>
    </div>

    <div class="row g-2 mb-3">
      <div class="col-6">
        <div class="border rounded p-2 h-100">
          <div class="text-muted small">Best aligned target</div>
          <div class="fw-semibold">${escapeHtml(normalizePhraseDisplay(bestAligned?.tgt || "—"))}</div>
        </div>
      </div>
      <div class="col-6">
        <div class="border rounded p-2 h-100">
          <div class="text-muted small">Consistency</div>
          <div class="fw-semibold">${formatPct(consistency)}</div>
        </div>
      </div>
      <div class="col-4">
        <div class="border rounded p-2 h-100">
          <div class="text-muted small">Occurrences</div>
          <div class="fw-semibold">${formatInt(total)}</div>
        </div>
      </div>
      <div class="col-4">
        <div class="border rounded p-2 h-100">
          <div class="text-muted small">Aligned variants</div>
          <div class="fw-semibold">${formatInt(numAlignedVariants)}</div>
        </div>
      </div>
      <div class="col-4">
        <div class="border rounded p-2 h-100">
          <div class="text-muted small">Unaligned share</div>
          <div class="fw-semibold">${formatPct(unalignedShare)}</div>
        </div>
      </div>
    </div>

    <div class="mb-3">
      <div class="text-muted small mb-1">Hideable because of</div>
      ${
        hideReasons.length
          ? hideReasons
              .map((reason) => `<span class="badge text-bg-success me-1">${escapeHtml(reason)}</span>`)
              .join("")
          : `<div class="text-muted small">Not automatically hideable by the current rules.</div>`
      }
    </div>

    <div class="mb-3">
      <h6>Suspicious criteria</h6>
      ${renderCriterionRow("low consistency", lowConsistency)}
      ${renderCriterionRow("many aligned variants", manyVariants)}
      ${renderCriterionRow("high unaligned share", highUnaligned)}
    </div>

    <div>
      <h6>Variants</h6>
      ${
        variants.length
          ? variants
              .map((variant, idx) => {
                const label = variant.is_unaligned
                  ? "unaligned"
                  : normalizePhraseDisplay(variant.tgt || "—");
                const badgeClass =
                  idx === 0
                    ? "text-bg-primary"
                    : variant.is_unaligned
                      ? "text-bg-secondary"
                      : "text-bg-light";

                return `
                  <div class="d-flex justify-content-between align-items-start border-bottom py-2">
                    <div>
                      <span class="badge ${badgeClass} me-2">${idx + 1}</span>
                      <span>${escapeHtml(label)}</span>
                    </div>
                    <div class="text-end small">
                      <div>${formatInt(variant.count)} occurrences</div>
                      <div class="text-muted">${formatPct(variant.share)}</div>
                    </div>
                  </div>
                `;
              })
              .join("")
          : `<div class="text-muted small">No variants reported.</div>`
      }
    </div>
  `;
}

function getStateKey(projectId) {
  return `alignfix-review-state:v6:${projectId}`;
}

function loadSavedState(projectId) {
  try {
    const raw = localStorage.getItem(getStateKey(projectId));
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (error) {
    console.warn("Failed to load saved review state:", error);
    return null;
  }
}

function saveState(projectId, state) {
  try {
    localStorage.setItem(getStateKey(projectId), JSON.stringify(state));
  } catch (error) {
    console.warn("Failed to save review state:", error);
  }
}

function applyProjectOccurrenceJump(payload, attemptsLeft = 70) {
  const src = String(payload?.src || "").trim();
  const direction = String(payload?.direction ?? "0");

  if (!src) return;

  const phrasesTableEl = document.getElementById("phrases-table");
  const translationsTableEl = document.getElementById("translations-table");
  const srcInput = document.getElementById("fix-test1");
  const srcFixInput = document.getElementById("fix-fix1");
  const tgtFixInput = document.getElementById("fix-fix2");

  const canUseDataTables =
    typeof window.$ === "function" &&
    Boolean(window.$.fn?.DataTable) &&
    Boolean(phrasesTableEl) &&
    Boolean(translationsTableEl) &&
    Boolean(srcInput);

  if (!canUseDataTables) {
    if (attemptsLeft > 0) {
      window.setTimeout(() => applyProjectOccurrenceJump(payload, attemptsLeft - 1), 120);
    }
    return;
  }

  const setVisibleDataTableSearchInput = (tableId, value) => {
    const input = window.$(`#${tableId}_filter input[type="search"]`);
    if (input.length) input.val(value);
  };

  window.$("#fix-test1").val(src);
  window.$("#fix-fix1").val(src);
  window.$("#fix-test2").val("");
  window.$("#fix-fix2").val("");
  window.$("#fix-direction").val(direction);

  if (srcFixInput) srcFixInput.disabled = false;
  if (tgtFixInput) tgtFixInput.disabled = true;

  window.$("#translations-table").data("unaligned-only", false);
  window.$("#translations-table").data("all-occurrences", true);

  try {
    const phrasesTable = window.$("#phrases-table").DataTable();
    const translationsTable = window.$("#translations-table").DataTable();

    // Fill the visible DataTables search fields, so the Project page clearly shows
    // which Review word is being inspected.
    setVisibleDataTableSearchInput("phrases-table", src);
    setVisibleDataTableSearchInput("translations-table", src);

    // Restrict both Project tables to the selected source word.
    phrasesTable.search(src).page("first").draw();
    translationsTable.search(src).page("first").draw("page");
  } catch (error) {
    if (attemptsLeft > 0) {
      window.setTimeout(() => applyProjectOccurrenceJump(payload, attemptsLeft - 1), 120);
      return;
    }
    console.warn("Could not open occurrences in Project page:", error);
  }

  translationsTableEl.scrollIntoView({ behavior: "smooth", block: "start" });
}

function jumpToProjectOccurrences(projectId, row) {
  const src = String(row?.src_phrase || "").trim();
  if (!src) return;

  const payload = {
    projectId: String(projectId),
    src,
    direction: String(row?.direction ?? "0"),
    createdAt: Date.now(),
  };

  try {
    localStorage.setItem(`alignfix:review-jump-occurrences:${projectId}`, JSON.stringify(payload));
  } catch (error) {
    console.warn("Could not persist review jump target:", error);
  }

  window.location.hash = `#project-${projectId}`;
  window.setTimeout(() => applyProjectOccurrenceJump(payload), 180);
}

export async function renderReview(projectId) {
  const app = document.getElementById("app") || document.body;
  const sidebar = document.getElementById("sidebar-content");
  const persisted = loadSavedState(projectId) || {};

  if (sidebar) {
    sidebar.innerHTML = `
      <h5>Review</h5>
      <p class="text-muted small mb-2">
        Project-level overview for alignment cleanup and translation consistency checks.
      </p>
      <p class="text-muted small mb-0">
        The diagrams show how much can likely be hidden automatically, how much still needs review,
        and which words are most useful to inspect. Click a word to see its variants and detailed flags.
      </p>
    `;
  }

  app.innerHTML = `
    <div class="container-fluid py-3">
      <div class="d-flex justify-content-between align-items-start flex-wrap gap-2 mb-3">
        <div>
          <h2 class="mb-1">Review</h2>
          <div class="text-muted">Project ${escapeHtml(projectId)} · whole-project overview</div>
        </div>
        <button id="review-refresh-btn" type="button" class="btn btn-outline-secondary btn-sm">
          Refresh data
        </button>
      </div>

      <div id="review-overview"></div>

      <div class="row g-3">
        <div class="col-12 col-xl-5">
          <div class="card h-100">
            <div class="card-header">
              <h5 class="mb-0">Detailed view</h5>
            </div>
            <div id="review-detail-pane" class="card-body">
              <div class="text-muted">Select a word to inspect details.</div>
            </div>
          </div>
        </div>

        <div class="col-12 col-xl-7">
          <div class="card h-100">
            <div class="card-header">
              <div class="d-flex justify-content-between align-items-center flex-wrap gap-2">
                <h5 class="mb-0">Words</h5>
                <span id="review-table-meta" class="text-muted small"></span>
              </div>
            </div>

            <div class="card-body">
              <div class="row g-2 align-items-end mb-3">
                <div class="col-6 col-md-2">
                  <label for="review-min-total" class="form-label small">Min</label>
                  <input
                    id="review-min-total"
                    type="number"
                    min="1"
                    class="form-control form-control-sm"
                    value="${escapeHtml(persisted.minTotal ?? DEFAULT_MIN_TOTAL)}"
                  >
                </div>

                <div class="col-6 col-md-3">
                  <label for="review-search" class="form-label small">Search</label>
                  <input
                    id="review-search"
                    type="search"
                    class="form-control form-control-sm"
                    value="${escapeHtml(persisted.search ?? "")}"
                  >
                </div>

                <div class="col-12 col-md-4">
                  <label for="review-sort-mode" class="form-label small">Order by</label>
                  <select id="review-sort-mode" class="form-select form-select-sm">
                    <option value="suspicious">Most suspicious</option>
                    <option value="lowest_consistency">Lowest consistency</option>
                    <option value="highest_unaligned">Highest unaligned</option>
                    <option value="most_variants">Most variants</option>
                    <option value="most_frequent">Most frequent</option>
                  </select>
                </div>

                <div class="col-6 col-md-3">
                  <div class="form-check form-switch">
                    <input
                      class="form-check-input"
                      type="checkbox"
                      role="switch"
                      id="review-suspicious-only"
                      ${persisted.suspiciousOnly ? "checked" : ""}
                    >
                    <label class="form-check-label small" for="review-suspicious-only">
                      Suspicious only
                    </label>
                  </div>
                  <div class="form-check form-switch">
                    <input
                      class="form-check-input"
                      type="checkbox"
                      role="switch"
                      id="review-hide-hideable"
                      ${persisted.hideHideable ? "checked" : ""}
                    >
                    <label class="form-check-label small" for="review-hide-hideable">
                      Hide hideable
                    </label>
                  </div>
                </div>
              </div>

              <div class="table-responsive">
                <table class="table table-sm align-middle mb-2">
                  <thead>
                    <tr>
                      <th>Word</th>
                      <th>Best target</th>
                      <th>Consistency</th>
                      <th>Occ.</th>
                      <th>Variants</th>
                      <th>Unaligned</th>
                      <th>Hideable</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody id="review-table-body">
                    <tr>
                      <td colspan="8" class="text-muted py-4 text-center">Loading…</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div class="d-flex justify-content-between align-items-center gap-2">
                <button id="review-prev-page-btn" type="button" class="btn btn-outline-secondary btn-sm">
                  Previous page
                </button>
                <span id="review-visible-meta" class="text-muted small"></span>
                <button id="review-next-page-btn" type="button" class="btn btn-outline-secondary btn-sm">
                  Next page
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  const sortSelect = document.getElementById("review-sort-mode");
  if (sortSelect && persisted.sortMode) sortSelect.value = persisted.sortMode;

  const state = {
    rawRows: [],
    overviewRows: [],
    rows: [],
    selectedIndex: -1,
    currentPage: Math.max(0, Number(persisted.currentPage || 0)),
  };

  function getControls() {
    return {
      minTotal: Math.max(1, Number(document.getElementById("review-min-total")?.value || DEFAULT_MIN_TOTAL)),
      search: String(document.getElementById("review-search")?.value || "").trim().toLowerCase(),
      sortMode: document.getElementById("review-sort-mode")?.value || "suspicious",
      suspiciousOnly: Boolean(document.getElementById("review-suspicious-only")?.checked),
      hideHideable: Boolean(document.getElementById("review-hide-hideable")?.checked),
    };
  }

  function persistControls() {
    const controls = getControls();
    const selectedRow = state.rows[state.selectedIndex] || null;

    saveState(projectId, {
      ...controls,
      currentPage: state.currentPage,
      selectedSource: selectedRow?.src_phrase || null,
      selectedTgt: getAlignedVariants(selectedRow || {})[0]?.tgt || null,
    });
  }

  function restoreSelection(savedSelection) {
    if (!savedSelection?.selectedSource) return false;

    const index = state.rows.findIndex((row) => {
      const aligned = getAlignedVariants(row)[0] || null;
      return (
        String(row?.src_phrase || "") === String(savedSelection.selectedSource || "") &&
        String(aligned?.tgt || "") === String(savedSelection.selectedTgt || "")
      );
    });

    if (index >= 0) {
      state.selectedIndex = index;
      return true;
    }

    return false;
  }

  function bindTableRowHandlers() {
    document.querySelectorAll(".review-row").forEach((rowEl) => {
      rowEl.addEventListener("click", () => {
        const index = Number(rowEl.dataset.rowIndex);
        if (!Number.isFinite(index)) return;

        state.selectedIndex = index;
        persistControls();
        redraw();
      });
    });
  }

  function bindDetailHandlers() {
    const hideBtn = document.getElementById("hide-top-pair-btn");

    if (hideBtn) {
      bindAsyncButton(
        hideBtn,
        async () => {
          const src = hideBtn.dataset.src;
          const tgt = hideBtn.dataset.tgt;
          if (!src || !tgt) return;

          await ignorePhrasePair(projectId, src, tgt);
          await loadReviewData();
        },
        "Hiding..."
      );
    }

    const jumpBtn = document.getElementById("jump-project-occurrences-btn");

    if (jumpBtn) {
      jumpBtn.onclick = () => {
        const row = state.rows[state.selectedIndex] || null;
        if (!row) return;
        jumpToProjectOccurrences(projectId, row);
      };
    }
  }

  function bindStaticButtonHandlers() {
    const prevBtn = document.getElementById("review-prev-page-btn");
    const nextBtn = document.getElementById("review-next-page-btn");

    if (prevBtn) {
      prevBtn.onclick = () => {
        state.currentPage = Math.max(0, state.currentPage - 1);
        persistControls();
        redraw();
      };
    }

    if (nextBtn) {
      nextBtn.onclick = () => {
        const maxPage = Math.max(0, Math.ceil(state.rows.length / DEFAULT_PAGE_SIZE) - 1);
        state.currentPage = Math.min(maxPage, state.currentPage + 1);
        persistControls();
        redraw();
      };
    }
  }

  function redraw() {
    const controls = getControls();
    const totalRows = state.rows.length;
    const totalPages = Math.max(1, Math.ceil(totalRows / DEFAULT_PAGE_SIZE));

    if (state.currentPage > totalPages - 1) {
      state.currentPage = totalPages - 1;
    }

    const start = state.currentPage * DEFAULT_PAGE_SIZE;
    const end = Math.min(start + DEFAULT_PAGE_SIZE, totalRows);
    const visibleRows = state.rows.slice(start, end);
    const currentRow = state.rows[state.selectedIndex] || null;

    document.getElementById("review-overview").innerHTML = renderOverview(
      state.overviewRows,
      controls.minTotal
    );

    document.getElementById("review-table-body").innerHTML = renderTableRows(
      visibleRows,
      state.selectedIndex,
      start,
      controls.minTotal
    );

    document.getElementById("review-detail-pane").innerHTML = renderDetailPane(
      currentRow,
      controls.minTotal
    );

    document.getElementById("review-table-meta").textContent =
      `${formatInt(totalRows)} words after filters`;

    document.getElementById("review-visible-meta").textContent =
      totalRows > 0
        ? `Page ${formatInt(state.currentPage + 1)} of ${formatInt(totalPages)} · rows ${formatInt(start + 1)}–${formatInt(end)} of ${formatInt(totalRows)}`
        : "Page 1 of 1 · 0 rows";

    const prevBtn = document.getElementById("review-prev-page-btn");
    const nextBtn = document.getElementById("review-next-page-btn");

    if (prevBtn) prevBtn.disabled = state.currentPage <= 0 || totalRows === 0;
    if (nextBtn) nextBtn.disabled = state.currentPage >= totalPages - 1 || totalRows === 0;

    bindStaticButtonHandlers();
    bindTableRowHandlers();
    bindDetailHandlers();
  }

  function applyFiltersAndSort() {
    const controls = getControls();

    let rows = [...state.rawRows].filter((row) => getTotalCount(row) >= controls.minTotal);

    if (controls.search) {
      rows = rows.filter((row) => {
        const bestTarget = getAlignedVariants(row)[0]?.tgt || row?.tgt_phrase || "";

        return (
          String(row?.src_phrase || "").toLowerCase().includes(controls.search) ||
          String(bestTarget).toLowerCase().includes(controls.search)
        );
      });
    }

    // Important: overview diagrams use the searched/min-total set before table-only filters.
    // This prevents "Hide reasons" from becoming 0 after reload when "Hide hideable" is active.
    state.overviewRows = getSortableRows(rows, controls.sortMode);

    if (controls.hideHideable) {
      rows = rows.filter((row) => getHideableReasons(row, controls.minTotal).length === 0);
    }

    if (controls.suspiciousOnly) {
      rows = rows.filter((row) => isSuspicious(row));
    }

    state.rows = getSortableRows(rows, controls.sortMode);
  }

  async function loadReviewData() {
    const tbody = document.getElementById("review-table-body");
    if (tbody) {
      tbody.innerHTML = `
        <tr>
          <td colspan="8" class="text-muted py-4 text-center">Loading…</td>
        </tr>
      `;
    }

    const params = {
      draw: 1,
      start: 0,
      length: DEFAULT_FETCH_LIMIT,
      project_id: projectId,
      min_phrase_len: 1,
      directions: new Set(["0", "-1", "1"]),
      minTotal: 1,
      singleTokenOnly: true,
      hideConsistency: false,
      hideFormAligned: false,
      hideDictionary: false,
      suspiciousOnly: false,
      sortMode: "frequency",
      search: { value: "" },
    };

    try {
      const result = await fetchPhraseOverview(params);
      const rawRows = Array.isArray(result?.data) ? result.data : [];

      state.rawRows = rawRows.map((row) => ({
        ...row,
        suspicious_reasons: computeSuspiciousReasons(row),
      }));

      applyFiltersAndSort();

      if (!restoreSelection(loadSavedState(projectId))) {
        if (!state.rows.length) {
          state.selectedIndex = -1;
        } else if (state.selectedIndex < 0 || state.selectedIndex >= state.rows.length) {
          state.selectedIndex = 0;
        }
      }

      persistControls();
      redraw();
    } catch (error) {
      console.error("Error loading review dashboard:", error);

      const message = escapeHtml(error?.message || error);

      document.getElementById("review-overview").innerHTML = "";
      document.getElementById("review-table-body").innerHTML = `
        <tr>
          <td colspan="8" class="text-danger py-4 text-center">
            Failed to load review data: ${message}
          </td>
        </tr>
      `;
      document.getElementById("review-detail-pane").innerHTML = `
        <div class="alert alert-danger mb-0">${message}</div>
      `;
      document.getElementById("review-visible-meta").textContent = "";
      document.getElementById("review-table-meta").textContent = "";

      const prevBtn = document.getElementById("review-prev-page-btn");
      const nextBtn = document.getElementById("review-next-page-btn");

      if (prevBtn) prevBtn.disabled = true;
      if (nextBtn) nextBtn.disabled = true;
    }
  }

  bindAsyncButton(document.getElementById("review-refresh-btn"), loadReviewData, "Loading...");

  [
    "review-min-total",
    "review-search",
    "review-sort-mode",
    "review-suspicious-only",
    "review-hide-hideable",
  ].forEach((id) => {
    const element = document.getElementById(id);
    if (!element) return;

    const eventName = id === "review-search" ? "input" : "change";

    element.addEventListener(eventName, () => {
      state.selectedIndex = -1;
      state.currentPage = 0;

      if (state.rawRows.length) {
        applyFiltersAndSort();
        if (state.rows.length) state.selectedIndex = 0;
        persistControls();
        redraw();
      } else {
        loadReviewData();
      }
    });
  });

  bindStaticButtonHandlers();
  await loadReviewData();
}
