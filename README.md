# SkillsAggregator MCP

Small Streamable HTTP MCP server for sharing chat skills.

## Tools

- `list_skills` — returns canonical skill names and short descriptions explaining what each skill does and when to use it.
- `get_skill(name)` — returns the complete `SKILL.md` by canonical name; no authentication is required.
- `write_skill(name, description, markdown, overwrite)` — creates or replaces a skill from Markdown pasted or attached in chat.
- `delete_skill(name)` — deletes a skill by canonical name.

`write_skill` and `delete_skill` require `Authorization: Bearer <write token>` on the MCP `tools/call` request. `description` is mandatory and must concisely explain what the skill does and when an agent should use it. The server replaces any supplied frontmatter with canonical `name` and `description` fields, so the folder and metadata cannot diverge.

The complete generated `SKILL.md`, including frontmatter, is limited to 60,000 characters. Skills are intentionally returned in one response without pagination.

Skills are stored as `<data-dir>\<skill-name>\SKILL.md`. Writes use a temporary file followed by an atomic rename.

## Run

Node.js 18 or newer is required. There are no npm dependencies.

```powershell
node server.js --host 127.0.0.1 --port 11611 `
  --data-dir C:\path\to\.generated\skills `
  --token-file C:\path\to\.generated\write-token.txt
```

Endpoint: `http://127.0.0.1:11611/mcp`  
Health: `http://127.0.0.1:11611/healthz`

`GET /` also returns a small successful response for supervisors that require root endpoint health in addition to `/healthz`.

Set `SKILLS_WRITE_TOKEN` to provide the write token explicitly. If it is empty, the server creates a random 256-bit token in the token file on first start. Keep that file private.

For MCP Control Center, connect through the MCP's Gate endpoint or Unified endpoint. Configure Unified to forward Bearer only for this MCP profile; ordinary read-only sessions do not need a token.
