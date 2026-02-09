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
import { safeSyncfs } from "./storage.js";

export async function applyFixes(project_id, fixes) {
  const pyodide = await initPyodide();

  pyodide.globals.set("project_id", project_id);
  pyodide.globals.set("fixes_json", JSON.stringify(fixes));

  const startTime = performance.now();

  await pyodide.runPythonAsync(`
      from fixes import apply_fixes
      fixes = json.loads(fixes_json)
      apply_fixes(project_id, fixes)
  `);

  const endTime = performance.now();
  console.log(`Applied fixes in ${(endTime - startTime).toFixed(2)} ms`);

  await safeSyncfs(pyodide);

  return;
}

export async function getFixes(project_id) {
  const pyodide = await initPyodide();

  pyodide.globals.set("project_id", project_id);

  const response = await pyodide.runPythonAsync(`
      import json
      from fixes import get_fixes

      fixes = get_fixes(project_id)
      json.dumps(fixes)
  `);
  
  const fixes = JSON.parse(response);
  return fixes;
}

export async function countFixes(project_id) {
  const pyodide = await initPyodide();

  pyodide.globals.set("project_id", project_id);

  const response = await pyodide.runPythonAsync(`
      import json
      from fixes import count_fixes

      num_fixes = count_fixes(project_id)
      num_fixes
  `);
  
  return response;
}