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

#include <iostream>
#include <sstream>
#include <vector>
#include <fstream>

#include <queue>
#include <map>
#include <set>
#include <getopt.h>

#include "alignment_io.h"

#include <emscripten/emscripten.h>
#include <string>
#include <fstream>


using namespace std;

struct option options[] = {
    {"input_1",                 required_argument, 0,                  'i'},
    {"input_2",                 required_argument, 0,                  'j'},
    {"command",                 required_argument, 0,                  'c'},
    {0,0,0,0}
};

string input_1;
string input_2;
string command;

bool InitCommandLine(int argc, char** argv) {
  while (1) {
    int oi;
    int c = getopt_long(argc, argv, "i:j:c:", options, &oi);
    if (c == -1) break;
    switch(c) {
      case 'i': input_1 = optarg; break;
      case 'j': input_2 = optarg; break;
      case 'c': command = optarg; break;
      default: return false;
    }
  }
  if (input_1.size() == 0) return false;
  if (command.size() == 0) return false;
  return true;
}

struct Command {
  virtual ~Command() {}
  virtual string Name() const = 0;

  // returns 1 for alignment grid output [default]
  // returns 2 if Summary() should be called [for AER, etc]
  virtual int Result() const { return 1; }

  virtual bool RequiresTwoOperands() const { return true; }
  virtual void Apply(const Array2D<bool>& a, const Array2D<bool>& b, Array2D<bool>* x) = 0;
  void EnsureSize(const Array2D<bool>& a, const Array2D<bool>& b, Array2D<bool>* x) {
    x->resize(max(a.width(), b.width()), max(a.height(), b.height()));
  }
  static bool Safe(const Array2D<bool>& a, int i, int j) {
    if (i >= 0 && j >= 0 && i < static_cast<int>(a.width()) && j < static_cast<int>(a.height()))
      return a(i,j);
    else
      return false;
  }
  virtual void Summary() { assert(!"Summary should have been overridden"); }
};

// compute fmeasure, second alignment is reference, first is hyp
struct FMeasureCommand : public Command {
  FMeasureCommand() : matches(), num_predicted(), num_in_ref() {}
  int Result() const { return 2; }
  string Name() const { return "fmeasure"; }
  bool RequiresTwoOperands() const { return true; }
  void Apply(const Array2D<bool>& hyp, const Array2D<bool>& ref, Array2D<bool>* x) {
    (void) x;   // AER just computes statistics, not an alignment
    unsigned i_len = ref.width();
    unsigned j_len = ref.height();
    for (unsigned i = 0; i < i_len; ++i) {
      for (unsigned j = 0; j < j_len; ++j) {
        if (ref(i,j)) {
          ++num_in_ref;
          if (Safe(hyp, i, j)) ++matches;
        } 
      }
    }
    for (unsigned i = 0; i < hyp.width(); ++i)
      for (unsigned j = 0; j < hyp.height(); ++j)
        if (hyp(i,j)) ++num_predicted;
  }
  void Summary() {
    if (num_predicted == 0 || num_in_ref == 0) {
      cerr << "Insufficient statistics to compute f-measure!\n";
      abort();
    }
    const double prec = static_cast<double>(matches) / num_predicted;
    const double rec = static_cast<double>(matches) / num_in_ref;
    cout << "P: " << prec << endl;
    cout << "R: " << rec << endl;
    const double f = (2.0 * prec * rec) / (rec + prec);
    cout << "F: " << f << endl;
  }
  int matches;
  int num_predicted;
  int num_in_ref;
};

struct DisplayCommand : public Command {
  string Name() const { return "display"; }
  bool RequiresTwoOperands() const { return false; }
  void Apply(const Array2D<bool>& in, const Array2D<bool>&, Array2D<bool>* x) {
    *x = in;
    cout << *x << endl;
  }
};

struct ConvertCommand : public Command {
  string Name() const { return "convert"; }
  bool RequiresTwoOperands() const { return false; }
  void Apply(const Array2D<bool>& in, const Array2D<bool>&, Array2D<bool>* x) {
    *x = in;
  }
};

struct InvertCommand : public Command {
  string Name() const { return "invert"; }
  bool RequiresTwoOperands() const { return false; }
  void Apply(const Array2D<bool>& in, const Array2D<bool>&, Array2D<bool>* x) {
    Array2D<bool>& res = *x;
    res.resize(in.height(), in.width());
    for (unsigned i = 0; i < in.height(); ++i)
      for (unsigned j = 0; j < in.width(); ++j)
        res(i, j) = in(j, i);
  }
};

