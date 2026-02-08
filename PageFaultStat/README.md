# PageFaultStat - Page Fault Monitor

PageFaultStat is a ncurses-based Linux utility that samples `/proc` once per second (by default) and shows which processes cause major and minor page faults. The tool is handy when you need to understand why a system is thrashing or which workload keeps forcing disk reads.

## Highlights
- Real-time terminal UI powered by ncurses (`-t` top-like mode or plain text mode)
- Per-process totals plus deltas between samples (major, minor, swap)
- Filtering by PID/name (`-p`), custom intervals, and different command name formats (-c/-l/-s)
- Lightweight C implementation (~1700 LOC) with hash-table based caches for processes and usernames
- When started without arguments it prompts interactively for the interval and sample count

## Source Layout
- `main.c` — argument parsing, sampling loop, signal handling
- `display.c` — ncurses and plain TTY output helpers
- `proc.c` — reads `/proc/[pid]/stat` and `/proc/[pid]/status`, computes deltas, sorts output
- `cache.c` — memory pooling plus PID/UID caches
- `utils.c` — helpers for cmdline parsing, formatting, timing, and PID utilities
- `faultstat.h` — shared types, macros, and prototypes

## Build Requirements
- GCC or Clang
- GNU make
- `libncursesw` development headers (Debian/Ubuntu: `sudo apt install build-essential libncursesw5-dev`)

## Build & Run
### Standard Linux / WSL workflow
```bash
cd /mnt/d/RVCE/EL-2025/OS/Real-Time\ System\ Fault\ and\ Performance\ Analyzer
make clean
make
./faultstat -t
```
The commands above rebuild from scratch and start the interactive “top” mode. Omit `make clean` for incremental builds and drop `-t` to print a single plain-text snapshot.

### Quick commands
```bash
./faultstat          # default interval (1 s) continuous text mode
./faultstat -t       # ncurses dashboard that updates until you press q
./faultstat 2 10     # sample every 2 seconds, stop after 10 samples
./faultstat -p sshd  # track only processes whose PID or name matches “sshd”
./faultstat -a       # show arrows indicating the direction of change
```

## Option cheatsheet
| Flag | Purpose |
|------|---------|
| `-a` | show up/down arrows for major+minor deltas |
| `-c` | read the command from `/proc/[pid]/comm` |
| `-d` | strip directory prefixes from command names |
| `-l` / `-s` | long/short command line formats |
| `-p pid,list` | comma-separated PID or name filters |
| `-t` / `-T` | ncurses “top” modes (changes only vs totals) |

## Sample output (`./faultstat -t`)
```
 PID      Major   Minor  +Major  +Minor    Swap  User       Command
 2473       12    1047        0       8       0  krupa      firefox
 1714        2     890        0       2       0  root       systemd-journald
 Total:      0       0        0       0
```
(Columns differ slightly in plain-text mode, but the data is identical.)

## Web UI
The project includes a web interface in the `webui/` directory for remote monitoring capabilities.

## Troubleshooting
- Build errors about `pwd.h`, `uid_t`, or ncurses usually mean you are compiling on Windows instead of Linux/WSL. Run the build inside Ubuntu/WSL.
- If nothing appears in top mode, ensure your terminal is large enough and that `/proc` is accessible (must run locally, not inside a minimal container without `/proc`).
- Use `make clean && make` after switching branches or pulling updates to avoid stale objects.


