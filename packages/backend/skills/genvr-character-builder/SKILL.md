---
name: genvr-character-builder
description: "Plan simple agent avatars and respect the supported GenVR character capabilities"
metadata:
  agent-player:
    version: "1.0.0"
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
a tool grant or a change of personality, memory or role. In the host, the user chooses agents
under Create space or Manage agents and can randomize or change a simple avatar preset.
Appearance is saved per signed-in account and agent; membership belongs to each space.
The current host previews are simple schematic figures, not catalog garment assets.

Discover actual tools before acting. The released standalone MCP 0.3.0-preview.1 has no
create_character, set_character_body, add_character_item or preview_character tools. The
platform character skill describes some planned interfaces; never fabricate their availability.
The embedded Studio exposes its own character editor, but no public host API for spawning
multiple live agent characters. Report this limit instead of claiming they are in the scene.

When a supported character API arrives, use its real schema and approved library item IDs,
start from simple/classic presets and basic clothing, validate skeleton/slot compatibility,
retain the previous look on failure, and read back the saved appearance after reopening.
Do not import paid garments, download unlicensed models, impersonate recognizable characters,
spend money, alter other users' appearances or publish without an explicit authorized action.
This skill grants no tools or permission and does not connect to Genvr automatically.
