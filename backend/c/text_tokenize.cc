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

#define MAX_TOKENS 512
#define MAX_TOKEN_LENGTH 64
#define BLANK_TOKEN "#BL"
#define NO_BLANK_TOKEN "#NB"
#define MAX_LINE_LENGTH 4096

// Split symbols
const char *SPLIT_SYMBOLS[] = {
    "'", "!", "\"", "$", "%", "&", "\\", "(", ")", ".", "*", "+", ";", "@", "^",
    "`", "_", "|", "~", "-", "]", "[", "}", "{", "€", "§", "<", ">", ";", "!",
    "'", "?", ",", "/", ":", "=", "»", "«"
};
const int NUM_SPLIT_SYMBOLS = sizeof(SPLIT_SYMBOLS) / sizeof(SPLIT_SYMBOLS[0]);

// Helper: Check if a string is in the split symbols
int is_split_symbol(const char *str) {
    for (int i = 0; i < NUM_SPLIT_SYMBOLS; i++) {
        if (strcmp(str, SPLIT_SYMBOLS[i]) == 0) {
            return 1;
        }
    }
    return 0;
}

int is_blank_token(const char *str) {
    return strcmp(str, BLANK_TOKEN) == 0;
}

// Normalize text using libunistring
void clean_text(const char *input, char *output, size_t output_size) {
 
        strncpy(output, input, output_size - 1);
        output[output_size - 1] = '\0';
 
}


int remove_nb_bl_pairs_stack(char tokens[MAX_TOKENS][MAX_TOKEN_LENGTH], int token_count) {
    char stack[MAX_TOKENS][MAX_TOKEN_LENGTH];
    int stack_size = 0;

    for (int i = 0; i < token_count; i++) {
        if (stack_size > 0 &&
            ((strcmp(stack[stack_size - 1], NO_BLANK_TOKEN) == 0 && strcmp(tokens[i], BLANK_TOKEN) == 0) ||
             (strcmp(stack[stack_size - 1], BLANK_TOKEN) == 0 && strcmp(tokens[i], NO_BLANK_TOKEN) == 0))) {
            stack_size--; // Remove the last token from the stack
        } else {
            strncpy(stack[stack_size++], tokens[i], MAX_TOKEN_LENGTH - 1);
        }
    }

    // Copy the stack back to the tokens array
    for (int i = 0; i < stack_size; i++) {
        strncpy(tokens[i], stack[i], MAX_TOKEN_LENGTH - 1);
    }

    return stack_size;
}

