#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { main } from "./main.js";

const code = await main(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text + "\n"),
  stderr: (text) => process.stderr.write(text + "\n"),
  env: process.env,
  interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  ask: async (question) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  },
});
process.exitCode = code;
