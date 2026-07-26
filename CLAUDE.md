
<!-- devlog:start -->
## devLog
Base URL: https://api.devlog.one
Token: read from .devlog (never commit this file).
Modes: REST is always available. Hosted MCP may also be configured at https://api.devlog.one/mcp when the client supports HTTP MCP with Authorization headers. If MCP is unsupported or misconfigured, use the REST endpoints below.

Always call GET /docs first for the latest reference. If /docs is unavailable, use mcp/AGENT_DOCS.md in this repo as the fallback reference.

Use devLog as this repo's project knowledgebase and planning playground: log meaningful changes, decisions, blockers, releases, and plan updates. When major work is achieved, create a devLog entry automatically without waiting to be asked, unless the user has told you not to log. Keep entries concise and useful. Do not log secrets, raw tokens, private credentials, or noisy every-command transcripts. Use the selected project by default and let devLog use the project default visibility unless the user asks otherwise.

Project scope for this repo:
  project_id: 0fd520da-cf66-4b7a-93ab-803fe2a98022
  title: saarthi
Use this project_id by default for logs, timeline reads, and plan updates from this repository. Do not ask which devLog project this repo belongs to unless the user explicitly wants a different project.

Quick reference:

Quick reference:
  GET   /projects                      — list my projects
  POST  /projects                      — create a project
  PATCH /projects/{id}                 — update a project
  GET   /projects/{id}/timeline        — get project + all logs
  POST  /logs {project_id,title,content,mood,visibility} — create a log entry
  PATCH /logs/{id}                     — update a log entry
  GET   /projects/{id}/plan            — get milestones + todos
  POST  /projects/{id}/milestones      — create a milestone
  POST  /milestones/{id}/todos         — create a todo
  PATCH /milestones/{id}               — update a milestone
  PATCH /todos/{id}                    — update a todo
  POST  /todos/{id}/complete           — complete a todo
  POST  /todos/{id}/reopen             — reopen a todo

All requests: Authorization: Bearer $(cat .devlog)
mood: building | shipped | stuck | reflecting | inspired | learning
visibility: private | public | unlisted | shared
<!-- devlog:end -->
