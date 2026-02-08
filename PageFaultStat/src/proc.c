/*
 * Process and fault handling for faultstat
 */

#define _GNU_SOURCE
#define _XOPEN_SOURCE_EXTENDED

#include "faultstat.h"

/*
 *  get_proc_self_stat_field()
 *     find nth field of /proc/$PID/stat data. This works around
 *     the problem that the comm field can contain spaces and
 *     multiple ) so sscanf on this field won't work.  The returned
 *     pointer is the start of the Nth field and it is up to the
 *     caller to determine the end of the field
 */
static const char *get_proc_self_stat_field(const char *buf, const int num)
{
	const char *ptr, *comm_end;
	int n;

	if (num < 1 || !buf || !*buf)
		return NULL;
	if (num == 1)
		return buf;
	if (num == 2)
		return strstr(buf, "(");

	comm_end = NULL;
	for (ptr = buf; *ptr; ptr++) {
		if (*ptr == ')')
			comm_end = ptr;
	}
	if (!comm_end)
		return NULL;
	comm_end++;
	n = num - 2;

	ptr = comm_end;
	while (*ptr) {
		while (*ptr == ' ')
			ptr++;
		n--;
		if (n <= 0)
			break;
		while (*ptr && *ptr != ' ')
			ptr++;
	}

	return ptr;
}

/*
 *  fault_get_by_proc()
 *	get page fault info for a specific proc
 */
int fault_get_by_proc(const pid_t pid, fault_info_t ** const fault_info)
{
	FILE *fp;
	fault_info_t *new_fault_info;
	proc_info_t *proc;
	unsigned long min_fault, maj_fault, vm_swap;
	int n;
	char buffer[4096];
	char path[PATH_MAX];
	const char *ptr;
	int got_fields = 0;

	if (getpgid(pid) == 0)
		return 0;	/* Kernel thread */

	if ((proc = proc_cache_find_by_pid(pid)) == NULL)
		return 0;	/* It died before we could get info */

	if (proc->kernel_thread)
		return 0;	/* Ignore */

	if (pids) {
		pid_list_t *p;

		for (p = pids; p; p = p->next) {
			if (p->pid == pid)
				break;
			if (p->name) {
				char *tmp_cmdline = proc->cmdline;

				if (strchr(p->name, '/') == NULL)
					tmp_cmdline = basename(proc->cmdline);

			 	if (tmp_cmdline && procnamecmp(p->name, tmp_cmdline) == 0)
					break;
			}
		}
		if (!p)
			return 0;
	}

	if ((new_fault_info = fault_cache_alloc()) == NULL)
		return -1;

	(void)snprintf(path, sizeof(path), "/proc/%i/stat", pid);
	if ((fp = fopen(path, "r")) == NULL) {
		fault_cache_free(new_fault_info);
		return -1;	/* Gone? */
	}
	(void)memset(buffer, 0, sizeof(buffer));
	if (fgets(buffer, sizeof(buffer) - 1, fp) == NULL) {
		fault_cache_free(new_fault_info);
		(void)fclose(fp);
		return -1;
	}
	(void)fclose(fp);
	ptr = get_proc_self_stat_field(buffer, 10);
	if (!ptr) {
		fault_cache_free(new_fault_info);
		return -1;
	}
	n = sscanf(ptr, "%lu %*u %lu",
		&min_fault, &maj_fault);
	if (n == 2) {
		new_fault_info->min_fault = min_fault;
		new_fault_info->maj_fault = maj_fault;
	}

	new_fault_info->pid = pid;
	new_fault_info->proc = proc_cache_find_by_pid(pid);
	new_fault_info->uid = 0;
	new_fault_info->uname = NULL;
	new_fault_info->next = *fault_info;
	*fault_info = new_fault_info;

	(void)snprintf(path, sizeof(path), "/proc/%i/status", pid);
	if ((fp = fopen(path, "r")) == NULL)
		return 0;

	/*
	 *  Find Uid and uname. Note that it may
	 *  not be found, in which case new->uname is
	 *  still NULL, so we need to always use
	 *  uname_name() to fetch the uname to handle
	 *  the NULL uname cases.
	 */
	while (fgets(buffer, sizeof(buffer), fp) != NULL) {
		if (!strncmp(buffer, "VmSwap:", 7)) {
			if (sscanf(buffer + 8, "%lu", &vm_swap) == 1)
				new_fault_info->vm_swap = vm_swap;
			got_fields++;
		} else if (!strncmp(buffer, "Uid:", 4)) {
			if (sscanf(buffer + 5, "%9i", &new_fault_info->uid) == 1) {
				new_fault_info->uname = uname_cache_find(new_fault_info->uid);
				if (new_fault_info->uname == NULL) {
					(void)fclose(fp);
					return -1;
				}
			}
			got_fields++;
		}
		if (got_fields == 2)
			break;
	}
	(void)fclose(fp);

	return 0;
}

