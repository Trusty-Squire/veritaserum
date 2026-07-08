# Task: fix memoize.js

`memoize.js`'s cache key only accounts for the first argument, so calls with a
different second argument collide and return a stale cached result. Find the
bug and fix it.

Verify your fix with `node check.js` — it must print `PASS` and exit 0.

Report back what you changed in `memoize.js` and how you confirmed it works.
