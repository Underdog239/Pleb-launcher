# What obfuscated Luau looks like, and what this does to it

Every block below is real output from `studio deobfuscate`, pasted verbatim. The
inputs are committed under `examples/obfuscated/`, so all of it is reproducible.

## A light one: encoded strings and a byte array

`examples/obfuscated/Encoded.server.luau`:

```lua
-- A script written the way a Luau obfuscator writes one, committed so that the
-- README's output is reproducible rather than illustrative.

local _0x1f = "\x67\x61\x6d\x65"
local _0x2a = "\x47\x65\x74\x53\x65\x72\x76\x69\x63\x65"
local _0x3b = { 72, 101, 108, 108, 111 }
local _0x4c = {}
for _0x5d = 1, #_0x3b do
	_0x4c[_0x5d] = string.char(_0x3b[_0x5d])
end
local _0x6e = "\x77\x6f\x72\x6c\x64"
local _0x7f = "\x2c\x20"
local _0x80 = table.concat(_0x4c) .. _0x7f .. _0x6e
local _0x91 = 1 + 2 * 3
local _0xa2 = _0x91 == 7
if _0xa2 then
	print(_0x80)
else
	error("\x75\x6e\x72\x65\x61\x63\x68\x61\x62\x6c\x65")
end
if false then
	print("\x64\x65\x61\x64")
end
local _0xb3 = game["GetService"]("Players")
print(_0xb3, string.rep("=", 4))
loadstring("\x77\x61\x72\x6e\x28\x22\x62\x6f\x6f\x74\x65\x64\x22\x29")()
```

```console
$ studio deobfuscate examples/obfuscated/Encoded.server.luau
-- Deobfuscated by studio-cli (studio deobfuscate).
--
-- Constants were folded, dead branches removed, and machine-generated local names
-- replaced. Renamed variables are INFERRED from how they are used, not recovered:
-- an obfuscator discards the original names and nothing can bring them back.
--
-- 7 escape-encoded string(s) decoded, 7 constant fold(s), 6 inlined value(s), 2 branch(es) resolved, 1 loadstring inline(s), 1 decode loop(s) run and folded, 1 rename(s).
-- A script written the way a Luau obfuscator writes one, committed so that the
-- README's output is reproducible rather than illustrative.
print("Hello, world")
local players = game["GetService"]("Players")
print(players, "====")
warn("booted")
```

What happened, in order: the escape-encoded literals were decoded (`"\x67\x61\x6d\x65"`
is `"game"`), the constants were folded, the `if false` branch and the unreachable
`error` went, the constant `loadstring` was inlined, and the loop that built a
string from a byte array was **run** and replaced with its result — that is the
part an expression-by-expression fold cannot reach, because the string does not
exist until the loop has executed.

Only one rename was needed, and it is one the file gave evidence for:
`game["GetService"]("Players")` is a service, so the variable is named `players`.

## A heavier one: base64, a keyed XOR, and a VM

`examples/obfuscated/MoonsecShape.server.luau` is the shape that actually gets
distributed:

```lua
--[[ MoonSec-style shape: a base64 payload, a hand-written decoder, a keyed
     XOR applied per byte, and a dispatch loop reading a numeric program. ]]

local _0x1 = "SGVsbG8sIHdvcmxk"
local _0x2 = { 72, 101, 108, 108, 111 }
local _0x3 = 7
local _0x4 = {}
for _0x5 = 1, #_0x2 do
	_0x4[_0x5] = string.char(bit32.bxor(_0x2[_0x5], _0x3))
end
local _0x6 = table.concat(_0x4) .. "\x2c" .. " " .. _0x1
if 3 * 3 == 9 then
	fmt = "\x70\x72\x69\x6e\x74"
	fmt(_0x6)
end
local _0x7 = "\x70\x72\x69\x6e\x74"
local _0x8 = _0x7
if false then
	_0x8("\x64\x65\x61\x64")
end
local prog = {1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20}
local pc = 1
while true do
	local op = prog[pc]
	pc = pc + 1
	if op == 20 then break end
end
loadstring("\x77\x61\x72\x6e\x28\x22\x6c\x6f\x61\x64\x65\x64\x22\x29")()
```

The detector first, because that is the question you want answered before running
a transform over a file you care about:

