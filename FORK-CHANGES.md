# Changes in this fork

This fork (torsteinvestre/open-instinct) runs as **Sunshine**. It is based on
[mariagorskikh/open-instinct](https://github.com/mariagorskikh/open-instinct) at commit `79a144a`,
with upstream merged in up to `9d262da` on 2026-10-15 (see [Upstream merges](#upstream-merges)).
This page lists what the fork adds, so each change can be found, understood and removed.

## Tagged changes

Every change carries a tag in a code comment on every line or block it adds (the earliest ones were
tagged afterwards, see [Earlier changes](#earlier-changes-tagged-afterwards-2026-10-15)). Search the
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
  `send_message`, `notify_owner` and `ask_owner` declare it, and `send_file` when it has a caption
  (seen live: the PDF, its caption, then "Sent: a one-page packing list ..."). A file without a
  caption leaves the final reply as its message.
- When a tool reached the run's own audience (the thread being answered, or the owner from a
  scheduled job or the owner's private text thread), `repliedViaTool` is set and the final reply
  is not sent. It is written to the audit log instead (`policy` entry with `replyGuard`).
- Texts to anyone else, files, a contact's request relayed to the owner, and the dashboard chat
  are unchanged.
- Prompt lines tell the model the same, not to send "on it" progress notes with a tool, and to
  put what it wants to say about a file in the caption.

**Files.** `packages/core/src/types.ts`, `runtime.ts`, `prompt.ts`, `core-tools.ts`,
`packages/inkbox/src/tools.ts`, and tests in `packages/core/test` and `packages/inkbox/test`.

**To remove.** Revert its commits (`git log --grep "reply-guard"` finds them), or delete every
tagged block. The tests tagged the same way go with it.

Upstream's system tasks (`runSystemTask`, merged 2026-10-15) follow the scheduled-job rule: a task
that texted the owner with a tool sends no final reply, and `NO_REPLY` is never texted from one.

**A new tool that texts the owner or the current conversation** must declare `replyTarget`,
or the double message comes back for it. The tests list which tools declare it, so a new one
shows up there.

### `[sunshine:silent-reply]`: the stay-quiet word

**Problem.** A scheduled run stays silent only if its final reply is empty. Seen live: "in 2 minutes,
check if it's raining and only text me if it is" texted "I'm not sending Torstein a message. The
current Oslo reading says ..." on a dry day, because any reply text is delivered.

**What the fork adds,** copied from OpenClaw's `NO_REPLY` convention:

- A final reply that is exactly `NO_REPLY` (any case, surrounding spaces ignored) is not sent. It is
  written to the audit log instead (`policy` entry with `silentReply`).
- Only scheduled runs are told about the word. A person who texts gets an answer, as in OpenClaw,
  where direct chats never get the guidance.
- The word alone is never texted in a thread either, in case it slips out there.
- The word must be the whole reply: "It's raining. NO_REPLY" is still sent. A2A replies and the
  dashboard chat are unchanged.

**Files.** `packages/core/src/prompt.ts` (`SILENT_REPLY` and one scheduled-run line),
`packages/core/src/runtime.ts` (`runScheduled`, `deliver`, `isSilentReply`), and tests in
`packages/core/test`.

**To remove.** Revert its commit (`git log --grep "silent-reply"` finds it), or delete every tagged
block. Scheduled runs then fall back to upstream's empty reply.

**The coming watcher** relies on this: most of its checks should end in `NO_REPLY`.

### `[sunshine:reactions]`: tapbacks that replace a message, never add one

**Problem.** Upstream's `react` tool asked for a message id the model never sees, so it was never
used. Sunshine answered "thanks" with "You're welcome!", a message that adds nothing.

**What the fork adds.**

- `react` (`packages/inkbox/src/tools.ts`) always targets the message being answered
  (`ctx.replyRef.messageId`); only `like` and `love` (no laugh, question, dislike: easy to misuse);
  at most one per message; only in the owner's own one-to-one thread.
- `alone: true` declares the tapback the whole reply (`replyTarget: "acknowledge"`): the runtime
  (`packages/core/src/runtime.ts`) then drops any text the model writes after it ("I've already
  reacted…"), but only if the run used no other tool. If it did something, or a tool failed, the
  text still goes out, so a report is never swallowed. `alone: false` lets the words through.
- One short principle in the iMessage prompt (`packages/core/src/prompt.ts`), not a flowchart: a
  tapback only where it is the most natural response, never instead of words they need; alone when
  they close something just done; with a few words for happy news, where the one plain "no" is
  offers; words for anything sad; their own tapbacks are feedback, answered briefly only when they
  show confusion or displeasure; most messages get none.
- Off switch: `config.features.tapbacks = false` (upstream's flag, unused until now) removes both
  the tool and the guidance.
- Never a tapback on their tapback (it would land on Sunshine's own message): an incoming tapback is
  marked (`replyRef.tapback`, `packages/inkbox/src/events.ts`), and the tool then sends nothing and
  says there is nothing to do, worded so the model does not apologise. Found when the time stamps
  arrived (`[sunshine:stable-cache]`); after the fence, 6 of 6 of their tapbacks got nothing back.

**Why this wording.** Three versions were compared on the same conversations with the real model.
A numbered ladder kept happy replies clean but ignored a 👎 ("their tapbacks need no reply").
A principle without the offers sentence read signals well but offered things in half the happy
replies ("car insurance?" after a driving test). Allowing "only the obvious next step" kept good
offers but still offered celebration dinners after an engagement (10 of 18). The final version
(principle plus "no offers" in happy moments) scored 75/76 with no serious mistakes: happy 23/24
with no unwanted offer, closing 14/14, signals 6/6, sad, questions and requests all in words.

**Files.** `packages/inkbox/src/tools.ts` (tool, fences, off switch), `packages/core/src/runtime.ts`
(the lone-tapback rule), `packages/core/src/types.ts` (`ReplyTarget`), `packages/core/src/prompt.ts`
(guidance), tests next to each, and the scenario test `packages/server/scenarios/reactions.mjs`
(`node scenarios/reactions.mjs [rounds] [new|old|both] [kinds]`, about $0.25 for a full run).

**To remove.** Set `features.tapbacks` to false in the agent's config to switch it off. To take it
out of the code, revert its commits (`git log --grep "sunshine:reactions"`), or delete the tagged
blocks in the files above. Upstream's tool comes back unusable as before.

### `[sunshine:watcher]`: the news watch (built, off by default)

**Goal.** Sunshine texts its owner soon after something genuinely worth knowing happens in their
interests, and otherwise stays silent. Plan and reasoning: `~/sunshine-ops/WATCHER-PLAN.md`
(private notes). Principle: code for facts and fences, reasoning for taste.

**How a check works.** Every two hours outside the owner's quiet hours by default (one scheduled job
carrying `gate: "watcher"`; the owner can ask for 2, 3, 4, 6, 8, 12 or 24 hours, never faster: an
older faster setting counts as two hours and the job follows at the next start), entirely in code,
never waking the agent:

1. Fences: off, quiet hours, a daily model-call budget.
2. Collect: Google News RSS per search, last day only, headlines already seen skipped (by link
   and wording); Jev (`TYPESAFE_API_KEY`) removes the clearly off-topic, one yes/no per headline.
   The short list holds an hour's worth (30) for every hour between checks, at most 60
   (`headlinesPerCheck`); what does not fit waits for the next check.
3. Screen (step 1): off unless `WATCHER_SCREEN_MODEL` names a model (see below).
4. Decide (step 2, Claude Sonnet 5.5): the playbook, over every short-listed headline. Tell now / keep for later / nothing, plus the
   text and a story card per story ("new", or an update to an existing card with what changed).
5. The door (code): refuses an article already told, an update with nothing changed, or a "new"
   story that reads almost like a told one (unless the model says how it differs); one retry with
   the reason, else nothing is sent. Then quiet hours and a hidden limit of 6 texts a day.
6. Write (step 3, Claude Sonnet 5.5, scheduled texts only): the chosen stories are written as
   Sunshine would text them, with its persona, its memory of the owner, the last 10 messages of
   their thread and one web search per story (the agent's own `web_search`). It introduces unknown
   names from the search, adds a personal line only where one is real, says how something is doing
   but never advises (buy/sell/hold), and tells every story it was given. It may hold the text back
   only for re-posted old news (the search clearly shows the event is over a week old) or a bad
   moment, with a reason in the journal (`stage: "write"`) and the audit (`writerHeld`). A failed
   search writes from the headline; a failed or unusable writer sends step 2's own text.

**Why the writer.** Step 2 wrote from the headline alone, in its own voice: "Since you follow XRP:",
names nobody could place, and a "news watch" the agent then disowned. Tested on real headlines
(`packages/server/scenarios/writer.mjs`): the writer's texts read like a friend's; Sonnet beat Haiku
(Haiku explained itself and forced links); of 15 test stories, 7 old ones were held back and 8
fresh ones sent, after one fix (it had second-guessed whether a story was worth telling, and held
back one search could not confirm). About 0.4-0.6 cents per text sent.

**Speaking as itself.** The skill and the tools' descriptions and results say what Sunshine does
("keeping up with the news for them", "what you looked at"), never "the news watch", and
`watch_profile` lists timing and settings last, labelled "to mention only if they ask". With the
watch on, the owner's system prompt carries a short fixed section (`NEWS_PROMPT` in
`packages/watcher/src/prompts.ts`, added in `boot.ts`): talk about what you keep an eye on and why
it fit, not how. It has to be there: asked "how did you know?", the model never opened the skill
and recited what the tools had shown it ("I check Google News every 60 minutes… a search for
'startup Norge'"). Tested with `packages/server/scenarios/voice.mjs` (the real server answering
four questions about a news text it sent): machinery talk in 3 of 4 answers before, 0 of 4 in two
runs after ("I keep an eye on Norwegian startups and AI news for you, and that story fit"). Step
2's own text no longer opens with "Since you follow X" (`packages/watcher/scenarios/wording.mjs`).

**Why every two hours, and no screen** (2026-10-15). About 25-30 new headlines arrive per hour for a
typical owner, and a decision costs about 1.3 cents fixed (instructions, story cards, thinking) plus a
little per headline: measured 1.5 cents for 11 headlines, 1.72 for 25, 2.36 for 60. Hourly that is
about $8 a month per owner, every two hours about $5.70, and slower saves less and less while news
arrives later and each list gets longer. The Haiku screen saved almost nothing (its own call cost
about the difference) and dropped the day's one story worth telling (an Oslo pre-seed round, Jev
0.96), which Sonnet picked every time it saw it, among 11, 25 or 60 headlines. A filter in front of
the decision can only lose stories, so only Jev stays there: cheap, and a mechanical question.

No new headline means no model call. A failed step 2 sends nothing and its headlines wait for the
next check. Each check leaves one `policy` audit entry (`watcher: "check"`) with counts, outcome,
note and cost, and one line in the decision journal (`watcher-journal.jsonl`) with every headline
it looked at and where its path ended (Jev, screen, or decision). In conversation the agent has
six owner-only tools: `watch_profile`, `watch_profile_update`, `watch_check` (answers "anything
new?" in its own reply), `watch_journal` ("what did you skip?"), `watch_later`, `watch_settings`.

**Where to change what.**

| To change | Where |
|---|---|
| How the decision is made, examples | `packages/watcher/src/prompts.ts` (`DECIDE_SYSTEM`; the screen's `SCREEN_SYSTEM` next to it) |
| How a news text reads, when the writer holds back | `writeSystem` in `packages/watcher/src/prompts.ts` |
| What the writer is given (persona, memory, thread, search) | `packages/server/src/watcher-writer.ts` (`WRITER_THREAD_MESSAGES`); `RESEARCH_MAX_CHARS` in `packages/watcher/src/check.ts` |
| Which models, or one step off | env `WATCHER_SCREEN_MODEL` (unset: no screen), `WATCHER_DECIDE_MODEL`, `WATCHER_WRITE_MODEL` (`off` disables a step; the writer off sends step 2's text); `boot.ts` |
| Prompt caching for the steps (off) | `modelCall` in `packages/watcher/src/models.ts`. Off on purpose: Pi caches every call for 5 minutes and storing costs 25% more, but checks run an hour apart, so it was never read back (measured: 0.56 cents a call with it, 0.475 without) |
| Haiku 5.5 description (Pi 1.0.1 lacks it) | `resolveWatcherModel` in `packages/watcher/src/models.ts` |
| How often, quiet hours (per owner) | by text to Sunshine (`watch_settings`); defaults in `store.ts` (`DEFAULT_EVERY_MINUTES`, 120) / `clock.ts`. A changed default reaches new owners only. The choices: `CHECK_INTERVALS` in `clock.ts` (2 to 24 hours); `checkCron` starts long gaps at the first full hour after quiet hours |
| How many headlines one check takes on | `headlinesPerCheck`, `HEADLINES_PER_HOUR`, `DECIDE_MAX` in `packages/watcher/src/check.ts` |
| Text limit, model budget, ask-after hours | constants at the top of `packages/watcher/src/check.ts` |
| Jev threshold, how many headlines per search | `DEFAULTS` in `packages/watcher/src/scan.ts` |
| How the short list is shared between searches | `fairShare` in `packages/watcher/src/scan.ts` |
| The decision journal (`watcher-journal.jsonl`, 7 days) | `JOURNAL_*` in `store.ts`; read by the `watch_journal` tool |
| "Reads almost like a told story" threshold | `SAME_HEADLINE_OVERLAP` in `packages/watcher/src/decide.ts` |
| How Sunshine keeps the picture, reacts to feedback | `skills/news-watch/SKILL.md` |
| The interest question in the welcome chat | `skills/onboarding/SKILL.md` (see `[sunshine:onboarding]`) |
| Test scenarios (real models, costs cents) | `packages/watcher/scenarios/` |

**Core and server pieces.** `ScheduleEntry.gate` and `RuntimeDeps.scheduleGates` (a gated job
runs plain code first; a gate that is not registered makes the job do nothing),
`ScheduleEntry.toolRepliesOnly` (a second guard: such a job's final reply is never texted),
both in `core/src/types.ts` and `runtime.ts`. `server/src/boot.ts` creates the watcher only when
`INSTINCT_WATCHER=1`; unset, the agent is unchanged. On first boot with the switch on, the
owner's checks start by themselves; with no interests after a day, it asks once.

**For friends' agents** (2026-10-15). The gateway passes `INSTINCT_WATCHER`, `TYPESAFE_API_KEY` (as a
secret), the `WATCHER_*_MODEL` settings and `MEMORY_PASS_MODEL` to every new agent when they are set on
the gateway (`AGENT_SETTINGS`, `agentExtraEnv` in `packages/gateway/src/main.ts`; nothing else of the
gateway's own settings is passed). Agents created before keep what they had: change those with
`agent-env.sh` or Maritime's dashboard.

**Not done yet.** Opening the article itself: Google News links lead to a consent page in Europe, so
the writer uses a web search instead.

**To remove.** Delete `packages/watcher` and `skills/news-watch`, and every block tagged
`[sunshine:watcher]` (`boot.ts`, `server/src/watcher-writer.ts`, `server/package.json`, `types.ts`,
`runtime.ts`, both Dockerfiles, `skills/onboarding/SKILL.md`, `skills/README.md`, tests), then
`pnpm install`.

### `[sunshine:timezone]`: agents get the owner's timezone

**Problem.** Agents created by the gateway ran in UTC: the gateway never passed
`INSTINCT_OWNER_TIMEZONE`, so core fell back to the server's zone. Relative timers were right, but
times in texts were 2 hours off in Norway and clock-time reminders ("every day at 8") fired late.
Upstream's own `instinct deploy` already passes the timezone; only the gateway missed it.

**What the fork adds.**

- The signup form has a hidden `timezone` field that the browser fills
  (`Intl.DateTimeFormat().resolvedOptions().timeZone`). Nothing visible changes.
- The gateway keeps it only if it is a real IANA zone. `UTC` and `Etc/*` count as unknown, since
  privacy modes report UTC. Otherwise it falls back to the picked country's single zone (NO, SE, GB).
  The US and "Other" get no fallback. A bad value never fails a signup.
- The zone is saved on the user record and sent to the new agent as `INSTINCT_OWNER_TIMEZONE`.

**Existing agents are not changed by this.** Core reads the env var only on first boot; after that,
`/data/config.json` wins. Change `owner.timezone` there and restart the agent.

**Files.** `packages/gateway/src/validate.ts` (`placeTimezone`, `signupTimezone`, country zones),
`pages.ts` (hidden field and script), `server.ts`, `store.ts`, `provision.ts`, and tests in
`packages/gateway/test`.

**To remove.** Revert its commit (`git log --grep "timezone"`), or delete every tagged block. New
agents then run in UTC again.

### `[sunshine:relative-time]`: "in N minutes" is computed by the code

**Problem.** `schedule_create` only took an exact ISO time, so for "remind me in 5 minutes" the model
did the sum itself. Usually right (it often checked the clock with `date` first), but not always:
asked at 11:27 in a long thread, it set 11:36. OpenClaw's agent tool has the same gap; only its
command line (`parseAt`, "20m") computes relative times in code.

**What the fork adds** (`packages/core/src/core-tools.ts`).

- An `inMinutes` option: "in 5 minutes" = 5, "in 2 hours" = 120. The tool adds it to the real clock
  (`ctx.now()`). It must stand alone (not with `at` or `cron`), above 0 and at most a year.
- The result also gives the owner's clock time ("Next run: 2026-10-14T09:32:00.000Z (Wed 14 Oct,
  11:32 Europe/Oslo)"), so the model never converts zones itself. Correct across the change to
  winter time (tested for Oslo, 25 October).
- The `at` description asks for the zone (Z or an offset). A time without one is read in the
  server's zone (UTC on Maritime); the model's past calls all had one, so this stays a description,
  not a code change.

**Tested with the real model** (`packages/server/scenarios/reminders.mjs`, 14 ways of asking, 2
rounds, about $0.24 with the old tool for comparison): new 28/28 at the right time, every relative
request used `inMinutes`, every clock time had the right offset (+01:00 after 25 October), and no
reply stated a wrong time (all in 24-hour form). The old tool: 27/28 in that short, clean thread
(today's 11:36 slip did not recur there), up to a minute early in half the relative cases (seconds
dropped), "in 2 days" once set to 09:00, and some replies in 12-hour form ("2:11 PM").

**To remove.** Revert its commit (`git log --grep "relative-time"`), or delete the tagged blocks in
`core-tools.ts`, its tests in `packages/core/test/core-tools.test.ts`, and the scenario. Reminders
then work as before, with the model doing the sum.

### `[sunshine:stable-cache]`: the prompt cache holds from one message to the next

**Problem.** Measured on the live agent (2026-10-14): each message cost 13-16 cents, because about
50,000 tokens (tools, system prompt, history) were paid as a fresh cache write every time. Two things
changed the start of the request on every run: the clock in the system prompt ("# Now", to the
millisecond), and the history fold, which moved one message into the summary on every turn once a
thread passed 60 messages. Anthropic's cache only reuses an identical prefix. OpenClaw keeps the time
out of its system prompt and compacts only near the limit, for the same reason.

**What the fork adds** (on unless `config.features.stableCache` is false).

- `packages/core/src/prompt.ts`: "# Now" becomes "# Time" (the timezone only, the same all day), and
  `timeStamp()` builds the line put in front of each message: `[Wed 14 Oct 2026, 12:27 Europe/Oslo,
  UTC+02:00]`.
- `packages/core/src/runtime.ts`: `Conversation` stamps every message it runs, steers or follows up
  (owner, friends, agents, scheduled jobs all pass through it). `foldInSteps()` replaces the sliding
  fold: nothing changes until 80 messages or the old 240k-character cap, then one fold down to 50
  messages / 160k characters. Between the model calls of one run only the size cap applies, so a fold
  happens once, at the start of a message.
- The off switch brings back upstream's prompt and fold on the next restart.

**Guards.** A test builds the system prompt at different times of day and requires it to be byte for
byte the same, so anything time-dependent added later fails at once. Tests also check the stamps, that
the history is only appended to between folds, the one-step fold on count and size, and the switch.
`packages/server/scenarios/cache.mjs` runs the real runtime against the real model, on and off, and
prints what each call read from the cache.

**Tested with the real model** (2026-10-14). Cache: with the switch on, each message after the first
read the whole start from the cache and cost about a tenth of the first; off, every message wrote it
again. The clock reaches the model ("It's 14:13 in Oslo", right) and no reply copied a stamp.
Reminders 14/14 at the right time. Tapbacks 37/38, no serious mistakes. One side effect found and
fenced: with stamps, a tapback of theirs sometimes got one back (2 of 6, 0 of 8 without stamps); see
`[sunshine:reactions]`. To watch: after "sounds good" the model sometimes sets a reminder nobody asked
for and says so (2 of 3 runs with stamps, 1 of 6 without, then 0 of 1).

**Known limits.** The memory digest (today's journal) is still in the system prompt: a journal entry
breaks the cache once. A message after more than 5 minutes of quiet pays full price (the cache's
lifetime); a 1-hour cache (`PI_CACHE_RETENTION=long`) is possible but costs twice as much to write.
`[sunshine:prune]` makes that full price smaller by shortening old tool results at exactly those moments.

**To remove.** Set `features.stableCache` to false in the agent's config and restart, or revert its
commit (`git log --grep "stable-cache"`) or delete the tagged blocks in `prompt.ts`, `runtime.ts`,
`types.ts`, the tests and the scenarios.

### `[sunshine:delivery-mirror]`: Sunshine knows what it texted the owner from elsewhere

**Problem.** A reminder, a news-watch text, a relay from a friend or an approval question reaches
the owner's phone from another conversation (`scheduled:<id>`, `scheduled:watcher`, a friend's
thread). The owner's own thread never recorded it, so a reply to it had no context: "preciate the
reminder" got "Did the stretch reminder come through?", and "What's Sanna?" after a news text made
Sunshine dig through its logs (live, 2026-10-14).

**What the fork adds** (as OpenClaw's "delivery mirror", `src/infra/outbound/deliver-transcript.ts`).

- `InkboxChannel.afterSend` (`packages/inkbox/src/channel.ts`): called after every successful send,
  never after a failed one; a failing hook never fails the send. Every text passes there: the
  runtime, the core tools, `send_message`, the news watch, payments. `boot.ts` wires it to the runtime.
- `AgentRuntime.mirrorToOwner` (`packages/core/src/runtime.ts`): if the text reached the owner's own
  thread (`ownerLast`) from a different conversation, two messages are added to that thread: a note
  (time stamp, "Not a message from <owner>: a note that you texted them the next message from <the
  news ("on your own, after reading the news for them") / a reminder ("when "stretch", which they
  set up with you, came due") / your conversation with Sam, in words without machinery>") and the text itself as
  Sunshine's message. Once: the same text to the same thread within two minutes is skipped. If the
  thread is mid-run, the copy is added when the run ends; if it is not loaded, it goes into the saved
  session file. Failures are logged, never retried or fatal.
- Off switch: `config.features.deliveryMirror = false`.

**Why the note.** Tested with the real model: a bare copy made Sunshine disown the news text ("didn't
come from anything I looked up, and I shouldn't have sent it"). With the note it answered "what's
Sanna?" from the text it had sent (`packages/server/scenarios/mirror.mjs`, on vs off).

**Not covered yet.** Files sent from elsewhere (`sendFile`) are not mirrored; only text.

**To remove.** Set `features.deliveryMirror` to false, or revert its commit
(`git log --grep "delivery-mirror"`) or delete the tagged blocks in `channel.ts`, `runtime.ts`,
`types.ts`, `boot.ts`, the tests and the scenario.

### `[sunshine:reminders]`: plain reminders cost nothing; repeating ones leave room in the day's texts

**Problem** (2026-10-15). Every reminder, even "drink water", ran a full agent turn: half a cent to a
few cents each, more when nothing else had run for a while, and nothing at all when the model was
unreachable (the credits ran out twice). And nothing limited how often a repeating one fired: "every
2 minutes, text me PING" worked in testing, which would cost dollars a day and use up the day's texts
(Inkbox lets an agent send 100 iMessages per rolling 24 hours).

**What the fork adds.**

- `schedule_create` takes `text` or `prompt` (`packages/core/src/core-tools.ts`). A plain reminder,
  whose words need no thinking when it fires, gives `text`: that message is stored on the job
  (`ScheduleEntry.text`, `types.ts`) and `runScheduled` sends it as written (`runtime.ts`), with no
  model run. A job that looks something up or decides gives `prompt`, as before. The model chooses,
  from the tool's description; the result repeats the exact message so its confirmation can say it.
- A repeating job is refused when, on its busiest day, it and the other repeating jobs would plan more
  than 40 texts (`REPEATING_SEND_SHARE` of `DAILY_SEND_LIMIT` 100; `busiestDayRuns` in
  `scheduler.ts` counts them). The refusal says why, so the model can tell the owner and offer an
  interval that fits. One-off reminders and jobs that run in code (the news, the memory notes) are not
  counted. A limit taken from the platform, not a judgment of how often is reasonable.

**Tested with the real model** (`packages/server/scenarios/reminder-kinds.mjs`, about 5 cents a round):
9 of 9 as expected. Five plain reminders (in 5 minutes, at 18, hourly 9-17, weekdays 8:55, Friday 12)
were saved as messages; three jobs (the daily weather, "only tell me if it rains", the morning XRP
price) as prompts; "every 2 minutes, PING" was refused and the reply explained it and offered what fits
("every 2 minutes for a limited window, like 14:10 to 14:50"). Found and fixed: an example message with
the owner's name came back in every reminder ("…, Torstein"), and the refusal counted only to 41.

**What it does not cover.** Repeating jobs that run the model ("every 10 minutes, check the price")
still cost per run; a daily spending limit per owner is the planned safety net for those.

**To remove.** Revert the commit (`git log --grep "sunshine:reminders"`) or delete the tagged blocks
in the files above and their tests (`core-tools.test.ts`, `scheduler.test.ts`, `runtime.test.ts`).
Jobs saved with `text` would then run their prompt ("Send the plain reminder: …") through the model.

### `[sunshine:memory]`: Sunshine keeps notes on what matters

**Problem** (2026-10-15). After three days of chatting, `memory/MEMORY.md` held 231 bytes: saving
depended on the model calling `memory_write` (3 times in 3 days), so the fund, the concert tickets and
the apartment plans were not in it. The summary of a trimmed conversation was the first 200 characters
of each message, and at the next trim that summary was clipped like any other message, so everything
older vanished (seen live: "[Conversation summ…"). And the digest in the prompt kept the start of
`MEMORY.md`, so once it grew, the newest facts would have been the first to drop out.

**What the fork adds.**

- `packages/core/src/runtime.ts` (`summarizeMessages`): an earlier summary is carried forward whole;
  time stamps are kept short ("[Wed 14 Oct, 12:27]"); over 6,000 characters the oldest highlights go.
- `packages/core/src/memory.ts` (`digest`): the start and the newest end of `MEMORY.md` when it is long.
- `packages/server/src/memory-pass.ts`: the nightly notes. At 03:30 in the owner's timezone a job that
  runs in code (gate `memory`, never wakes the agent, never texts) checks whether the owner texted since
  the last pass. If so, one model call reads `MEMORY.md` and the owner's own thread since then (and the
  summary of its trimmed part, if it was trimmed since) and writes `MEMORY.md` back, in sections: About,
  People, Preferences, Lately. The model decides what a friend would remember; the code checks the
  answer: under 2,400 characters (the part of the digest shown in full; one retry with the reason), a
  rewrite under 40% of a longer file is refused as a loss, seven backups in `memory/backups/`, every run
  in `memory-pass.json` and the audit log (`memoryPass`). A refused or failed night reads the same
  conversation again the next night.
- `packages/core/src/core-tools.ts`: `schedule_list` leaves out jobs that run in code (keeping up with
  the news, the memory notes) and `schedule_delete` will not remove them: they are not the owner's
  reminders.
- `packages/server/src/watcher-writer.ts`: `ownerThreadEntries`, the owner's thread as entries, shared by
  the news writer and the notes.

**Why at night.** The notes are in every message's prompt. Changed by day, the next message pays for
the whole prompt again (`[sunshine:stable-cache]`); at 03:30 the cache has long gone cold and nobody waits.

**Cost.** One call on nights after the owner texted, none otherwise: about 1-3 cents with Sonnet 5.5,
at most about $0.30-0.60 per owner per month. The notes in the prompt stay under the digest's cap.

**Privacy.** The Preferences section is what partners and family may see (`preferencesDigest`), so the
notes keep private things out of it. Only the owner's own thread is read.

**Settings.** `MEMORY_PASS_MODEL` picks the model; `off` switches the notes off and removes their job.
Without a key for the model there is no job either.

**Known limits.** On a very busy day, messages trimmed before the night reach the notes only as summary
highlights (200 characters each).

**To remove.** `MEMORY_PASS_MODEL=off`, or revert the commit (`git log --grep "sunshine:memory"`) or
delete the tagged blocks in the files above and their tests (`packages/server/test/memory-pass.test.ts`,
`packages/core/test/runtime.test.ts`, `memory.test.ts`, `core-tools.test.ts`).

### `[sunshine:apps]`: Gmail and Calendar through Composio's router, without its code sandbox

**Measured** (2026-10-15, a local boot with the live agent's settings, Anthropic's token counter):
Gmail and Google Calendar in Composio's **direct** mode are 109 tools, about **100,000 tokens on every
message** (nearly six times the whole prompt). **Router** mode is 6 meta tools, about 8,600 tokens, of
which the remote workbench (2,019) and remote bash (406) run code on Composio's servers, which email
and calendar never need.

**What the fork adds.** `LEFT_OUT_TOOLS` in `packages/apps/src/composio.ts`: those two are never
offered. Router mode then adds about **6,200 tokens** a message (search 2,613, run 1,698, connections
915, tool schemas 534, apps_list and guidance). The agent runs with `COMPOSIO_MODE=router` and
`COMPOSIO_TOOLKITS=gmail,googlecalendar` (Maritime settings), so apps are the owner's only.

**Loaded only when needed** since `[sunshine:tool-loader]`: the router's tools come with `load_tools`
("apps") instead of riding along with every message.

**To remove.** Delete `LEFT_OUT_TOOLS` and its filter in `tools()`, and the test next to it.

### `[sunshine:prune]`: old tool results are removed once their turn is over

**Problem** (measured live 2026-10-15, a Gmail and Calendar test). Six requests in seven minutes grew the
owner's history from 35k to 72k tokens: every email list and tool search (10,000-21,000 characters each)
stayed in the history and was sent again with every later message. Tool results were 59% of it, nearly
all in the 9 results over 2,000 characters. A message after a pause would have cost about 18 cents.

**What the fork adds** (copied from OpenClaw's session pruning, `contextPruning.mode: "cache-ttl"`).

- `pruneToolResults` (`packages/core/src/runtime.ts`): every tool result before the last turn that is
  longer than 2,000 characters (`PRUNE_MIN_CHARS`), or holds an image, is replaced by `PRUNED_RESULT`:
  "[Removed from the history later, to save space. You had the full result when you used it. Run the
  tool again if you need the details.]". The call, its id and its place stay, so the history stays valid
  for the API; running it again changes nothing. Conversation text is never touched, and nothing else
  reads old results (the memory notes and the news writer read only messages and replies).
- **Why nothing of the result is kept** (`packages/server/scenarios/prune.mjs`, 2026-10-15). A first
  version kept the first 600 characters and "N more characters left out". With the real model the answers
  stayed right, but beside a partial start its own detailed reply looked unsupported: it looked the emails
  up again and told the owner "I wrote it from a result that had been cut off, so I should have
  re-checked" and "my first summary went out when I'd only seen part of your inbox" (2 to 3 of 3 runs;
  rewording the note alone did not stop it). Removed whole, as OpenClaw's hard clear and Anthropic's own
  clearing do, 3 of 3 runs answered from its own earlier reply with no self-doubt and nothing made up.
  A follow-up that needs a detail only in the removed result (the J. Cole order number, in none of the
  first summaries): 3 of 3 runs looked the emails up again and answered right, with no self-doubt and
  nothing made up.
- The last turn (from the message that began the last model run) stays whole, so "reply to the second
  one" still finds what was just looked up. A reminder's note and copy added since do not move it.
- **When:** at the start of a message, only if the start of the prompt is paid in full anyway: the history
  was just folded, or the last model call in this conversation is at least 5 minutes ago (Anthropic's
  cache lifetime, `PROMPT_CACHE_MS`; one hour when `PI_CACHE_RETENTION=long`, passed by `boot.ts` as
  `promptCacheMs`). Between messages a few minutes apart nothing changes, so the cache keeps being read.
  OpenClaw's other route, Anthropic's server-side clearing, was not used: its docs say clearing
  invalidates the cache from the first cleared result, every time it clears.
- The history is saved without them, so later calls start from the same text. Each pruning leaves an audit
  entry (`policy`, `prunedToolResults`, `prunedChars`).
- Off switch: `config.features.pruneToolResults = false`.

**Expected effect.** In the measured history about 83,000 of 92,600 tool-result characters go (about
20,000 tokens): a message after a pause from about 18 cents to about 10. Chat without tools barely changes.
In the scenario the first call after the pause carried 5,500 tokens instead of 12,500.

**Tests** (`packages/core/test/runtime.test.ts`, "prune old tool results"): warm cache leaves everything;
lapsed cache removes all but the last turn and saves it; a fold removes even while warm; the one-hour
cache and the off switch; small results untouched, old screenshots removed, the same result on a second
pass; reminder copies do not count as model calls. Real model: `node scenarios/prune.mjs [on|off|both]
[rounds]` (about 6 cents for the first round, about 2 for each further one).

**To remove.** Set `features.pruneToolResults` to false, or revert the commit
(`git log --grep "sunshine:prune"`) or delete the tagged blocks in `runtime.ts`, `types.ts`, `boot.ts`
and the tests.

### `[sunshine:onboarding]`: a short welcome on a new owner's first text

**Problem** (2026-10-15/16). Upstream's welcome skill was an eight-step checklist (name, city, texting
style, news, apps, partner, family, morning text) that began by asking for the name signup already
gave. And it never ran: tested with the real model and a new friend's exact prompt
(`packages/server/scenarios/onboarding.mjs`), Sonnet never opened it, because nothing says a text is
someone's first ("Hej!" with no history looks like any other). Without it the first reply was a bare
"Vad kan jag hjälpa dig med?", and it never asked what news to follow, so the news stayed idle.

**What the fork adds.**

- `skills/onboarding/SKILL.md` rewritten as principles: greet by name and do not ask what signup gave;
  one short opening text (who you are, a couple of things you can do, one question, usually what to
  follow); one question per text; two or three exchanges, then something useful or "text me whenever";
  stop when they are busy; their language; everything else (style, quiet hours, people, apps, a morning
  text) when it comes up. Apps only when set up.
- `welcomeIfFirstText` (`packages/core/src/runtime.ts`): on the owner's very first text in their own
  text thread (nothing in it yet, no facts in `MEMORY.md`), a note goes in front of it: "[Not a message
  from <owner>: they signed up a moment ago, and the next message is their first text to you. How to
  welcome them:]" and the skill's instructions. In the delivery mirror's form, so the news writer and
  the memory notes treat it as a note. Once: afterwards the thread is not empty; saved with the thread,
  so a restart does not repeat it. Audit entry `policy` `firstContact`. Not for the dashboard chat, groups,
  or an owner with saved facts (existing agents never see it). OpenClaw passes its first-run ritual
  (BOOTSTRAP.md) with the first message for the same reason: models do not reliably open it themselves.
- `RuntimeDeps.firstContactGuide`, filled by `boot.ts` with `skillGuide(skills, "onboarding")`
  (`packages/server/src/skills.ts`: the skill without its header and comments).

**Tested with the real model** (2026-10-16, $0.087): a curious Swede writing Swedish and a busy one
opening in English, the friend played by Haiku. Both opened with hello by name, who Sunshine is, what it
does and one question (what to follow); no name or timezone questions, one question per text, Swedish
throughout for the Swede; it saved her interests and memory and set two correct reminders for her
Lisbon flight in three texts; the busy one got "No problem, Åsa. Text me whenever something comes up."
The opening follows the skill's example almost word for word, so that example is the welcome's wording.

**To remove.** Revert the commits (`git log --grep "sunshine:onboarding"`) or delete the tagged blocks
in `runtime.ts`, `boot.ts`, `skills.ts` and their tests; restore upstream's `skills/onboarding/SKILL.md`.

### `[sunshine:history]`: the owner's conversations stay searchable after a trim

**Problem** (seen live 2026-10-16). Upstream folds older messages into a short summary and deletes
them from disk. The owner's agent could see whole messages back to the day before, 200-character
highlights for one more day, and nothing older: what was said on the first days survived only as the
few facts in `MEMORY.md`. The nightly notes had the same gap on busy days (only the highlights of
what a trim removed). OpenClaw keeps transcripts searchable (`memory_search`).

**What the fork adds.**

- `HistoryArchive` (`packages/core/src/history.ts`): each time an owner thread (their own iMessage/SMS
  threads and the dashboard chat) is saved, its conversation is added to `history/owner.jsonl`: the
  owner's texts, the agent's replies, and the runtime's notes (kept to 300 characters), with the time;
  each message once. Not kept: tool calls and results (they can be fetched again), trim summaries,
  other people's threads. Entries older than 365 days (`HISTORY_KEEP_DAYS`) are dropped.
- Two owner-only tools (`packages/core/src/core-tools.ts`, capability `memory.write`):
  `history_search` (words, optional days in the owner's timezone; newest first, each with the answer
  that followed; dated, "things may have changed since") and `history_forget` (lists what contains the
  words, removes it on `confirm`; removed messages are remembered by fingerprint in
  `history/forgotten.json`, no text, so the live thread cannot write them back).
- The nightly notes (`packages/server/src/memory-pass.ts`) read the whole day from the archive, merged
  with the live thread; the trim summary is used only where the archive does not reach back.
- Off switch: `config.features.history = false` (no archive, no tools).

**Cost.** The two tools add about 246 tokens to every message (measured with Anthropic's token count),
about $0.08 per owner per month; a search is one extra model call when the past is asked about. Storage
is text on the agent's disk, about 1 MB a month.

**Tested.** Unit tests (`packages/core/test/history.test.ts`, the "kept history" test in
`runtime.test.ts`, `memory-pass.test.ts`): kept once, stamps dropped, notes short, no tool traffic;
words in any order, newest first, a reply shown under its question; days in the owner's zone; forget
lists then removes and never re-adds; the age limit; a fold removes a message from view but search finds
it; other people's threads not kept; the notes read whole messages from the archive. Real model
(`packages/server/scenarios/history.mjs`, $0.027): with nothing in view, it searched and answered "Your
bike lock code is 4471. You told me on Monday."; reproduced Thursday's four fund-vs-apartment points;
for a birthday never mentioned it searched twice and said it could not find it, without inventing one.

**To remove.** `features.history = false`, or revert the commit (`git log --grep "sunshine:history"`)
or delete `history.ts`, its tools and the tagged blocks in `runtime.ts`, `types.ts`, `index.ts`,
`boot.ts`, `memory-pass.ts`, `watcher-writer.ts` and the tests.

### `[sunshine:tool-loader]`: email, desktop, file and people tools load when a request needs them

**Problem** (measured 2026-10-16, a local boot with the live agent's settings, Anthropic's token
counter). Every message carried 23,700 tokens before the conversation: 5,700 of instructions and 51
tools (18,000). Most of the tools are for things most messages never touch: Gmail and Calendar through
Composio's router (6,000), the desktop (2,900, plus 350 of instructions), files and shell (2,100),
contacts, trust and other people's assistants (2,600). They are paid again on every message after a
pause and on every scheduled run.

**What the fork adds** (Pi's mid-conversation tool changes, which Sonnet 5.5 supports).

- `packages/core/src/tool-loader.ts`: four loadable groups by `meta.group` (`apps`; `computer`;
  `files`; `people` = `contacts` + `network`) and the `load_tools` tool, which lists them with one line
  each. The owner's conversations start without those groups; `load_tools` adds one, and its result
  carries the group's guidance (the desktop and apps text that `boot.ts` otherwise puts in every
  prompt).
- `packages/core/src/runtime.ts`:
  - `bindTools` gives the owner's own conversations the base tools, `load_tools` and the loaded groups;
    everyone else sees what policy allows, as before.
  - `loadToolGroups` marks a group loaded, and `prepareNextTurnWithContext` hands the new list to the
    next model call. Pi then announces the added tools in a system message after the load (a
    `tool_addition` block), so the tool list and instructions at the start stay as they were and the
    cache is read back.
  - `applySystemPrompt` builds the opening from the base tools only and keeps those announcements in
    place. Before, it rebuilt the opening from the current tool list and threw the announcements away,
    so every message after a load would have paid for the whole prompt again.
  - `foldInSteps` keeps announcements where they are. Before, it moved every system message to the
    front before each request, which would have put them ahead of the whole history and broken the
    cache. In a fold they stay in place, or go right after the summary if what followed them was
    folded away, so a fold in the middle of a desktop session does not take the tools away.
  - `unloadIfPaidAnyway` drops the loaded groups and their announcements at the moments
    `[sunshine:prune]` uses: the cache has lapsed (5 minutes after the last model call, an hour with
    `PI_CACHE_RETENTION=long`) or the history was folded. The start is paid in full then anyway. A
    restart starts from the base list too (announcements are not saved). The calls made with a dropped
    group stay in the history; Anthropic accepts tools that are no longer declared there.
  - `systemPromptFor` lists capabilities and tool groups from everything the person may use, loaded or
    not, so a load never changes the prompt.
  - Audit `policy` entries: `toolsLoaded`, `toolsUnloaded`.
- `packages/server/src/boot.ts`: with the loader on, the desktop and apps guidance go to the loader
  instead of the prompt.
- Off switch: `config.features.toolLoader = false`. It also needs `stableCache`; without it the
  prompt changes every run anyway.

**Measured** (free). The owner's thread: 23,703 tokens before the conversation, now 9,813 (instructions
5,013, 23 tools 4,800, of which `load_tools` is 414). About $3.90 per owner per month with email,
about $2.10 for a friend without email (each 1,000 tokens is about $0.28 per user per month).

**Checked without a model run.**
- Pi's own Anthropic requests for a conversation that loads the file tools mid-reply (scratchpad
  `loader-wire2.mjs`, built by Pi and stopped before sending): the same tool list and system in all 5
  requests, each request only adding to the one before, the `tool_addition` blocks right after the
  load's result, and every request accepted by Anthropic's token counter.
- A history using a tool no longer declared, and a `tool_removal`, are accepted too.

**Tests** (`packages/core/test/runtime.test.ts`, "tools loaded when needed"):
- the opening leaves the groups out and never changes across messages and loads; every request only
  adds to the one before;
- a warm second message keeps the group, and a cold one drops it;
- a restart starts from the base list;
- "already loaded";
- other people's conversations are unchanged, and the switch and stableCache-off restore everything;
- a fold keeps the announcements.

Two checks were made by putting the old behaviour back on purpose: the tests fail for both traps. The
smoke test loads `files` before making its PDF.

**Real model** (`packages/server/scenarios/tool-loader.mjs`, 18 requests each in a thread of its own,
canned tool answers, 2026-10-16, $0.36 a round).
- Every request that needed a group loaded the right one first (12 of 12: inbox, calendar, an email to
  Martin, moving an appointment, a web form, a screenshot, a PDF, saved files, saving a contact, what
  Sanna may see, asking Sanna's assistant, the contact list). Every request that needed none loaded
  nothing (6 of 6: a sum, a reminder, weather, "thanks", last week's question, XRP news).
- No reply mentioned loading. The two replies with "can't" were about the scripted data, not about
  loading: a calendar answer dated the 23rd on Friday the 16th, and a trust list without the tier's
  details.
- The cache held. Each thread's first call read the shared start (about 10,000 tokens). The call after
  a load read it again and wrote only the added tools (6,500 for apps, 3,400 desktop, 2,200 files,
  2,750 people), and the calls after that read everything back.
- Requests that needed no group cost 0.2 to 0.7 cents; email and calendar ones 3.5 to 5.5 cents.

**To remove.** `features.toolLoader = false`, or revert the commit (`git log --grep "tool-loader"`) or
delete `tool-loader.ts` and the tagged blocks in `runtime.ts`, `tools.ts`, `types.ts`, `index.ts`,
`boot.ts`, `smoke.ts` and the tests.

### `[sunshine:search]`: friends' agents get the web search key

**Problem** (2026-10-16). Sunshine said its searches were failing. Without a key, `web_search`
(`packages/core/src/core-tools.ts`) reads DuckDuckGo's HTML page, and that page stopped answering
requests from the agent's server (each search timed out after about 11 seconds) while it still answered
from a laptop: a block on DuckDuckGo's side, not a code change. Upstream already supports the Brave
Search API: `BRAVE_SEARCH_API_KEY` is mapped to `searchApiKey` in `packages/server/src/boot.ts`. With the
key set, Torstein's agent searched in about a second. Only the gateway did not pass it to new agents.

**Why Brave.** It runs its own index and sells access to it. Cheaper providers such as Serper resell
results scraped from Google, which Google is contesting in court (Google v. SerpApi, 2025-), so that
route could break the same way. About $5 per 1,000 searches, with a monthly credit that covers a few
users. With the key, search uses Brave only (no DuckDuckGo fallback; it is blocked from Maritime anyway).

**What the fork adds.** `BRAVE_SEARCH_API_KEY` in `AGENT_SETTINGS` (`packages/gateway/src/main.ts`):
when it is set on the gateway, every new agent gets it, as a secret (its name ends in `KEY`). Agents
created before keep what they had: add it with `agent-env.sh set-secret` or Maritime's dashboard and
restart them.

**To remove.** Delete the name from `AGENT_SETTINGS` and the tagged test in
`packages/gateway/test/main.test.ts`, or unset the variable on the gateway.

### Long replies (investigated 2026-10-15, nothing changed)

A money question ("what should be considered: fund vs apartment") got a 1,435-character, seven-point
reply although the persona and the iMessage line ask for short texts. `packages/server/scenarios/texting.mjs`
plays 17 questions through the exact live prompt (boots the server; about 30 cents a run). Three
wordings of the iMessage line (upstream's, a principle, real example replies with the reason) and a
prompt with only the everyday tools all landed in the same range (advice answers 712-828 characters on
average, lists in 6-12 of 22), so neither the wording nor the tool list is the lever. Detail requests
were answered in full and the main risk kept in every version. Upstream's line stays. Untested: the
skills list, memory (`[sunshine:memory]`), the thinking level.

## Upstream merges

### 2026-10-15: upstream up to `9d262da`

**What came in** (9 commits, none fixing what the fork fixes): approvals in the owner's own words
(`approval_settle`, no tokens or "Reply YES or NO" in texts), `image_generate` (needs `IMAGE_API_KEY` or
`OPENAI_API_KEY`; without one it says it is not set up), `system.task` envelopes (an operator-started
task, `runSystemTask`, nothing sends them here yet), `INSTINCT_INSTRUCTIONS` seeding `AGENTS.md`, an
apps hint after a connect link, a blocked-merchant fix, Windows fixes.

**Collisions,** all both sides adding in the same place, resolved by keeping both: one import line in
`core-tools.ts`; the run flags on `Conversation` and the place where the fork's two audit helpers meet
`runSystemTask` in `runtime.ts`; the end of `runtime.test.ts`.

**Fitted to the fork.** `runSystemTask` texted its final reply straight to the owner, past the
`[sunshine:silent-reply]` and `[sunshine:reply-guard]` checks, and a `system:` conversation did not count
the owner as its audience. Both now behave as a scheduled job (tagged blocks in `runtime.ts`, two tests).

**Checked after the merge.** All tests (1,148) and the smoke test; real-model scenarios: reminders 14/14,
the cache read on every message after the first, the mirror (answers "what's Sanna?" on, not off),
tapbacks (misses only the known English "Loved “…”" text and the flaky "you're hilarious"), voice
(no machinery talk in 4 of 4). Approvals now add a section to the system prompt while one is pending,
which costs one cache write when it appears and when it goes.

## Earlier changes (tagged afterwards, 2026-10-15)

The fork's first changes were made before tagging started. Their code and tests now carry tags too,
so the same search finds them. Ordered from most to least likely to cause trouble. `git show
<commit>` shows a change in full; `git revert <commit>` undoes it (later commits build on some of
them, so a revert may need small fixes by hand). JSON files (`package.json`, the lockfile) and the
docs cannot carry a comment; they are listed under each change instead.

### `[sunshine:phone]`: phone numbers outside the US (`80b36b5`, `parsePhone` in `f5edfbb`)
- **What:** adds the `libphonenumber-js` library (pinned 1.13.14) and replaces the old rule that
  read any ten-digit number as American. Numbers written the local way are read as the owner's
  country. The three copies of the phone rule now share one function.
- **Where:** `packages/core/src/principal.ts` (`normalizePhone`, `parsePhone`, `phoneCountryOf`),
  `core/src/contacts.ts`, `core/src/config.ts`, `core/src/runtime.ts` (group threads),
  `network/src/lookup.ts`, `inkbox/src/tools.ts`, `server/src/boot.ts`, `cli/src/commands/invite.ts`;
  untagged: `packages/core/package.json` and `pnpm-lock.yaml` (the library).
- **If it breaks:** the owner or a contact is treated as a stranger, or a text goes to a wrong number.

### `[sunshine:signup]`: country picker, picked handles, repeat signups (`f5edfbb`, `ba288a7`)
- **What:** the country picker (`GATEWAY_DEFAULT_COUNTRY`); handles like `sunshine-anna-k3f9` picked
  by the gateway (`GATEWAY_HANDLE_PREFIX`); a repeat signup recognized by phone alone (restarts a
  failed setup, reveals nothing about the record).
- **Where:** `packages/gateway/src/validate.ts`, `gateway/src/server.ts`, `gateway/src/main.ts`,
  the form in `gateway/src/pages.ts`.
- **If it breaks:** friends cannot sign up, see "does not look like a phone number", get a second
  agent, or stay at "Setting up".

### `[sunshine:gateway-settings]`: settings for new agents (`ba288a7`)
- **What:** `GATEWAY_BRAND_NAME`, `INSTINCT_AGENT_DESKTOP`, `INSTINCT_MODEL`. New agents get the brand
  as their name (Inkbox display name, `INSTINCT_AGENT_NAME`, Maritime persona), the chosen model, and
  the desktop setting; every page shows the brand.
- **Where:** `packages/gateway/src/brand.ts` (whole file), `gateway/src/main.ts`,
  `gateway/src/provision.ts`, `gateway/src/server.ts`, `gateway/src/pages.ts`.
- **If it breaks:** new agents fail to be created at Maritime, or run the wrong model or name.

### `[sunshine:schedule-list]`: finished reminders read as done (`704d137`)
- **What:** finished one-time jobs read "done, already sent at ...". Only the list text changed.
- **Where:** `packages/core/src/core-tools.ts` (`schedule_list`).
- **If it breaks:** the agent misreads its reminders. Low risk.

### `[sunshine:contact-card]`: "save to contacts", switched off (`08d5728`, `f82b1bd`)
- **What:** a "save to contacts" step with a sun picture. Off unless `GATEWAY_AGENT_NUMBER` is set.
- **Where:** `packages/gateway/src/contact.ts` (whole file), the `/connect/:id/contact.vcf` route in
  `gateway/src/server.ts`, `GATEWAY_AGENT_NUMBER` in `gateway/src/main.ts`, the save step in
  `gateway/src/pages.ts`.
- **If it breaks:** nothing while it is off.

### `[sunshine:design]`: the page design (`ba288a7`, `08d5728`, `f82b1bd`)
- **What:** minimal signup and connect pages, always dark, top-left sunlight, sun mark,
  animations (off with Reduce Motion), flags, one "Connect to Sunshine" button.
- **Where:** `packages/gateway/src/pages.ts`: the fork rewrote most of the file, so a note at its top
  says which parts are upstream's (the URL and router helpers) and the rest is tagged by block.
- **If it breaks:** only how the two web pages look or behave; the agent is not affected.

### Docs (untagged)
- Gateway README, `docs/ARCHITECTURE.md`, `docs/DEPLOY-MARITIME.md`, this file. No effect on behavior.

## Outside the code

- **Railway** runs the gateway image `ghcr.io/torsteinvestre/open-instinct-gateway:latest`; its
  variables set the brand, prefix, country, model, invite code and keys. `INSTINCT_AGENT_IMAGE`
  decides which agent version new signups get.
- **Maritime** agents run `ghcr.io/torsteinvestre/open-instinct-agent:latest`. Existing agents
  keep their version until redeployed (`POST /api/deploy`, source `docker`); `/data` survives.
- **GitHub Actions** rebuild both images on every push to this fork's `main`.

## Known upstream issues not fixed here yet

- `instinct dev --tunnel` logs a harmless "409 already delivers" when restarted.