/*
 *  fault_get_all_pids()
 *	scan processes for page fault info
 */
int fault_get_all_pids(fault_info_t ** const fault_info, size_t * const npids)
{
	DIR *dir;
	struct dirent *entry;
	*npids = 0;

	if ((dir = opendir("/proc")) == NULL) {
		display_restore();
		(void)fprintf(stderr, "Cannot read directory /proc\n");
		return -1;
	}

	while ((entry = readdir(dir)) != NULL) {
		pid_t pid;

		if (!isdigit(entry->d_name[0]))
			continue;
		pid = (pid_t)strtoul(entry->d_name, NULL, 10);

		if (fault_get_by_proc(pid, fault_info) < 0)
			continue;
		(*npids)++;
	}

	(void)closedir(dir);

	return 0;
}

/*
 *  fault_delta()
 *	compute page fault changes
 */
void fault_delta(fault_info_t * const fault_new, fault_info_t *const fault_old_list)
{
	fault_info_t *fault_old;

	for (fault_old = fault_old_list; fault_old; fault_old = fault_old->next) {
		if (fault_new->pid == fault_old->pid) {
			fault_new->d_min_fault = fault_new->min_fault - fault_old->min_fault;
			fault_new->d_maj_fault = fault_new->maj_fault - fault_old->maj_fault;
			fault_old->alive = true;
			return;
		}
	}
	fault_new->d_min_fault = fault_new->min_fault;
	fault_new->d_maj_fault = fault_new->maj_fault;
}

/*
 *  get_cmdline()
 *	get command line if it is defined
 */
static inline char *get_cmdline(const fault_info_t * const fault_info)
{
	if (fault_info->proc && fault_info->proc->cmdline)
		return fault_info->proc->cmdline;

	return "<unknown>";
}

/*
 *  compare()
 *	sort comparison based on sort_by setting
 */
static bool compare(const fault_info_t *f1, const fault_info_t *f2)
{
	switch (sort_by) {
	case SORT_MAJOR_MINOR:
		return f1->min_fault + f1->maj_fault <
		       f2->min_fault + f2->maj_fault;
		break;
	case SORT_MAJOR:
		return f1->maj_fault < f2->maj_fault;
		break;
	case SORT_MINOR:
		return f1->min_fault < f2->min_fault;
		break;
	case SORT_D_MAJOR_MINOR:
		return f1->d_min_fault + f1->d_maj_fault <
		       f2->d_min_fault + f2->d_maj_fault;
		break;
	case SORT_D_MAJOR:
		return f1->d_maj_fault < f2->d_maj_fault;
		break;
	case SORT_D_MINOR:
		return f1->d_min_fault < f2->d_min_fault;
		break;
	case SORT_SWAP:
		return f1->vm_swap < f2->vm_swap;
		break;
	default:
		break;
	}
	return true;
}

/*
 *  fault_heading()
 *	output heading
 */
