/*
 * Copyright (C) 2014-2021 Canonical, Ltd.
 * Copyright (C) 2021-2025 Colin Ian King.
 *
 * This program is free software; you can redistribute it and/or
 * modify it under the terms of the GNU General Public License
 * as published by the Free Software Foundation; either version 2
 * of the License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program; if not, write to the Free Software
 * Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301, USA.
 *
 * Author: Colin Ian King <colin.i.king@gmail.com>
 */

#define _GNU_SOURCE
#define _XOPEN_SOURCE_EXTENDED

#include "faultstat.h"
#include <fcntl.h>
#include <unistd.h>

/* Global variables */
uname_cache_t *uname_cache[UNAME_HASH_TABLE_SIZE];
proc_info_t *proc_cache_hash[PROC_HASH_TABLE_SIZE];
const char *const app_name = "PageFaultStat";

bool stop_faultstat = false;
unsigned int opt_flags;
fault_info_t *fault_info_cache;
pid_list_t *pids;
display_funcs_t df;
bool resized;
int rows = 25;
int cols = 80;
int cury = 0;
int sort_by = SORT_MAJOR_MINOR;

/* Signal handlers array */
static const int signals[] = {
	/* POSIX.1-1990 */
#ifdef SIGHUP
	SIGHUP,
#endif
#ifdef SIGINT
	SIGINT,
#endif
#ifdef SIGQUIT
	SIGQUIT,
#endif
#ifdef SIGFPE
	SIGFPE,
#endif
#ifdef SIGTERM
	SIGTERM,
#endif
#ifdef SIGUSR1
	SIGUSR1,
#endif
#ifdef SIGUSR2
	SIGUSR2,
	/* POSIX.1-2001 */
#endif
#ifdef SIGXCPU
	SIGXCPU,
#endif
#ifdef SIGXFSZ
	SIGXFSZ,
#endif
	/* Linux various */
#ifdef SIGIOT
	SIGIOT,
#endif
#ifdef SIGSTKFLT
	SIGSTKFLT,
#endif
#ifdef SIGPWR
	SIGPWR,
#endif
#ifdef SIGINFO
	SIGINFO,
#endif
#ifdef SIGVTALRM
	SIGVTALRM,
#endif
	-1,
};

static bool prompt_for_duration(double *duration)
{
	char buf[64];

	for (;;) {
		(void)printf("Enter sample interval in seconds (>= 1, blank keeps %.1f): ", *duration);
		(void)fflush(stdout);
		if (fgets(buf, sizeof(buf), stdin) == NULL)
			return false;
		if ((buf[0] == '\n') || (buf[0] == '\0'))
			return false;
		errno = 0;
		char *endptr = NULL;
		double val = strtod(buf, &endptr);
		if ((errno == 0) && (endptr != buf) && (val >= 1.0)) {
			*duration = val;
			return true;
		}
		(void)printf("Invalid interval. Please enter a number >= 1.\n");
	}
}

static bool prompt_for_count(long int *count, bool *forever)
{
	char buf[64];

	for (;;) {
		(void)printf("Enter number of samples (0 for continuous, blank keeps default): ");
		(void)fflush(stdout);
		if (fgets(buf, sizeof(buf), stdin) == NULL)
			return false;
		if ((buf[0] == '\n') || (buf[0] == '\0'))
			return false;
		errno = 0;
		char *endptr = NULL;
		long int val = strtol(buf, &endptr, 10);
		if ((errno == 0) && (endptr != buf) && (val >= 0)) {
			if (val == 0) {
				*forever = true;
				*count = -1;
			} else {
				*forever = false;
				*count = val;
			}
			return true;
		}
		(void)printf("Invalid count. Enter 0 or a positive integer.\n");
	}
}

