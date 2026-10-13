-- Independent verification: read files written by studio-cli using Lune, which
-- uses the reference rbx-dom implementation.
--
--   lune run scripts/verify-with-lune.luau <file.rbxm|file.rbxmx> [path]
--
-- Prints the instance tree and, when a path is given, selected properties of
-- that instance. Exits non-zero if the file cannot be parsed.

local fs = require("@lune/fs")
local roblox = require("@lune/roblox")
local process = require("@lune/process")

local file = process.args[1]
local target = process.args[2]

if not file then
	print("usage: lune run scripts/verify-with-lune.luau <model-file> [path]")
	process.exit(1)
end

local contents = fs.readFile(file)
local roots = roblox.deserializeModel(contents)

print(string.format("parsed %s (%d root instances)", file, #roots))

local function walk(inst, depth)
	print(string.rep("  ", depth) .. inst.ClassName .. ' "' .. inst.Name .. '"')
	for _, child in inst:GetChildren() do
		walk(child, depth + 1)
	end
end

for _, inst in roots do
	walk(inst, 0)
end

if target then
	local function find(inst, path)
		local head, rest = path:match("^([^%.]+)%.?(.*)$")
		if inst.Name ~= head then
			return nil
		end
		if rest == "" then
			return inst
		end
		for _, child in inst:GetChildren() do
			local found = find(child, rest)
			if found then
				return found
			end
		end
		return nil
	end

	for _, inst in roots do
		local found = find(inst, target)
		if found then
			print(string.format("\n%s.%s:", found.ClassName, found.Name))
			local keys = { "Size", "CFrame", "Anchored", "Color", "Material", "CanCollide", "Transparency", "Brightness" }
			for _, key in keys do
				local ok, value = pcall(function()
					return found[key]
				end)
				if ok then
					print(string.format("  %s = %s", key, tostring(value)))
				end
			end
			return
		end
	end
	print("path not found: " .. target)
	process.exit(1)
end
