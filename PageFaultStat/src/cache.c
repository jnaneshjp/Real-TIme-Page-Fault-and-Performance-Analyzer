/*
 * Cache management functions for PageFaultStat
 */

#define _GNU_SOURCE
#define _XOPEN_SOURCE_EXTENDED

#include "faultstat.h"

/*
 *  fault_cache_alloc()
 *	allocate a fault_info_t, first try the cache of
 *	unused fault_info's, if none available fall back
 *	to calloc
 */
fault_info_t *fault_cache_alloc(void)
{
	fault_info_t *fault_info;

	if (fault_info_cache) {
		fault_info = fault_info_cache;
		fault_info_cache = fault_info_cache->next;

		(void)memset(fault_info, 0, sizeof(*fault_info));
		return fault_info;
	}

	if ((fault_info = calloc(1, sizeof(*fault_info))) == NULL) {
		out_of_memory("allocating page fault tracking information");
		return NULL;
	}
	return fault_info;
}

/*
 *  fault_cache_free()
 *	free a fault_info_t by just adding it to the
 *	fault_info_cache free list
 */
inline void fault_cache_free(fault_info_t * const fault_info)
{
	fault_info->next = fault_info_cache;
	fault_info_cache = fault_info;
}

/*
 *  fault_cache_free_list()
 *	free up a list of fault_info_t items by
 *	adding them to the fault_info_cache free list
 */
void fault_cache_free_list(fault_info_t *fault_info)
{
	while (fault_info) {
		fault_info_t *next = fault_info->next;

		fault_cache_free(fault_info);
		fault_info = next;
	}
}

/*
 *  fault_cache_prealloc()
 *	create some spare fault_info_t items on
 *	the free list so that we don't keep on
 *	hitting the heap during the run
 */
void fault_cache_prealloc(const size_t n)
{
	size_t i;

	for (i = 0; i < n; i++) {
		fault_info_t *fault_info;

		if ((fault_info = calloc(1, sizeof(*fault_info))) != NULL)
			fault_cache_free_list(fault_info);
	}
}

/*
 *  fault_cache_cleanup()
 *	free the fault_info_cache free list
 */
void fault_cache_cleanup(void)
{
	while (fault_info_cache) {
		fault_info_t *next = fault_info_cache->next;

		free(fault_info_cache);
		fault_info_cache = next;
	}
}

/*
 *  proc_cache_hash_pid()
 *	hash a process id
 */
static inline unsigned long proc_cache_hash_pid(const pid_t pid)
{
	const unsigned long h = (unsigned long)pid;

	return h % PROC_HASH_TABLE_SIZE;
}

/*
 *  proc_cache_add_at_hash_index()
 *	helper function to add proc info to the proc cache and list
 */
static proc_info_t *proc_cache_add_at_hash_index(
	const unsigned long h,
	const pid_t pid)
{
	proc_info_t *p;

	if ((p = calloc(1, sizeof(*p))) == NULL) {
		out_of_memory("allocating proc cache");
		return NULL;
	}

	p->pid = pid;
	p->cmdline = get_pid_cmdline(pid);
	if (p->cmdline == NULL)
		p->kernel_thread = true;

	if ((p->cmdline == NULL) || (opt_flags & OPT_CMD_COMM)) {
		if (p->cmdline)
			free(p->cmdline);
		p->cmdline = get_pid_comm(pid);
	}
	p->next = proc_cache_hash[h];
	proc_cache_hash[h] = p;

	return p;
}

/*
 *  proc_cache_find_by_pid()
 *	find process info by the process id, if it is not found
 * 	and it is a traceable process then cache it
 */
proc_info_t *proc_cache_find_by_pid(const pid_t pid)
{
	const unsigned long h = proc_cache_hash_pid(pid);
	proc_info_t *p;

	for (p = proc_cache_hash[h]; p; p = p->next)
		if (p->pid == pid)
			return p;

	/*
	 *  Not found, so add it and return it if it is a legitimate
	 *  process to trace
	 */
	if (!pid_exists(pid))
		return NULL;

	return proc_cache_add_at_hash_index(h, pid);
}

/*
 *  proc_cache_cleanup()
 *	free up proc cache hash table
 */
void proc_cache_cleanup(void)
{
	size_t i;

	for (i = 0; i < PROC_HASH_TABLE_SIZE; i++) {
		proc_info_t *p = proc_cache_hash[i];

		while (p) {
			proc_info_t *next = p->next;

			free(p->cmdline);
			free(p);

			p = next;
		}
	}
}

/*
 *  hash_uid()
 *	hash a uid
 */
static inline unsigned long hash_uid(const uid_t uid)
{
        const unsigned long h = (unsigned long)uid;

        return h % UNAME_HASH_TABLE_SIZE;
}

/*
 *  uname_cache_find()
 *	lookup uname info on uid and cache data
 */
uname_cache_t *uname_cache_find(const uid_t uid)
{
	struct passwd *pw;
	uname_cache_t *uname;
	const unsigned long h = hash_uid(uid);

	for (uname = uname_cache[h]; uname; uname = uname->next) {
		if (uname->uid == uid)
			return uname;
	}

	if ((uname = calloc(1, sizeof(*uname))) == NULL) {
		out_of_memory("allocating pwd cache item");
		return NULL;
	}

	if ((pw = getpwuid(uid)) == NULL) {
		char buf[16];

		(void)snprintf(buf, sizeof(buf), "%i", uid);
		uname->name = strdup(buf);
	} else {
		uname->name = strdup(pw->pw_name);
	}

	if (uname->name == NULL) {
		out_of_memory("allocating pwd cache item");
		free(uname);
		return NULL;
	}

	uname->uid = uid;
	uname->next = uname_cache[h];
	uname_cache[h] = uname;

	return uname;
}

/*
 *  uname_cache_cleanup()
 *	free cache
 */
void uname_cache_cleanup(void)
{
	size_t i;

	for (i = 0; i < UNAME_HASH_TABLE_SIZE; i++) {
		uname_cache_t *u = uname_cache[i];

		while (u) {
			uname_cache_t *next = u->next;

			free(u->name);
			free(u);
			u = next;
		}
	}
}
