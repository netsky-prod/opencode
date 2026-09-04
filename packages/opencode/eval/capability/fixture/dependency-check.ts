import fs from "fs/promises"
import path from "path"

await fs.access(path.resolve(process.cwd(), "../../../.eval/dependency-ready"))
