---
description: Read when the user or a system message says a build/process was killed by an OOM killer (systemd-oomd, kernel OOM, Claude Code's background-shell pressure reaper), or before launching a worldwide build (make world, prepare-world.ts) that needs a memory cap. Covers systemd-run scopes, how to read memory on this box, and the don't-loop-the-retry rule.
---

# Memory-constrained runs and OOM kills

**Memory-constrained runs**: wrap a worldwide build (`make world`,
`prepare-world.ts`; the only thing here that has hit OOM on this 32 GB box)
in `systemd-run --user --scope -p MemoryMax=<N>`, and set `N` *below* what
the system can actually spare -- too high and the kernel's global OOM killer
fires and can kill unrelated processes instead of containing the one that's
over budget. The scope also matters for a second reason: each app (a
Konsole or VS Code window, whichever Claude Code runs in) is one cgroup, and
when memory pressure kills it the *whole* app goes, so a build started from
a tab or the VS Code terminal takes every session in that window with it,
this one included. systemd-oomd watches the Konsole scopes (`oomctl`: kill
at 60% memory pressure for 30 s, or swap use over 90%). A `systemd-run`
scope is a separate cgroup next to them (checked: not in `oomctl`'s monitored
list), so systemd-oomd leaves the build alone and the kernel's `MemoryMax`
is what bounds it.
Claude Code has its own reaper for background shells under memory pressure
(anthropics/claude-code#78674, off with
`CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP`; it acts only after 30+ minutes
without user input, no timer setting known, seen once against 40-50 oomd
kills). It injects a message telling you to end your turn: do, and say what
was killed. Don't relaunch the build in a loop after an OOM kill; one retry
at most, then ask.

How to read memory on this machine while a build runs:
- `free -h` is not the signal. `vm.swappiness` is 60 and swap is zram
  (4 GB, zstd, tried first) then a 32 GB swapfile, so the kernel parks idle
  pages (a tray app untouched for hours) in swap to keep RAM for file cache.
  Low "free", big "buff/cache" and some swap in use are normal and healthy.
  Don't poll it, don't report "available" as headroom, and don't conclude
  "thrashing" from it. Silence plus high memory isn't a stall either: a
  build can sit quiet for minutes between log lines.
- The signal is memory pressure (`cat /proc/pressure/memory`, the `some` /
  `full` avg10 values; oomd's own numbers are in `oomctl`) and the
  build's real outcome: exit code and log output, or an OOM kill in
  `journalctl -k -b | grep -i oom` (kernel) / `journalctl -b -u
  systemd-oomd` (oomd).
- Don't kill or restart a build because memory looks high; wait for one of
  those outcomes.