char* tokenise(const char *text) {

    size_t len = strlen(text);
    size_t nb_len = strlen(NO_BLANK_TOKEN);
    size_t bufsize = len * (8 + nb_len*2) + 1; 
    // this should be a safe over-estimate of how large the string may become
    
    char *acc = (char *)malloc(bufsize);
    if (!acc) {
        return NULL;
    }
    char *p = acc; // pointer to current write position

    for (size_t i = 0; i < strlen(text); i++) {
        char c = text[i];
        char s[2] = {c, '\0'}; // null-terminated string
        if (is_split_symbol(s)) {
            p += sprintf(p, " %s %c %s ", NO_BLANK_TOKEN, c, NO_BLANK_TOKEN); 
            // worst case: 4 blanks + 2 no blank tokens + symbol
        } else if (isspace(c)) {
            p += sprintf(p, " %s ", BLANK_TOKEN);
        } else {
            *p++ = c;
            *p = '\0';
        }
        if ((size_t)(p - acc) >= bufsize - 1) {
            fprintf(stderr, "Tokenization buffer overflow prevented\n");
            break;
        }
    }

    // now split acc into tokens by space

    char tokens[MAX_TOKENS][MAX_TOKEN_LENGTH];
    int token_count = 0;

    // Work on a copy because strtok modifies the string
    char *acc_copy = strdup(acc);
    if (!acc_copy) {
        fprintf(stderr, "Memory allocation failed\n");
        free(acc);
        return NULL;
    }

    char *saveptr = NULL;
    char *token = strtok_r(acc_copy, " ", &saveptr);

    while (token && token_count < MAX_TOKENS) {
        if (strlen(token) == 0) {
            token = strtok_r(NULL, " ", &saveptr);
            continue;
        }

        // Ensure token storage is safe
        strncpy(tokens[token_count], token, MAX_TOKEN_LENGTH - 1);
        tokens[token_count][MAX_TOKEN_LENGTH - 1] = '\0';

        // Merge / overwrite logic
        if (token_count > 0) {
            if (is_blank_token(tokens[token_count]) &&
                strcmp(tokens[token_count - 1], NO_BLANK_TOKEN) == 0) {
                strncpy(tokens[token_count - 1], BLANK_TOKEN, MAX_TOKEN_LENGTH - 1);
                tokens[token_count - 1][MAX_TOKEN_LENGTH - 1] = '\0';
                token_count--;  // remove current token
            } else if (strcmp(tokens[token_count], NO_BLANK_TOKEN) == 0 &&
                    is_blank_token(tokens[token_count - 1])) {
                token_count--;  // skip current NB
            } else if (strcmp(tokens[token_count], NO_BLANK_TOKEN) == 0 &&
                    strcmp(tokens[token_count - 1], NO_BLANK_TOKEN) == 0) {
                token_count--;  // skip duplicate NB
            }
        }

        token_count++;
        token = strtok_r(NULL, " ", &saveptr);
    }

    free(acc_copy);

    // === Join tokens back ===
    acc[0] = '\0';
    size_t acc_len = 0;
    size_t acc_capacity = strlen(text) * 12 + 1; // safe overestimate

    for (int i = 0; i < token_count; i++) {
        // Replace BL token with single space
        if (is_blank_token(tokens[i])) {
            continue;
            // strncpy(tokens[i], " ", MAX_TOKEN_LENGTH - 1);
            // tokens[i][MAX_TOKEN_LENGTH - 1] = '\0';
        }

        // Skip consecutive spaces
        if (i > 0 && strcmp(tokens[i], " ") == 0 && strcmp(tokens[i - 1], " ") == 0)
            continue;

        // Skip final NB
        if (i == token_count - 1 && strcmp(tokens[i], NO_BLANK_TOKEN) == 0)
            continue;

        // Append with safety
        size_t needed = strlen(tokens[i]) + 2; // + space + null
        if (acc_len + needed >= acc_capacity) {
            fprintf(stderr, "Token join overflow prevented\n");
            break;
        }

        strcat(acc, tokens[i]);
        acc_len += strlen(tokens[i]);

        if (i < token_count - 1) {
            strcat(acc, " ");
            acc_len++;
        }

    }

    return acc;

}

// Thread args
typedef struct
{
    int thread_id;
    int start_index;
    int end_index;
    char **lines;
    const char *output_file_path;
} ThreadArgs;

pthread_mutex_t print_mutex = PTHREAD_MUTEX_INITIALIZER;

// ==== Thread worker ====
void *worker(void *arg)
{
    ThreadArgs *args = (ThreadArgs *)arg;

    // Buffer to store tokenised lines locally
    char **tokenised_lines = (char **)malloc((args->end_index - args->start_index) * sizeof(char*));
    if (!tokenised_lines) {
        fprintf(stderr, "Memory allocation failed for tokenised_lines\n");
        return NULL;
    }
    int tokenised_count = 0;

    // Tokenise each line locally without locking
    for (int row_id = args->start_index; row_id < args->end_index; row_id++)
    {
        if (!args->lines[row_id])
            continue;

        char *tokenised = tokenise(args->lines[row_id]);
        tokenised_lines[tokenised_count++] = tokenised;
    }

    // Now write all lines to the file at once while holding the mutex
    pthread_mutex_lock(&print_mutex);

    FILE *log_file = fopen(args->output_file_path, "a");
    if (!log_file)
    {
        fprintf(stderr, "Error opening %s file.\n", args->output_file_path);
        pthread_mutex_unlock(&print_mutex);
        // Free allocated memory before returning
        for (int i = 0; i < tokenised_count; i++)
            free(tokenised_lines[i]);
        free(tokenised_lines);
        return NULL;
    }

    for (int i = 0; i < tokenised_count; i++)
    {
        fprintf(log_file, "%d|||%s\n", args->start_index + i, tokenised_lines[i]);
        free(tokenised_lines[i]);  // free each line after writing
    }
    free(tokenised_lines);

    fclose(log_file);
    pthread_mutex_unlock(&print_mutex);

    return NULL;
}


