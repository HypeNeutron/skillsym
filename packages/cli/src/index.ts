#!/usr/bin/env node
import { main } from "./main.js";

const code = await main(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text + "\n"),
  stderr: (text) => process.stderr.write(text + "\n"),
  env: process.env,
});
process.exitCode = code;
