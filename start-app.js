const { spawn } = require('child_process');
const electron = require('electron');
const path = require('path');

// Identify the electron executable path
// When running in Node, require('electron') returns the string path to the executable
const electronPath = electron;

console.log(`[LAUNCHER] Electron executable path: ${electronPath}`);
console.log(`[LAUNCHER] Current ELECTRON_RUN_AS_NODE: ${process.env.ELECTRON_RUN_AS_NODE}`);

// Prepare environment: clone current env and REMOVE ELECTRON_RUN_AS_NODE
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

// Spawn Electron process
const child = spawn(electronPath, ['.', '--no-sandbox'], {
    env,
    stdio: 'inherit',
    cwd: __dirname,
    windowsHide: false
});

child.on('error', (err) => {
    console.error('[LAUNCHER] Failed to start electron:', err);
});

child.on('exit', (code) => {
    console.log(`[LAUNCHER] Electron process exited with code ${code}`);
    process.exit(code);
});

console.log('[LAUNCHER] Electron started successfully');
