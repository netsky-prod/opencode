---
name: mobile-testing
description: Verify mobile application outcomes on available simulators or devices and retain visual and crash evidence.
---

# Mobile testing

Enable only `mobile/ios` or `mobile/android` for the requested target. iOS execution requires macOS; if the selected profile is unsupported or degraded, report the exact missing probe and remediation instead of pretending a device is available.

1. Use the built-in `bash` tool for `xcodebuild`, `xcrun simctl`, `flutter`, and `adb`; its canonical permission action and resource remain `bash` and the exact command string.
2. Discover the available simulator or device before building or launching. Never select a real device implicitly.
3. Translate the task into observable checks, interact with the shortest representative path, and collect logs, screenshots, recordings, or crash reports needed to prove the outcome.
4. Keep command output in the normal tool response. Large output is automatically retained by the session tool-output artifact store; cite every returned artifact path.
5. Recheck the final app state independently before reporting completion. Separate observed device state from inferred source behavior.

Do not expose signing credentials, provisioning data, device secrets, or environment values in commands, output, or artifacts.
