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
import { writeFileInChunks } from './utils.js';
import { safeSyncfs } from "./storage.js";
import { nextFrame } from "../../ui/utils.js";

export async function importScoresFromFile(project_id, scores) {
  const pyodide = await initPyodide();

  console.log("Importing scores for project:", project_id);

  pyodide.globals.set("project_id", project_id);
  pyodide.globals.set("scores", scores);

  await pyodide.runPythonAsync(`
    from scores import import_scores_from_file
    import_scores_from_file(project_id, scores)
  `);

  await safeSyncfs(pyodide);

  return;
}

export async function assignAutoScores(project_id) {
  const pyodide = await initPyodide();

  console.log("Assigning automatic scores for project:", project_id);

  pyodide.globals.set("project_id", project_id);

  await pyodide.runPythonAsync(`
    from scores import assign_auto_scores
    assign_auto_scores(project_id)
  `);

  await safeSyncfs(pyodide);
  return;
}

async function computeStabilityScores(project_id, numCores) {
  
  const pyodide = await initPyodide(); 
  pyodide.globals.set("project_id", project_id);

  const result = await pyodide.runPythonAsync(`
      from projects import get_alignments
      src_lines, tgt_lines, align_lines, score_lines = get_alignments(project_id)
      (src_lines, tgt_lines, align_lines, score_lines)
    `);

  const [src_lines, tgt_lines, align_lines, score_lines] = result;

  console.log('operation:Initializing WASM alignment scoring module');
  const { createModule, config } = await window.WasmModuleLoader.loadAlignmentScore();
  const poolSize = Math.min(config.poolSize, numCores);
  const module = await createModule({ 
    pthreadPoolSize: poolSize
  });
  console.log(`✅ Alignment scoring module loaded (${poolSize} threads)`);

  // File paths for WASM processing
  const srcFilename = "/src.txt";
  const tgtFilename = "/tgt.txt";
  const alignFilename = "/align.txt";
  const scoreFilename = "/scores.txt";  

  // Write all data to virtual filesystem in chunks to avoid memory issues
  console.log(`📁 Writing ${src_lines.length} lines to WASM filesystem in chunks...`);
  writeFileInChunks(module, srcFilename, src_lines);
  writeFileInChunks(module, tgtFilename, tgt_lines);
  writeFileInChunks(module, alignFilename, align_lines);
  
  console.log(`📁 All files written to WASM filesystem`);
  
  // Allow UI to update after file writing
  await nextFrame();

  const start_idx = 0;
  const end_idx = src_lines.length;

  // Single extraction call for all data
  await module.ccall(
      "alignment_score_main",
      null,
      [
          "string", "string", "string", "string",
          "number", "number", "number"
      ],
      [
          srcFilename, tgtFilename, alignFilename, scoreFilename,
          start_idx, end_idx, poolSize
      ]
  );

  const content = module.FS.readFile(scoreFilename, { encoding: 'utf8' });
  
  // Cleanup files
  try { module.FS.unlink(srcFilename); } catch(e){}
  try { module.FS.unlink(tgtFilename); } catch(e){}
  try { module.FS.unlink(alignFilename); } catch(e){}
  try { module.FS.unlink(scoreFilename); } catch(e){}
  const lines = content.split(/\r?\n/);
  const scores = lines
    .map(line => parseFloat(line));

  console.log(`Parsed ${scores.length} scores`);

  return scores;

}


async function saveScores(project_id, scores) {
  const pyodide = await initPyodide();

  console.log("Saving stability scores for project:", project_id);

  pyodide.globals.set("project_id", project_id);
  pyodide.globals.set("scores", scores);  // Pass as a JavaScript object, not stringified

  await pyodide.runPythonAsync(`
    from scores import save_scores
    save_scores(project_id, scores)
  `);

  await safeSyncfs(pyodide);

  return;
}

export async function assignStabilityScores(project_id) {
  const numCores = navigator.hardwareConcurrency || 4;
  const scores = await computeStabilityScores(project_id, numCores);
  await saveScores(project_id, scores);
  return;
}


export async function getScores(project_id) {
  const pyodide = await initPyodide();

  console.log("Fetching scores for project:", project_id);

  pyodide.globals.set("project_id", project_id);

  const binCount = 20;

  const binnedScores = await pyodide.runPythonAsync(`
    from scores import get_scores, bin_scores

    scores = get_scores(project_id)
    values = [round(float(s[0]),2) for s in scores if s is not None]
    binned = bin_scores(values, ${binCount})
    binned
  `);

  return binnedScores.toJs(); // returns array of objects: [{bin, count}, ...]
}

export async function getAlignmentsWithScores(projectId, currentPage, pageSize, currentFilters) {
  const pyodide = await initPyodide();
  pyodide.globals.set("project_id", projectId);
  pyodide.globals.set("page", currentPage - 1); // 0-indexed
  pyodide.globals.set("page_size", pageSize);
  // Convert null to undefined so Python receives None instead of JsNull
  pyodide.globals.set("min_score", currentFilters.minScore === null ? undefined : currentFilters.minScore);
  pyodide.globals.set("max_score", currentFilters.maxScore === null ? undefined : currentFilters.maxScore);
  pyodide.globals.set("sort_order", currentFilters.sortOrder);

  const result = await pyodide.runPythonAsync(`
    import json
    from alignment import get_alignments_with_scores

    alignments, total = get_alignments_with_scores(
        project_id, 
        page, 
        page_size, 
        min_score, 
        max_score, 
        sort_order
    )
    
    json.dumps({
        "alignments": alignments,
        "total": total
    })
  `);

  const data = JSON.parse(result);
  return data;
}
