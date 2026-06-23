#!/usr/bin/env node

import { main } from '../lib/main.mjs';

main(process.argv.slice(2)).catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
