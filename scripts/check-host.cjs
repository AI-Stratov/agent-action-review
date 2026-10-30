const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');

const flags = process.argv.slice(2);
const option = name => {
  const index = flags.indexOf(name);
  return index < 0 ? undefined : flags[index + 1];
};
const app = option('--app');
const tarball = option('--tarball');
if (!app || !tarball) {
  process.stderr.write('Usage: node scripts/check-host.cjs --app /absolute/path/App.app --tarball /absolute/path/plugin.tgz\n');
  process.exit(2);
}
const appPath = path.resolve(app);
const archive = path.resolve(tarball);
if (!process.versions.electron) {
  const executable = path.join(appPath, 'Contents/MacOS', path.basename(appPath, '.app'));
  const run = spawnSync(executable, [__filename, '--app', appPath, '--tarball', archive], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'inherit',
  });
  if (run.error) throw run.error;
  process.exit(run.status ?? 1);
}
const installation = path.join(appPath, 'Contents/Resources/app.asar/dsh');
const anchor = path.join(installation, 'package.json');
const load = createRequire(path.join(installation, 'node_modules/__action_review_host_check.cjs'));
const { Context } = load('@deepseek-ai/cordis');
const boot = load('@deepseek-ai/dsh-app-boot');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'action-review-host-'));
(async () => {
  let resolutionFiber;
  try {
    const unpacked = path.join(temporary, 'unpacked');
    fs.mkdirSync(unpacked);
    const unpack = spawnSync('tar', ['-xzf', archive, '-C', unpacked], { encoding: 'utf8' });
    if (unpack.status !== 0) throw new Error(unpack.stderr || 'Could not unpack the plugin tarball.');
    const manifest = JSON.parse(fs.readFileSync(path.join(unpacked, 'package/package.json'), 'utf8'));
    assert.equal(manifest.name, 'dsh-action-review');
    assert.equal(boot.evaluatePluginCompatibility(manifest), undefined, 'Installed host rejects the plugin version.');
    assert(boot.evaluatePluginCompatibility(manifest, {}, '0.0.0'), 'An unverified host version must be refused.');
    const profile = path.join(temporary, 'profiles/check');
    const packageDirectory = path.join(profile, 'node_modules', manifest.name);
    fs.mkdirSync(path.dirname(packageDirectory), { recursive: true });
    fs.renameSync(path.join(unpacked, 'package'), packageDirectory);
    fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({
      name: 'action-review-test-profile', private: true,
      dependencies: { [manifest.name]: `file:${archive}` },
      dsh: { profile: { bundles: [manifest.name] } },
    }, null, 2) + '\n');
    const loaded = boot.loadProfileDirectory('dsh', profile, anchor);
    assert.deepEqual(loaded.skippedBundles, []);
    assert.equal(loaded.layers.length, 1);
    const entries = boot.composeEntries([boot.readBundlePatches('dsh', { dir: profile, installAnchor: anchor }, loaded), loaded.patches]);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].id, 'action-review');
    assert.equal(entries[0].name, manifest.name);
    const resolution = await boot.createRuntimeResolution({ installAnchor: anchor, profile: loaded, home: temporary });
    const root = new Context();
    resolutionFiber = root.plugin(boot.PluginPackages, { resolution });
    await resolutionFiber.await();
    const component = createRequire(path.join(profile, 'package.json'))(manifest.name);
    assert.equal(typeof component.apply, 'function');
    assert(component.Config, 'The built component must export its settings schema.');
    assert(Array.isArray(component.inject), 'The built component must declare required services.');
    console.log(JSON.stringify({
      status: 'passed', host: boot.getDshRuntimeVersion(), package: `${manifest.name}@${manifest.version}`,
      checks: ['built tarball in clean offline profile', 'real profile bundle parser and composer', 'real compatibility admission', 'unverified host refused', 'real host peer resolver imports built component', 'Config and service requirements exported'],
      working_profile_changed: false, model_requests: 0,
    }, null, 2));
  } finally {
    await resolutionFiber?.dispose();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error.stack ?? String(error));
  process.exitCode = 1;
});
