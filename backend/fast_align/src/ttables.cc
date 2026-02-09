/*
 * Original work Copyright 2013 Chris Dyer
 * Modified work Copyright 2025 Samuel Frontull and Simon Haller-Seeber, University of Innsbruck
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
 *
 * This file contains modifications to the original FastAlign implementation
 * to support WebAssembly compilation and browser-based execution.
 */

#include "src/ttables.h"

#include <cmath>
#include <string>
#include <fstream>

#include "src/corpus.h"

void TTable::DeserializeLogProbsFromText(std::istream* in, Dict& d) {
  int c = 0;
  std::string e, f;
  double p;
  while(*in) {
    (*in) >> e >> f >> p;
    if (e.empty()) break;
    ++c;
    unsigned ie = d.Convert(e);
    if (ie >= ttable.size()) ttable.resize(ie + 1);
    ttable[ie][d.Convert(f)] = std::exp(p);
  }
  std::cerr << "Loaded " << c << " translation parameters.\n";
}

