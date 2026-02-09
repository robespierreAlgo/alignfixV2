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

export async function fetchTranslations(data) {

  const pyodide = await initPyodide();

  pyodide.globals.set("project_id", data.project_id);
  pyodide.globals.set("phrase1", data.phrase1);
  pyodide.globals.set("phrase2", data.phrase2);
  pyodide.globals.set("fix1", data.fix1);
  pyodide.globals.set("fix2", data.fix2);
  pyodide.globals.set("direction", data.direction);
  pyodide.globals.set("start", data.start);
  pyodide.globals.set("length", data.length);
  pyodide.globals.set("search_value", data.search.value);

  console.log(`Fetching translations for project ${data.project_id} - Phrase1: "${data.phrase1}", Phrase2: "${data.phrase2}", Search: "${data.search.value}"`);

  const response = await pyodide.runPythonAsync(`
      import json
      from projects import fetch_translations

      res, total_records = fetch_translations(
          project_id, phrase1, phrase2, fix1, fix2, direction, start, length, search_value
      )
      json.dumps({
          "data": res,
          "total_records": total_records,
          "filtered_records": total_records
      })
  `);

  const res = JSON.parse(response);
  
  return {
    draw: data.draw,
    recordsTotal: res.total_records,
    recordsFiltered: res.filtered_records,
    data: res.data,
  };
}

export async function storeTranslation(id, line1, line2) {

  const pyodide = await initPyodide();

  pyodide.globals.set("id", id);
  pyodide.globals.set("line1", line1);
  pyodide.globals.set("line2", line2);

  await pyodide.runPythonAsync(`
      from projects import update_translation
      update_translation(id, line1, line2)
  `);

  await safeSyncfs(pyodide);
  console.log(`Translation ${id} updated`);
    
  return;
}

export async function deleteTranslation(id) {

  const pyodide = await initPyodide();

  pyodide.globals.set("id", id);

  await pyodide.runPythonAsync(`
      from projects import delete_translation
      delete_translation(id)
  `);

  await safeSyncfs(pyodide);
  console.log(`Translation ${id} deleted`);
    
  return;
}