struct IntersectCommand : public Command {
  string Name() const { return "intersect"; }
  bool RequiresTwoOperands() const { return true; }
  void Apply(const Array2D<bool>& a, const Array2D<bool>& b, Array2D<bool>* x) {
    EnsureSize(a, b, x);
    Array2D<bool>& res = *x;
    for (unsigned i = 0; i < a.width(); ++i)
      for (unsigned j = 0; j < a.height(); ++j)
        res(i, j) = Safe(a, i, j) && Safe(b, i, j);
  }
};

struct UnionCommand : public Command {
  string Name() const { return "union"; }
  bool RequiresTwoOperands() const { return true; }
  void Apply(const Array2D<bool>& a, const Array2D<bool>& b, Array2D<bool>* x) {
    EnsureSize(a, b, x);
    Array2D<bool>& res = *x;
    for (unsigned i = 0; i < res.width(); ++i)
      for (unsigned j = 0; j < res.height(); ++j)
        res(i, j) = Safe(a, i, j) || Safe(b, i, j);
  }
};

struct RefineCommand : public Command {
  RefineCommand() {
    neighbors_.push_back(make_pair(1,0));
    neighbors_.push_back(make_pair(-1,0));
    neighbors_.push_back(make_pair(0,1));
    neighbors_.push_back(make_pair(0,-1));
  }
  bool RequiresTwoOperands() const { return true; }

  void Align(unsigned i, unsigned j) {
    res_(i, j) = true;
    is_i_aligned_[i] = true;
    is_j_aligned_[j] = true;
  }

  bool IsNeighborAligned(int i, int j) const {
    for (unsigned k = 0; k < neighbors_.size(); ++k) {
      const int di = neighbors_[k].first;
      const int dj = neighbors_[k].second;
      if (Safe(res_, i + di, j + dj))
        return true;
    }
    return false;
  }

  bool IsNeitherAligned(int i, int j) const {
    return !(is_i_aligned_[i] || is_j_aligned_[j]);
  }

  bool IsOneOrBothUnaligned(int i, int j) const {
    return !(is_i_aligned_[i] && is_j_aligned_[j]);
  }

  bool KoehnAligned(int i, int j) const {
    return IsOneOrBothUnaligned(i, j) && IsNeighborAligned(i, j);
  }

  typedef bool (RefineCommand::*Predicate)(int i, int j) const;

 protected:
  void InitRefine(
      const Array2D<bool>& a,
      const Array2D<bool>& b) {
    res_.clear();
    EnsureSize(a, b, &res_);
    in_.clear(); un_.clear(); is_i_aligned_.clear(); is_j_aligned_.clear();
    EnsureSize(a, b, &in_);
    EnsureSize(a, b, &un_);
    is_i_aligned_.resize(res_.width(), false);
    is_j_aligned_.resize(res_.height(), false);
    for (unsigned i = 0; i < in_.width(); ++i)
      for (unsigned j = 0; j < in_.height(); ++j) {
        un_(i, j) = Safe(a, i, j) || Safe(b, i, j);
        in_(i, j) = Safe(a, i, j) && Safe(b, i, j);
        if (in_(i, j)) Align(i, j);
    }
  }
  // "grow" the resulting alignment using the points in adds
  // if they match the constraints determined by pred
  void Grow(Predicate pred, bool idempotent, const Array2D<bool>& adds) {
    if (idempotent) {
      for (unsigned i = 0; i < adds.width(); ++i)
        for (unsigned j = 0; j < adds.height(); ++j) {
          if (adds(i, j) && !res_(i, j) &&
              (this->*pred)(i, j)) Align(i, j);
        }
      return;
    }
    set<pair<int, int> > p;
    for (unsigned i = 0; i < adds.width(); ++i)
      for (unsigned j = 0; j < adds.height(); ++j)
        if (adds(i, j) && !res_(i, j))
          p.insert(make_pair(i, j));
    bool keep_going = !p.empty();
    while (keep_going) {
      keep_going = false;
      set<pair<int, int> > added;
      for (set<pair<int, int> >::iterator pi = p.begin(); pi != p.end(); ++pi) {
        if ((this->*pred)(pi->first, pi->second)) {
          Align(pi->first, pi->second);
          added.insert(make_pair(pi->first, pi->second));
          keep_going = true;
        }
      }
      for (set<pair<int, int> >::iterator ai = added.begin(); ai != added.end(); ++ai)
        p.erase(*ai);
    }
  }
  Array2D<bool> res_;  // refined alignment
  Array2D<bool> in_;   // intersection alignment
  Array2D<bool> un_;   // union alignment
  vector<bool> is_i_aligned_;
  vector<bool> is_j_aligned_;
  vector<pair<int,int> > neighbors_;
};

