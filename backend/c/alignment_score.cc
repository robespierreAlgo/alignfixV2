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
#include <cmath>
#include <algorithm>
#include <vector>

#define MAX_LINE_LENGTH 4096
#define MAX_PHRASE_LENGTH 512
#define MAX_TOKENS_PER_LINE 512
#define MAX_ALIGNMENTS_PER_LINE 256
#define MAX_PHRASES_PER_LINE 2048

typedef struct
{
    int src;
    int tgt;
} Alignment;

// Global file mutex for safe file access
static pthread_mutex_t file_mutex = PTHREAD_MUTEX_INITIALIZER;

// Parse alignments "0-0 1-2 ..."
int parse_alignments(char *line, Alignment *alignments)
{
    int count = 0;
    char *token = strtok(line, " \t\n");
    while (token && count < MAX_ALIGNMENTS_PER_LINE)
    {
        int s, t;
        if (sscanf(token, "%d-%d", &s, &t) == 2)
        {
            alignments[count].src = s;
            alignments[count].tgt = t;
            count++;
        }
        token = strtok(NULL, " \t\n");
    }
    return count;
}

// Count tokens in a line
int count_tokens(const char *line)
{
    if (!line) return 0;
    
    int count = 0;
    bool in_token = false;
    
    for (int i = 0; line[i]; i++)
    {
        if (isspace(line[i]))
        {
            in_token = false;
        }
        else
        {
            if (!in_token)
            {
                count++;
                in_token = true;
            }
        }
    }
    
    return count;
}

// Comparator for sorting alignments
int compare_alignments(const void *a, const void *b)
{
    const Alignment *align_a = (const Alignment *)a;
    const Alignment *align_b = (const Alignment *)b;
    
    if (align_a->src != align_b->src)
        return align_a->src - align_b->src;
    return align_a->tgt - align_b->tgt;
}

// Compute alignment stability score with F1-based metric
float compute_alignment_stability(Alignment *alignments, int align_count, int src_len, int tgt_len)
{
    if (align_count == 0 || src_len == 0 || tgt_len == 0) {
        return 0.0f;
    }
    
    // Collect unique aligned token indices (with bounds checking)
    std::unordered_set<int> src_aligned_set;
    std::unordered_set<int> tgt_aligned_set;
    
    for (int i = 0; i < align_count; i++)
    {
        // Only count valid alignment points within bounds
        if (alignments[i].src >= 0 && alignments[i].src < src_len)
            src_aligned_set.insert(alignments[i].src);
        if (alignments[i].tgt >= 0 && alignments[i].tgt < tgt_len)
            tgt_aligned_set.insert(alignments[i].tgt);
    }
    
    int src_aligned = src_aligned_set.size();
    int tgt_aligned = tgt_aligned_set.size();
    
    // Avoid division by zero
    if (src_len == 0 || tgt_len == 0) {
        return 0.0f;
    }
    
    // Compute precision and recall
    float precision = (float)tgt_aligned / (float)tgt_len;
    float recall = (float)src_aligned / (float)src_len;
    
    // Compute F1 score
    float f1 = 0.0f;
    if (precision + recall > 0.0f)
    {
        f1 = 2.0f * (precision * recall) / (precision + recall);
    }
    else
    {
        return 0.0f; // No coverage at all
    }
    
    // Compute unaligned tokens penalty
    int unaligned_src = src_len - src_aligned;
    int unaligned_tgt = tgt_len - tgt_aligned;
    int total_tokens = src_len + tgt_len;
    
    // Penalty factor: 1 - (unaligned_tokens / total_tokens)
    float penalty = 1.0f;
    if (total_tokens > 0)
    {
        penalty = 1.0f - (float)(unaligned_src + unaligned_tgt) / (float)total_tokens;
    }
    
    // Ensure penalty is non-negative
    if (penalty < 0.0f)
        penalty = 0.0f;
    
    // Adjusted F1 score
    float adjusted_f1 = f1 * penalty;
    
    return adjusted_f1;
}

// Thread args
typedef struct
{
    int thread_id;
    int start_index;
    int end_index;
    char **src_lines;
    char **tgt_lines;
    char **align_lines;
    FILE *log_file;
} ThreadArgs;

pthread_mutex_t print_mutex = PTHREAD_MUTEX_INITIALIZER;

