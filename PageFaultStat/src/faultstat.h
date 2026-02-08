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

#ifndef __FAULTSTAT_H__
#define __FAULTSTAT_H__

#include <stdlib.h>
#include <stdio.h>
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>
#include <inttypes.h>
#include <string.h>
#include <unistd.h>
#include <limits.h>
#include <ctype.h>
#include <pwd.h>
#include <errno.h>
#include <dirent.h>
#include <fcntl.h>
#include <signal.h>
#include <libgen.h>
#include <sys/types.h>
#include <sys/time.h>
#include <sys/stat.h>
#include <sys/ioctl.h>
#include <ncurses.h>
#include <math.h>
#include <locale.h>

#define UNAME_HASH_TABLE_SIZE	(521)
#define PROC_HASH_TABLE_SIZE 	(503)

#define OPT_CMD_SHORT		(0x00000001)
#define OPT_CMD_LONG		(0x00000002)
#define OPT_CMD_COMM		(0x00000004)
#define OPT_CMD_ALL		(OPT_CMD_SHORT | OPT_CMD_LONG | OPT_CMD_COMM)
#define OPT_DIRNAME_STRIP	(0x00000008)
#define OPT_TOP			(0x00000010)
#define OPT_TOP_TOTAL		(0x00000020)
#define OPT_ARROW		(0x00000040)
#define OPT_WEB_UI		(0x00000080)
#define OPT_JSON		(0x00000100)
#define OPT_ONCE		(0x00000200)

#define SORT_MAJOR_MINOR	(0x00)
#define SORT_MAJOR		(0x01)
#define SORT_MINOR		(0x02)
#define SORT_D_MAJOR_MINOR	(0x03)
#define SORT_D_MAJOR		(0x04)
#define SORT_D_MINOR		(0x05)
#define SORT_SWAP		(0x06)
#define SORT_END		(0x07)

#define ATTR_MAJOR		(0x00)
#define ATTR_MINOR		(0x01)
#define ATTR_D_MAJOR		(0x02)
#define ATTR_D_MINOR		(0x03)
#define ATTR_SWAP		(0x04)
#define ATTR_MAX		(0x05)

#define SIZEOF_ARRAY(a)		(sizeof(a) / sizeof(a[0]))

/* Data structures */
typedef struct {
	bool	attr[ATTR_MAX];
} attr_vals_t;

/* process specific information */
typedef struct proc_info {
	struct proc_info *next;		/* next in hash */
	char		*cmdline;	/* Process name from cmdline */
	pid_t		pid;		/* PID */
	bool		kernel_thread;	/* true if process is kernel thread */
} proc_info_t;

/* UID cache */
typedef struct uname_cache_t {
	struct uname_cache_t *next;
	char *		name;		/* User name */
	uid_t		uid;		/* User UID */
} uname_cache_t;

/* page fault information per process */
typedef struct fault_info_t {
	pid_t		pid;		/* process id */
	uid_t		uid;		/* process' UID */
	proc_info_t 	*proc;		/* cached process info */
	uname_cache_t	*uname;		/* cached uname info */

	int64_t		min_fault;	/* minor page faults */
	int64_t		maj_fault;	/* major page faults */
	int64_t		vm_swap;	/* pages swapped */
	int64_t		d_min_fault;	/* delta in minor page faults */
	int64_t		d_maj_fault;	/* delta in major page faults */

	struct fault_info_t *d_next;	/* sorted deltas by total */
	struct fault_info_t *s_next;	/* sorted by total */
	struct fault_info_t *next;	/* for free list */
	bool		alive;		/* true if proc is alive */
} fault_info_t;

typedef struct pid_list {
	struct pid_list	*next;		/* next in list */
	char 		*name;		/* process name */
	pid_t		pid;		/* process id */
} pid_list_t;

typedef struct {
	void (*df_setup)(void);		/* display setup */
	void (*df_endwin)(void);	/* display end */
	void (*df_clear)(void);		/* display clear */
	void (*df_refresh)(void);	/* display refresh */
	void (*df_winsize)(const bool redo);	/* display get size */
	void (*df_printf)(const char *str, ...) __attribute__((format(printf, 1, 2)));
	void (*df_attrset)(const int attr);	/* display attribute */
} display_funcs_t;

/* Global variables */
extern uname_cache_t *uname_cache[UNAME_HASH_TABLE_SIZE];
extern proc_info_t *proc_cache_hash[PROC_HASH_TABLE_SIZE];
extern const char *const app_name;

extern bool stop_faultstat;
extern unsigned int opt_flags;
extern fault_info_t *fault_info_cache;
extern pid_list_t *pids;
extern display_funcs_t df;
extern bool resized;
extern int rows;
extern int cols;
extern int cury;
extern int sort_by;

/* Display functions */
void display_restore(void);
void faultstat_top_setup(void);
void faultstat_top_endwin(void);
void faultstat_top_clear(void);
void faultstat_top_refresh(void);
void faultstat_generic_winsize(const bool redo);
void faultstat_top_winsize(const bool redo);
void faultstat_noop(void);
void faultstat_top_printf(const char *fmt, ...);
void faultstat_normal_printf(const char *fmt, ...);
void faultstat_top_attrset(const int attr);
void faultstat_normal_attrset(const int attr);

/* Display function tables */
extern const display_funcs_t df_normal;
extern const display_funcs_t df_top;

/* Process and fault functions */
int fault_get_all_pids(fault_info_t ** const fault_info, size_t * const npids);
int fault_get_by_proc(const pid_t pid, fault_info_t ** const fault_info);
void fault_delta(fault_info_t * const fault_new, fault_info_t *const fault_old_list);
int fault_dump(fault_info_t * const fault_info_old, fault_info_t * const fault_info_new, const bool one_shot);
int fault_dump_json(fault_info_t * const fault_info_old, fault_info_t * const fault_info_new);
int fault_dump_diff(fault_info_t * const fault_info_old, fault_info_t * const fault_info_new);
bool fault_should_insert_before(const fault_info_t *lhs, const fault_info_t *rhs);

/* Cache functions */
fault_info_t *fault_cache_alloc(void);
void fault_cache_free(fault_info_t * const fault_info);
void fault_cache_free_list(fault_info_t *fault_info);
void fault_cache_prealloc(const size_t n);
void fault_cache_cleanup(void);
proc_info_t *proc_cache_find_by_pid(const pid_t pid);
void proc_cache_cleanup(void);
uname_cache_t *uname_cache_find(const uid_t uid);
void uname_cache_cleanup(void);

/* Utility functions */
void out_of_memory(const char *msg);
int pid_max_digits(void);
int getattr(const int index);
void handle_sigwinch(int sig);
void handle_sig(int dummy);
char *get_pid_comm(const pid_t pid);
char *get_pid_cmdline(const pid_t pid);
bool pid_exists(const pid_t pid);
void int64_to_str(int64_t val, char *buf, const size_t buflen);
double timeval_to_double(const struct timeval * const tv);
void double_to_timeval(const double val, struct timeval * const tv);
double gettime_to_double(void);
unsigned int count_bits(const unsigned int val);
const char *uname_name(const uname_cache_t * const uname);
int procnamecmp(const char *s1, const char *s2);
void pid_list_cleanup(void);
int parse_pid_list(char * const arg);
void show_usage(void);

/* Web UI */
int webui_run(uint16_t port);

#endif /* __FAULTSTAT_H__ */
