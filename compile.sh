#!/bin/bash

cd ../../emsdk/
source ./emsdk_env.sh

cd ../alignfix/wasm/backend/c

# Configuration: Set POOL_SIZE and MAX_MEMORY as parameters
# Usage: ./compile.sh [POOL_SIZE] [MAX_MEMORY]
# Examples:
#   ./compile.sh 1 2GB
#   ./compile.sh 4 4GB
#   ./compile.sh 8 8GB
#   ./compile.sh 16 16GB

POOL_SIZE=${1:-4}
MAX_MEMORY=${2:-4GB}

echo "Compiling with PTHREAD_POOL_SIZE=${POOL_SIZE} and MAXIMUM_MEMORY=${MAX_MEMORY}"

# Output filenames include configuration
SUFFIX="_p${POOL_SIZE}"

emcc phrase_extraction.cc \
     -O3 -std=c++11 -I. -I src \
	-s USE_PTHREADS=1 -s PTHREAD_POOL_SIZE=${POOL_SIZE} \
     -s WASM=1 -s MODULARIZE=1 \
     -s EXPORT_NAME="createExtractPhrasesModule" \
     -s ALLOW_MEMORY_GROWTH=1 -s MEMORY64=1 -s ASSERTIONS=0 \
     -s MAXIMUM_MEMORY=${MAX_MEMORY} \
     -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","FS"]' \
     -s EXPORTED_FUNCTIONS='["_extract_phrases_parallel_main"]' \
     -o phrase_extraction${SUFFIX}.js

# emcc text_tokenize.cc -O3 -std=c++11 \
#     -s USE_PTHREADS=1 -s PTHREAD_POOL_SIZE=${POOL_SIZE} \
#     -s WASM=1 -s MODULARIZE=1 \
#     -s EXPORT_NAME="createTextTokenizeModule" \
#     -s ALLOW_MEMORY_GROWTH=1 -s MEMORY64=1 \
#     -s MAXIMUM_MEMORY=${MAX_MEMORY} \
#     -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","FS"]' \
#     -s EXPORTED_FUNCTIONS='["_tokenize_file"]' \
#     -o text_tokenize${SUFFIX}.js

# emcc alignment_score.cc -O3 -std=c++11 \
#     -s USE_PTHREADS=1 -s PTHREAD_POOL_SIZE=${POOL_SIZE} \
#     -s WASM=1 -s MODULARIZE=1 \
#     -s EXPORT_NAME="createAlignmentScoreModule" \
#     -s ALLOW_MEMORY_GROWTH=1 -s MEMORY64=1 \
#     -s MAXIMUM_MEMORY=${MAX_MEMORY} \
#     -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","FS"]' \
#     -s EXPORTED_FUNCTIONS='["_alignment_score_main"]' \
#     -o alignment_score${SUFFIX}.js

# cd ../fast_align/

# emcc src/fast_align.cc src/ttables.cc src/alignment_io.cc \
#      -O3 -std=c++11 -I. -I src \
# 	-s USE_PTHREADS=1 -s PTHREAD_POOL_SIZE=${POOL_SIZE} \
#      -s ASYNCIFY=1 -s MAXIMUM_MEMORY=${MAX_MEMORY} \
#      -s WASM=1 -s MODULARIZE=1 -s EXPORT_NAME="createFastAlignModule" \
#      -s ALLOW_MEMORY_GROWTH=1 -s MEMORY64=1 -s ASSERTIONS=0 \
#      -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","FS"]' \
#      -s EXPORTED_FUNCTIONS='["_run_fast_align"]' \
#      -o fast_align${SUFFIX}.js

# emcc src/atools.cc src/alignment_io.cc \
#      -O3 -std=c++11 -I. -I src \
#      -s USE_PTHREADS=1 -s PTHREAD_POOL_SIZE=${POOL_SIZE} \
#      -s WASM=1 -s MODULARIZE=1 -s EXPORT_NAME="createAtoolsModule" \
#      -s ALLOW_MEMORY_GROWTH=1 -s MEMORY64=1 -s ASSERTIONS=0 \
#      -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","FS"]' \
#      -s EXPORTED_FUNCTIONS='["_run_atools"]' \
#      -o atools${SUFFIX}.js

# cd ..

echo "Compilation complete with pool_size=${POOL_SIZE}, max_memory=${MAX_MEMORY}"
echo "Output files: *${SUFFIX}.js and *${SUFFIX}.wasm"

# note that with thread pool size N, max N threads can be used and dynamic threads cannot exceed N