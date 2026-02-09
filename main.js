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

import { initPyodide } from "./pyodide.js";
import { router } from "./router.js";

function showLoader(show) {
  const loader = document.querySelector(".loader");
  if (loader) {
    loader.style.display = show ? "inline-block" : "none";
  }
  var logContainer = document.getElementById('log');
  if (logContainer) {
    if (show) {
      logContainer.classList.add('show');
    } else {
      logContainer.classList.remove('show');
    }
  }
}

(async function main() {
  showLoader(true);
  await initPyodide();
  router(); // render initial page
  showLoader(false);
})();
