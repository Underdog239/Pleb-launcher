local Rig = {}

function Rig.build()
  local part = Instance.new("Part")
  part.Parent = workspace

  part.Sizee = Vector3.new(1, 1, 1)
  part.Material = Enum.Material.Concree
  part.Anchored = true

  local world = Instance.new("Workspace")

  return part
end

return Rig
