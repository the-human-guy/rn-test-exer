// Starts the UNMODIFIED kit mock with an isolated state file on a random port.
// Prints the base URL on stdout. Used by the Jest integration tests only.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockServer } from '../../../kit/mock-server.mjs';

const dir = mkdtempSync(join(tmpdir(), 'kit-mock-'));
const server = createMockServer({ statePath: join(dir, 'state.json') });
server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`READY http://127.0.0.1:${server.address().port}\n`);
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
