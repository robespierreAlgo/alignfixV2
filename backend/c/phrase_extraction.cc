/*
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

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <pthread.h>
#include <emscripten/emscripten.h>
#include <unordered_set>
#include <string>
#include <vector>
#include <algorithm>
#include <climits>

#define MAX_LINE_LENGTH 4096
#define MAX_PHRASE_LENGTH 512
#define MAX_TOKENS_PER_LINE 512
#define MAX_ALIGNMENTS_PER_LINE 256
#define MAX_PHRASES_PER_LINE 2048
#define NO_BLANK_TOKEN "#NB"
#define BLANK_TOKEN "#BLANK"

typedef struct
{
    int src;
    int tgt;
} Alignment;

typedef struct
{
    char *src_phrase;
    char *tgt_phrase;
} Phrase;

// Hash set for fast phrase pair lookup
struct PhrasePairHash {
    std::size_t operator()(const std::pair<std::string, std::string>& p) const {
        // Combine hashes of both strings
        std::size_t h1 = std::hash<std::string>{}(p.first);
        std::size_t h2 = std::hash<std::string>{}(p.second);
        return h1 ^ (h2 << 1);
    }
};

typedef std::unordered_set<std::pair<std::string, std::string>, PhrasePairHash> PhrasePairSet;

typedef struct
{
    char *tokens[MAX_TOKENS_PER_LINE];
    int num_tokens;
} TokenList;

// Global file mutex for safe file access
static pthread_mutex_t file_mutex = PTHREAD_MUTEX_INITIALIZER;

// Dynamic int list helper
struct IntList {
    int *data;
    int count;
    int cap;
    IntList(): data(nullptr), count(0), cap(0) {}
    ~IntList() { free(data); }
    void append(int v) {
        if (count >= cap) {
            int newcap = cap == 0 ? 4 : cap * 2;
            data = (int*)realloc(data, sizeof(int) * newcap);
            cap = newcap;
        }
        data[count++] = v;
    }
};

TokenList split_tokens(const char *line)
{
    TokenList tl = {.num_tokens = 0};

    // Make a writable copy for tokenization
    char *tmp = strdup(line);
    if (!tmp) {
        fprintf(stderr, "Memory allocation failed\n");
        return tl;
    }

    char *saveptr = NULL;
    char *token = strtok_r(tmp, " \t\n", &saveptr);

    while (token && tl.num_tokens < MAX_TOKENS_PER_LINE)
    {
        tl.tokens[tl.num_tokens] = strdup(token);
        if (!tl.tokens[tl.num_tokens]) {
            fprintf(stderr, "Memory allocation failed\n");
            break;
        }

        tl.num_tokens++;

        token = strtok_r(NULL, " \t\n", &saveptr);
    }

    free(tmp);  // IMPORTANT: free the temporary copy

    return tl;
}

// Free token list
void free_token_list(TokenList tl)
{
    for (int i = 0; i < tl.num_tokens; i++)
    {
        free(tl.tokens[i]);
    }
}

// Parse alignments "0-0 1-2 ..."
int parse_alignments(char *line, int reverse_direction, Alignment *alignments)
{
    int count = 0;
    char *token = strtok(line, " \t\n");
    while (token && count < MAX_ALIGNMENTS_PER_LINE)
    {
        int s, t;
        if (sscanf(token, "%d-%d", &s, &t) == 2)
        {
            if (reverse_direction) {
                alignments[count].src = t;
                alignments[count].tgt = s;
            }
            else {
                alignments[count].src = s;
                alignments[count].tgt = t;
            }
            count++;
        }
        token = strtok(NULL, " \t\n");
    }
    return count;
}

// Helper function to strip leading/trailing #NB and #BLANK tokens
void strip_nb_bl(char *phrase) {
    if (!phrase || strlen(phrase) == 0) return;
    
    const char *nb_token = NO_BLANK_TOKEN;
    const char *blank_token = BLANK_TOKEN;
    size_t nb_len = strlen(nb_token);
    size_t blank_len = strlen(blank_token);
    
    char *start = phrase;
    char *end = phrase + strlen(phrase);
    
    // Strip leading tokens
    while (start < end) {
        // Skip leading spaces
        while (start < end && *start == ' ') start++;
        if (start >= end) break;
        
        if (strncmp(start, nb_token, nb_len) == 0 && 
            (start + nb_len == end || start[nb_len] == ' ')) {
            start += nb_len;
        } else if (strncmp(start, blank_token, blank_len) == 0 && 
                   (start + blank_len == end || start[blank_len] == ' ')) {
            start += blank_len;
        } else {
            break;
        }
    }
    
    // Strip trailing tokens
    while (start < end) {
        // Skip trailing spaces
        while (end > start && *(end-1) == ' ') end--;
        if (end <= start) break;
        
        if (end >= start + nb_len && strncmp(end - nb_len, nb_token, nb_len) == 0 &&
            (end - nb_len == start || *(end - nb_len - 1) == ' ')) {
            end -= nb_len;
        } else if (end >= start + blank_len && strncmp(end - blank_len, blank_token, blank_len) == 0 &&
                   (end - blank_len == start || *(end - blank_len - 1) == ' ')) {
            end -= blank_len;
        } else {
            break;
        }
    }
    
    // Final trim spaces
    while (start < end && *start == ' ') start++;
    while (end > start && *(end-1) == ' ') end--;
    
    // Move result and null-terminate
    size_t new_len = end - start;
    if (start != phrase) {
        memmove(phrase, start, new_len);
    }
    phrase[new_len] = '\0';
}

// Check if string is empty or only punctuation
int is_valid_phrase(const char *str)
{
    if (!str) return 0;

    // Find first non-space character
    int start = 0;
    while (str[start] && isspace((unsigned char)str[start])) {
        start++;
    }

    // If string is empty or only whitespace
    if (str[start] == '\0') return 0;

    // Find last non-space character
    int end = start;
    while (str[end] != '\0') {
        end++;
    }
    end--; // move to last character
    while (end >= start && isspace((unsigned char)str[end])) {
        end--;
    }

    if (end < start) return 0; // safety

    // Reject if first or last significant character is punctuation
    if (ispunct((unsigned char)str[start]) || ispunct((unsigned char)str[end])) {
        return 0;
    }

    return 1;
}

// Build alignment maps: src_to_tgt[i] = list of target indices aligned to source i
// and tgt_to_src[j] = list of source indices aligned to target j
static void build_alignment_maps(const Alignment *alignments, int align_count,
                                 int src_num, int tgt_num,
                                 std::vector<IntList> &src_to_tgt,
                                 std::vector<IntList> &tgt_to_src)
{
    src_to_tgt.assign(src_num, IntList());
    tgt_to_src.assign(tgt_num, IntList());

    for (int i = 0; i < align_count; ++i) {
        int s = alignments[i].src;
        int t = alignments[i].tgt;
        if (s < 0 || s >= src_num || t < 0 || t >= tgt_num) continue;
        src_to_tgt[s].append(t);
        tgt_to_src[t].append(s);
    }
}

// Helper to join tokens into a safe buffer with a space between tokens
static void build_phrase_from_tokens_safe(char *out_buf, size_t bufsize,
                                          char **tokens, int start, int end_exclusive)
{

    out_buf[0] = '\0';
    for (int i = start; i < end_exclusive && tokens && tokens[i]; ++i) {
        size_t cur = strlen(out_buf);
        size_t toklen = strlen(tokens[i]);
        size_t space_needed = toklen + ((i < end_exclusive - 1) ? 1 : 0);
        if (cur + space_needed < bufsize - 1) {
            strncat(out_buf, tokens[i], bufsize - cur - 1);
            if (i < end_exclusive - 1) {
                strncat(out_buf, " ", bufsize - strlen(out_buf) - 1);
            }
        } else {
            size_t room = bufsize - cur - 1;
            if (room > 0) {
                strncat(out_buf, tokens[i], room);
            }
            break;
        }
    }
}

struct ExtractedPhrase {
    std::string src_phrase;
    std::string tgt_phrase;
    int direction; // 1 src->tgt, -1 tgt->src
    int start_src;
    int start_tgt;
    int consistency_flag; // 0 if consistent both ways, 1 otherwise
};

// Extract phrases for one direction with consistency checking
static std::vector<ExtractedPhrase> extract_phrases_direction(
    TokenList &src, TokenList &tgt,
    const std::vector<IntList> &src_to_tgt,
    const std::vector<IntList> &tgt_to_src,
    int min_len, int max_len,
    const PhrasePairSet *ignore_set,
    int return_direction
)
{
    std::vector<ExtractedPhrase> results;
    int src_num = src.num_tokens;
    int tgt_num = tgt.num_tokens;

    char src_phrase_buf[MAX_PHRASE_LENGTH];
    char tgt_phrase_buf[MAX_PHRASE_LENGTH];

    for (int length = min_len; length <= max_len; ++length) {
        for (int start_src = 0; start_src <= src_num - length; ++start_src) {

            // Collect all target indices aligned to tokens in [start_src, start_src+length)
            bool has_aligned = false;
            int start_tgt = -1, end_tgt = -1;
            for (int si = start_src; si < start_src + length; ++si) {
                const IntList &il = src_to_tgt[si];
                for (int k = 0; k < il.count; ++k) {
                    int t = il.data[k];
                    if (!has_aligned) {
                        start_tgt = t;
                        end_tgt = t;
                        has_aligned = true;
                    } else {
                        if (t < start_tgt) start_tgt = t;
                        if (t > end_tgt) end_tgt = t;
                    }
                }
            }
            if (!has_aligned) continue;
            end_tgt = end_tgt + 1; // make exclusive

            if (start_tgt < 0) continue;
            if (end_tgt > tgt_num) end_tgt = tgt_num;

            // Reverse-project: find all source indices aligned to tokens in [start_tgt, end_tgt)
            bool has_rev_aligned = false;
            int aligned_start_src = INT_MAX, aligned_end_src = -1;
            for (int ti = start_tgt; ti < end_tgt; ++ti) {
                const IntList &il = tgt_to_src[ti];
                for (int k = 0; k < il.count; ++k) {
                    int s = il.data[k];
                    if (!has_rev_aligned) {
                        aligned_start_src = s;
                        aligned_end_src = s;
                        has_rev_aligned = true;
                    } else {
                        if (s < aligned_start_src) aligned_start_src = s;
                        if (s > aligned_end_src) aligned_end_src = s;
                    }
                }
            }
            if (!has_rev_aligned) continue;
            aligned_end_src = aligned_end_src + 1; // make exclusive

            // Consistency check: reverse-projected source span must equal original
            int consistency_flag = 1;
            if (aligned_start_src == start_src && aligned_end_src == start_src + length) {
                consistency_flag = 0; // consistent (symmetric)
            }

            // Build phrase strings
            build_phrase_from_tokens_safe(src_phrase_buf, sizeof(src_phrase_buf), src.tokens, start_src, start_src + length);
            build_phrase_from_tokens_safe(tgt_phrase_buf, sizeof(tgt_phrase_buf), tgt.tokens, start_tgt, end_tgt);

            // Strip #NB and #BLANK from phrases
            strip_nb_bl(src_phrase_buf);
            strip_nb_bl(tgt_phrase_buf);

            // Validate after stripping
            if (!is_valid_phrase(src_phrase_buf) || !is_valid_phrase(tgt_phrase_buf)) {
                continue;
            }

            std::string src_s(src_phrase_buf);
            std::string tgt_s(tgt_phrase_buf);

            // Check ignore list
            if (ignore_set) {
                if (ignore_set->find({src_s, tgt_s}) != ignore_set->end()) {
                    continue;
                }
                
                // Also check lowercase
                std::string src_lower, tgt_lower;
                for (char c : src_s) src_lower += tolower(c);
                for (char c : tgt_s) tgt_lower += tolower(c);
                
                if (ignore_set->find({src_lower, tgt_lower}) != ignore_set->end()) {
                    continue;
                }
            }

            ExtractedPhrase ep;
            ep.src_phrase = std::move(src_s);
            ep.tgt_phrase = std::move(tgt_s);
            ep.direction = return_direction;
            ep.start_src = start_src;
            ep.start_tgt = start_tgt;
            ep.consistency_flag = consistency_flag;

            results.push_back(std::move(ep));

            if ((int)results.size() >= MAX_PHRASES_PER_LINE) {
                return results;
            }
        }
    }

    return results;
}

// Main phrase extraction function with bidirectional consistency checking
int get_phrases(TokenList src, TokenList tgt, Alignment *alignments, 
    int align_count, int min_len, int max_len, PhrasePairSet *phrases_to_ignore, Phrase *phrases)
{
    int phrase_count = 0;

    // Build alignment maps for forward direction
    std::vector<IntList> src_to_tgt, tgt_to_src;
    build_alignment_maps(alignments, align_count, src.num_tokens, tgt.num_tokens, src_to_tgt, tgt_to_src);

    // Extract forward (src->tgt) with consistency checking
    std::vector<ExtractedPhrase> forward_phrases = extract_phrases_direction(
        src, tgt, src_to_tgt, tgt_to_src, min_len, max_len, phrases_to_ignore, 1
    );

    // Add forward phrases to output - ONLY CONSISTENT ONES
    for (size_t i = 0; i < forward_phrases.size() && phrase_count < MAX_PHRASES_PER_LINE; ++i) {
        // Only add if consistency_flag == 0 (consistent/symmetric)
        if (forward_phrases[i].consistency_flag == 0) {
            phrases[phrase_count].src_phrase = strdup(forward_phrases[i].src_phrase.c_str());
            phrases[phrase_count].tgt_phrase = strdup(forward_phrases[i].tgt_phrase.c_str());
            phrase_count++;
        }
    }

    // No need to compute reverse direction since we only output consistent forward phrases
    // Consistent reverse phrases would be duplicates of forward, and we don't want inconsistent ones

    return phrase_count;
}

// Thread args
typedef struct
{
    int thread_id;
    int start_index;
    int end_index;
    char **src_lines;
    char **tgt_lines;
    float *score_lines;
    char **align_lines;
    PhrasePairSet *phrases_to_ignore;
    float threshold;
    int min_phrase_length;
    int max_phrase_length;
    FILE *log_file;
    FILE *ignore_file;
    int reverse_direction; // 0: src->tgt, 1: tgt->src
} ThreadArgs;

pthread_mutex_t print_mutex = PTHREAD_MUTEX_INITIALIZER;

// ==== Thread worker ====
void *worker(void *arg)
{
    ThreadArgs *args = (ThreadArgs *)arg;
    int min_phrase_length = args->min_phrase_length;
    int max_phrase_length = args->max_phrase_length;
    float threshold = args->threshold;
    PhrasePairSet *phrases_to_ignore = args->phrases_to_ignore;

    FILE *log_file = args->log_file;
    FILE *ignore_file = args->ignore_file;

    for (int row_id = args->start_index; row_id < args->end_index; row_id++)
    {
         // Check only pointer types for NULL, not float array elements
        if (!args->src_lines[row_id] || !args->tgt_lines[row_id] || !args->align_lines[row_id]) {
            printf("Warning: Thread %d Missing data at line %d, skipping.\n", args->thread_id, row_id + 1);
            continue;
        }

        // score_lines is a float array, so we can always access it
        // Just check if the score_lines pointer itself exists
        if (!args->score_lines) {
            printf("Warning: Thread %d score_lines array is NULL\n", args->thread_id);
            continue;
        }


        float current_score = args->score_lines[row_id];
        
        TokenList src_tokens;
        TokenList tgt_tokens;

        if (args->reverse_direction) {
            src_tokens = split_tokens(args->tgt_lines[row_id]);
            tgt_tokens = split_tokens(args->src_lines[row_id]);
        } else {
            src_tokens = split_tokens(args->src_lines[row_id]);
            tgt_tokens = split_tokens(args->tgt_lines[row_id]);
        }

        Alignment alignments[MAX_ALIGNMENTS_PER_LINE];
        int align_count = parse_alignments(args->align_lines[row_id], args->reverse_direction, alignments);
        if (align_count == 0) {
            free_token_list(src_tokens);
            free_token_list(tgt_tokens);
            continue; // no alignments, skip
        }

        Phrase phrases[MAX_PHRASES_PER_LINE];
        int phrase_count = get_phrases(
            src_tokens, 
            tgt_tokens,
            alignments, 
            align_count, 
            min_phrase_length, 
            max_phrase_length, 
            phrases_to_ignore,
            phrases
        );

        if (phrase_count >  MAX_PHRASES_PER_LINE) {
            printf("Warning: Thread %d Line %d exceeded max phrases, truncating.\n", args->thread_id, row_id + 1);
            phrase_count = MAX_PHRASES_PER_LINE;
        }
        
        pthread_mutex_lock(&print_mutex);
        for (int j = 0; j < phrase_count; j++)
        {   
            // Add null pointer checks before writing
            if (phrases[j].src_phrase && phrases[j].tgt_phrase) {
                if (args->reverse_direction) {
                    if (current_score > threshold) {
                        fprintf(ignore_file, "%s|||%s\n", phrases[j].tgt_phrase, phrases[j].src_phrase);
                    } else {
                        fprintf(log_file, "%s|||%s|||%d\n", 
                            phrases[j].tgt_phrase, 
                            phrases[j].src_phrase, 
                            row_id
                        );
                    }
                } else {
                    if (current_score > threshold) {
                        fprintf(ignore_file, "%s|||%s\n", phrases[j].src_phrase, phrases[j].tgt_phrase);
                    } else {
                        fprintf(log_file, "%s|||%s|||%d\n",
                            phrases[j].src_phrase, 
                            phrases[j].tgt_phrase, 
                            row_id
                        );
                    }
                }
            }
            
            // Always free allocated memory, even if null
            if (phrases[j].src_phrase) {
                free(phrases[j].src_phrase);
                phrases[j].src_phrase = NULL;
            }
            if (phrases[j].tgt_phrase) {
                free(phrases[j].tgt_phrase);
                phrases[j].tgt_phrase = NULL;
            }
        }

        pthread_mutex_unlock(&print_mutex);

        free_token_list(src_tokens);
        free_token_list(tgt_tokens);
    }
    return NULL;
}

// ==== Parallel extraction ====
void extract_phrases_parallel(
    char **src_lines, 
    char **tgt_lines, 
    float *score_lines,
    char **align_lines, 
    int line_count, 
    PhrasePairSet *phrases_to_ignore,
    const char *output_file_path, 
    const char *output_ignore_file_path,
    int reverse_direction,
    float threshold = 1.0,
    int min_phrase_length = 1,
    int max_phrase_length = 3,
    const int num_cores = 4
) {

    // create empty output file
    FILE *out_file = fopen(output_file_path, "w");
    if (!out_file) {
        fprintf(stderr, "Error creating output file: %s\n", output_file_path);
        return;
    }

    FILE *ignore_file = fopen(output_ignore_file_path, "w");
    if (!ignore_file) {
        fprintf(stderr, "Error creating ignore file: %s\n", output_ignore_file_path);
        return;
    }

    int NUM_THREADS = num_cores; // adjust as needed

    pthread_t* threads = new pthread_t[NUM_THREADS];
    ThreadArgs* args = new ThreadArgs[NUM_THREADS];

    // // Make a safe local copy of the string
    char safe_path[256];
    snprintf(safe_path, sizeof(safe_path), "%s", output_file_path);

    char safe_ignore_path[256];
    snprintf(safe_ignore_path, sizeof(safe_ignore_path), "%s", output_ignore_file_path);

    int chunk_size = (line_count + NUM_THREADS - 1) / NUM_THREADS;

    // printf("Starting phrase extraction with %d threads with chunk size %d...\n", NUM_THREADS, chunk_size);

    for (int t = 0; t < NUM_THREADS; t++)
    {
        args[t].thread_id = t;
        args[t].start_index = t * chunk_size;
        args[t].end_index = (t + 1) * chunk_size;
        if (args[t].end_index > line_count)
            args[t].end_index = line_count;

        args[t].src_lines = src_lines;
        args[t].tgt_lines = tgt_lines;
        args[t].score_lines = score_lines;
        args[t].align_lines = align_lines;
        args[t].phrases_to_ignore = phrases_to_ignore;
        args[t].log_file = out_file;        // opened once in main
        args[t].ignore_file = ignore_file;  // same
        args[t].reverse_direction = reverse_direction;
        args[t].threshold = threshold; // set desired score threshold
        args[t].min_phrase_length = min_phrase_length; // set desired min phrase length
        args[t].max_phrase_length = max_phrase_length; // set desired max phrase length

        pthread_create(&threads[t], NULL, worker, &args[t]);
    }

    for (int t = 0; t < NUM_THREADS; t++)
    {
        pthread_join(threads[t], NULL);
    }

    //printf("Phrase extraction completed with %d threads.\n", NUM_THREADS);
    
    fclose(out_file);
    fclose(ignore_file);

    delete[] threads;
    delete[] args;
}

extern "C"
{
    EMSCRIPTEN_KEEPALIVE
    int extract_phrases_parallel_main(
        const char *src_file_path, 
        const char *tgt_file_path, 
        const char *score_file_path, 
        const char *align_file_path, 
        const char *input_ignore_file_path, 
        const char *output_file_path, 
        const char *output_ignore_file_path,
        int start_idx,
        int end_idx,
        int num_phrases_to_ignore,
        int reverse_direction,
        float threshold,
        int min_phrase_length,
        int max_phrase_length,
        const int num_cores
    )   {
        char **src_lines = NULL;
        char **tgt_lines = NULL;
        float *score_lines = NULL;
        char **align_lines = NULL;
        char line[MAX_LINE_LENGTH];  // Add this line declaration

        FILE *src_file = fopen(src_file_path, "r");
        FILE *tgt_file = fopen(tgt_file_path, "r");
        FILE *score_file = fopen(score_file_path, "r");
        FILE *align_file = fopen(align_file_path, "r");
        if (!src_file || !tgt_file || !score_file || !align_file)
        {
            fprintf(stderr, "Error opening input files.\n");
            return 1;
        }

        // Count lines in the source file
        int line_count = end_idx - start_idx;

        // Allocate memory for lines
        src_lines = (char **)calloc(line_count, sizeof(char *));
        tgt_lines = (char **)calloc(line_count, sizeof(char *));
        score_lines = (float *)calloc(line_count, sizeof(float));
        align_lines = (char **)calloc(line_count, sizeof(char *));
        
        if (!src_lines || !tgt_lines || !score_lines || !align_lines)
        {
            fprintf(stderr, "Memory allocation failed.\n");
            return 1;
        }

        // printf("Processing %d lines, from %d to %d...\n", line_count, start_idx, end_idx);
        
        // Read lines into arrays - need to fix the indexing logic
        int file_line_index = 0;
        int array_index = 0;
        
        while (array_index < line_count) {
            // Read from all files simultaneously
            char *src_result = fgets(line, sizeof(line), src_file);
            if (src_result && file_line_index >= start_idx && file_line_index < end_idx) {
                src_lines[array_index] = strdup(line);
            }
            
            char *tgt_result = fgets(line, sizeof(line), tgt_file);
            if (tgt_result && file_line_index >= start_idx && file_line_index < end_idx) {
                tgt_lines[array_index] = strdup(line);
            }
            
            char *score_result = fgets(line, sizeof(line), score_file);
            if (score_result && file_line_index >= start_idx && file_line_index < end_idx) {
                // Parse scores
                float score_value = 1.0f; // default fallback
                if (sscanf(line, "%f", &score_value) == 1) {
                    score_lines[array_index] = score_value;
                } else {
                    score_lines[array_index] = 1.0f; // fallback
                }
            }
            
            char *align_result = fgets(line, sizeof(line), align_file);
            if (align_result && file_line_index >= start_idx && file_line_index < end_idx) {
                align_lines[array_index] = strdup(line);
            }
            
            // Check if we've reached end of any file
            if (!src_result || !tgt_result || !score_result || !align_result) {
                break;
            }
            
            // Only increment array index if we're in the target range
            if (file_line_index >= start_idx && file_line_index < end_idx) {
                array_index++;
            }
            
            file_line_index++;
        }

        fclose(src_file);
        fclose(tgt_file);
        fclose(score_file);
        fclose(align_file);

        // read each phrase pair on input_ignore_file_path where they are stored as src_phrase|||tgt_phrase
        // and store them in a hash set for O(1) lookup during extraction
        FILE *input_ignore_file = fopen(input_ignore_file_path, "r");
        
        PhrasePairSet *phrases_to_ignore = new PhrasePairSet();
        phrases_to_ignore->reserve(num_phrases_to_ignore); // Pre-allocate for better performance
        
        if (input_ignore_file)
        {
            char ignore_line[MAX_LINE_LENGTH];
            while (fgets(ignore_line, sizeof(ignore_line), input_ignore_file))
            {
                // Parse the ignore line into src and tgt phrases
                char *src_phrase = strtok(ignore_line, "|||");
                char *tgt_phrase = strtok(NULL, "|||");

                // strip newline from tgt_phrase
                if (tgt_phrase) {
                    size_t len = strlen(tgt_phrase);
                    if (len > 0 && tgt_phrase[len - 1] == '\n') {
                        tgt_phrase[len - 1] = '\0';
                    }
                }

                if (src_phrase && tgt_phrase)
                {
                    // Insert into hash set for O(1) lookup
                    phrases_to_ignore->insert({std::string(src_phrase), std::string(tgt_phrase)});
                }
            }
            fclose(input_ignore_file);
        }

        extract_phrases_parallel(
            src_lines, 
            tgt_lines, 
            score_lines,
            align_lines, 
            line_count, 
            phrases_to_ignore,
            output_file_path, 
            output_ignore_file_path,
            reverse_direction,
            threshold,
            min_phrase_length,
            max_phrase_length,
            num_cores
        );

        for (int i = 0; i < line_count; i++)
        {
            if (src_lines[i]) free(src_lines[i]);
            if (tgt_lines[i]) free(tgt_lines[i]);
            if (align_lines[i]) free(align_lines[i]);
        }
        free(src_lines);
        free(tgt_lines);
        free(score_lines);
        free(align_lines);
        
        // Clean up hash set
        delete phrases_to_ignore;

        return 0;
    }
}