---
name: browser-testing
description: Verify user-visible web outcomes in a real browser and preserve evidence.
---

# Browser testing

Use the smallest browser profile that can verify the requested outcome. Start with `browser/default`; add `browser/diagnostics` only when console, network, source, or performance evidence is necessary.

1. Translate the requested outcome into observable assertions before interacting with the page.
2. Navigate to the exact test URL and inspect the rendered page rather than inferring behavior from source code alone.
3. Exercise the shortest realistic user path, including failure and boundary states relevant to the change.
4. Save a screenshot for the final verified state. Preserve console, network, or trace artifacts when they explain a failure.
5. Verify the artifact exists and independently re-check the observable outcome before reporting completion.

Report the URL, actions, observed result, and artifact path. Distinguish direct observations from inferences. Never claim a browser outcome from a successful tool call alone.
