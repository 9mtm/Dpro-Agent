---
name: genvr-character-builder
description: "Plan simple agent avatars and respect the supported GenVR character capabilities"
metadata:
  agent-player:
    version: "1.1.0"
    author: "Mohamed Alarade"
    category: "creative"
    tags: ["genvr", "avatars", "agents"]
    triggers: ["agent avatar", "genvr character", "change avatar"]
---

# GenVR agent appearance

Consumer adaptation of Genvr's character-builder design. The canonical engine uses licensed
base data, recipes and validated clothing slots; do not copy or rebuild its mesh generator here.
Source reference: Genvr project `.claude/skills/genvr-character-builder/SKILL.md`.

Use stable existing agent IDs. An avatar is an appearance, not a second agent, a new account,
a tool grant or a change of personality, memory or role. Linking agents to characters is not done
from the GenVR spaces page; the owner decides where that lives.

Discover actual tools before acting. With the live Studio connection (3d-world-sdk 0.3.0-preview.15):
`user_avatar_library` lists built-in and private characters and assigns one to `self` (My avatar);
`list_avatar_motions` and `present_avatar` preview actions and expressions (see the SDK skill
`genvr-avatar-presentation`). `avatar_studio` edits a character's body, shape, muscle, fat, face,
colours, hair, view mode and expression in the Avatar tab, then saves or exports it; `motion_lab`
(read `get_motion_lab_guide` first) runs measured motion courses and keeps motion versions, and making
a version the best waits for the owner. Both need a live Studio and an owner grant for the agent;
`inspect_studio` says whether they can run now. Never fabricate other tools. Private characters come from the owner's own imports and stay on the device; never
upload or publish them. Several independent imported cast members in one scene are not guaranteed.

When a supported character API arrives, use its real schema and approved library item IDs,
start from simple/classic presets and basic clothing, validate skeleton/slot compatibility,
retain the previous look on failure, and read back the saved appearance after reopening.
Do not import paid garments, download unlicensed models, impersonate recognizable characters,
spend money, alter other users' appearances or publish without an explicit authorized action.
This skill grants no tools or permission and does not connect to Genvr automatically.
