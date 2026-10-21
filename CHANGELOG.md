# Changelog

## Unreleased

- **Destination safety check:** new optional Google Safe Browsing integration (`SAFE_BROWSING_API_KEY`). Destination URLs, including device/country routing rule URLs, are checked when a link is created or edited and in CSV imports (one batched lookup per file); phishing, malware, unwanted-software and harmful-app listings are refused with `400`. Results are cached in memory for 5 minutes. If Google can't be reached the check fails open by default; set `SAFE_BROWSING_FAIL_CLOSED=true` to refuse with `503` instead. Off when no key is set. Checks happen on save, not on each redirect. No schema change, no new dependency. See `SECURITY.md`.
