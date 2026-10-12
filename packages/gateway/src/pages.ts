import { type Brand, DEFAULT_BRAND } from "./brand.js";
import type { UserRecord } from "./store.js";
import { DEFAULT_SIGNUP_COUNTRY, OTHER_COUNTRY, SIGNUP_COUNTRIES } from "./validate.js";

/** What every page needs to know about the deployment. */
export interface PageOptions {
  /** Unset shows Open Instinct. */
  brand?: Brand;
}

export const GITHUB_URL = "https://github.com/mariagorskikh/open-instinct";

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

/** Only allow data: PNG urls and plain https links into attributes. */
export function safeUrl(u: string | undefined, allowData = false): string {
  if (!u) return "";
  if (allowData && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(u)) return u;
  if (/^(https?:|sms:|mailto:)/i.test(u)) return escapeHtml(u);
  return "";
}

// Always dark, whatever the device prefers: the warm light reads best on it. Amber buttons carry dark ink.
// Sunlight comes in from beyond the top-left corner of the screen: a wide glow that fades out across the
// page with no visible edge (a background, so it can never widen the page on a phone). It sits on <html>
// with min-height 100%, so it always fills the window; on a short page, zoomed out, a background sized to
// the content would stop in a hard line. Nothing on the page gives off light; everything is lit from that
// corner, the same way for text as for cards: the color stays, a faint warm tint fades in from the lit
// side, a soft warm haze sits only on the side facing the light, and a faint shadow falls down and to the
// right. A card's border is warm where it faces the light, along the top and left edges, fading out along
// both (a gradient painted under a transparent border). The tint only paints inside the heading's box, so the heading
// gets room below for descenders (the tail of a "g"), taken back from its margin so nothing moves.
const CSS = `
:root{color-scheme:dark;--bg:#14110d;--card:#1c1813;--text:#f6efe6;--muted:#a89c8d;--line:#2c261e;--accent:#fbbf24;--accent-ink:#1f1404;--link:#fbbf24;--bad:#f97066;--code:#262019;--sunlight:rgba(251,191,36,.13);--sunlight-in:rgba(251,191,36,.06);--sunlight-edge:rgba(251,191,36,.26);--sunlit:#fff0d4;--sunlit-haze:rgba(251,191,36,.2);--shade:rgba(0,0,0,.5)}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;min-height:100%;background:radial-gradient(130vmax 95vmax at -12% -18%,var(--sunlight),transparent 62%) no-repeat,var(--bg)}
body{margin:0;color:var(--text);font:16px/1.55 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,Inter,Helvetica,Arial,sans-serif}
h1,.lit{filter:drop-shadow(-1px -1px 3px var(--sunlit-haze)) drop-shadow(1px 2px 2px var(--shade))}
@supports ((-webkit-background-clip:text) or (background-clip:text)){h1,.lit{background:linear-gradient(135deg,var(--sunlit),var(--text) 42%);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}h1{padding-bottom:.15em;margin-bottom:calc(24px - .15em)}}
a{color:var(--link)}
.wrap{max-width:480px;margin:0 auto;padding:40px 20px 56px}
header{margin-bottom:40px}
.brand{font-weight:700;font-size:18px;letter-spacing:-.01em}
.sun{display:inline-block;width:22px;height:22px;margin-right:8px;vertical-align:-5px;animation:turn 40s linear infinite}
.sun-wrap{display:inline-block;filter:drop-shadow(1px 2px 2px var(--shade))}
.sun circle{fill:var(--accent)}
.sun path{fill:none;stroke:var(--accent);stroke-width:2;stroke-linecap:round}
h1{font-size:clamp(28px,7vw,36px);line-height:1.15;letter-spacing:-.02em;margin:0 0 24px}
p{margin:0 0 12px}
.muted{color:var(--muted)}
.card{border:1px solid transparent;border-radius:16px;padding:20px;background:linear-gradient(135deg,var(--sunlight-in),transparent 45%) padding-box,linear-gradient(var(--card),var(--card)) padding-box,linear-gradient(135deg,var(--sunlight-edge),var(--line) 40%) border-box;box-shadow:-8px -6px 26px -16px var(--sunlight-edge),6px 10px 24px -14px var(--shade)}
label{display:block;font-size:14px;font-weight:600;margin:16px 0 6px}
label small{font-weight:400;color:var(--muted)}
input,select{width:100%;font:inherit;padding:12px 14px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--text)}
input:focus,select:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:transparent}
.btn{display:block;width:100%;text-align:center;font:inherit;font-weight:600;padding:14px 18px;border:0;border-radius:12px;background:var(--accent);color:var(--accent-ink);text-decoration:none;cursor:pointer;margin-top:20px;transition:transform .15s ease,box-shadow .15s ease,filter .15s ease}
.btn:hover{transform:translateY(-1px);filter:brightness(1.04);box-shadow:0 8px 18px -10px rgba(245,158,11,.75)}
.btn:active{transform:scale(.98);box-shadow:none}
.btn:focus-visible{outline:2px solid var(--link);outline-offset:2px}.error{background:rgba(180,35,24,.08);border:1px solid rgba(180,35,24,.35);color:var(--bad);border-radius:10px;padding:10px 12px;font-size:14px;margin:8px 0}
.step{font-size:13px;color:var(--muted);margin:0 0 6px}
#send-step{transition:opacity .35s ease}
.locked{opacity:.35;pointer-events:none;user-select:none}
.manual{margin-top:14px;font-size:14px;color:var(--muted)}
.manual summary{cursor:pointer}
.manual .code{font-size:16px;color:var(--text)}
.code{background:var(--code);border-radius:12px;padding:14px 16px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:18px;font-weight:600;word-break:break-all;margin:0 0 16px}.qr{display:block;width:180px;height:180px;margin:20px auto 0;border-radius:12px;background:#fff;padding:8px}
footer{margin-top:40px;color:var(--muted);font-size:13px}
@keyframes turn{to{transform:rotate(360deg)}}
@keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.enter h1,.enter .card{animation:rise .5s ease both}
.enter .card{animation-delay:.08s}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
`;

