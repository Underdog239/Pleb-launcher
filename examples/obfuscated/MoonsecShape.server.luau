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
