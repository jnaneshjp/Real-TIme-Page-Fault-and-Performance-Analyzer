#include <stdio.h>
#include <stdlib.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/mman.h>
#include <signal.h>

#define FILE_SIZE (200 * 1024 * 1024)   // 200 MB
#define PAGE_SIZE 4096

volatile sig_atomic_t keep_running = 1;

void handle_signal(int sig) {
    keep_running = 0;
}

int main() {
    int fd;
    char *map;
    size_t i;

    // Handle termination signals
    signal(SIGTERM, handle_signal);
    signal(SIGINT, handle_signal);

    fd = open("fault_test_file.bin", O_RDWR | O_CREAT, 0666);
    if (fd < 0) {
        perror("open");
        return 1;
    }

    ftruncate(fd, FILE_SIZE);

    map = mmap(NULL, FILE_SIZE, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (map == MAP_FAILED) {
        perror("mmap");
        close(fd);
        return 1;
    }

    printf("Process running. PID = %d\n", getpid());
    printf("Terminate this process from the UI.\n");

    // Repeatedly access pages to keep causing major faults
    while (keep_running) {
        for (i = 0; i < FILE_SIZE; i += PAGE_SIZE) {
            map[i] = 'A';
        }
        sleep(1);  // slow down so graph is readable
    }

    printf("Termination signal received. Exiting cleanly...\n");

    munmap(map, FILE_SIZE);
    close(fd);

    return 0;
}
