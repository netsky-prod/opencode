import { expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"

test("admits an overdue loop exactly once through the real server graph", async () => {
  await using tmp = await tmpdir({ git: true })
  const fixture = path.join(import.meta.dir, "fixture/loop-scheduler-process.ts")
  const database = path.join(tmp.path, "opencode-loop-test.db")
  const child = Bun.spawn([process.execPath, "run", fixture, tmp.path], {
    cwd: path.resolve(import.meta.dir, "../.."),
    env: { ...process.env, OPENCODE_DB: database },
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
