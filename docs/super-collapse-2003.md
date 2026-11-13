# Super Collapse! (2003) — unpacking / decompiling notes

> **Where this ended up:** unpacking the 2003 Reflexive Arcade copy was not
> needed. The collection also holds the 2002 GameHouse build
> (`../Super Collapse!/Collapse.exe`), which is not packed at all — a plain
> PE with a real `.text` section — and it runs on Windows 11 unchanged at
> 800×600. The launcher's Super Collapse! tile now points at that copy and
> plays it through BitBit at 1920×1080. Everything below still describes the
> 2003 copy in `Super Collapse/`, which the launcher refuses to start.

`Super Collapse/Collapse.exe` (PE32, 337,920 bytes, version 2.7.1.0,
timestamp 2003-04-21) is packed with **ASProtect 1.23 RC1**. There is no game
code in the file in usable form: the game is encrypted, and the loader that is
supposed to decrypt it in memory cannot get started on current Windows. That is
why nothing here can be decompiled, and why the launcher refuses to run it.

This file records what was measured, so the work does not have to be repeated.

## Why it is ASProtect 1.23 RC1

- Entry bytes `68 01 10 4B 00 E8 01 00 00 00 C3 C3` — a three-instruction
  trampoline into `.data` at `0x4B1001`, the exact shape ASProtect 1.23 RC1
  writes.
- Section names are blanked, an `.adata` section sits last, and the import
  table is the protector's 8-function decoy (one token function each from
  msacm32, winmm, user32, gdi32, advapi32, shell32, ole32).
- `.data` (`0x4B1000`, 68 KB) decrypts itself at runtime into about 63 KB of
  loader code. It is encrypted in the file: the bytes at `0x4B16C0` on disk are
  not the bytes that run there.
- `Collapse.dll` (999 KB) is resources only — no imports, no code, 985 KB of
  `.rsrc`. There is no second copy of the game hiding in the folder.

## What the loader does, and where it stops

1. Entry `0x401000` jumps to `0x4B1001` in `.data`.
2. The loader decrypts itself and runs relocatable code from `.data`.
3. It finds kernel32 **by faulting**: it takes the top SEH handler address out
   of the thread's `fs:[0]` chain and writes to it, so the write raises an
   access violation inside kernel32.
4. Its own SEH handler then reads the fault address off the stack and compares
   it against `0x77E00000` — where kernel32 lived on Windows XP:

   ```
   004B16C0  mov  eax, [esp+0x24]      ; faulting address (top SEH handler)
   004B16C4  cmp  eax, 0x77E00000      ; "is it in kernel32?" (XP layout)
   004B16C9  jae  004B16D5             ; yes -> parse the PE below
   004B16CB  pop  dword ptr fs:[0]     ; no  -> unwind and return into nowhere
   004B16D1  add  esp, 0x24
   004B16D4  ret
   004B16D5  and  eax, 0xFFFF0000
   004B16DF  sub  eax, 0x10000         ; walk down in 64 KB steps for the MZ
   004B16E4  cmp  word ptr [eax], 0x5A4D
   004B16E9  jne  004B16DF
   ```

   On Windows 11 kernel32 is at `0x76890000` and the fault address is
   `0x768A5D49`, below the XP threshold, so the handler takes the second branch
   and dies.
5. If it gets past that, it parses kernel32's export directory and resolves
   functions by hash (rotate-right-8 over the name bytes, seed `0x9C3B248E`,
   tap `0xC1A7F39F`), storing the pointers in `.data` at `0x4B17A4`.
6. It then allocates a 0x11000-byte block and jumps to its first page expecting
   generated code. The block actually holds a descriptor structure — image base
   `0x00400000`, module pointers such as `0x772F8360`, and a table of
   (start, end, pointer) region records — so the first instruction there is
   `add [eax], al` against data and it faults.

## Measurements

- **Without any debugger:** the process exits with `0xC0000005`; Windows Error
  Reporting records fault offset `0x0029E000`, faulting module `unknown`. The
  same failure with nothing attached rules out anti-debug behaviour as the
  cause.
- **Under a debugger:** the first fault is at about 10 ms, at
  `eip = <block base>`, writing to `0x768A5D49` (kernel32), with `eax` holding
  that same address. The handler at `0x4B16C0` is decrypted and runs from
  `.data` at that point.
- **Patching the XP constant** (`0x77E00000` → `0x70000000`, patched at the
  moment of the fault, since `.data` is encrypted on disk) makes the handler
  find kernel32 and resolve its exports, but execution then re-faults on the
  same descriptor block: over a million passes, the block's contents never
  change and the process never progresses.
- The game itself is never decrypted into memory. Nothing resembling game code
  is ever executable, so a dump of the process yields no code to rebuild an
  image from.

## What this means

Unpacking and decompiling both start from "run the loader to the original entry
point, then dump". The loader never gets there, and the failure is not one
hardcoded constant: step 6 shows it landing on a descriptor block instead of
generated code, which is a structural mismatch rather than an adjustable
number. Patching further would mean reimplementing ASProtect 1.23's decryption
stages by hand.

The options that remain are:

1. **An unpacked build of the same release** — drop it anywhere, then use
   **LOCATE** on the tile. This is what the launcher is set up for.
2. **Windows XP in a virtual machine**, where the protector's assumptions hold.
3. Not worth attempting: more patching of this stub. Each fix uncovers the next
   stage, and the stages are encrypted data structures, not code.

Or bypass the binary entirely: [`../../SuperCollapseRS`](../../SuperCollapseRS)
reimplements the game in Rust (compiled to WebAssembly) and draws it with this
title's own artwork and sound, extracted from `Collapse.dll`. It runs in any
modern browser.

## Tools used

The probes live in `../.freebuff/` next to the game folders (not part of the
launcher): `xdis.py` (disassembler helper), `steptrace.py` / `trace3.py`
(trap-flag tracing through WOW64, which reports single-steps as `0x4000001E`),
`fix1.py` / `fix2.py` (patch the XP constant at the fault and follow what
happens next), `grab.py` / `grab2.py` / `grab3.py` (dump `.data`, the stack and
the allocated block at the fault), `plain.py` (passive event log). A hardware
breakpoint does not survive this stub — it clears the debug registers — so
detection has to go through the trap flag or guard pages.
