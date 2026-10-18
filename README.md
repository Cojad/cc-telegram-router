# marketplace-test

A test branch, not part of cc-telegram-router: a plugin marketplace named `Cojad` hosted on GitHub, with one minimal channel plugin (`test`), used to check how Claude Code installs, updates and allows a channel plugin from a GitHub marketplace.

```bash
claude plugin marketplace add Cojad/cc-telegram-router#marketplace-test --scope local
claude plugin install test@Cojad --scope local
```

The plugin keeps its files in `.channel-probe/` under the session's working directory: a file dropped into `.channel-probe/inbox/` is pushed as a channel event; the `reply` tool appends to `.channel-probe/outbox.log`. No tokens, no network.