static void fault_heading(const bool one_shot, const int pid_size)
{
	if (one_shot) {
		df.df_printf(" %*.*s  Major   Minor    Swap  User       Command\n",
			pid_size, pid_size, "PID");
	} else {
		df.df_attrset(A_BOLD);
		df.df_printf(" %*.*s  ", pid_size, pid_size, "PID");
		df.df_attrset(getattr(ATTR_MAJOR) | A_BOLD);
		df.df_printf("Major");
		df.df_attrset(A_NORMAL);
		df.df_printf("   ");
		df.df_attrset(getattr(ATTR_MINOR) | A_BOLD);
		df.df_printf("Minor");
		df.df_attrset(A_NORMAL);
		df.df_printf("  ");
		df.df_attrset(getattr(ATTR_D_MAJOR) | A_BOLD);
		df.df_printf("+Major");
		df.df_attrset(A_NORMAL);
		df.df_printf("  ");
		df.df_attrset(getattr(ATTR_D_MINOR) | A_BOLD);
		df.df_printf("+Minor");
		df.df_attrset(A_NORMAL);
		df.df_printf("    ");
		df.df_attrset(getattr(ATTR_SWAP) | A_BOLD);
		df.df_printf("Swap");
		df.df_attrset(A_BOLD);
		df.df_printf("  %sUser       Command\n", (opt_flags & OPT_ARROW) ? "D " : "");
		df.df_attrset(A_NORMAL);
	}
}

/*
 *  fault_dump_json()
 *	dump out page fault usage in JSON format
 */
int fault_dump_json(
	fault_info_t * const fault_info_old,
	fault_info_t * const fault_info_new)
{
	fault_info_t *fault_info, **l;
	fault_info_t *sorted = NULL;
	int64_t	t_min_fault = 0, t_maj_fault = 0;
	int64_t	t_d_min_fault = 0, t_d_maj_fault = 0;
	int64_t t_vm_swap = 0;
	bool first = true;

	for (fault_info = fault_info_new; fault_info; fault_info = fault_info->next) {
		fault_delta(fault_info, fault_info_old);
		for (l = &sorted; *l; l = &(*l)->s_next) {
			if (compare(*l, fault_info)) {
				fault_info->s_next = (*l);
				break;
			}
		}
		*l = fault_info;

		t_min_fault += fault_info->min_fault;
		t_maj_fault += fault_info->maj_fault;
		t_d_min_fault += fault_info->d_min_fault;
		t_d_maj_fault += fault_info->d_maj_fault;
		t_vm_swap += fault_info->vm_swap;
	}

	printf("{\"processes\":[");
	for (fault_info = sorted; fault_info; fault_info = fault_info->s_next) {
		const char *cmd = get_cmdline(fault_info);
		
		if (!first)
			printf(",");
		first = false;

		printf("{\"pid\":%d,\"major\":%ld,\"minor\":%ld,\"deltaMajor\":%ld,\"deltaMinor\":%ld,\"swap\":%ld,\"user\":\"%s\",\"command\":\"%s\"}",
			fault_info->pid,
			(long)fault_info->maj_fault,
			(long)fault_info->min_fault,
			(long)fault_info->d_maj_fault,
			(long)fault_info->d_min_fault,
			(long)fault_info->vm_swap,
			uname_name(fault_info->uname),
			cmd);
	}

	printf("],\"totals\":{\"major\":%ld,\"minor\":%ld,\"deltaMajor\":%ld,\"deltaMinor\":%ld,\"swap\":%ld},\"timestamp\":%ld}\n",
		(long)t_maj_fault,
		(long)t_min_fault,
		(long)t_d_maj_fault,
		(long)t_d_min_fault,
		(long)t_vm_swap,
		(long)time(NULL));

	return 0;
}

/*
 *  fault_dump()
 *	dump out page fault usage
 */
