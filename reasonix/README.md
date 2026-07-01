# Skill Files (adaptable to any MCP host)

This directory contains markdown skill/command files for the crosstalk
inter-federation MCP server. These provide guidance for your agent on
how to use the MCP tools (`send_message`, `check_inbox`, `reply`,
`crosstalk_identity`).

## Usage

Copy or adapt these to your host's skill/command format:

| Host | Location |
|------|----------|
| Reasonix | `~/.reasonix/skills/<name>/SKILL.md` |
| Claude Code | `.claude/commands/` or plugin `commands/` dir |
| Claude Desktop | `.claude/commands/` |
| Other | Consult your host's documentation |

## Files

| File | Purpose |
|------|---------|
| `crosstalk-inbox.skill.md` | Read, send, reply, manage identity |
| `crosstalk-join.skill.md` | Onboarding: sign in -> get approved -> install credentials |

## Prerequisites

- MCP server built and running (see `../mcp/BUILD.md`)
- `~/.crosstalk/config.env` with credentials (set up via `crosstalk-join`)
