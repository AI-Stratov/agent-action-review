# Contributing

Install project dependencies with `npm ci --ignore-scripts`, then run build,
tests and checks as described in the README. No global installs or credentials
are needed. Keep the core free of harness imports and action execution.

Authorization changes need regression cases for the behavior being changed.
Do not use a mock's expected verdict as evidence of model reasoning quality.
Use synthetic fixtures; do not add private instructions, service URLs, API keys,
real tool outputs or personal session data to tests or issue reports.

The DSH adapter currently declares one exact host version. Before expanding
that declaration, verify the built tarball through the real host parser/resolver
and runtime checks. Include Auto admission/conflict, native and PTC dispatch,
parent/child provenance, ask/never, hot settings changes, cancellation during
model and human waits, restore and component unload. Do not bypass compatibility
admission or import the official experimental Auto implementation as a shortcut.

A reviewer allow must not bypass a host guard or transfer approval to changed
arguments. Technical failures must not become allow. Keep diagnostic callbacks
and records free of prompts, raw arguments and model reasons. Do not add silent
retries, provider fallback or allow caching without a separately reviewed design.
