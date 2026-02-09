// parallel_for.h
#pragma once

#include <thread>
#include <vector>
#include <algorithm>

#ifdef USE_OPENMP
#include <omp.h>
#endif

template<typename Func>
inline void parallel_for(size_t num_threads, size_t start, size_t end, Func func) {
#ifdef USE_OPENMP
    #pragma omp parallel for schedule(dynamic)
    for (size_t i = start; i < end; ++i) {
        func(i, omp_get_thread_num());
    }
#else
    std::vector<std::thread> threads(num_threads);

    size_t chunk_size = (end - start + num_threads - 1) / num_threads;

    auto worker = [&](size_t thread_id) {
        size_t s = start + thread_id * chunk_size;
        size_t e = std::min(s + chunk_size, end);
        for (size_t i = s; i < e; ++i) {
            func(i, thread_id);
        }
    };

    for (size_t t = 0; t < num_threads; ++t) {
        threads[t] = std::thread(worker, t);
    }
    for (auto& th : threads) {
        if (th.joinable()) th.join();
    }
#endif
}
