import { expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"

test("queues loop wakes behind a legacy foreground turn without creating a second conversation", async () => {
  await using tmp = await tmpdir({ git: true })
  const fixture = path.join(import.meta.dir, "fixture/legacy-loop-scheduler-process.ts")
  const child = Bun.spawn([process.execPath, "run", fixture, tmp.path], {
    cwd: path.resolve(import.meta.dir, "../.."),
    env: { ...process.env, OPENCODE_DB: path.join(tmp.path, "legacy-loop.db") },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(exitCode, `${stdout}\n${stderr}`).toBe(0)
}, 30_000)

test("resumes an overdue persisted session with its configured provider through the real server graph", async () => {
  await using tmp = await tmpdir({ git: true })
  const fixture = path.join(import.meta.dir, "fixture/loop-scheduler-process.ts")
  const database = path.join(tmp.path, "opencode-loop-test.db")
  const child = Bun.spawn([process.execPath, "run", fixture, tmp.path], {
    cwd: path.resolve(import.meta.dir, "../.."),
    env: { ...process.env, OPENCODE_DB: database, SCHEDULED_BRIDGE_API_KEY: "stub-key" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(exitCode, `${stdout}\n${stderr}`).toBe(0)
})

for (const boundary of ["empty", "message", "full", "retry"])
  test(`recovers a legacy wake across a process restart after ${boundary} projection`, async () => {
    await using tmp = await tmpdir({ git: true })
    const fixture = path.join(import.meta.dir, "fixture/legacy-loop-scheduler-process.ts")
    for (const phase of [`prepare-${boundary}`, "resume"]) {
      const child = Bun.spawn([process.execPath, "run", fixture, tmp.path, phase], {
        cwd: path.resolve(import.meta.dir, "../.."),
        env: { ...process.env, OPENCODE_DB: path.join(tmp.path, "legacy-loop.db") },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(exit, `${phase}\n${stdout}\n${stderr}`).toBe(0)
    }
  }, 30000)
