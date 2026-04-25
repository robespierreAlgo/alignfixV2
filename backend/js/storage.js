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

// Persist in-memory FS -> IndexedDB.
// Do NOT toggle direction on failure.
// Loading from IndexedDB belongs only in initPyodide() with syncfs(true).
export async function safeSyncfs(pyodide, maxAttempts = 4, baseDelayMs = 200) {
    return new Promise((resolve, reject) => {
        let attempts = 0;

        const tryWrite = () => {
            try {
                pyodide.FS.syncfs(false, (err) => {
                    if (!err) {
                        resolve();
                        return;
                    }

                    const errMsg = err && err.message ? err.message : String(err);
                    console.warn(`FS.syncfs(false) attempt ${attempts + 1} failed:`, errMsg);

                    if (attempts < maxAttempts - 1) {
                        attempts++;
                        const delay = Math.pow(2, attempts - 1) * baseDelayMs;
                        setTimeout(tryWrite, delay);
                        return;
                    }

                    reject(err);
                });
            } catch (ex) {
                const errMsg = ex && ex.message ? ex.message : String(ex);
                console.error("FS.syncfs(false) threw:", errMsg);

                if (attempts < maxAttempts - 1) {
                    attempts++;
                    const delay = Math.pow(2, attempts - 1) * baseDelayMs;
                    setTimeout(tryWrite, delay);
                    return;
                }

                reject(ex);
            }
        };

        tryWrite();
    });
}
