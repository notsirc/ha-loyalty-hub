# Security policy

Loyalty Hub stores loyalty cards and vouchers, which can be personal data. Please report security problems privately.

## Reporting a vulnerability

Use GitHub's **private vulnerability reporting**: *Security* tab of this repository → *Report a vulnerability*.
Please do not open a public issue, and do not include real card numbers or personal data in the report: fake values are enough to show the problem.

You will get an answer as soon as possible; this is a hobby project, so please allow a few days.

## Scope

- Cards or logos visible to a user who should not see them (sharing, private cards, admin options).
- WebSocket commands that accept data they should refuse, or reveal the existence of other users' cards.
- Unsafe handling of uploaded images, imported files or logo downloads (for example requests to local network addresses).
- Anything that sends data outside Home Assistant beyond what the README describes.

## Supported versions

Only the latest release gets fixes.
