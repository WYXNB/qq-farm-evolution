#!/usr/bin/env node
const { runStdioBridge } = require('../src/services/evolution-main-mcp');

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--cap-file') {
    process.stderr.write('Evolution tool bridge unavailable\n');
    process.exitCode = 1;
} else {
    runStdioBridge(args[1]).catch(() => {
        process.stderr.write('Evolution tool bridge unavailable\n');
        process.exitCode = 1;
    });
}