int fault_dump(
	fault_info_t * const fault_info_old,
	fault_info_t * const fault_info_new,
	const bool one_shot)
{
	fault_info_t *fault_info, **l;
	fault_info_t *sorted = NULL;
	int64_t	t_min_fault = 0, t_maj_fault = 0;
	int64_t	t_d_min_fault = 0, t_d_maj_fault = 0;
	const int pid_size = pid_max_digits();
	char s_min_fault[12], s_maj_fault[12],
	     s_d_min_fault[12], s_d_maj_fault[12],
	     s_vm_swap[12];

	for (fault_info = fault_info_new; fault_info; fault_info = fault_info->next) {
		fault_delta(fault_info, fault_info_old);
		for (l = &sorted; *l; l = &(*l)->s_next) {
			if (compare(*l, fault_info)) {
				fault_info->s_next = (*l);
				break;
			}
		}
		*l = fault_info;

		t_min_fault += fault_info->min_fault;
		t_maj_fault += fault_info->maj_fault;

		t_d_min_fault += fault_info->d_min_fault;
		t_d_maj_fault += fault_info->d_maj_fault;
	}

	for (fault_info = fault_info_old; fault_info; fault_info = fault_info->next) {
		if (fault_info->alive)
			continue;

		/* Process has died, so include it as -ve delta */
		for (l = &sorted; *l; l = &(*l)->d_next) {
			if (compare(*l, fault_info)) {
				fault_info->d_next = (*l);
				break;
			}
		}
		*l = fault_info;

		t_min_fault += fault_info->min_fault;
		t_maj_fault += fault_info->maj_fault;

		fault_info->d_min_fault = -fault_info->min_fault;
		fault_info->d_maj_fault = -fault_info->maj_fault;

		t_d_min_fault += fault_info->d_min_fault;
		t_d_maj_fault += fault_info->d_maj_fault;

		fault_info->min_fault = 0;
		fault_info->maj_fault = 0;
	}

	fault_heading(one_shot, pid_size);
	for (fault_info = sorted; fault_info; fault_info = fault_info->s_next) {
		const char *cmd = get_cmdline(fault_info);

		int64_t delta = fault_info->d_min_fault + fault_info->d_maj_fault;
#if 0
		const char * const arrow = (delta < 0) ? "\u2193 " :
						  ((delta > 0) ? "\u2191 "  : "  ");
#endif
		const char * const arrow = (delta < 0) ? "v" :
						  ((delta > 0) ? "^ "  : "  ");

		int64_to_str(fault_info->maj_fault, s_maj_fault, sizeof(s_maj_fault));
		int64_to_str(fault_info->min_fault, s_min_fault, sizeof(s_min_fault));
		int64_to_str(fault_info->vm_swap, s_vm_swap, sizeof(s_vm_swap));
		if (one_shot) {
			df.df_printf(" %*d %7s %7s %7s %-10.10s %s\n",
				pid_size, fault_info->pid,
				s_maj_fault, s_min_fault, s_vm_swap,
				uname_name(fault_info->uname), cmd);
		} else {
			int64_to_str(fault_info->d_maj_fault, s_d_maj_fault, sizeof(s_d_maj_fault));
			int64_to_str(fault_info->d_min_fault, s_d_min_fault, sizeof(s_d_min_fault));
			df.df_printf(" %*d %7s %7s %7s %7s %7s %s%-10.10s %s\n",
				pid_size, fault_info->pid,
				s_maj_fault, s_min_fault,
				s_d_maj_fault, s_d_min_fault,
				s_vm_swap,
				(opt_flags & OPT_ARROW) ? arrow : "",
				uname_name(fault_info->uname), cmd);
		}
	}

	int64_to_str(t_maj_fault, s_maj_fault, sizeof(s_maj_fault));
	int64_to_str(t_min_fault, s_min_fault, sizeof(s_min_fault));
	if (one_shot) {
		df.df_printf(" %*s %7s %7s\n\n", pid_size, "Total:", s_maj_fault, s_min_fault);
	} else {
		int64_to_str(t_d_maj_fault, s_d_maj_fault, sizeof(s_d_maj_fault));
		int64_to_str(t_d_min_fault, s_d_min_fault, sizeof(s_d_min_fault));
		df.df_printf(" %*s %7s %7s %7s %7s\n\n",
			pid_size, "Total:", s_maj_fault, s_min_fault, s_d_maj_fault, s_d_min_fault);
	}

	return 0;
}

