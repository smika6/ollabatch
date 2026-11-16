// Starts a long-lived grandchild (like npm → node) and reports its pid.
import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
console.log(`grandchild ${child.pid}`);
setInterval(() => {}, 1000);
