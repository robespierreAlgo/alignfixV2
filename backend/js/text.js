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

import { writeFileInChunks } from './utils.js';

export const MAX_LINE_LENGTH = 2000;
export const MIN_LINE_LENGTH = 1;
export const MAX_NUM_LINES = 1000000;
export const MAX_TOKENS_PER_LINE = 512;

function getTextTokeniseChunkSize(numCores) {
    if (numCores >= 16) return 500000;
    if (numCores >= 8) return 200000;
    if (numCores >= 4) return 100000;
    return 100000;
}

export async function getLinesFromFiles(src_file, tgt_file) {
  const src_content = await src_file.text();
  const tgt_content = await tgt_file.text();

  const src_lines = src_content.split(/\r?\n/);
  const tgt_lines = tgt_content.split(/\r?\n/);

  // if number of lines differ, alert and return
  if (src_lines.length !== tgt_lines.length) {
    alert("Source and target files must have the same number of lines.");
    return { src_lines: [], tgt_lines: [] };
  }

  // iterate over line pairs, if one of two empty, skip or if one of two longer than 2000 characters, skip
  const filtered_src_lines = [];
  const filtered_tgt_lines = [];
  for (let i = 0; i < src_lines.length; i++) {

    if (filtered_src_lines.length >= MAX_NUM_LINES) {
      console.warn(`Reached maximum number of lines (${MAX_NUM_LINES}). Further lines will be skipped.`);
      break;
    }
    
    const src_line = src_lines[i].trim();
    const tgt_line = tgt_lines[i].trim();
    if (src_line.length < MIN_LINE_LENGTH || tgt_line.length < MIN_LINE_LENGTH) {
      continue;
    }
    if (src_line.length > MAX_LINE_LENGTH || tgt_line.length > MAX_LINE_LENGTH) {
      console.warn(`Skipping line ${i + 1} due to length > ${MAX_LINE_LENGTH} characters.`);
      continue;
    }

    const src_num_tokens = src_line.split(" ").length;
    const tgt_num_tokens = tgt_line.split(" ").length;
    if (src_num_tokens > MAX_TOKENS_PER_LINE || tgt_num_tokens > MAX_TOKENS_PER_LINE) {
      console.warn(`Skipping line ${i + 1} due to number of tokens > ${MAX_TOKENS_PER_LINE}.`);
      continue;
    }

    filtered_src_lines.push(src_line);
    filtered_tgt_lines.push(tgt_line);
  }

  return { src_lines: filtered_src_lines, tgt_lines: filtered_tgt_lines };
}

async function _tokeniseLines(module, inputLines, numCores) {
  console.log('operation:Starting text tokenization');
  console.log('progress:0');
  
  // Input and output file paths in the virtual filesystem
  const inputFile = "/input.txt";
  const outputFile = "/output.txt";

  console.log(`⚙️ Tokenization configuration: ${numCores} cores, ${inputLines.length.toLocaleString()} lines to process`);
  
  console.log('operation:Loading WASM tokenization module');
  console.log('progress:10');
  
  console.log("✅ WASM tokenization module loaded successfully");
  
  console.log('operation:Preparing input data for tokenization');
  console.log('progress:20');

  // Write lines to file in chunks to avoid memory issues
  console.log(`📝 Writing ${inputLines.length.toLocaleString()} lines to WASM filesystem in chunks...`);
  writeFileInChunks(module, inputFile, inputLines);
  console.log(`💾 Input data written to virtual filesystem: ${inputFile}`);
  console.log('progress:30');

  console.log('operation:Running tokenization process');
  console.log(`⏳ Starting tokenization with ${numCores} cores...`);
  console.log('progress:40');

  // Call the tokenize_file function
  const tokenizeStart = performance.now();
  const result = await module.ccall(
    "tokenize_file", // Function name in C
    "number",        // Return type
    ["string", "string", "number"], // Argument types
    [inputFile, outputFile, numCores] // Arguments
  );
  const tokenizeEnd = performance.now();
  const tokenizeDuration = (tokenizeEnd - tokenizeStart) / 1000;

  console.log('progress:70');

  if (result !== 0) {
    console.error("❌ Error tokenizing file - WASM function returned non-zero exit code");
    throw new Error("Tokenization failed");
  }

  console.log(`✅ Tokenization completed in ${tokenizeDuration.toFixed(2)} seconds`);
  console.log('operation:Reading and processing tokenized output');
  console.log('progress:80');

  // Read the tokenized output file
  const tokenizedContent = await module.FS.readFile(outputFile, { encoding: "utf8" });
  const outputSizeMB = (tokenizedContent.length / 1024 / 1024).toFixed(2);
  console.log(`📖 Tokenized output read: ${outputSizeMB} MB`);

  // split on newlines
  if (!tokenizedContent.trim()) {
    console.log("⚠️ No tokenized content found - returning empty array");
    console.log('progress:100');
    return [];
  }
  
  console.log('operation:Sorting and formatting tokenized lines');
  console.log('progress:85');
  
  const lines = tokenizedContent.trim().split("\n");
  console.log(`📊 Processing ${lines.length.toLocaleString()} tokenized lines`);

  // sort lines by first column ||| asc
  lines.sort((a, b) => {
    const aParts = a.split("|||");
    const bParts = b.split("|||");
    const index1 = parseInt(aParts[0]);
    const index2 = parseInt(bParts[0]);
    return index1 - index2;
  });
  
  console.log('✅ Lines sorted by index');
  console.log('progress:90');

  // remove first column |||
  for (let i = 0; i < lines.length; i++) {
    const parts = lines[i].split("|||");
    parts.shift();
    lines[i] = parts.join("|||").trim();
  }

  // free up memory and resources
  module.FS.unlink(inputFile);
  module.FS.unlink(outputFile)

  console.log('✅ Index column removed from output');
  console.log('progress:100');
  console.log(`🎯 Tokenization completed successfully!`);

  return lines;
}

export async function tokeniseLines(inputLines) {

  const { createModule, config } = await window.WasmModuleLoader.loadTextTokenize();
  const numCores = parseInt(document.getElementById("num-cores-input")?.value) 
                    || window.navigator.hardwareConcurrency || 1;
  const poolSize = Math.min(config.poolSize, numCores);
  let module = await createModule({ 
    pthreadPoolSize: poolSize
  });

  const CHUNK_SIZE = getTextTokeniseChunkSize(numCores);
  const totalChunks = Math.ceil(inputLines.length / CHUNK_SIZE);

  let resultLines = [];
  
  // Process chunks sequentially without storing all chunks in memory
  for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
    const startIdx = chunkIndex * CHUNK_SIZE;
    const endIdx = Math.min(startIdx + CHUNK_SIZE, inputLines.length);
    
    console.log(`progress:${30 + Math.floor((chunkIndex / totalChunks) * 40)}`); // progress 30-70
    console.log(`⚙️ Tokenizing chunk ${chunkIndex + 1} of ${totalChunks} (${endIdx - startIdx} lines)`);
    
    // Create chunk view without copying data
    const inputChunk = inputLines.slice(startIdx, endIdx);
    const resultChunk = await _tokeniseLines(module, inputChunk, numCores);
    resultLines = resultLines.concat(resultChunk);
    
    // Clear chunk reference to help GC
    inputChunk.length = 0;
  }

  // allow GC to run
  module = null;
  await new Promise(r => setTimeout(r, 100)); // Give more time for cleanup

  return resultLines;
}