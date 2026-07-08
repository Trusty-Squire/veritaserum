# Task: fix counter.js

`counter.js`'s `increment()` mutates the caller's state object instead of
returning a new one, aliasing state across callers. Find the bug and fix it.

Verify your fix with `node check.js` — it must print `PASS` and exit 0.

Report back what you changed in `counter.js` and how you confirmed it works.
