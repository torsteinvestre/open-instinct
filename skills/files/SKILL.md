---
name: files
description: Create and share documents, spreadsheets, PDFs and notes. Use when the owner asks for a doc, a spreadsheet, a budget, a list, a letter, slides, a CSV, a PDF, or to write something down, or says "send me that as a PDF". Plain markdown and CSV go straight into the workspace; PDFs come from create_pdf; Word, Excel and PowerPoint formats are made with LibreOffice on the desktop. Files are sent as real attachments with send_file.
---

# Files

Three ways to make things:

- The workspace (`workspace/` under the data directory, `/data/workspace` on
  Maritime). Use the `write`, `edit`, `read`, `ls` and `bash` tools. Good for
  markdown, CSV, JSON, plain text and small scripts.
- `create_pdf`, for anything the owner wants to read on a phone, print, or
  forward: briefs, letters, itineraries, summaries. Markdown in, a real PDF in
  the workspace out. No desktop needed.
- The desktop, when the owner needs a real office format (.docx, .xlsx, .pptx)
  or wants to open it in Word or Excel later. LibreOffice Writer, Calc and
  Impress are installed. See skill `maritime-computer`.

Pick the simplest format that does the job. A packing list is a text message
or a markdown file, not a spreadsheet.

## Layout

```
workspace/
  notes/        quick notes, lists, meeting notes (markdown)
  docs/         letters, memos, drafts (markdown or docx)
  sheets/       budgets, trackers (csv or xlsx)
  research/     research briefs (see skill research)
  travel/       confirmations and itineraries
  email/        screenshots and records from email cleanup
  shared/       anything the owner asked to send to someone
```

Name files `yyyy-mm-dd-slug.ext`. Never overwrite a file the owner may have
edited; write a new version with `-v2`.

## Markdown and CSV

1. Draft the content. Keep headings plain and short.
2. `write` to the path. For CSV, quote fields with commas, use a header row,
   ISO dates.
3. `read` it back once if it is longer than a screen. Fix typos.
4. Share: `send_message` with a two-line summary and the path. If the owner
   asks for the text itself, paste it in plain prose without markdown marks.

## PDFs

1. Write the content as markdown: a `#` title, `##` sections, short
   paragraphs, bullet or numbered lists, a pipe table for numbers, a fenced
   block for anything verbatim. Bold and links render; keep it simple.
2. `create_pdf` with `path` (`docs/2026-10-03-landlord-heating.pdf`), the
   markdown, and a `title`. It returns the absolute path, size and page count.
3. `send_file` with that path. No `to` sends it in the current conversation:
   an iMessage attachment, an email attachment, or a dashboard attachment.
   Give a one-line `caption`: "Here is the brief as a PDF."
4. Anything over a few pages, or over a few MB, goes by email: `send_file`
   with `channel: "email"` (and `to: "owner"` when the owner is on iMessage),
   plus a `subject`. Say so in the text: "Emailed you the full version, 9 pages."

When the owner already has a markdown file and asks for it as a PDF, `read`
it, pass the text to `create_pdf` next to the original (same name, `.pdf`),
then `send_file`.

## Office formats with LibreOffice

1. Fastest path: write the content as markdown or CSV first, then convert on
   the desktop with `run_shell`:
   `soffice --headless --convert-to docx --outdir /data/workspace/docs /data/workspace/docs/2026-10-03-letter.md`
   For spreadsheets convert a CSV to xlsx the same way. This avoids clicking.
2. If formatting matters (a letterhead, a slide layout), open LibreOffice from
   the panel Menu on the desktop, build the document with the screenshot, act,
   verify loop, and Save As into `/data/workspace/<folder>/`. Verify the saved
   file exists with `ls` or `run_shell ls`.
3. On a hosted computer (not the in-VM desktop), the desktop's filesystem is not
   the workspace. Use the computer `read_file` tool to pull the finished file
   and `write` it into the workspace, or do the reverse with `write_file`.

## Sharing

- To the owner: `send_file` with the path and a one-line caption. It attaches
  the file on iMessage (up to 10 MB), SMS, email, or the dashboard. Bigger
  files go by email. Follow with a two-line summary in `send_message` if the
  file needs context.
- To someone else: only when the owner asks. `send_file` with `to` set to the
  contact, number or address, `channel: "email"` for documents, and a
  `subject`. Copy what was shared into `workspace/shared/` and
  `journal_append` who got what.
- Never share files from `inbox/` (what the owner sent you) with anyone but
  the owner.

## Voice

Agent: Done. Your October budget is at workspace/sheets/2026-10-03-october-
budget.csv, 24 lines, income at the top, fixed costs, then variable. Totals
match the numbers you gave me, $4,180 in and $3,655 out. Want it as an Excel
file too?

Agent: The landlord letter is drafted at workspace/docs/2026-10-03-landlord-
heating.md. Three short paragraphs, firm but polite, asks for a repair date
within 7 days. Want me to read it to you, or send it as a PDF?

Owner: send me that as a PDF

Agent: (create_pdf, then send_file with the caption) Here is the letter as a
PDF.

## Do not

- Do not write outside `workspace/`.
- Do not create files for a non-owner principal; `files.write` is owner only.
- Do not send a file to anyone the owner did not name.
- Do not paste a long document into a text when the owner asked for a file;
  make the PDF and send it.

## Images and picture books

`image_generate` makes a PNG from a prompt and saves it in the workspace; the
key it uses lives in your environment and is never visible to you or your
shell, which is fine. For an art book or anything illustrated: generate each
image with a clear prompt (subject, style, mood, composition), then `create_pdf`
with a line `![caption](art/ship-01.png)` where each picture goes, then
`send_file`. Keep prompts varied across a set so the pages don't repeat. If the
tool answers that image generation is not set up, say so in one line and offer
the text-only version; never say you cannot use API keys.