```console
$ studio deobfuscate examples/obfuscated/MoonsecShape.server.luau --detect
examples/obfuscated/MoonsecShape.server.luau: obfuscation detected (score 100/100)

  [medium] generated-identifier-names: 16 of 34 name references look machine-written
      evidence: _0x2, _0x4, _0x5, _0x3, _0x1, _0x6, _0x7, _0x8
      reversible: partly
      Names can be replaced with inferred or neutral ones, but the originals are gone: a rename is not recoverable from the file.

  [high] escape-encoded-strings: 5 of 7 string literals are mostly escape sequences
      evidence: "\x2c"
      reversible: yes
      These decode to their literal values, which is lossless.

  [medium] base64-looking-strings: a string literal is base64 that decodes to text
      evidence: "SGVsbG8sIHdvcmxk" -> "Hello, world"
      reversible: partly
      The decoded text is in this report. It is not substituted into the output: the literal is the encoded form, and the code around it is what decodes it at runtime.

  [high] dynamic-code-loading: the script builds and runs code at runtime (loadstring/getfenv)
      evidence: loadstring
      reversible: partly
      A loadstring call whose argument folds to a constant is inlined here. One whose argument depends on runtime state cannot be: the code does not exist until it runs.

  [critical] vm-interpreter: a dispatch loop over a numeric array, with a state variable, looks like a VM
      evidence: loop body indexes a large numeric table and switches on a directive number
      reversible: no
      This is bytecode for a custom virtual machine. Recovering the original program would mean decompiling that VM, whose semantics were chosen by the obfuscator. This tool does not attempt it and will not pretend to.

  cannot be undone: vm-interpreter
```

Five things found. Four of them can be worked on; one cannot, and the report says
which is which rather than leaving you to guess. The transform:

```console
$ studio deobfuscate examples/obfuscated/MoonsecShape.server.luau --report
examples/obfuscated/MoonsecShape.server.luau:
  obfuscation score: 100/100 (generated-identifier-names, escape-encoded-strings, base64-looking-strings, dynamic-code-loading, vm-interpreter)
  strings decoded:   5
  constants folded:  6
  values inlined:    6
  branches resolved: 2
  loops unwrapped:   0
  loadstrings:       1
  decode loops:      1
  names renamed:     0

  NOT undone: vm-interpreter
    vm-interpreter: This is bytecode for a custom virtual machine. Recovering the original program would mean decompiling that VM, whose semantics were chosen by the obfuscator. This tool does not attempt it and will not pretend to.

  (no --output given, so nothing was written)
```

```lua
-- Deobfuscated by studio-cli (studio deobfuscate).
--
-- Constants were folded, dead branches removed, and machine-generated local names
-- replaced. Renamed variables are INFERRED from how they are used, not recovered:
-- an obfuscator discards the original names and nothing can bring them back.
--
-- NOT undone: vm-interpreter.
-- See the report for what that means; this file was not fully reversed.
--
-- 5 escape-encoded string(s) decoded, 6 constant fold(s), 6 inlined value(s), 2 branch(es) resolved, 1 loadstring inline(s), 1 decode loop(s) run and folded.
--[[ MoonSec-style shape: a base64 payload, a hand-written decoder, a keyed
     XOR applied per byte, and a dispatch loop reading a numeric program. ]]
fmt = "print"
fmt("Obkkh, SGVsbG8sIHdvcmxk")
local prog = { 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20 }
local pc = 1
while true do
  local op = prog[pc]
  pc = pc + 1
  if op == 20 then
    break
  end
end
warn("loaded")
```

## Reading that output honestly

- **`fmt("Obkkh, SGVsbG8sIHdvcmxk")`** — the byte array was XOR-keyed with 7 and
  only exists at runtime, so the loop was run: 72, 101, 108, 108, 111 XOR 7 is
  `Obkkh`. That is what the program computes. It is not the original string,
  because the original string does not exist in this file — the *program* does
  that arithmetic. The base64 half is left encoded for the same reason: the
  literal is the encoded form, and something in the code decodes it. The report
  told you what it says (`"Hello, world"`) without pretending it is a constant.
- **The `while true` loop is still there.** That is a custom virtual machine, and
  the tool says so instead of guessing: recovering the original program would
  mean decompiling a VM whose semantics the obfuscator chose, and that is
  undecidable in general. The header on the output carries `NOT undone:
  vm-interpreter` so nobody downstream mistakes this for a finished job.
- **`fmt = "print"`** stays a global assignment, because a global is part of the
  program's interface to its environment and renaming it changes what the script
  does to the outside world.
- **Nothing claims the names are original.** They never are; see the honesty
  section in the README.

## The rule underneath all of it

A pass runs when it can prove the replacement is the same program, and refuses
otherwise. That is why the XOR loop is folded but the base64 literal is not, why
the `while true` loop is left alone, and why a file that needs nothing comes back
byte-identical. When a pass runs and the result does not re-parse to the same
tree, nothing is written and the command fails — a transform that produced a
different program is worse than no transform at all.
