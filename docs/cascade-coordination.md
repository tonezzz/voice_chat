# Multi-session Cascade Coordination

This note outlines a lightweight process to keep overlapping Cascade sessions from colliding. Adjust the pieces below to match your team size, but try to keep the disciplines consistent so every session knows what information to produce and where to put it.

## 1. Session ownership & scope
- Every Cascade run declares its scope _before_ touching code: branch name, directory focus, and any high-risk files (compose, Dockerfiles, shared configs).
- Default branch naming: `cascade/<date>-<short-tag>` (e.g., `cascade/2025-11-21-prepush`). Include the task ID if you have one.
- If a session needs to edit outside its declared scope, it must update the change log (below) _first_ so other sessions see the expansion.

## 2. Central change log template
Keep a single shared Markdown document (Notion, Google Doc, etc.) titled **Cascade Session Log** that every session updates. Recommended fields:

```
| Session | Editor | Branch | Focus Area(s) | Locked Files | Start | ETA/Status | Notes |
|---------|--------|--------|----------------|--------------|-------|------------|-------|
| A | Cascade (ChatGPT) | cascade/2025-11-21-prepush | client/src/hooks, docker-compose.yml | docker-compose.yml | 14:05 | In progress | Adding MCP meeting envs |
```

Guidelines:
1. Update **Start** when work begins.
2. Set **ETA/Status** to `In progress`, `Blocked`, or `Ready for Review`.
3. Move rows to a "Completed" subsection with a summary once merged to main.

## 3. File/area locking rules
- Any file listed under **Locked Files** is treated as exclusive. Other sessions either avoid it or explicitly coordinate before editing.
- Locks auto-expire after 2 hours unless renewed in the log to avoid stale blocks.
- For binary assets (images, DLLs) rely on Git LFS locking when available; otherwise note "binary" in the log so others know to wait for the push.

## 4. Session lifecycle checklists
**Kickoff (before you type):**
1. Pull latest `main` and run `git status` to confirm clean base.
2. Create/checkout your `cascade/<date>-<tag>` branch.
3. Fill in the log row (scope, locks, ETA).
4. Skim the log for overlapping areas and ping owners if needed.

**While working:**
- Keep commits scoped to the declared focus.
- When you expand scope or grab a new lock, update the log immediately.
- If you discover global changes (config migrations, dependency upgrades), pause and coordinate before proceeding.

**Handoff/finish:**
1. Push branch + open draft PR (or note "awaiting review" in log).
2. Release locks (clear the column) and mark status `Ready for Review` or `Complete`.
3. Leave a short summary + blockers/next steps in **Notes** so the next session can continue.
4. If abandoned mid-task, mark status `Needs pickup` with clear TODO bullets.

## 5. Avoiding merge pain
- Rebase frequently: `git fetch origin && git rebase origin/main` at least once per session.
- Run the agreed pre-push script (`scripts/prepush-checks.cmd`) before handing off so downstream sessions inherit a clean state.
- When touching shared YAML/JSON, format using the repo’s formatter (Prettier, ESLint, etc.) to keep diffs minimal.

## 6. Optional automation hooks
- **Log helpers:** a tiny script can append/update log rows via CLI to avoid manual editing.
- **Pre-commit guards:** reject commits that modify locked files unless the committer’s session is listed as owner.
- **Notification bot:** watches the log document (or a text file in the repo) and posts to Slack/Teams when a lock is taken or released.

Start with the manual process (sections 1–5). Once the routine feels natural, automate the parts that cause the most friction (usually the log updates and lock reminders).
