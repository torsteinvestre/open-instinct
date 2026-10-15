---
name: purchases
description: Buy things for the owner within the spend policy. Use when the owner asks to order, buy, reorder, or find the best price for a product, or when a trusted person asks for a purchase on the owner's behalf. Compare prices, build the cart, stop before payment for a takeover, get approval above the spend threshold, and record the spend.
---

# Purchases

Money moves here, so the policy guard is strict. Read the spend policy
(`perActionUsd`, `perDayUsd`, `askAbove`, `neverWithoutAsk`, merchant lists)
as the rules you work within. When unsure, ask.

## Gather

What exactly, quantity, acceptable substitutes, delivery deadline, budget,
preferred merchants from memory (`memory_read`). Reorders: check the journal
and memory for the last order and offer to repeat it.

## Compare

1. `web_search` the product plus "price". `web_fetch` two or three merchant
   pages. Prefer merchants the owner has used (memory) and `allowedMerchants`.
   Skip `blockedMerchants` without comment unless asked.
2. Record for each: price, shipping, tax if shown, delivery date, return
   policy. The number you report is the total to the door.
3. Text the owner the best two in one message, lead with the total, say the
   trade-off, recommend one.

Agent: Two options for the Anker 737 power bank. Amazon $89.99 with free
delivery Thursday, easy returns. Anker direct $79.99 with code, ships in 5 to 7
days. I'd go Amazon for Thursday unless the ten dollars matters. Which?

## Approval

- Total under `askAbove` and the owner asked for the purchase in this
  conversation: proceed, then report.
- Total at or above `askAbove`, or the item falls under `neverWithoutAsk`, or
  the requester is not the owner: `ask_owner` with merchant, item, total and
  delivery date. "Buy the Anker 737 from Amazon, $89.99 total, arrives Thu?
  Go ahead?" Wait. No answer means no.
- Over `perActionUsd` or past `perDayUsd` for today: tell the owner the limit
  and stop. The owner can raise it in words; that is a policy change the server
  records, not something you do silently.

## Checkout

1. Open the merchant on the desktop (skill `maritime-computer`). Add the exact
   item and quantity. Verify the cart line by zooming on price and quantity.
2. Proceed to checkout. If a login is needed, `request_takeover` with reason
   "Log in to Amazon for the Anker order".
3. Fill shipping from memory only if the owner stored an address and said you
   may use it. Confirm the address on screen.
4. Stop at the payment step every time. `request_takeover` with reason "Enter
   payment and place the Anker 737 order, $89.99". The owner places the order.
   If the takeover returns `success: false`, do not retry; tell the owner.
5. Read the confirmation page. Zoom on order number and total.

## Record

- The approval you obtained is what the audit uses for spend. In addition,
  `journal_append` one line: date, merchant, item, total, order number.
- `memory_write` any new stable fact: a preferred merchant, a size, a brand to
  avoid.
- Text the owner: what, where, total, delivery date, order number.

## For other people

A partner asking for a purchase ("order Maria more coffee pods") is `purchase`
at `ask`: build the comparison, then the approval goes to the owner, not the
requester. Tell the requester you are checking. Family, friends and contacts
cannot trigger purchases at all; decline kindly and offer to pass the message.

## Do not

- Do not enter card numbers, CVVs or gift card codes. Ever.
- Do not change saved payment methods or addresses on a merchant account.
- Do not place an order when the total differs from what the owner approved.
- Do not split one purchase into several to stay under a limit.
