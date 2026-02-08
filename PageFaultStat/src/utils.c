/*
 * Utility functions for faultstat
 */

#define _GNU_SOURCE
#define _XOPEN_SOURCE_EXTENDED

#include "faultstat.h"

/*
 *  out_of_memory()
 *      report out of memory condition
 */
void out_of_memory(const char *msg)
{
	display_restore();
	(void)fprintf(stderr, "Out of memory: %s.\n", msg);
}

/*
 *  uname_name()
 *	fetch name from uname, handle
 *	unknown NULL unames too
 */
const char *uname_name(const uname_cache_t * const uname)
{
	return uname ? uname->name : "<unknown>";
}

/*
 *  count_bits()
 */
#if defined(__GNUC__)
/*
 *  use GCC built-in
 */
unsigned int count_bits(const unsigned int val)
{
	return __builtin_popcount(val);
}
#else
/*
 *  count bits set, from C Programming Language 2nd Ed
 */
unsigned int count_bits(const unsigned int val)
{
	register unsigned int c, n = val;

	for (c = 0; n; c++)
		n &= n - 1;

	return c;
}
#endif

/*
 *  procnamecmp()
 *	compare process names up to the end of string or ' '
 */
int procnamecmp(const char *s1, const char *s2)
{
	register char c1, c2;

	do {	
		c1 = (unsigned char)*s1++;
		c2 = (unsigned char)*s2++;

		if (c1 == 0 || c1 == ' ')
			return 0;
	} while (c1 == c2);

	return c1 - c2;
}

/*
 *  int64_to_str()
 *	report int64 values in different units
 */
void int64_to_str(int64_t val, char *buf, const size_t buflen)
{
	double s;
	const int64_t pos_val = val < 0 ? 0 : val;
	const double v = (double)pos_val;
	char unit;

	(void)memset(buf, 0, buflen);

	if (pos_val < 1000000LL) {
		s = v;
		unit = ' ';
	} else if (pos_val < 1000000000LL) {
		s = v / 1000.0;
		unit = 'k';
	} else if (pos_val < 1000000000000LL) {
		s = v / 1000000.0;
		unit = 'M';
	} else {
		s = v / 1000000000.0;
		unit = 'G';
	}
	(void)snprintf(buf, buflen, "%6.0f%c", s, unit);
}

/*
 *  get_pid_comm
 *	get comm name of a pid
 */
char *get_pid_comm(const pid_t pid)
{
	char buffer[4096];
	int fd;
	ssize_t ret;

	(void)snprintf(buffer, sizeof(buffer), "/proc/%i/comm", pid);

	if ((fd = open(buffer, O_RDONLY)) < 0)
		return NULL;

	if ((ret = read(fd, buffer, sizeof(buffer))) <= 0) {
		(void)close(fd);
		return NULL;
	}
	(void)close(fd);
	buffer[ret - 1] = '\0';

	return strdup(buffer);
}

/*
 *  get_pid_cmdline
 * 	get process's /proc/pid/cmdline
 */
char *get_pid_cmdline(const pid_t pid)
{
	char buffer[4096];
	char *ptr;
	int fd;
	ssize_t ret;

	(void)snprintf(buffer, sizeof(buffer), "/proc/%i/cmdline", pid);

	if ((fd = open(buffer, O_RDONLY)) < 0)
		return NULL;

	if ((ret = read(fd, buffer, sizeof(buffer))) <= 0) {
		(void)close(fd);
		return NULL;
	}
	(void)close(fd);

	if (ret >= (ssize_t)sizeof(buffer))
		ret = sizeof(buffer) - 1;
	buffer[ret] = '\0';

	/*
	 *  OPT_CMD_LONG option we get the full cmdline args
	 */
	if (opt_flags & OPT_CMD_LONG) {
		for (ptr = buffer; ptr < buffer + ret - 1; ptr++) {
			if (*ptr == '\0')
				*ptr = ' ';
		}
		*ptr = '\0';
	}
	/*
	 *  OPT_CMD_SHORT option we discard anything after a space
	 */
	if (opt_flags & OPT_CMD_SHORT) {
		for (ptr = buffer; *ptr && (ptr < buffer + ret); ptr++) {
			if (*ptr == ' ')
				*ptr = '\0';
		}
	}

	if (opt_flags & OPT_DIRNAME_STRIP) {
		char *base = buffer;

		for (ptr = buffer; *ptr; ptr++) {
			if (isblank(*ptr))
				break;
			if (*ptr == '/')
				base = ptr + 1;
		}
		return strdup(base);
	}

	return strdup(buffer);
}