struct DiagCommand : public RefineCommand {
  DiagCommand() {
    neighbors_.push_back(make_pair(1,1));
    neighbors_.push_back(make_pair(-1,1));
    neighbors_.push_back(make_pair(1,-1));
    neighbors_.push_back(make_pair(-1,-1));
  }
};

struct GDCommand : public DiagCommand {
  string Name() const { return "grow-diag"; }
  void Apply(const Array2D<bool>& a, const Array2D<bool>& b, Array2D<bool>* x) {
    InitRefine(a, b);
    Grow(&RefineCommand::KoehnAligned, false, un_);
    *x = res_;
  }
};

struct GDFCommand : public DiagCommand {
  string Name() const { return "grow-diag-final"; }
  void Apply(const Array2D<bool>& a, const Array2D<bool>& b, Array2D<bool>* x) {
    InitRefine(a, b);
    Grow(&RefineCommand::KoehnAligned, false, un_);
    Grow(&RefineCommand::IsOneOrBothUnaligned, true, a);
    Grow(&RefineCommand::IsOneOrBothUnaligned, true, b);
    *x = res_;
  }
};

struct GDFACommand : public DiagCommand {
  string Name() const { return "grow-diag-final-and"; }
  void Apply(const Array2D<bool>& a, const Array2D<bool>& b, Array2D<bool>* x) {
    InitRefine(a, b);
    Grow(&RefineCommand::KoehnAligned, false, un_);
    Grow(&RefineCommand::IsNeitherAligned, true, a);
    Grow(&RefineCommand::IsNeitherAligned, true, b);
    *x = res_;
  }
};

map<string, shared_ptr<Command> > commands;

template<class C> static void AddCommand() {
  C* c = new C;
  commands[c->Name()].reset(c);
}

// core reusable function: works on istreams
int run_atools_core(const char* command_name, istream& in1, istream* in2, ostream& out) {

  command = command_name ? std::string(command_name) : "";
  AddCommand<ConvertCommand>();
  AddCommand<DisplayCommand>();
  AddCommand<InvertCommand>();
  AddCommand<IntersectCommand>();
  AddCommand<UnionCommand>();
  AddCommand<GDCommand>();
  AddCommand<GDFCommand>();
  AddCommand<GDFACommand>();
  AddCommand<FMeasureCommand>();

  if (commands.count(command) == 0) {
    cerr << "Don't understand command: " << command << endl;
    return 1;
  }

  Command& cmd = *commands[command];
  string line1, line2;

  while (getline(in1, line1)) {
    if (in2) {
      if (!getline(*in2, line2)) {
        cerr << "Mismatched number of lines!\n";
        return 1;
      }
    }

    if (line1.empty()) continue;

    shared_ptr<Array2D<bool>> outGrid(new Array2D<bool>);
    auto a1 = AlignmentIO::ReadPharaohAlignmentGrid(line1);

    if (in2) {
      auto a2 = AlignmentIO::ReadPharaohAlignmentGrid(line2);
      cmd.Apply(*a1, *a2, outGrid.get());
    } else {
      Array2D<bool> dummy;
      cmd.Apply(*a1, dummy, outGrid.get());
    }

    if (cmd.Result() == 1) {
      AlignmentIO::SerializePharaohFormat(*outGrid, &out);
    }
  }

  if (cmd.Result() == 2)
    cmd.Summary();

  return 0;
}

extern "C" {
  EMSCRIPTEN_KEEPALIVE
  void run_atools(const char* forward_file,
                  const char* backward_file,
                  const char* output_file) {

    if (!forward_file || !output_file) {
        std::cerr << "Input or output file is null!" << std::endl;
        return;
    }

    // Read forward file
    std::ifstream ifs1(forward_file);
    if (!ifs1) {
        std::cerr << "Failed to open forward file: " << forward_file << std::endl;
        return;
    }

    // Read backward file if provided
    std::ifstream ifs2;
    if (backward_file && backward_file[0] != '\0') {
        ifs2.open(backward_file);
        if (!ifs2) {
            std::cerr << "Failed to open backward file: " << backward_file << std::endl;
            return;
        }
    }

    // Run core function
    std::ostringstream out;
    run_atools_core("grow-diag-final-and", ifs1, (ifs2.is_open() ? &ifs2 : nullptr), out);

    // Write output to file
    std::ofstream ofs(output_file);
    if (!ofs) {
        std::cerr << "Failed to open output file: " << output_file << std::endl;
        return;
    }
    ofs << out.str();
    ofs.close();
  }
}