int main(int argc, char **argv)
{
	fault_info_t *fault_info_old = NULL;
	fault_info_t *fault_info_new = NULL;

	double duration = 1.0;
	struct timeval tv1;
	bool forever = true;
	long int count = 0;
	size_t npids;
	bool duration_from_user = false;
	bool count_from_user = false;

	df = df_normal;

	for (;;) {
		int c = getopt(argc, argv, "acdhlp:stTj");

		if (c == -1)
			break;
		switch (c) {
		case 'a':
			opt_flags |= OPT_ARROW;
			break;
		case 'c':
			opt_flags |= OPT_CMD_COMM;
			break;
		case 'd':
			opt_flags |= OPT_DIRNAME_STRIP;
			break;
		case 'h':
			show_usage();
			exit(EXIT_SUCCESS);
		case 'j':
			opt_flags |= OPT_JSON | OPT_ONCE;
			count = 2;
			duration = 1.0;
			forever = false;
			break;
		case 'l':
			opt_flags |= OPT_CMD_LONG;
			break;
		case 'p':
			if (parse_pid_list(optarg) < 0)
				exit(EXIT_FAILURE);
			break;
		case 's':
			opt_flags |= OPT_CMD_SHORT;
			break;
		case 'T':
			opt_flags |= OPT_TOP_TOTAL;
			/* fall through */
		case 't':
			opt_flags |= OPT_TOP;
			count = -1;
			break;
		default:
			show_usage();
			exit(EXIT_FAILURE);
		}
	}

	if (count_bits(opt_flags & OPT_CMD_ALL) > 1) {
		(void)fprintf(stderr, "Cannot have -c, -l, -s at same time.\n");
		exit(EXIT_FAILURE);
	}

	setlocale(LC_ALL, "");

	if (optind < argc) {
		errno = 0;
		duration = strtof(argv[optind++], NULL);
		if (errno) {
			(void)fprintf(stderr, "Invalid or out of range value for duration\n");
			exit(EXIT_FAILURE);
		}
		if (duration < 1.0) {
			(void)fprintf(stderr, "Duration must be 1.0 or more seconds.\n");
			exit(EXIT_FAILURE);
		}
		count = -1;
		duration_from_user = true;
	}

	if (optind < argc) {
		forever = false;
		errno = 0;
		count = strtol(argv[optind++], NULL, 10);
		if (errno) {
			(void)fprintf(stderr, "Invalid or out of range value for count\n");
			exit(EXIT_FAILURE);
		}
		if (count < 1) {
			(void)fprintf(stderr, "Count must be > 0\n");
			exit(EXIT_FAILURE);
		}
		count_from_user = true;
	}

	const bool interactive_prompt = (argc == 1) && isatty(STDIN_FILENO) && !(opt_flags & OPT_JSON);
	if (interactive_prompt && !duration_from_user) {
		if (prompt_for_duration(&duration)) {
			count = -1;
			duration_from_user = true;
		}
	}
	if (interactive_prompt && !count_from_user)
		(void)prompt_for_count(&count, &forever);

	if (count == 0) {
		if (fault_get_all_pids(&fault_info_new, &npids) == 0) {
			fault_dump(fault_info_old, fault_info_new, true);
		}
	} else {
		struct sigaction new_action;
		uint64_t t = 1;
		int i;
		bool redo = false;
		double duration_secs = (double)duration, time_start, time_now;

		if (opt_flags & OPT_TOP)
			df = df_top;
		/*
		 *  Pre-cache, this way we reduce
		 *  the amount of mem infos we alloc during
		 *  sampling
		 */
		if (fault_get_all_pids(&fault_info_old, &npids) < 0)
			goto free_cache;
		fault_cache_prealloc((npids * 5) / 4);

		if (gettimeofday(&tv1, NULL) < 0) {
			(void)fprintf(stderr, "gettimeofday failed: errno=%d (%s)\n",
				errno, strerror(errno));
			exit(EXIT_FAILURE);
		}

		if (!(opt_flags & OPT_TOP))
			(void)printf("Change in page faults (average per second):\n");

		(void)memset(&new_action, 0, sizeof(new_action));
		for (i = 0; signals[i] != -1; i++) {
			new_action.sa_handler = handle_sig;
			sigemptyset(&new_action.sa_mask);
			new_action.sa_flags = 0;

			if (sigaction(signals[i], &new_action, NULL) < 0) {
				(void)fprintf(stderr, "sigaction failed: errno=%d (%s)\n",
					errno, strerror(errno));
				exit(EXIT_FAILURE);
			}
		}
		(void)memset(&new_action, 0, sizeof(new_action));
		new_action.sa_handler = handle_sigwinch;
		if (sigaction(SIGWINCH, &new_action , NULL) < 0) {
			(void)fprintf(stderr, "sigaction failed: errno=%d (%s)\n",
				errno, strerror(errno));
			exit(EXIT_FAILURE);
		}

		time_now = time_start = gettime_to_double();

		df.df_setup();
		df.df_winsize(true);

		while (!stop_faultstat && (forever || count--)) {
			struct timeval tv;
			double secs;
			int nchar;

			df.df_clear();
			cury = 0;

			/* Timeout to wait for in the future for this sample */
			secs = time_start + ((double)t * duration_secs) - time_now;
			/* Play catch-up, probably been asleep */
			if (secs < 0.0) {
				t = ceil((time_now - time_start) / duration_secs);
				secs = time_start +
					((double)t * duration_secs) - time_now;
				/* We don't get sane stats if duration is too small */
				if (secs < 0.5)
					secs += duration_secs;
			} else {
				if (!redo)
					t++;
			}
			redo = false;

			double_to_timeval(secs, &tv);
retry:
			if (select(0, NULL, NULL, NULL, &tv) < 0) {
				if (errno == EINTR) {
					if (!resized) {
						stop_faultstat = true;
					} else {
						redo = true;
						df.df_winsize(true);
						if (timeval_to_double(&tv) > 0.0)
							goto retry;
					}
				} else {
					display_restore();
					(void)fprintf(stderr, "Select failed: %s\n", strerror(errno));
					break;
				}
			}

			nchar = 0;
			if ((ioctl(0, FIONREAD, &nchar) == 0) && (nchar > 0)) {
				char ch;

				nchar = read(0, &ch, 1);
				if (nchar == 1) {
					switch (ch) {
					case 'q':
					case 'Q':
					case 27:
						stop_faultstat = true;
						break;
					case 'a':
						opt_flags ^= OPT_ARROW;
						break;
					case 't':
						opt_flags ^= OPT_TOP_TOTAL;
						break;
					case 's':
						sort_by++;
						if (sort_by >= SORT_END)
							sort_by = SORT_MAJOR_MINOR;
					}
				}
			}


			if (fault_get_all_pids(&fault_info_new, &npids) < 0)
				goto free_cache;

			if (opt_flags & OPT_JSON) {
				fault_dump_json(fault_info_old, fault_info_new);
			} else if (opt_flags & OPT_TOP_TOTAL) {
				fault_dump(fault_info_old, fault_info_new, false);
			} else {
				fault_dump_diff(fault_info_old, fault_info_new);
			}

			df.df_refresh();

			fault_cache_free_list(fault_info_old);
			fault_info_old = fault_info_new;
			fault_info_new = NULL;
			time_now = gettime_to_double();
		}

free_cache:
		fault_cache_free_list(fault_info_old);
	}

	display_restore();
	uname_cache_cleanup();
	proc_cache_cleanup();
	fault_cache_cleanup();
	pid_list_cleanup();

	exit(EXIT_SUCCESS);
}
