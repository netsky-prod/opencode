# Durable loops

`/loop` schedules another turn in the current session. Netsky Code must remain running; closing every Netsky Code process pauses the scheduler until `netsky` starts again.

## Examples

- `/loop 10m check CI and fix the next failure`
- `/loop investigate the flaky test and choose when to check again`
- `/loop 30m`
- `/loop list`
- `/loop pause loop_...`
- `/loop resume loop_...`
- `/loop delete loop_...`

Durations use one positive integer followed by `s`, `m`, `h`, or `d`. The minimum is 10 seconds and the maximum is 7 days.

Fixed loops coalesce missed intervals and keep at most one queued invocation. Adaptive loops choose their next wake-up and use a 10-minute fallback when they do not choose one. Schedules never expire automatically and survive restart because they are stored with session data.

Deleting a loop prevents future admission, but a prompt already admitted to the durable inbox may execute once.

The model can manage loops directly with `loop_create`, `loop_list`, `loop_update`, `loop_delete`, and `loop_wakeup`. Every mutation uses the normal permission system and is scoped to the current session.