/*
 *  fault_dump_diff()
 *	dump differences between old and new events
 */
int fault_dump_diff(
	fault_info_t * const fault_info_old,
	fault_info_t * const fault_info_new)
{
	fault_info_t *fault_info, **l;
	fault_info_t *sorted_deltas = NULL;
	int64_t	t_min_fault = 0, t_maj_fault = 0;
	int64_t	t_d_min_fault = 0, t_d_maj_fault = 0;
	const int pid_size = pid_max_digits();
	char s_min_fault[12], s_maj_fault[12],
	     s_d_min_fault[12], s_d_maj_fault[12],
	     s_vm_swap[12];

	for (fault_info = fault_info_new; fault_info; fault_info = fault_info->next) {
		fault_delta(fault_info, fault_info_old);
		if ((fault_info->d_min_fault + fault_info->d_maj_fault) == 0)
			continue;

		for (l = &sorted_deltas; *l; l = &(*l)->d_next) {
			if (compare(*l, fault_info)) {
				fault_info->d_next = (*l);
				break;
			}
		}
		*l = fault_info;

		t_min_fault += fault_info->min_fault;
		t_maj_fault += fault_info->maj_fault;

		t_d_min_fault += fault_info->d_min_fault;
		t_d_maj_fault += fault_info->d_maj_fault;
	}

	for (fault_info = fault_info_old; fault_info; fault_info = fault_info->next) {
		if (fault_info->alive)
			continue;

		/* Process has died, so include it as -ve delta */
		for (l = &sorted_deltas; *l; l = &(*l)->d_next) {
			if (compare(*l, fault_info)) {
				fault_info->d_next = (*l);
				break;
			}
		}
		*l = fault_info;

		t_min_fault -= fault_info->min_fault;
		t_maj_fault -= fault_info->maj_fault;

		fault_info->d_min_fault = -fault_info->min_fault;
		fault_info->d_maj_fault = -fault_info->maj_fault;

		t_d_min_fault += fault_info->d_min_fault;
		t_d_maj_fault += fault_info->d_maj_fault;

		fault_info->min_fault = 0;
		fault_info->maj_fault = 0;
	}

	fault_heading(false, pid_size);
	for (fault_info = sorted_deltas; fault_info; ) {
		const char *cmd = get_cmdline(fault_info);
		fault_info_t *next = fault_info->d_next;

		int64_to_str(fault_info->maj_fault, s_maj_fault, sizeof(s_maj_fault));
		int64_to_str(fault_info->min_fault, s_min_fault, sizeof(s_min_fault));
		int64_to_str(fault_info->d_maj_fault, s_d_maj_fault, sizeof(s_d_maj_fault));
		int64_to_str(fault_info->d_min_fault, s_d_min_fault, sizeof(s_d_min_fault));
		int64_to_str(fault_info->vm_swap, s_vm_swap, sizeof(s_vm_swap));

		df.df_printf(" %*d %7s %7s %7s %7s %7s %-10.10s %s\n",
			pid_size, fault_info->pid,
			s_maj_fault, s_min_fault,
			s_d_maj_fault, s_d_min_fault,
			s_vm_swap,
			uname_name(fault_info->uname), cmd);

		fault_info->d_next = NULL;	/* Nullify for next round */
		fault_info = next;
	}

	int64_to_str(t_maj_fault, s_maj_fault, sizeof(s_maj_fault));
	int64_to_str(t_min_fault, s_min_fault, sizeof(s_min_fault));
	int64_to_str(t_d_maj_fault, s_d_maj_fault, sizeof(s_d_maj_fault));
	int64_to_str(t_d_min_fault, s_d_min_fault, sizeof(s_d_min_fault));
	df.df_printf(" %*s %7s %7s %7s %7s\n\n",
		pid_size, "Total:", s_maj_fault, s_min_fault, s_d_maj_fault, s_d_min_fault);

	return 0;
}
