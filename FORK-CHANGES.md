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

Ordered from most to least likely to cause trouble. `git show <commit>` shows a change in full;
`git revert <commit>` undoes it.

### Phone numbers (`80b36b5`)
- **What:** adds the `libphonenumber-js` library (pinned 1.13.14) and replaces the old rule that
  read any ten-digit number as American. Numbers written the local way are read as the owner's
  country. The three copies of the phone rule now share one function.
- **Where:** `packages/core/package.json`, `pnpm-lock.yaml`, `core/src/principal.ts`
  (`normalizePhone`, `parsePhone`, `phoneCountryOf`), `core/src/contacts.ts`, `core/src/config.ts`,
  `core/src/runtime.ts` (group threads), `network/src/lookup.ts`, `inkbox/src/tools.ts`,
  `server/src/boot.ts`, `cli/src/commands/invite.ts`.
- **If it breaks:** the owner or a contact is treated as a stranger, or a text goes to a wrong number.

### Signup: country, picked handles, repeat signups (`f5edfbb`, `ba288a7`)
- **What:** the country picker; handles like `sunshine-anna-k3f9` picked by the gateway; a repeat
  signup recognized by phone alone (restarts a failed setup, reveals nothing about the record).
- **Where:** `packages/gateway/src/validate.ts`, `gateway/src/server.ts`, `gateway/src/main.ts`.
- **If it breaks:** friends cannot sign up, see "does not look like a phone number", get a second
  agent, or stay at "Setting up".

### Settings for new agents (`ba288a7`)
- **What:** `GATEWAY_BRAND_NAME`, `GATEWAY_HANDLE_PREFIX`, `INSTINCT_AGENT_DESKTOP`, `INSTINCT_MODEL`.
  New agents get the brand as their name, the chosen model, and the desktop setting.
- **Where:** `packages/gateway/src/main.ts`, `gateway/src/provision.ts`, `gateway/src/brand.ts` (new).
- **If it breaks:** new agents fail to be created at Maritime, or run the wrong model or name.

### Schedule list wording (`704d137`)
- **What:** finished one-time jobs read "done, already sent at ...". Only the list text changed.
- **Where:** `packages/core/src/core-tools.ts` (`schedule_list`).
- **If it breaks:** the agent misreads its reminders. Low risk.

### Contact card, switched off (`08d5728`, `f82b1bd`)
- **What:** a "save to contacts" step with a sun picture. Off unless `GATEWAY_AGENT_NUMBER` is set.
- **Where:** `packages/gateway/src/contact.ts` (new), the `/connect/:id/contact.vcf` route in
  `gateway/src/server.ts`, the save step in `gateway/src/pages.ts`.
- **If it breaks:** nothing while it is off.

### Page design (`ba288a7`, `08d5728`, `f82b1bd`)
- **What:** minimal signup and connect pages, always dark, top-left sunlight, sun mark,
  animations (off with Reduce Motion), flags, one "Connect to Sunshine" button.
- **Where:** `packages/gateway/src/pages.ts`.
- **If it breaks:** only how the two web pages look or behave; the agent is not affected.

### Docs
- Gateway README, `docs/ARCHITECTURE.md`, `docs/DEPLOY-MARITIME.md`, this file. No effect on behavior.

## Outside the code

- **Railway** runs the gateway image `ghcr.io/torsteinvestre/open-instinct-gateway:latest`; its
  variables set the brand, prefix, country, model, invite code and keys. `INSTINCT_AGENT_IMAGE`
  decides which agent version new signups get.
- **Maritime** agents run `ghcr.io/torsteinvestre/open-instinct-agent:latest`. Existing agents
  keep their version until redeployed (`POST /api/deploy`, source `docker`); `/data` survives.
- **GitHub Actions** rebuild both images on every push to this fork's `main`.

## Known upstream issues not fixed here yet

- Cloud agents run in UTC: the gateway never passes the owner's timezone.
- `instinct dev --tunnel` logs a harmless "409 already delivers" when restarted.
