const fs = require('fs');
const path = require('path');

module.exports = context => {
    if (context.electronPlatformName !== 'linux') {
        return;
    }

    const sandboxPath = path.join(context.appOutDir, 'chrome-sandbox');
    if (!fs.existsSync(sandboxPath)) {
        throw new Error(`Electron sandbox helper is missing: ${sandboxPath}`);
    }

    // Chromium requires a root-owned setuid helper when user namespaces are
    // unavailable, which is common on older Debian installations.
    fs.chmodSync(sandboxPath, 0o4755);
};
