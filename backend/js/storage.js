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

// Safe wrapper around pyodide.FS.syncfs with retries and fallback toggle
export async function safeSyncfs(pyodide, maxAttempts = 4) {
    return new Promise((resolve, reject) => {
        let attempts = 0;
        let triedToggle = false;

        const trySync = (syncToPersistent = false) => {
            try {
                pyodide.FS.syncfs(syncToPersistent, (err) => {
                    if (!err) {
                        resolve();
                        return;
                    }

                    const errMsg = err && err.message ? err.message : String(err);
                    console.warn(`FS.syncfs attempt ${attempts + 1} failed:`, errMsg);

                    // Retry with exponential backoff
                    if (attempts < maxAttempts - 1) {
                        attempts++;
                        const delay = Math.pow(2, attempts) * 100;
                        setTimeout(() => trySync(syncToPersistent), delay);
                        return;
                    }

                    // If we exhausted attempts, try toggling the sync direction once
                    if (!triedToggle) {
                        triedToggle = true;
                        attempts = 0;
                        console.warn('FS.syncfs toggling sync direction and retrying');
                        // toggle direction: try true (syncToPersistent) if we previously used false, and vice versa
                        trySync(!syncToPersistent);
                        return;
                    }

                    // Give up
                    reject(err);
                });
            } catch (ex) {
                // catch synchronous exceptions from FS.syncfs
                const syncErrMsg = ex && ex.message ? ex.message : String(ex);
                console.error('FS.syncfs threw:', syncErrMsg);
                if (attempts < maxAttempts - 1) {
                    attempts++;
                    const delay = Math.pow(2, attempts) * 100;
                    setTimeout(() => trySync(syncToPersistent), delay);
                } else if (!triedToggle) {
                    triedToggle = true;
                    attempts = 0;
                    trySync(!syncToPersistent);
                } else {
                    reject(ex);
                }
            }
        };

        trySync(false);
    });
}