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

/**
 * Dynamic WASM Module Loader
 * Selects the appropriate WASM module version based on available hardware
 */

// Detect available hardware capabilities
function detectHardwareCapabilities() {
    const cores = navigator.hardwareConcurrency || 1;
    const memory = navigator.deviceMemory || 4; // GB, defaults to 4GB if unavailable
    
    console.log(`Detected hardware: ${cores} cores, ~${memory}GB RAM`);
    
    return { cores, memory };
}

// Select the best configuration based on hardware
function selectOptimalConfig(cores, memory) {
    // Define available configurations (pool_size, max_memory_gb)
    const configs = [
        { poolSize: 16, memoryGB: 16, suffix: '_p16', minCores: 9,  minMemory: 8 },
        { poolSize: 8,  memoryGB: 8,  suffix: '_p8',  minCores: 5,  minMemory: 4 },
        { poolSize: 4,  memoryGB: 4,  suffix: '_p4',  minCores: 2,  minMemory: 2 },
        { poolSize: 1,  memoryGB: 2,  suffix: '_p1',  minCores: 1,  minMemory: 1 }
    ];
    
    // Find the best matching configuration
    for (const config of configs) {
        if (cores >= config.minCores && memory >= config.minMemory) {
            console.log(`Selected configuration: ${config.poolSize} threads, ${config.memoryGB}GB max memory (${config.suffix})`);
            return config;
        }
    }
    
    // Fallback to smallest config
    console.log('Using fallback configuration: 1 thread, 2GB');
    return configs[configs.length - 1];
}

// Load a WASM module with the appropriate suffix
async function loadWasmModule(baseName, moduleLoaderName) {
    const { cores, memory } = detectHardwareCapabilities();
    const config = selectOptimalConfig(cores, memory);
    
    const scriptPath = `backend/c/${baseName}${config.suffix}.js`;
    
    console.log(`Loading ${baseName} from ${scriptPath}`);
    
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = scriptPath;
        script.onload = () => {
            console.log(`✓ Loaded ${baseName}${config.suffix}.js`);
            // Return the module loader function and config
            resolve({
                createModule: window[moduleLoaderName],
                config: config
            });
        };
        script.onerror = (error) => {
            console.error(`✗ Failed to load ${scriptPath}:`, error);
            reject(new Error(`Failed to load ${scriptPath}`));
        };
        document.head.appendChild(script);
    });
}

// Load fast_align module
async function loadFastAlignModule() {
    const { cores, memory } = detectHardwareCapabilities();
    const config = selectOptimalConfig(cores, memory);
    
    const scriptPath = `backend/fast_align/fast_align${config.suffix}.js`;
    
    console.log(`Loading fast_align from ${scriptPath}`);
    
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = scriptPath;
        script.onload = () => {
            console.log(`✓ Loaded fast_align${config.suffix}.js`);
            resolve({
                createModule: window.createFastAlignModule,
                config: config
            });
        };
        script.onerror = (error) => {
            console.error(`✗ Failed to load ${scriptPath}:`, error);
            reject(new Error(`Failed to load ${scriptPath}`));
        };
        document.head.appendChild(script);
    });
}

// Load atools module
async function loadAtoolsModule() {
    const { cores, memory } = detectHardwareCapabilities();
    const config = selectOptimalConfig(cores, memory);
    
    const scriptPath = `backend/fast_align/atools${config.suffix}.js`;
    
    console.log(`Loading atools from ${scriptPath}`);
    
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = scriptPath;
        script.onload = () => {
            console.log(`✓ Loaded atools${config.suffix}.js`);
            resolve({
                createModule: window.createAtoolsModule,
                config: config
            });
        };
        script.onerror = (error) => {
            console.error(`✗ Failed to load ${scriptPath}:`, error);
            reject(new Error(`Failed to load ${scriptPath}`));
        };
        document.head.appendChild(script);
    });
}

// Export for use in other modules
window.WasmModuleLoader = {
    loadPhraseExtraction: () => loadWasmModule('phrase_extraction', 'createExtractPhrasesModule'),
    loadTextTokenize: () => loadWasmModule('text_tokenize', 'createTextTokenizeModule'),
    loadAlignmentScore: () => loadWasmModule('alignment_score', 'createAlignmentScoreModule'),
    loadFastAlign: loadFastAlignModule,
    loadAtools: loadAtoolsModule,
    detectHardwareCapabilities,
    selectOptimalConfig
};

console.log('WASM Module Loader initialized');
