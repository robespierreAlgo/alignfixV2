#!/bin/bash

# Compile all configurations
# This script compiles WASM modules with different thread pool sizes and memory limits

echo "========================================"
echo "Compiling all WASM module configurations"
echo "========================================"

# Configuration array: (pool_size max_memory)
configs=(
    "1 2GB"
    "4 4GB"
    "8 4GB"
    "8 8GB"
    "16 16GB"
    "32 16GB"
)

for config in "${configs[@]}"; do
    set -- $config
    pool_size=$1
    max_memory=$2
    
    echo ""
    echo "----------------------------------------"
    echo "Building config: pool_size=${pool_size}, max_memory=${max_memory}"
    echo "----------------------------------------"
    
    bash ./compile.sh ${pool_size} ${max_memory}
    
    if [ $? -eq 0 ]; then
        echo "✓ Successfully compiled pool_size=${pool_size}, max_memory=${max_memory}"
    else
        echo "✗ Failed to compile pool_size=${pool_size}, max_memory=${max_memory}"
        exit 1
    fi
done

echo ""
echo "========================================"
echo "All configurations compiled successfully!"
echo "========================================"
echo ""
echo "Generated files:"
echo "  - phrase_extraction_p1.js/wasm  (1 thread,  2GB)"
echo "  - phrase_extraction_p4.js/wasm  (4 threads, 4GB)"
echo "  - phrase_extraction_p8.js/wasm  (8 threads, 8GB)"
echo "  - phrase_extraction_p16.js/wasm (16 threads, 16GB)"
echo ""
echo "  - text_tokenize_p1.js/wasm  (1 thread,  2GB)"
echo "  - text_tokenize_p4.js/wasm  (4 threads, 4GB)"
echo "  - text_tokenize_p8.js/wasm  (8 threads, 8GB)"
echo "  - text_tokenize_p16.js/wasm (16 threads, 16GB)"
echo ""
echo "  - alignment_score_p1.js/wasm  (1 thread,  2GB)"
echo "  - alignment_score_p4.js/wasm  (4 threads, 4GB)"
echo "  - alignment_score_p8.js/wasm  (8 threads, 8GB)"
echo "  - alignment_score_p16.js/wasm (16 threads, 16GB)"
echo ""
echo "  - fast_align_p1.js/wasm  (1 thread,  2GB)"
echo "  - fast_align_p4.js/wasm  (4 threads, 4GB)"
echo "  - fast_align_p8.js/wasm  (8 threads, 8GB)"
echo "  - fast_align_p16.js/wasm (16 threads, 16GB)"
