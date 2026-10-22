// Small self-contained HTML pages the server renders itself (password gate, errors, report form).
export const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Pages are small, self-contained HTML. Never cached or indexed: they gate private content.
export function sendPage(res, status, title, body) {
  res
    .status(status)
    .set({
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
      // No form-action: browsers apply it to the redirect after the POST too, which would
      // block the jump to the destination site.
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'",
      'Referrer-Policy': 'no-referrer',
    })
    .type('html')
    .send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title><style>
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,sans-serif;background:Canvas;color:CanvasText}
main{width:min(420px,100% - 32px);padding:28px 0}
h1{font-size:22px;margin:0 0 8px}p{margin:0 0 16px;opacity:.75}
input,button,select,textarea{font:inherit;width:100%;padding:10px 12px;border-radius:8px;border:1px solid #8886;box-sizing:border-box}
textarea{min-height:90px;resize:vertical}label{display:block;font-size:14px;font-weight:600;margin:14px 0 4px}
button{margin-top:12px;background:#2f5bff;border-color:#2f5bff;color:#fff;font-weight:600;cursor:pointer}
.err{color:#b4281e;opacity:1}@media (prefers-color-scheme:dark){.err{color:#ff7b6e}}
</style></head><body><main>${body}</main></body></html>`);
}

export const message = (res, status, title, text) =>
  sendPage(res, status, title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p>`);


// Small link under a page that visitors might want to report from
export const reportLinkHtml = (slug) =>
  `<p style="margin:20px 0 0;font-size:13px"><a href="/report/${encodeURIComponent(slug)}" style="color:inherit">Report this link</a></p>`;
