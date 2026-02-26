// test-electron.js — minimal test to verify electron works
console.log("[TEST] process.type:", process.type);
console.log("[TEST] process.versions.electron:", process.versions.electron);

// IMPORTANT: In Electron main process, require('electron') should NOT
// resolve to node_modules/electron/index.js. It should be a built-in module.
// We can check by examining require.resolve('electron'):
try {
    const resolvedPath = require.resolve('electron');
    console.log("[TEST] require.resolve('electron'):", resolvedPath);
} catch (e) {
    console.log("[TEST] require.resolve threw:", e.message);
}

const electron = require('electron');
console.log("[TEST] typeof electron:", typeof electron);
console.log("[TEST] typeof electron.app:", typeof electron?.app);

if (electron?.app) {
    electron.app.whenReady().then(() => {
        console.log("[TEST] App is ready! Creating window...");
        const { BrowserWindow } = electron;
        const win = new BrowserWindow({ width: 400, height: 300 });
        win.loadURL('data:text/html,<h1>Electron Works!</h1>');
    });
} else {
    console.error("[TEST] FAILED - electron.app is undefined!");
    console.log("[TEST] electron value:", String(electron).substring(0, 200));
    process.exit(1);
}