/*
 *  pid_exists()
 *	true if given process with given pid exists
 */
bool pid_exists(const pid_t pid)
{
	char path[PATH_MAX];
	struct stat statbuf;

	(void)snprintf(path, sizeof(path), "/proc/%i", pid);
	return stat(path, &statbuf) == 0;
}

/*
 *  timeval_to_double
 *      timeval to a double
 */
inline double timeval_to_double(const struct timeval * const tv)
{
	return (double)tv->tv_sec + ((double)tv->tv_usec / 1000000.0);
}

/*
 *  double_to_timeval
 *      seconds in double to timeval
 */
inline void double_to_timeval(
	const double val,
	struct timeval * const tv)
{
	tv->tv_sec = val;
	tv->tv_usec = (val - (time_t)val) * 1000000.0;
}

/*
 *  gettime_to_double()
 *      get time as a double
 */
double gettime_to_double(void)
{
	struct timeval tv;

	if (gettimeofday(&tv, NULL) < 0) {
		display_restore();
		(void)fprintf(stderr, "gettimeofday failed: errno=%d (%s)\n",
			errno, strerror(errno));
		exit(EXIT_FAILURE);
	}
	return timeval_to_double(&tv);
}

/*
 *  pid_max_digits()
 *	determine (or guess) maximum digits of pids
 */
int pid_max_digits(void)
{
	static int max_digits;
	ssize_t n;
	int fd;
	const int default_digits = 6;
	const int min_digits = 6;
	char buf[32];

	if (max_digits)
		goto ret;

	max_digits = default_digits;
	fd = open("/proc/sys/kernel/pid_max", O_RDONLY);
	if (fd < 0)
		goto ret;
	n = read(fd, buf, sizeof(buf) - 1);
	(void)close(fd);
	if (n < 0)
		goto ret;

	buf[n] = '\0';
	max_digits = 0;
	while ((max_digits < n) && (buf[max_digits] >= '0') && (buf[max_digits] <= '9'))
		max_digits++;
	if (max_digits < min_digits)
		max_digits = min_digits;
ret:
	return max_digits;
}

/*
 *  handle_sig()
 *      catch signals and flag a stop
 */
void handle_sig(int dummy)
{
	(void)dummy;    /* Stop unused parameter warning with -Wextra */

	stop_faultstat = true;
}

/*
 * pid_list_cleanup()
 *	free pid list
 */
void pid_list_cleanup(void)
{
	pid_list_t *p = pids;

	while (p) {
		pid_list_t *next = p->next;
		if (p->name)
			free(p->name);
		free(p);
		p = next;
	}
}

/*
 *  parse_pid_list()
 *	parse list of process IDs,
 *	collect process info in pids list
 */
int parse_pid_list(char * const arg)
{
	char *str, *token;
	pid_list_t *p;

	for (str = arg; (token = strtok(str, ",")) != NULL; str = NULL) {
		if (isdigit(token[0])) {
			pid_t pid;

			errno = 0;
			pid = strtol(token, NULL, 10);
			if (errno) {
				(void)fprintf(stderr, "Invalid pid specified.\n");
				pid_list_cleanup();
				return -1;
			}
			for (p = pids; p; p = p->next) {
				if (p->pid == pid)
					break;
			}
			if (!p) {
				if ((p = calloc(1, sizeof(*p))) == NULL)
					goto nomem;
				p->pid = pid;
				p->name = NULL;
				p->next = pids;
				pids = p;
			}
		} else {
			if ((p = calloc(1, sizeof(*p))) == NULL)
				goto nomem;
			if ((p->name = strdup(token)) == NULL) {
				free(p);
				goto nomem;
			}
			p->pid = 0;
			p->next = pids;
			pids = p;
		}
	}

	return 0;
nomem:
	out_of_memory("allocating pid list.\n");
	pid_list_cleanup();
	return -1;
}

/*
 *  show_usage()
 *	show how to use
 */
void show_usage(void)
{
	(void)printf("%s, version %s\n\n"
		"Usage: %s [options] [duration] [count]\n"
		"Options are:\n"
		"  -a\t\tshow page fault change with up/down arrows\n"
		"  -c\t\tget command name from processes comm field\n"
		"  -d\t\tstrip directory basename off command information\n"
		"  -h\t\tshow this help information\n"
		"  -l\t\tshow long (full) command information\n"
		"  -p proclist\tspecify comma separated list of processes to monitor\n"
		"  -s\t\tshow short command information\n"
		"  -t\t\ttop mode, show only changes in page faults\n"
		"  -T\t\ttop mode, show top page faulters\n",
		app_name, VERSION, app_name);
}
