/*
 * Display functions for PageFaultStat
 */

#define _GNU_SOURCE
#define _XOPEN_SOURCE_EXTENDED

#include "faultstat.h"

/* Forward declarations for static arrays */
static const attr_vals_t attr_vals[] = {
	/*  Major  Minor  dMajor dMinor Swap */
	{ { true,  true,  false, false, false } }, /* SORT_MAJOR_MINOR */
	{ { true,  false, false, false, false } }, /* SORT_MAJOR */
	{ { false, true,  false, false, false } }, /* SORT_MINOR */
	{ { false, false, true,  true,  false } }, /* SORT_D_MAJOR_MINOR */
	{ { false, false, true,  false, false } }, /* SORT_D_MAJOR */
	{ { false, false, false, true,  false } }, /* SORT_D_MINOR */
	{ { false, false, false, false, true  } }, /* SORT_SWAP */
};

/*
 *  getattr()
 *	get attribute for a specific column, index
 *	is the index into the attr fields that maps
 *	to a specific column.
 */
int getattr(const int index)
{
	if (sort_by < 0 || sort_by >= SORT_END)
		return A_NORMAL;
	if (index < 0 || index >= ATTR_MAX)
		return A_NORMAL;

	return attr_vals[sort_by].attr[index] ? A_UNDERLINE : A_NORMAL;
}

/*
 *  handle_sigwinch()
 *      flag window resize on SIGWINCH
 */
void handle_sigwinch(int sig)
{
	(void)sig;
	resized = true;
}

/*
 *  faultstat_noop()
 *	no-operation display handler
 */
void faultstat_noop(void)
{
}

/*
 *  faultstat_top_setup()
 *	setup display for ncurses top mode
 */
void faultstat_top_setup(void)
{
	(void)initscr();
	(void)cbreak();
	(void)noecho();
	(void)nodelay(stdscr, 1);
	(void)keypad(stdscr, 1);
	(void)curs_set(0);
}

/*
 *  faultstat_top_endwin()
 *	end display for ncurses top mode
 */
void faultstat_top_endwin(void)
{
	df.df_winsize(true);
	(void)resizeterm(rows, cols);
	(void)refresh();
	resized = false;
	(void)clear();
	(void)endwin();
}

/*
 *  faultstat_top_clear()
 *	clear display for ncurses top mode
 */
void faultstat_top_clear(void)
{
	(void)clear();
}

/*
 *  faultstat_top_refresh()
 *	refresh display for ncurses top mode
 */
void faultstat_top_refresh(void)
{
	(void)refresh();
}

/*
 *  faultstat_generic_winsize()
 *	get tty size in all modes
 */
void faultstat_generic_winsize(const bool redo)
{
	if (redo) {
		struct winsize ws;

		(void)memset(&ws, 0, sizeof(ws));
		if ((ioctl(fileno(stdin), TIOCGWINSZ, &ws) != -1)) {
			rows = ws.ws_row;
			cols = ws.ws_col;
		} else {
			rows = 25;
			cols = 80;
		}
	}
}

/*
 *  faultstat_top_winsize()
 *	get tty size in top mode
 */
void faultstat_top_winsize(const bool redo)
{
	(void)redo;

	faultstat_generic_winsize(true);
	(void)resizeterm(rows, cols);
}

/*
 *  faultstat_top_printf()
 *	print text to display width in top mode
 */
void faultstat_top_printf(const char *fmt, ...)
{
	va_list ap;
	char buf[256];
	int sz = sizeof(buf) - 1;
	char *ptr;

	if (cury >= rows)
		return;

	if (cols < sz)
		sz = cols;

	va_start(ap, fmt);
	(void)vsnprintf(buf, sizeof(buf), fmt, ap);
	buf[sz] = '\0';
	(void)printw("%s", buf);

	for (ptr = buf; *ptr; ptr++)
		if (*ptr == '\n')
			cury++;
	va_end(ap);
}

/*
 *  faultstat_normal_printf()
 *	normal tty printf
 */
void faultstat_normal_printf(const char *fmt, ...)
{
	va_list ap;
	char buf[256];

	va_start(ap, fmt);
	(void)vsnprintf(buf, sizeof(buf), fmt, ap);
	(void)fputs(buf, stdout);
	va_end(ap);
}

/*
 *  faultstat_top_attrset()
 *	set attributes for ncurses top mode
 */
void faultstat_top_attrset(const int attr)
{
	attrset(attr);
}

/*
 *  faultstat_normal_attrset
 *	set attribites for tty printf (ignored)
 */
void faultstat_normal_attrset(const int attr)
{
	(void)attr;
}

/* ncurses based "top" mode display functions */
const display_funcs_t df_top = {
	faultstat_top_setup,
	faultstat_top_endwin,
	faultstat_top_clear,
	faultstat_top_refresh,
	faultstat_top_winsize,
	faultstat_top_printf,
	faultstat_top_attrset,
};

/* normal tty mode display functions */
const display_funcs_t df_normal = {
	faultstat_noop,
	faultstat_noop,
	faultstat_noop,
	faultstat_noop,
	faultstat_generic_winsize,
	faultstat_normal_printf,
	faultstat_normal_attrset,
};

/*
 *  display_restore()
 *	restore display back to normal tty
 */
void display_restore(void)
{
	df.df_endwin();
	df = df_normal;
}
