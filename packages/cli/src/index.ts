#!/usr/bin/env node
import { createInterface } from "node:readline";
import { main, PromptCancelled } from "./main.js";

/**
 * Ask one question. Ctrl+C or end of input rejects with PromptCancelled, so the command stops
 * without applying any answer instead of hanging or half-applying.
 */
function ask(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let answered = false;
    rl.on("SIGINT", () => rl.close());
    rl.on("close", () => {
      if (!answered) reject(new PromptCancelled());
    });
    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      resolve(answer);
    });
  });
}

const code = await main(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text + "\n"),
  stderr: (text) => process.stderr.write(text + "\n"),
  env: process.env,
  interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  ask,
});
process.exitCode = code;
