# Security Policy

## Reporting a vulnerability

Please **don't open a public issue** for a security problem. Report it privately
through GitHub: the repository's **Security** tab, then **Report a vulnerability**
(<https://github.com/The-OASIS-Project/aurora/security/advisories/new>).

Include what you found, how to reproduce it, which part of Aurora it affects, and
what an attacker could do with it. A proof of concept helps but isn't required.

A problem in DAWN itself (the server Aurora connects to) belongs in
[DAWN's security policy](https://github.com/The-OASIS-Project/dawn/security/policy).
If you aren't sure which side it's on, report it here and we'll move it.

## What to expect

Aurora is maintained by one developer. You can expect an acknowledgement within
7 days, then an assessment and, for a confirmed issue, a fix on `main` with a
GitHub security advisory. You'll be credited in the advisory unless you'd rather
not be.

## Supported versions

Aurora doesn't publish versioned releases yet; fixes land on `main`. Run a current
`main` and update when an advisory is published.

## Scope

Aurora is a browser interface to DAWN. It shows text that comes from outside the
user's control (replies, email, documents, Home Assistant names, web content the
assistant read, visuals it generated), and it acts on the user's behalf over their
own DAWN session. In scope, among others:

- **Script injection.** Any way for that outside text to run script or reach the
  page as markup instead of text: the markdown renderer, the email body pipeline,
  attachments, the generated-visuals sandbox, notification cards.
- **Acting beyond the user's own data.** Aurora is the user's surface, not DAWN's
  admin console: it never sends DAWN's operator or admin requests (settings,
  secrets, restarts, user management). A way to make it do so, or to make it
  perform a destructive action (deleting a conversation, a watch, a memory)
  without the user's deliberate confirmation, is a vulnerability.
- **One user's data reaching another.** Aurora clears a user's data from the
  browser on logout, on a revoked session, and when a different user signs in. A
  way around that on a shared browser counts.
- **Weakening the connection.** Anything that lets another site ride the user's
  DAWN login, or that sends their data anywhere but their own DAWN.

Out of scope:

- **A compromised DAWN server.** Aurora trusts the DAWN it is connected to for what
  that DAWN is allowed to do; content DAWN relays from outside is still treated as
  untrusted, and a way around that is in scope.
- **Exposing DAWN or Aurora directly to the internet.** It isn't supported; reach
  them over a VPN.
- **Physical access** to the machine or the browser profile.
- **Bugs in dependencies** with no path to exploit them through Aurora: report
  those upstream, and tell us if Aurora's use of the library makes one exploitable.
