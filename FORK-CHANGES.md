# Changes in this fork

This fork (torsteinvestre/open-instinct) runs as **Sunshine**. It is based on
[mariagorskikh/open-instinct](https://github.com/mariagorskikh/open-instinct) at commit `79a144a`.
This page lists what the fork adds, so each change can be found, understood and removed.

## Tagged changes

Newer changes carry a tag in a code comment on every line or block they add. Search the
repository for the tag to find all of it.

### `[sunshine:reply-guard]`: one reply per run

**Problem.** A run (an incoming message or a scheduled job) could text the same person twice:
once with a tool (`send_message`, `notify_owner`, `ask_owner`) and once with the final reply.
Seen live: a reminder arrived twice ("TIMER!!!" twice), or followed by a report ("I sent
Torstein the reminder ...").

**Upstream already had the fix for one case.** For agent-to-agent tasks, `runtime.ts` sets
`repliedViaTool` when the model answers with `reply_instinct` and then skips the final reply.

**What the fork adds.** The same rule for text threads and scheduled jobs:

- Tools declare who they text with `ToolMeta.replyTarget` (`"current"` or `"owner"`).
  `send_message`, `notify_owner` and `ask_owner` declare it.
- When a tool reached the run's own audience (the thread being answered, or the owner from a
  scheduled job or the owner's private text thread), `repliedViaTool` is set and the final reply
  is not sent. It is written to the audit log instead (`policy` entry with `replyGuard`).
- Texts to anyone else, files, a contact's request relayed to the owner, and the dashboard chat
  are unchanged.
- Two prompt lines tell the model the same, and not to send "on it" progress notes with a tool.

**Files.** `packages/core/src/types.ts`, `runtime.ts`, `prompt.ts`, `core-tools.ts`,
`packages/inkbox/src/tools.ts`, and tests in `packages/core/test` and `packages/inkbox/test`.

**To remove.** Revert its commit (`git log --grep "reply-guard"` finds it), or delete every
tagged block. The tests tagged the same way go with it.

**A new tool that texts the owner or the current conversation** must declare `replyTarget`,
or the double message comes back for it. The tests list which tools declare it, so a new one
shows up there.

## Earlier changes (not tagged; find them by commit)

| Commit | What |
|---|---|
| `80b36b5` | Phone numbers through libphonenumber-js: non-US owners recognized, local formats read as the owner's country |
| `f5edfbb` | Gateway signup asks for the country (`GATEWAY_DEFAULT_COUNTRY`) |
| `ba288a7` | Gateway branding and Maritime free-plan settings (`GATEWAY_BRAND_NAME`, `GATEWAY_HANDLE_PREFIX`, `INSTINCT_AGENT_DESKTOP`, `INSTINCT_MODEL`), minimal pages |
| `08d5728` | Contact card, two-step connect page, dark sunlit theme, animations |
| `f82b1bd` | Contact card only with a known number (`GATEWAY_AGENT_NUMBER`) |
| `704d137` | `schedule_list` says when a one-time job is already done |

`git show <commit>` shows any of them in full; `git revert <commit>` undoes one.
