# Launch kit

Copy, paste, post. Attach `docs/assets/brand/wordmark.png` or `docs/assets/screenshots/imessage-mock.png`
to every post; the architecture drawing (`docs/assets/brand/architecture.png`) works as a second image.
Repo: https://github.com/mariagorskikh/open-instinct

## Before you post (10 minutes)

1. Live test from your own phone: `pnpm instinct dev --tunnel`, then text `connect @<your-handle>` to the
   router number `pnpm instinct connect` prints. Ask it to remember something, then ask it back.
2. Tag the release so the images get a version: `git tag v0.1.0 && git push origin v0.1.0`.
3. In the GitHub repo settings, set the social preview image to `docs/assets/brand/wordmark.png`.
4. Pin the repo on your profile.

## One-line description

Open Instinct: an open-source personal agent you text. Its own computer, a trusted network of other agents, and a permission table you can read.

## X: single post

Instinct just raised $1B for a personal agent you text.

We think the future is many specialized agents, not one. So we built the open-source version: a personal agent you text on iMessage, with its own computer and a trusted network of other agents.

MIT. Fork it. github.com/mariagorskikh/open-instinct

## X: thread

1/ Instinct raised $1B for a personal agent you text. It is closed and invite-only.

We open-sourced the whole thing. Open Instinct: a personal agent you text on iMessage, with its own computer and a trusted network of other agents.

github.com/mariagorskikh/open-instinct

2/ How it works, in one picture. You text a number. Inkbox gives the agent that number, an email and an agent-to-agent endpoint. A small gateway wakes your agent, which lives in its own microVM on Maritime with a Linux desktop.

3/ The part Instinct got right: agents coordinating with other people's agents. Yours can ask your partner's agent for free evenings, propose three slots, and book once you say yes. Four messages, not forty.

4/ The part we made visible: who gets which key. Six trust tiers, enforced in code before any tool runs. Partner can read your calendar. Friend can only ask when you are free. Stranger gets a polite no, and you get a text saying who asked.

5/ Stack, all swappable: Pi for the agent loop (the framework OpenClaw grew out of), Inkbox for iMessage and identity, Maritime for hosting and the desktop, Composio for Gmail and Calendar, Stripe Link for one-time cards the owner approves. Any model in Pi's catalog.

6/ Nine packages, 725 tests, Docker images on GHCR, docs for every key you need. Clone, run three commands, text it.

7/ Fork it. Swap Inkbox for Twilio, Maritime for your own VM, Composio for your own MCP servers. Add Uber, add voice, add a new tier. Let's make it the next OpenClaw. MIT.

## LinkedIn

Instinct raised $1B this week for a personal agent you text. It books your dinners, checks you into flights, and talks to your spouse's agent to find a time. It is also closed, invite-only, and keeps your data.

We built the open-source version and published it today: Open Instinct.

What it is: a personal agent you reach on iMessage, SMS or email. It has its own computer (a Linux desktop in a microVM), it remembers, it schedules itself, and it coordinates with the agents of the people you trust.

What we think is the interesting part: trust is explicit. Seven tiers, from owner to stranger, decide what each person's agent may ask yours. Your partner's agent can read your calendar. A friend's can only ask when you are free. A request outside the tier gets a polite no, and you get a one-line text saying who asked for what. The table is a file with tests, not a promise.

How it is built: Pi for the agent loop, Inkbox for iMessage and identity, Maritime for hosting and the desktop, Composio for Gmail and Calendar, Stripe Link for payments the owner approves one card at a time. Every service sits behind one small package, so you can swap any of them.

Why open: Instinct is one company's view of a very personal product. We see a world of many specialized agents, run by the people who use them. Fork it, point it at your own services, and build the version your users need.

Nine packages, 725 tests, Docker images, and a guide for every key. MIT license.

github.com/mariagorskikh/open-instinct

## Show HN

Title: Show HN: Open Instinct, an open-source personal agent you text

Text:

Hi HN, Maria here. Instinct raised a billion dollars this week for a personal agent you text. It is a lovely product. It is also closed, invite-only, and it keeps your data. Grok Bot, Meta's Muse and Dots are heading the same way: one company, one agent, your whole life inside it.

I think the better future is many agents, run by the people who use them and built by a community that can read every line. So we built the open-source version and we are putting it out today.

What it is: a personal agent you reach on iMessage, SMS or email. It has its own computer (a Linux desktop in a microVM), it remembers, it schedules itself, and it coordinates with the agents of the people you trust. Your partner's agent can read your calendar. A friend's can only ask when you are free. A stranger gets a polite no, and you get a text saying who asked. The trust table is a file with tests, not a promise.

How it is built: Pi for the agent loop (the framework OpenClaw grew out of), Inkbox for the iMessage line and the agent's identity, Maritime for hosting and the desktop, Composio for Gmail and Calendar, Stripe Link for one-time cards you approve. Every service sits behind one small package, so you can swap any of them for Twilio, Telegram, your own VM, your own MCP servers. Any model in Pi's catalog.

Honest caveats: the live iMessage path and the Maritime deploy are beta, tested by hand rather than by CI. Rides, food and reservations go through the agent's own browser with a human takeover for logins and payment. Payments need a Stripe Link OAuth client, which Stripe grants by application.

It is MIT. Fork it, point it at your own services, add a channel, add a tier, add voice. Let me know what you think, tell me what is wrong, and let's build on top of it together. A personal agent should be something everyone can own.

https://github.com/mariagorskikh/open-instinct

## Honest caveats to keep handy

- Live iMessage and Maritime deploys were exercised against real identities during development, but there is no automated test for them. Say "beta" for those two.
- Uber, food delivery and reservations run through the agent's desktop browser with a human takeover for logins and payment. There is no Uber API integration.
- Payments need a Stripe Link OAuth client, which Stripe grants by application.
