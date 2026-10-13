local Rig = require(game.ReplicatedStorage.Shared.Rig)

local config = game:GetService("ReplicatedStorage"):WaitForChild("Shared"):WaitForChild("Cnofig")
local part = Rig.build()
wait(2)
part:Remove()
return config