// ==== Thread worker ====
void *worker(void *arg)
{
    ThreadArgs *args = (ThreadArgs *)arg;

    FILE *log_file = args->log_file;

    for (int row_id = args->start_index; row_id < args->end_index; row_id++)
    {
         // Check only pointer types for NULL, not float array elements
        if (!args->src_lines[row_id] || !args->tgt_lines[row_id] || !args->align_lines[row_id]) {
            printf("Warning: Thread %d Missing data at line %d, skipping.\n", args->thread_id, row_id + 1);
            continue;
        }
        
        // Count tokens in source and target lines
        int src_len = count_tokens(args->src_lines[row_id]);
        int tgt_len = count_tokens(args->tgt_lines[row_id]);
        
        // Parse alignments (make a copy since we need to sort them)
        Alignment alignments[MAX_ALIGNMENTS_PER_LINE];
        char align_line_copy[MAX_LINE_LENGTH];
        strncpy(align_line_copy, args->align_lines[row_id], MAX_LINE_LENGTH - 1);
        align_line_copy[MAX_LINE_LENGTH - 1] = '\0'; // Ensure null termination

        // Remove trailing \n or \r\n
        size_t len = strlen(align_line_copy);
        while (len > 0 && (align_line_copy[len-1] == '\n' || align_line_copy[len-1] == '\r')) {
            align_line_copy[len-1] = '\0';
            len--;
        }
        
        int align_count = parse_alignments(align_line_copy, alignments);

        // Compute the alignment stability score
        float alignment_score = compute_alignment_stability(alignments, align_count, src_len, tgt_len);

        pthread_mutex_lock(&print_mutex);
        fprintf(log_file, "%.5f\n", alignment_score);   
        pthread_mutex_unlock(&print_mutex);
    }
    return NULL;
}

// ==== Parallel extraction ====
void alignment_score_parallel(
    char **src_lines, 
    char **tgt_lines, 
    char **align_lines, 
    int line_count, 
    const char *output_file_path,
    int num_cores
) {

    // create empty output file
    FILE *out_file = fopen(output_file_path, "w");
    if (!out_file) {
        fprintf(stderr, "Error creating output file: %s\n", output_file_path);
        return;
    }

    int NUM_THREADS = num_cores; // adjust as needed

    pthread_t* threads = new pthread_t[NUM_THREADS];
    ThreadArgs* args = new ThreadArgs[NUM_THREADS];

    // // Make a safe local copy of the string
    char safe_path[256];
    snprintf(safe_path, sizeof(safe_path), "%s", output_file_path);

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
        args[t].align_lines = align_lines;
        args[t].log_file = out_file;        // opened once in main

        pthread_create(&threads[t], NULL, worker, &args[t]);
    }

    for (int t = 0; t < NUM_THREADS; t++)
    {
        pthread_join(threads[t], NULL);
    }

    //printf("Phrase extraction completed with %d threads.\n", NUM_THREADS);
    
    fclose(out_file);

    delete[] threads;
    delete[] args;
}

extern "C"
{
    EMSCRIPTEN_KEEPALIVE
    int alignment_score_main(
        const char *src_file_path, 
        const char *tgt_file_path, 
        const char *align_file_path, 
        const char *output_file_path, 
        int start_idx,
        int end_idx,
        int num_cores
    )   {
        char **src_lines = NULL;
        char **tgt_lines = NULL;
        float *score_lines = NULL;
        char **align_lines = NULL;
        char line[MAX_LINE_LENGTH];

        FILE *src_file = fopen(src_file_path, "r");
        FILE *tgt_file = fopen(tgt_file_path, "r");
        FILE *align_file = fopen(align_file_path, "r");
        if (!src_file || !tgt_file || !align_file)
        {
            fprintf(stderr, "Error opening input files.\n");
            return 1;
        }

        // Count lines in the source file
        int line_count = end_idx - start_idx;

        // Allocate memory for lines
        src_lines = (char **)calloc(line_count, sizeof(char *));
        tgt_lines = (char **)calloc(line_count, sizeof(char *));
        align_lines = (char **)calloc(line_count, sizeof(char *));
        
        if (!src_lines || !tgt_lines || !align_lines)
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
            
            char *align_result = fgets(line, sizeof(line), align_file);
            if (align_result && file_line_index >= start_idx && file_line_index < end_idx) {
                align_lines[array_index] = strdup(line);
            }
            
            // Check if we've reached end of any file
            if (!src_result || !tgt_result || !align_result) {
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
        fclose(align_file);

        alignment_score_parallel(
            src_lines, 
            tgt_lines, 
            align_lines, 
            line_count, 
            output_file_path,
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
        free(align_lines);

        return 0;
    }
}