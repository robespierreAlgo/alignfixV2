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

export function bindAsyncButton(btn, handler, text="Processing...") {
  btn.addEventListener("click", async (e) => {
    const oldHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${text}`;
    const logContainer = document.getElementById('log');
    if (logContainer) {
      logContainer.classList.add('show');
    }
    // wait before running handler to allow UI update
    await nextFrame();
    try {
      // handler may be async
      const res = handler(e);
      if (res && typeof res.then === "function") {
        await res;
      }
    } catch (err) {
      console.error("Handler error:", err);
      throw err;
    } finally {
      btn.disabled = false;
      btn.innerHTML = oldHtml;
      if (logContainer) {
        logContainer.classList.remove('show');
      }
    }
  });
}

// Small utility: wait for the next paint(s) instead of using setTimeout.
// Using requestAnimationFrame avoids long 'setTimeout' handler violations
// and gives the browser a chance to flush logs/layout.
export function nextFrame() {
  return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}