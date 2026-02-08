#
# Copyright (C) 2014-2021 Canonical, Ltd.
# Copyright (C) 2021-2025 Colin Ian King
#
# This program is free software; you can redistribute it and/or
# modify it under the terms of the GNU General Public License
# as published by the Free Software Foundation; either version 2
# of the License, or (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program; if not, write to the Free Software
# Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301, USA.
#

VERSION=0.01.11
#

CFLAGS += -Wall -Wextra -DVERSION='"$(VERSION)"' -O2

#
# Pedantic flags
#
ifeq ($(PEDANTIC),1)
CFLAGS += -Wabi -Wcast-qual -Wfloat-equal -Wmissing-declarations \
	-Wmissing-format-attribute -Wno-long-long -Wpacked \
	-Wredundant-decls -Wshadow -Wno-missing-field-initializers \
	-Wno-missing-braces -Wno-sign-compare -Wno-multichar -fanalyzer
endif

PREFIX=/usr
BINDIR=$(PREFIX)/bin
MANDIR=$(PREFIX)/share/man/man8
BASHDIR=$(PREFIX)/share/bash-completion/completions

# Directories
SRCDIR=src
BUILDDIR=build

SRCS = $(SRCDIR)/main.c $(SRCDIR)/display.c $(SRCDIR)/proc.c $(SRCDIR)/cache.c $(SRCDIR)/utils.c
OBJS = $(BUILDDIR)/main.o $(BUILDDIR)/display.o $(BUILDDIR)/proc.o $(BUILDDIR)/cache.o $(BUILDDIR)/utils.o

# Default target
all: $(BUILDDIR)/PageFaultStat

# Create build directory if it doesn't exist
$(BUILDDIR):
	mkdir -p $(BUILDDIR)

$(BUILDDIR)/PageFaultStat: $(OBJS) $(BUILDDIR)
	$(CC) $(CFLAGS) $(OBJS) -lm -lncursesw -o $@ $(LDFLAGS)

$(BUILDDIR)/main.o: $(SRCDIR)/main.c $(SRCDIR)/faultstat.h Makefile | $(BUILDDIR)
	$(CC) $(CFLAGS) -c $< -o $@

$(BUILDDIR)/display.o: $(SRCDIR)/display.c $(SRCDIR)/faultstat.h Makefile | $(BUILDDIR)
	$(CC) $(CFLAGS) -c $< -o $@

$(BUILDDIR)/proc.o: $(SRCDIR)/proc.c $(SRCDIR)/faultstat.h Makefile | $(BUILDDIR)
	$(CC) $(CFLAGS) -c $< -o $@

$(BUILDDIR)/cache.o: $(SRCDIR)/cache.c $(SRCDIR)/faultstat.h Makefile | $(BUILDDIR)
	$(CC) $(CFLAGS) -c $< -o $@

$(BUILDDIR)/utils.o: $(SRCDIR)/utils.c $(SRCDIR)/faultstat.h Makefile | $(BUILDDIR)
	$(CC) $(CFLAGS) -c $< -o $@

faultstat.8.gz: faultstat.8
	gzip -c $< > $@

dist:
	rm -rf faultstat-$(VERSION)
	mkdir faultstat-$(VERSION)
	cp -rp Makefile faultstat.c faultstat.8 COPYING faultstat.spec \
		.travis.yml bash-completion README.md faultstat-$(VERSION)
	tar -Jcf faultstat-$(VERSION).tar.xz faultstat-$(VERSION)
	rm -rf faultstat-$(VERSION)

clean:
	rm -rf $(BUILDDIR)
	rm -f faultstat.8.gz
	rm -f faultstat-$(VERSION).tar.xz

install: $(BUILDDIR)/PageFaultStat faultstat.8.gz
	mkdir -p ${DESTDIR}${BINDIR}
	cp $(BUILDDIR)/PageFaultStat ${DESTDIR}${BINDIR}
	mkdir -p ${DESTDIR}${MANDIR}
	cp faultstat.8.gz ${DESTDIR}${MANDIR}
	mkdir -p ${DESTDIR}${BASHDIR}
	cp bash-completion/PageFaultStat ${DESTDIR}${BASHDIR}

.PHONY: all clean install dist
