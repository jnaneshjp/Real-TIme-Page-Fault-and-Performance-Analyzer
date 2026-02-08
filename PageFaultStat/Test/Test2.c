#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <signal.h>

#define CHUNK_MB 200          // Allocate in chunks
#define PAGE_SIZE 4096

volatile sig_atomic_t keep_running = 1;

void handle_signal(int sig) {
    keep_running = 0;
}

int main() {
    char **blocks = NULL;
    size_t block_count = 0;
    size_t i;

    signal(SIGINT, handle_signal);
    signal(SIGTERM, handle_signal);

    printf("Swap-based Major Fault Generator\n");
    printf("PID: %d\n", getpid());
    printf("Terminate from your UI\n");

    // Phase 1: Allocate & touch memory (force swap-out)
    while (keep_running) {
        char *block = malloc(CHUNK_MB * 1024 * 1024);
        if (!block) {
            printf("Allocation failed (memory pressure reached)\n");
            break;
        }

        // Touch every page → forces RAM usage
        for (i = 0; i < CHUNK_MB * 1024 * 1024; i += PAGE_SIZE) {
            block[i] = 1;
        }

        block_count++;
        blocks = realloc(blocks, block_count * sizeof(char *));
        blocks[block_count - 1] = block;

        printf("Allocated & touched: %zu MB\n", block_count * CHUNK_MB);
        sleep(1);
    }

    // Phase 2: Re-access memory → swap-in → MAJOR faults
    printf("Re-accessing memory to trigger swap-in faults...\n");

    while (keep_running) {
        for (size_t b = 0; b < block_count; b++) {
            for (i = 0; i < CHUNK_MB * 1024 * 1024; i += PAGE_SIZE) {
                blocks[b][i] += 1;
            }
        }
        sleep(1);
    }

    printf("Cleaning up...\n");

    for (size_t b = 0; b < block_count; b++) {
        free(blocks[b]);
    }
    free(blocks);

    return 0;
}
