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

// Helper function to write large arrays to files in chunks
export function writeFileInChunks(module, filename, lines, chunkSize = 10000) {
  const stream = module.FS.open(filename, 'w');
  
  for (let i = 0; i < lines.length; i += chunkSize) {
    const chunk = lines.slice(i, Math.min(i + chunkSize, lines.length));
    const text = chunk.join("\n") + (i + chunkSize < lines.length ? "\n" : "");
    const buffer = new TextEncoder().encode(text);
    module.FS.write(stream, buffer, 0, buffer.length);
  }
  
  module.FS.close(stream);
}