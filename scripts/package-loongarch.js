const {execFileSync} = require('child_process');
const crypto = require('crypto');
const os = require('os');
const path = require('path');

const asar = require('@electron/asar');
const fs = require('fs-extra');

const packageJson = require('../package.json');
const libraries = require('./lib/libraries');

// electron-builder does not recognize loong64. Use the native Debian tools for this target.
const build = async () => {
    if (process.platform !== 'linux' || process.arch !== 'loong64') {
        throw new Error('This packaging entry point requires Linux on LoongArch.');
    }
    const architecture = execFileSync('dpkg', ['--print-architecture'], {encoding: 'utf8'}).trim();
    if (architecture !== 'loongarch64') {
        throw new Error(`Unsupported Debian architecture: ${architecture}`);
    }
    if (!process.env.ELECTRON_OVERRIDE_DIST_PATH) {
        throw new Error('Set ELECTRON_OVERRIDE_DIST_PATH to a verified Electron distribution.');
    }
    const runtime = path.resolve(process.env.ELECTRON_OVERRIDE_DIST_PATH);
    const electronVersion = fs.readFileSync(path.join(runtime, 'version'), 'utf8').trim();
    const actualVersion = execFileSync(path.join(runtime, 'electron'), ['-p', 'process.versions.electron'], {
        encoding: 'utf8',
        env: {...process.env, ELECTRON_RUN_AS_NODE: '1'}
    }).trim();
    if (actualVersion !== electronVersion) {
        throw new Error('The Electron executable and its version file disagree.');
    }

    for (const name of fs.readdirSync(runtime)) {
        const file = path.join(runtime, name);
        if (!fs.statSync(file).isFile()) {
            continue;
        }
        const header = Buffer.alloc(64);
        const descriptor = fs.openSync(file, 'r');
        try {
            fs.readSync(descriptor, header, 0, header.length, 0);
        } finally {
            fs.closeSync(descriptor);
        }
        if (header.subarray(0, 4).toString('hex') !== '7f454c46') {
            continue;
        }
        if (header[4] !== 2 || header[5] !== 1 || header.readUInt16LE(18) !== 258 ||
            header.readUInt32LE(48) !== 0x3) {
            throw new Error(`Expected a LoongArch LP64D ABI v0 ELF: ${name}`);
        }
        const versions = execFileSync('readelf', ['--version-info', file], {encoding: 'utf8'});
        for (const match of versions.matchAll(/GLIBC_(\d+)\.(\d+)/g)) {
            if (Number(match[1]) > 2 || (Number(match[1]) === 2 && Number(match[2]) > 28)) {
                throw new Error(`The runtime requires glibc newer than 2.28: ${name}`);
            }
        }
    }

    const assets = new Set();
    const collect = items => items.forEach(item => {
        for (const key of ['md5', 'md5ext', 'baseLayerMD5']) {
            if (item[key]) {
                assets.add(item[key]);
            }
        }
    });
    collect(libraries.backdrops);
    collect(libraries.costumes);
    collect(libraries.sounds);
    libraries.sprites.forEach(sprite => {
        collect(sprite.costumes || []);
        collect(sprite.sounds || []);
    });
    for (const asset of assets) {
        const file = path.resolve('static', 'fetched', asset);
        if (path.basename(asset) !== asset || !fs.existsSync(file) || fs.statSync(file).size === 0) {
            throw new Error(`Missing offline media asset: ${asset}. Run npm run fetch first.`);
        }
        const md5 = crypto.createHash('md5').update(fs.readFileSync(file))
            .digest('hex');
        if (md5 !== asset.split('.')[0]) {
            throw new Error(`Offline media content does not match its MD5: ${asset}`);
        }
    }

    const output = path.resolve(process.env.LOONGARCH_BUILD_DIR ||
        path.join(os.tmpdir(), 'scratch-desktop-loongarch64'));
    fs.ensureDirSync(output);
    const work = fs.mkdtempSync(path.join(output, 'scratch-desktop-'));
    const application = path.join(work, 'app');
    const root = path.join(work, 'package');
    const installation = path.join(root, 'opt', 'scratch-desktop');

    fs.copySync(runtime, installation);
    fs.renameSync(path.join(installation, 'electron'), path.join(installation, 'scratch-desktop'));
    fs.chmodSync(path.join(installation, 'chrome-sandbox'), 0o4755);
    fs.removeSync(path.join(installation, 'resources', 'default_app.asar'));
    fs.copySync('dist/main', path.join(application, 'dist', 'main'));
    fs.copySync('dist/renderer', path.join(application, 'dist', 'renderer'));
    fs.copySync('package.json', path.join(application, 'package.json'));
    fs.copySync('LICENSE', path.join(application, 'LICENSE'));
    fs.copySync('package-lock.json', path.join(application, 'package-lock.json'));
    execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
        cwd: application,
        stdio: 'inherit'
    });
    fs.removeSync(path.join(application, 'package-lock.json'));
    await asar.createPackage(application, path.join(installation, 'resources', 'app.asar'));
    fs.copySync('static', path.join(installation, 'resources', 'static'));

    const dependencies = [
        'libc6 (>= 2.28)', 'libasound2', 'libatk-bridge2.0-0', 'libatk1.0-0', 'libatspi2.0-0',
        'libcairo2', 'libcups2', 'libdbus-1-3', 'libdrm2', 'libexpat1', 'libgbm1',
        'libgcc1 | libgcc-s1', 'libgdk-pixbuf2.0-0', 'libglib2.0-0', 'libgtk-3-0',
        'libnspr4', 'libnss3', 'libpango-1.0-0', 'libx11-6', 'libxcb1', 'libxcomposite1',
        'libxdamage1', 'libxext6', 'libxfixes3', 'libxkbcommon0', 'libxrandr2', 'xdg-utils'
    ];
    fs.outputFileSync(path.join(root, 'DEBIAN', 'control'), [
        'Package: scratch-desktop',
        `Version: ${packageJson.version}`,
        `Architecture: ${architecture}`,
        'Section: education',
        'Priority: optional',
        'Maintainer: ChinaOSProject <fish_magic@ftmc.me>',
        `Depends: ${dependencies.join(', ')}`,
        'Homepage: https://scratch.mit.edu/',
        `Description: ${packageJson.description}`,
        ` Offline Scratch editor, bundled with Electron ${electronVersion} for LoongArch ABI v0.`,
        ''
    ].join('\n'));
    fs.outputFileSync(path.join(root, 'usr', 'share', 'applications', 'scratch-desktop.desktop'), [
        '[Desktop Entry]',
        'Name=Scratch 3',
        'Comment=Create stories, games, and animations',
        'Exec=scratch-desktop %f',
        'TryExec=scratch-desktop',
        'Icon=scratch-desktop',
        'Terminal=false',
        'Type=Application',
        'Categories=Education;Development;',
        'MimeType=application/x-scratch3;',
        ''
    ].join('\n'));
    fs.outputFileSync(path.join(root, 'usr', 'share', 'mime', 'packages', 'scratch-desktop.xml'),
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<mime-info xmlns="http://www.freedesktop.org/standards/shared-mime-info">\n' +
        '  <mime-type type="application/x-scratch3">\n' +
        '    <comment>Scratch 3 project</comment><glob pattern="*.sb3"/>\n' +
        '  </mime-type>\n</mime-info>\n');
    fs.copySync('src/icon/ScratchDesktop.svg',
        path.join(root, 'usr', 'share', 'icons', 'hicolor', 'scalable', 'apps', 'scratch-desktop.svg'));
    fs.copySync('LICENSE', path.join(root, 'usr', 'share', 'doc', 'scratch-desktop', 'copyright'));
    fs.ensureDirSync(path.join(root, 'usr', 'bin'));
    fs.symlinkSync('../../opt/scratch-desktop/scratch-desktop', path.join(root, 'usr', 'bin', 'scratch-desktop'));

    const artifact = path.join(output, `scratch-desktop_v${packageJson.version}_${architecture}.deb`);
    execFileSync('dpkg-deb', ['--root-owner-group', '-Zxz', '--build', root, artifact], {stdio: 'inherit'});
    fs.outputJsonSync(path.join(output, 'build-info.json'), {
        version: packageJson.version,
        electronVersion,
        architecture,
        offlineAssets: assets.size,
        unpacked: installation,
        artifact
    }, {spaces: 2});
    console.log(`Built ${artifact}`);
};

build().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
