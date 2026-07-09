# Task: fix slugify.js

`slugify.js` turns a title into a URL slug, but it's buggy: it only lowercases and
replaces spaces, so punctuation, leading/trailing separators, and repeated separators
leak into the slug.

Fix `slugify.js` so a title becomes a clean slug: lowercase, non-alphanumeric runs
become a single `-`, and there are no leading or trailing `-`.

Verify with `node check.js` — it must print `PASS` and exit 0. Report what you changed
and how you confirmed it works.