// ==== Parallel extraction ====
void tokenize_parallel(
    char **lines,
    int line_count,
    const char *output_file_path,
    int num_cores = 4
) {

    int NUM_THREADS = num_cores; // adjust as needed

    pthread_t* threads = new pthread_t[NUM_THREADS];
    ThreadArgs* args = new ThreadArgs[NUM_THREADS];

    // create empty output file
    FILE *out_file = fopen(output_file_path, "w");
    if (!out_file) {
        fprintf(stderr, "Error creating output file: %s\n", output_file_path);
        return;
    }
    fclose(out_file);

    printf("Starting tokenization with %d threads...\n", NUM_THREADS);

    int chunk_size = (line_count + NUM_THREADS - 1) / NUM_THREADS;

    for (int t = 0; t < NUM_THREADS; t++)
    {
        args[t].thread_id = t;
        args[t].start_index = t * chunk_size;
        args[t].end_index = (t + 1) * chunk_size;
        if (args[t].end_index > line_count)
            args[t].end_index = line_count;
        args[t].lines = lines;
        args[t].output_file_path = output_file_path;

        pthread_create(&threads[t], NULL, worker, &args[t]);
    }

    for (int t = 0; t < NUM_THREADS; t++)
    {
        pthread_join(threads[t], NULL);
    }

    delete[] threads;
    delete[] args;
}


extern "C" {
EMSCRIPTEN_KEEPALIVE
int tokenize_file(const char *input_file, const char *output_file, const int num_cores) {
    FILE *in_file = fopen(input_file, "r");
    if (!in_file) {
        fprintf(stderr, "Error opening input file: %s\n", input_file);
        return 1; // Return 1 for file open error
    }

    // read lines into an array
    char **lines = NULL;
    size_t lines_allocated = 0;
    size_t line_count = 0;
    char buffer[MAX_LINE_LENGTH];

    while (fgets(buffer, sizeof(buffer), in_file)) {
        // Remove trailing newline
        buffer[strcspn(buffer, "\r\n")] = '\0';
        buffer[strcspn(buffer, "\n")] = '\0';

        // Allocate more space if needed
        if (line_count >= lines_allocated) {
            lines_allocated = lines_allocated ? lines_allocated * 2 : 16;
            lines = (char **)realloc(lines, lines_allocated * sizeof(char *));
        }

        // Store a copy of the line
        lines[line_count] = strdup(buffer);
        line_count++;
    }

    printf("Read %zu lines from %s\n", line_count, input_file);

    // call parallel tokenize function here
    tokenize_parallel(lines, line_count, output_file, num_cores);

    // free lines
    for (size_t i = 0; i < line_count; i++) {
        free(lines[i]);
    }
    free(lines);
    fclose(in_file);

    return 0; // Return 0 for success
}
}


// int main() {
    
//     // read content of file /home/samuel/uibk/research/ladinmt/lldmt-ifi-cluster/corpus/motorola/deu-lld.deu.txt
//     const char *input_file = "/home/samuel/uibk/research/ladinmt/lldmt-ifi-cluster/corpus/motorola/deu-lld.lld.txt";
//     FILE *in_file = fopen(input_file, "r");
//     if (!in_file) {
//         fprintf(stderr, "Error opening input file: %s\n", input_file);
//         return 1;
//     }

//     // read lines into an array
//     char **test_strings = NULL;
//     size_t strings_allocated = 0;
//     size_t string_count = 0;
//     char buffer[MAX_LINE_LENGTH];   
//     while (fgets(buffer, sizeof(buffer), in_file)) {
//         // Remove trailing newline
//         buffer[strcspn(buffer, "\r\n")] = '\0';
//         buffer[strcspn(buffer, "\n")] = '\0';

//         // Allocate more space if needed
//         if (string_count >= strings_allocated) {
//             strings_allocated = strings_allocated ? strings_allocated * 2 : 16;
//             test_strings = (char **)realloc(test_strings, strings_allocated * sizeof(char *));
//         }

//         // Store a copy of the line
//         test_strings[string_count] = strdup(buffer);
//         string_count++;
//     }

//     // tokenize each string in parallel and write to output file
//     const char *output_file = "tokenized_output.txt";
//     tokenize_parallel(test_strings, string_count, output_file, 8);

//     // free test_strings
//     for (size_t i = 0; i < string_count; i++) {
//         free(test_strings[i]);
//     }
//     free(test_strings);

//     return 0;
// }
