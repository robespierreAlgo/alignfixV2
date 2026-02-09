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

export function getLinesStats(lines) {
  if (!lines || lines.length === 0) return 'No lines';
  let longest = 0;
  let shortest = Infinity;
  let totalLength = 0;

  let maxNumTokens = 0;
  let totalTokens = 0;

  lines.forEach(line => {
    const length = line.length;
    if (length > longest) longest = length;
    if (length < shortest) shortest = length;

    const numTokens = line.split(/\s+/).filter(Boolean).length;
    if (numTokens > maxNumTokens) maxNumTokens = numTokens;
    totalTokens += numTokens;
    totalLength += length;
  });

  const average = totalLength / lines.length;

  return {
    lines: lines.length,
    longest,
    shortest: (shortest === Infinity ? 0 : shortest),
    avg_length: average.toFixed(2),
    max_tokens: maxNumTokens,
    avg_tokens: (totalTokens / lines.length).toFixed(2),
    sample: lines.slice(0, 5)
  };
}