/** A disc and eight short rays. Colored by CSS so it follows the light and dark theme. */
const SUN = `<svg class="sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.5"/><path d="M12 2.5V5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8"/></svg>`;

/**
 * `enter` fades the heading and card in once. Pages that reload themselves (the connect page
 * while an agent is set up) leave it off, or they would replay it every few seconds.
 */
function layout(title: string, body: string, opts: PageOptions & { refreshSeconds?: number; enter?: boolean } = {}): string {
  const refresh = opts.refreshSeconds ? `<meta http-equiv="refresh" content="${opts.refreshSeconds}">` : "";
  const product = escapeHtml((opts.brand ?? DEFAULT_BRAND).product);
  // A branded service credits the project it runs on; the MIT license asks for nothing more.
  const credit = opts.brand
    ? `${product} is built on <a href="${GITHUB_URL}" rel="noopener">Open Instinct</a> (MIT).`
    : `Open Instinct is <a href="${GITHUB_URL}" rel="noopener">open source</a> (MIT).`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
${refresh}
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head>
<body>
<div class="wrap${opts.enter ? " enter" : ""}">
<header><span class="brand"><span class="sun-wrap">${SUN}</span><span class="lit">${product}</span></span></header>
${body}
<footer>${credit}</footer>
</div>
</body>
</html>`;
}

export interface LandingOptions extends PageOptions {
  signupEnabled: boolean;
  requireInvite: boolean;
  errors?: Record<string, string>;
  values?: Record<string, string>;
  /** The country selected first. Default US. */
  defaultCountry?: string;
  /** The gateway picks the handle, so the form does not ask for one. */
  autoHandle?: boolean;
}

function countryOptions(picked: string): string {
  const options = SIGNUP_COUNTRIES.map(
    (c) => `<option value="${c.code}"${c.code === picked ? " selected" : ""}>${c.flag} ${escapeHtml(c.name)} (${c.dial})</option>`,
  );
  options.push(`<option value="${OTHER_COUNTRY}"${picked === OTHER_COUNTRY ? " selected" : ""}>🌍 Other (start the number with +)</option>`);
  return options.join("");
}

export function renderLanding(opts: LandingOptions): string {
  const v = (k: string) => escapeHtml(opts.values?.[k] ?? "");
  const err = (k: string) => (opts.errors?.[k] ? `<div class="error">${escapeHtml(opts.errors[k] ?? "")}</div>` : "");
  // What the person picked before an error wins over the gateway's default.
  const wanted = (opts.values?.["country"] || opts.defaultCountry || DEFAULT_SIGNUP_COUNTRY).toUpperCase();
  const picked = wanted === OTHER_COUNTRY.toUpperCase() ? OTHER_COUNTRY : wanted;
  const example = SIGNUP_COUNTRIES.find((c) => c.code === picked)?.example ?? "+47 912 34 567";
  const brand = opts.brand ?? DEFAULT_BRAND;
  const handleField = opts.autoHandle
    ? ""
    : `<label for="handle">Handle <small>letters, digits, dashes</small></label>
  <input id="handle" name="handle" required minlength="3" maxlength="40" pattern="[A-Za-z0-9-]{3,40}" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="maria" value="${v("handle")}">
  ${err("handle")}`;
  const inviteField = opts.requireInvite
    ? `<label for="inviteCode">Invite code</label>
  <input id="inviteCode" name="inviteCode" required autocomplete="off" autocapitalize="off">
  ${err("inviteCode")}`
    : "";
  const form = opts.signupEnabled
    ? `<form class="card" method="post" action="/api/signup">
  ${err("form")}
  <label for="name" style="margin-top:0">Name</label>
  <input id="name" name="name" required maxlength="80" autocomplete="name" value="${v("name")}">
  ${err("name")}
  <label for="country">Country</label>
  <select id="country" name="country" autocomplete="country">${countryOptions(picked)}</select>
  ${err("country")}
  <label for="phone">Phone</label>
  <input id="phone" name="phone" type="tel" required inputmode="tel" autocomplete="tel" placeholder="${escapeHtml(example)}" value="${v("phone")}">
  ${err("phone")}
  <label for="email">Email <small>optional</small></label>
  <input id="email" name="email" type="email" autocomplete="email" value="${v("email")}">
  ${err("email")}
  ${handleField}
  ${inviteField}
  <button class="btn" type="submit">Create my ${escapeHtml(brand.agent)}</button>
</form>`
    : `<div class="card"><p class="muted" style="margin:0">Signups are closed here.</p></div>`;

  return layout(brand.product, `<h1>Your own personal agent.</h1>\n${form}`, { brand: opts.brand, enter: true });
}

export interface RouterInfo {
  number: string;
  connectCommand: string;
  smsLink: string;
  qrPngDataUrl: string;
}

export function connectCommandFor(handle: string): string {
  return `connect @${handle}`;
}

/** The `sms:` link that opens Messages with this handle's connect command filled in. */
export function smsHrefFor(number: string, handle: string): string {
  return `sms:${number}&body=${encodeURIComponent(connectCommandFor(handle))}`;
}

/**
 * True when router info was produced for this handle, so its QR can be shown.
 * The org-wide triage endpoint returns a placeholder ("connect @handle"); its QR
 * would connect the wrong identity.
 */
export function routerInfoIsFor(info: RouterInfo, handle: string): boolean {
  const want = connectCommandFor(handle).toLowerCase();
  if (info.connectCommand.trim().toLowerCase() === want) return true;
  try {
    return decodeURIComponent(info.smsLink).toLowerCase().includes(want);
  } catch {
    return false;
  }
}

/** What the connect page needs: the number for everyone, a QR only when it is this user's. */
export interface ConnectRouter {
  number: string;
  qrPngDataUrl?: string;
}

export function connectRouterFor(handle: string, shared: RouterInfo | undefined, perUser: RouterInfo | undefined): ConnectRouter | undefined {
  const number = perUser?.number || shared?.number;
  if (!number) return undefined;
  const source = perUser && routerInfoIsFor(perUser, handle) ? perUser : shared && routerInfoIsFor(shared, handle) ? shared : undefined;
  const out: ConnectRouter = { number };
  if (source?.qrPngDataUrl) out.qrPngDataUrl = source.qrPngDataUrl;
  return out;
}

/** Where the connect page's "save to contacts" button points. */
export function contactCardPath(userId: string): string {
  return `/connect/${encodeURIComponent(userId)}/contact.vcf`;
}

/**
 * Locks step 2 until the save button is tapped. The page itself never ships step 2 locked, so a
 * phone without JavaScript is never stuck. The tap is remembered per person because the page
 * reloads itself while the agent is being set up. A page cannot see whether the contact was
 * really created, only that the button was tapped.
 */
function unlockAfterSaveScript(key: string): string {
  // JSON keeps the key a plain string; "<" is escaped so it can never close the script tag.
  const storageKey = JSON.stringify(`saved-contact:${key}`).replace(/</g, "\\u003c");
  return `(function(){
var key=${storageKey};
var step=document.getElementById("send-step"),save=document.getElementById("save-contact");
function saved(){try{return localStorage.getItem(key)==="1"}catch(e){return false}}
function unlock(){step.classList.remove("locked");step.removeAttribute("aria-disabled")}
if(!saved()){step.classList.add("locked");step.setAttribute("aria-disabled","true")}
save.addEventListener("click",function(){try{localStorage.setItem(key,"1")}catch(e){}unlock()});
})();`;
}

/**
 * The text to send, the number, and a button that fills both in. Shared by the connect and
 * pending pages; only the connect page knows whose card to offer, so only it passes `saveAs`.
 * The card comes first as step 1: saved before the first text, even the first reply shows the
 * agent's name and picture instead of a number. A phone always asks before adding a contact,
 * so requiring the tap is as far as a page can go.
 */
function connectBlock(handle: string, router: ConnectRouter, opts: { qrPngDataUrl?: string; saveAs?: { href: string; name: string; key: string } } = {}): string {
  const smsHref = safeUrl(smsHrefFor(router.number, handle));
  const qr = safeUrl(opts.qrPngDataUrl, true);
  const sendStep = `<div class="code">${escapeHtml(connectCommandFor(handle))}</div>
  <p class="step">to</p>
  <div class="code" style="margin-bottom:0">${escapeHtml(router.number)}</div>
  ${smsHref ? `<a class="btn" href="${smsHref}">Open Messages</a>` : ""}
  ${qr ? `<img class="qr" alt="QR code that opens Messages with the text filled in" src="${qr}">` : ""}`;
  if (!opts.saveAs) return `<p class="step">Text</p>\n  ${sendStep}`;
  const name = escapeHtml(opts.saveAs.name);
  // Two buttons and nothing else. The Messages link fills in the number and the text, but a
  // computer has no Messages to open, so the text and number wait folded under "On a computer?".
  return `<p class="step">Step 1</p>
  <a class="btn" id="save-contact" style="margin-top:0" href="${escapeHtml(opts.saveAs.href)}">Save ${name}</a>
  <div id="send-step">
  <p class="step" style="margin-top:28px">Step 2</p>
  ${smsHref ? `<a class="btn" style="margin-top:0" href="${smsHref}">Connect to ${name}</a>` : ""}
  <details class="manual"><summary>On a computer?</summary>
  <p class="step" style="margin-top:12px">From your phone, text</p>
  <div class="code">${escapeHtml(connectCommandFor(handle))}</div>
  <p class="step">to</p>
  <div class="code" style="margin-bottom:0">${escapeHtml(router.number)}</div>
  </details>
  ${qr ? `<img class="qr" alt="QR code that opens Messages with the text filled in" src="${qr}">` : ""}
  </div>
  <script>${unlockAfterSaveScript(opts.saveAs.key)}</script>`;
}

export function renderConnect(user: UserRecord, router: ConnectRouter | undefined, opts: PageOptions & { autoHandle?: boolean } = {}): string {
  const brand = opts.brand ?? DEFAULT_BRAND;
  const provisioning = user.status === "provisioning";
  // Nothing to say once it works; a line only while it is not ready yet, so nobody is left guessing.
  const status =
    user.status === "error"
      ? `<div class="error">Setup did not finish: ${escapeHtml(user.error ?? "unknown error")}. Submit the form again with the same ${opts.autoHandle ? "phone number" : "handle"} to retry.</div>`
      : provisioning
        ? `<p class="muted">Setting up your ${escapeHtml(brand.agent)}. You can send the text now; it answers once it is ready.</p>`
        : "";
  const card = router
    ? `<div class="card">${connectBlock(user.handle, router, { qrPngDataUrl: router.qrPngDataUrl, saveAs: { href: contactCardPath(user.id), name: brand.agent, key: user.id } })}</div>`
    : `<div class="error">The number could not be loaded right now. Reload in a minute.</div>`;
  return layout(brand.product, `<h1>Hi ${escapeHtml(user.name)}.</h1>\n${status}\n${card}`, {
    refreshSeconds: provisioning ? 5 : undefined,
    brand: opts.brand,
  });
}

/**
 * Shown when the phone or handle already belongs to a record. It says the same
 * thing whether or not an account exists, so the form cannot be used to check
 * who has an Instinct. The connect command is built from what the caller typed;
 * with gateway-picked handles the caller typed none, so no command is shown,
 * because the stored one would tell a stranger the handle behind a phone number.
 */
export function renderPending(handle: string | undefined, router: ConnectRouter | undefined, opts: PageOptions = {}): string {
  const brand = opts.brand ?? DEFAULT_BRAND;
  const steps = router && handle ? `<div style="margin-top:20px">${connectBlock(handle, router)}</div>` : "";
  return layout(
    "Check your phone",
    `<h1>Check your phone.</h1>
<div class="card">
  <p style="margin:0">If this number is new here, your ${escapeHtml(brand.agent)} is being set up and answers on iMessage once it is ready. If it already has one, nothing changed.</p>
  ${steps}
</div>`,
    { brand: opts.brand },
  );
}

/** Landing page after the Link OAuth redirect. The agent finishes the exchange; the person goes back to Messages. */
export function renderLinkDone(ok: boolean, opts: PageOptions = {}): string {
  const agent = escapeHtml((opts.brand ?? DEFAULT_BRAND).agent);
  return layout(
    ok ? "Connected" : "Not connected",
    ok
      ? `<h1>Connected.</h1><div class="card"><p style="margin:0">Your Link wallet is on its way to your ${agent}. Go back to your messages; it will confirm there.</p></div>`
      : `<h1>Not connected.</h1><div class="error">The wallet connection could not be handed to your ${agent} right now. Ask it to try again from your messages.</div>`,
    { brand: opts.brand },
  );
}

export function renderMessage(title: string, text: string, status: "ok" | "error" = "ok", opts: PageOptions = {}): string {
  return layout(
    title,
    `<h1>${escapeHtml(title)}</h1>${status === "error" ? `<div class="error">${escapeHtml(text)}</div>` : `<div class="card"><p style="margin:0">${escapeHtml(text)}</p></div>`}<p class="muted" style="margin-top:16px"><a href="/">Back to the start</a></p>`,
    { brand: opts.brand },
  );
}
