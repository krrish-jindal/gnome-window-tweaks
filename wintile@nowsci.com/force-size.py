#!/usr/bin/env python3
"""Lower, or put back, the minimum-size hint of X11 windows.

WinTile calls this so a window can be tiled smaller than its application says it
may be (a browser that insists on 676 px is squeezed into half of a 1080 px
portrait monitor). The window manager takes the minimum from the WM_NORMAL_HINTS
property of the window, which is an ordinary property anyone may rewrite.

    force-size.py set  XID MIN_WIDTH MIN_HEIGHT [XID MIN_WIDTH MIN_HEIGHT ...]
    force-size.py restore XID [XID ...]
    force-size.py restore --all

`set` only ever lowers a minimum, and remembers the original so `restore` can put
it back. Sizes are for the client window (the shadow a GTK window draws around
itself counts). XIDs are hex (0x1234) or decimal. Needs libX11 and an X server.
"""
import ctypes
import ctypes.util
import json
import os
import sys

P_MIN_SIZE = 1 << 4
_ignore_errors = None  # keeps the ctypes callback alive


class _Aspect(ctypes.Structure):
    _fields_ = [("x", ctypes.c_int), ("y", ctypes.c_int)]


class XSizeHints(ctypes.Structure):
    # Xlib's XSizeHints, field for field.
    _fields_ = [
        ("flags", ctypes.c_long),
        ("x", ctypes.c_int), ("y", ctypes.c_int),
        ("width", ctypes.c_int), ("height", ctypes.c_int),
        ("min_width", ctypes.c_int), ("min_height", ctypes.c_int),
        ("max_width", ctypes.c_int), ("max_height", ctypes.c_int),
        ("width_inc", ctypes.c_int), ("height_inc", ctypes.c_int),
        ("min_aspect", _Aspect), ("max_aspect", _Aspect),
        ("base_width", ctypes.c_int), ("base_height", ctypes.c_int),
        ("win_gravity", ctypes.c_int),
    ]


def state_file():
    runtime = os.environ.get("XDG_RUNTIME_DIR") or "/tmp"
    return os.path.join(runtime, "wintile-size-hints.json")


def load_state():
    try:
        with open(state_file()) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def save_state(state):
    path = state_file()
    tmp = f"{path}.{os.getpid()}"
    with open(tmp, "w") as fh:
        json.dump(state, fh)
    os.replace(tmp, path)


def open_x():
    lib = ctypes.util.find_library("X11")
    if not lib:
        raise SystemExit("libX11 not found")
    x11 = ctypes.CDLL(lib)
    x11.XOpenDisplay.restype = ctypes.c_void_p
    x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
    x11.XGetWMNormalHints.argtypes = [ctypes.c_void_p, ctypes.c_ulong,
                                      ctypes.POINTER(XSizeHints), ctypes.POINTER(ctypes.c_long)]
    x11.XSetWMNormalHints.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(XSizeHints)]
    x11.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
    x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
    # A window that closes between listing and rewriting it raises BadWindow, whose
    # default handler would end the process; ignore it, the next window is fine.
    handler_t = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p)
    global _ignore_errors
    _ignore_errors = handler_t(lambda display, event: 0)
    x11.XSetErrorHandler.argtypes = [handler_t]
    x11.XSetErrorHandler(_ignore_errors)
    display = x11.XOpenDisplay(None)
    if not display:
        raise SystemExit("cannot open the X display")
    return x11, display


def read_hints(x11, display, xid):
    hints = XSizeHints()
    supplied = ctypes.c_long()
    if not x11.XGetWMNormalHints(display, xid, ctypes.byref(hints), ctypes.byref(supplied)):
        return None
    return hints


def cmd_set(x11, display, args):
    if not args or len(args) % 3:
        raise SystemExit(__doc__)
    state = load_state()
    done = []
    for i in range(0, len(args), 3):
        xid = int(args[i], 0)
        want_w, want_h = int(args[i + 1]), int(args[i + 2])
        hints = read_hints(x11, display, xid)
        if hints is None:
            continue
        had = bool(hints.flags & P_MIN_SIZE)
        cur_w, cur_h = (hints.min_width, hints.min_height) if had else (0, 0)
        new_w, new_h = min(cur_w, want_w), min(cur_h, want_h)
        if not had or (new_w, new_h) == (cur_w, cur_h):
            done.append(xid)  # no minimum, or already small enough: nothing to lower
            continue
        state.setdefault(str(xid), [cur_w, cur_h])  # first time wins: that is the original
        hints.min_width, hints.min_height = new_w, new_h
        x11.XSetWMNormalHints(display, xid, ctypes.byref(hints))
        done.append(xid)
    x11.XSync(display, 0)
    save_state(state)
    print(" ".join(hex(x) for x in done))


def cmd_restore(x11, display, args):
    state = load_state()
    ids = list(state) if args == ["--all"] else [str(int(a, 0)) for a in args]
    for key in ids:
        orig = state.pop(key, None)
        if not orig:
            continue
        xid = int(key)
        hints = read_hints(x11, display, xid)
        if hints is None:  # the window is gone
            continue
        hints.flags |= P_MIN_SIZE
        hints.min_width, hints.min_height = orig
        x11.XSetWMNormalHints(display, xid, ctypes.byref(hints))
    x11.XSync(display, 0)
    save_state(state)


def main(argv):
    if len(argv) < 2 or argv[1] not in ("set", "restore"):
        raise SystemExit(__doc__)
    x11, display = open_x()
    try:
        (cmd_set if argv[1] == "set" else cmd_restore)(x11, display, argv[2:])
    finally:
        x11.XCloseDisplay(display)


if __name__ == "__main__":
    main(sys.argv)
