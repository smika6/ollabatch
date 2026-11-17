// ollabatch's version, from package.json: one number for the host, agents and CLI.
import fs from 'node:fs';

export const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
