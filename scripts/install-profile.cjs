const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');

const PACKAGE = 'dsh-action-review';
const CONFIG_FILES = ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml'];
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const read = filename => fs.existsSync(filename) ? fs.readFileSync(filename) : null;
const state = profile => Object.fromEntries(CONFIG_FILES.map(name => [name, read(path.join(profile, name))?.toString('base64') ?? null]));
const sameState = (profile, saved) => JSON.stringify(state(profile)) === JSON.stringify(saved);
const flattened = rows => rows.flatMap(row => row.name === 'group' ? flattened(row.config ?? []) : [row]);

function host(app) {
  const application = fs.realpathSync(app);
  const installation = path.join(application, 'Contents/Resources/app.asar/dsh');
  const load = createRequire(path.join(installation, 'node_modules/__action_review_install.cjs'));
  const pnpm = path.join(application, 'Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs');
  assert(fs.existsSync(pnpm), 'The application does not provide its expected pnpm launcher.');
  return {
    app: application, installation, load, pnpm,
    executable: path.join(application, 'Contents/MacOS', path.basename(application, '.app')),
    anchor: path.join(installation, 'package.json'),
    boot: load('@deepseek-ai/dsh-app-boot'),
    operations: load('@deepseek-ai/dsh-plugin-manager/operations'),
    atomic: load('@deepseek-ai/dsh-atomic-write'),
  };
}

function assertAppClosed(runtime, listing) {
  if (listing === undefined) {
    const result = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
    assert.equal(result.status, 0, 'Cannot determine whether the application is closed.');
    listing = result.stdout;
  }
  const running = listing.split('\n').some(line => {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    return match && Number(match[1]) !== process.pid
      && (match[2] === runtime.executable || match[2].startsWith(runtime.executable + ' '));
  });
  assert(!running, 'Fully quit DeepSeek Harness before changing its profile. Auto integrations must not unload during replacement.');
}

function planInstall(options, runtime = host(options.app)) {
  assert(!fs.lstatSync(options.profile).isSymbolicLink(), 'The profile directory must not be a symlink.');
  const profile = fs.realpathSync(options.profile);
  assert(options.replaceAuto, 'Pass --replace-auto to explicitly replace the existing Auto integration.');
  assert(typeof options.provider === 'string' && options.provider.trim(), 'A fixed reviewer provider is required.');
  assert(typeof options.model === 'string' && options.model.trim(), 'A fixed reviewer model is required.');
  assert(fs.existsSync(path.join(profile, 'package.json')), 'The profile must already be initialized.');
  const modules = path.join(profile, 'node_modules');
  if (fs.existsSync(modules)) assert(!fs.lstatSync(modules).isSymbolicLink(), 'A shared node_modules symlink cannot be replaced safely.');
  const current = runtime.boot.readProfileManifest('dsh', profile);
  const exemptions = runtime.boot.readProfileVersionExemptions(profile);
  const layers = (current.dsh?.profile?.bundles ?? []).map(name => {
    const directory = runtime.boot.resolveBundleDir('dsh', name, runtime.anchor, profile);
    const manifest = runtime.boot.readProfileManifest('dsh', directory);
    const issue = runtime.boot.evaluatePluginCompatibility(manifest, exemptions);
    assert(!issue || issue.exempted, 'Resolve an incompatible existing bundle before replacing Auto.');
    assert(manifest.dsh?.bundle, 'An existing bundle has no bundle declaration.');
    return runtime.boot.bundlePatchPaths(directory, manifest.dsh.bundle).flatMap(filename => runtime.boot.loadOverlayPatches('dsh', filename));
  });
  const patches = runtime.boot.loadOptionalPatches('dsh', path.join(profile, 'cordis.patch.yml')) ?? [];
  const rows = flattened(runtime.boot.composeEntries([...layers, patches]));
  const targets = rows.filter(row => row.id === 'action-review');
  assert(targets.length <= 1 && targets.every(row => row.name === PACKAGE), 'The action-review id belongs to another component.');
  const tarball = fs.realpathSync(options.tarball);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'action-review-install-check-'));
  let manifest;
  try {
    const unpack = spawnSync('tar', ['-xzf', tarball, '-C', temporary], { encoding: 'utf8' });
    assert.equal(unpack.status, 0, 'The plugin archive cannot be read.');
    manifest = JSON.parse(fs.readFileSync(path.join(temporary, 'package/package.json'), 'utf8'));
    assert.equal(manifest.name, PACKAGE, 'The archive is not Action Review for DSH.');
    assert.equal(runtime.boot.evaluatePluginCompatibility(manifest), undefined, 'The archive is incompatible with this host.');
    for (const filename of ['dist/index.js', 'cordis.patch.yml']) assert(fs.existsSync(path.join(temporary, 'package', filename)), `The archive lacks ${filename}.`);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  const patch = read(path.join(profile, 'cordis.patch.yml'))?.toString('utf8') ?? '[]\n';
  assert(!/^\.\.\.\s*$/m.test(patch), 'An explicitly terminated YAML document must be normalized before installation.');
  return {
    profile, tarball, sha256: digest(fs.readFileSync(tarball)), version: manifest.version,
    before: state(profile), config: { mode: 'fixed', provider: options.provider, model: options.model, timeoutMs: 30000, contextBytes: 131072, metrics: options.metrics === true },
  };
}

function validateBackup(runtime, profile, backup, record) {
  const base = path.join(profile, '.action-review/backups');
  const relative = path.relative(base, fs.realpathSync(backup));
  assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'The backup is outside this profile backup directory.');
  assert.equal(record.profile, profile, 'This backup belongs to another profile.');
  assert.equal(typeof record.hadModules, 'boolean', 'The backup has no valid module-state record.');
  assert.equal(record.restored, false, 'The backup has already been restored.');
  assert(record.before && typeof record.before === 'object' && !Array.isArray(record.before), 'The backup has no configuration snapshot.');
  assert.deepEqual(Object.keys(record.before).sort(), [...CONFIG_FILES].sort(), 'The backup has unknown configuration files.');
  for (const name of CONFIG_FILES) {
    const content = record.before[name];
    assert(content === null || typeof content === 'string', 'The backup has an invalid file record.');
    if (content !== null) assert.equal(Buffer.from(content, 'base64').toString('base64'), content, 'The backup has invalid base64 file content.');
  }
  assert(typeof record.before['package.json'] === 'string', 'The backup has no package manifest.');
  const manifest = JSON.parse(Buffer.from(record.before['package.json'], 'base64').toString('utf8'));
  assert(manifest && typeof manifest === 'object' && !Array.isArray(manifest), 'The backup package manifest is invalid.');
  const yaml = runtime.load('yaml');
  for (const name of ['pnpm-lock.yaml', 'cordis.patch.yml']) {
    if (record.before[name] === null) continue;
    const document = yaml.parseDocument(Buffer.from(record.before[name], 'base64').toString('utf8'));
    assert.equal(document.errors.length, 0, 'A backup YAML file is invalid.');
    if (name === 'cordis.patch.yml') assert(yaml.isSeq(document.contents), 'The backup profile patch is not a sequence.');
  }
  const backupModules = path.join(backup, 'node_modules');
  if (record.hadModules) {
    assert(fs.existsSync(backupModules), 'The backup module directory is missing.');
    const stat = fs.lstatSync(backupModules);
    assert(stat.isDirectory() && !stat.isSymbolicLink(), 'The backup module directory must not be a symlink.');
    assert.equal(fs.realpathSync(backupModules), path.join(fs.realpathSync(backup), 'node_modules'), 'The backup module directory points outside its backup.');
  } else assert(!fs.existsSync(backupModules), 'The backup contains an unexpected module directory.');
}

async function restoreBackup(runtime, profile, backup) {
  const record = JSON.parse(fs.readFileSync(path.join(backup, 'record.json'), 'utf8'));
  validateBackup(runtime, profile, backup, record);
  const modules = path.join(profile, 'node_modules');
  if (fs.existsSync(modules)) fs.rmSync(modules, { recursive: true, force: true });
  if (record.hadModules) fs.renameSync(path.join(backup, 'node_modules'), modules);
  for (const name of CONFIG_FILES) {
    const content = record.before[name];
    const filename = path.join(profile, name);
    if (content === null) fs.rmSync(filename, { force: true });
    else await runtime.atomic.writeFileAtomic(filename, Buffer.from(content, 'base64'), { mode: 0o600 });
  }
  assert(sameState(profile, record.before), 'Restored profile configuration differs from its backup.');
  record.restored = true;
  fs.writeFileSync(path.join(backup, 'record.json'), JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
}

async function installPrepared(plan, runtime, { verifyClosed = () => assertAppClosed(runtime) } = {}) {
  verifyClosed();
  return runtime.atomic.withFileLock(path.join(plan.profile, 'package.json'), async () => {
    verifyClosed();
    assert(sameState(plan.profile, plan.before), 'The profile changed after the installation was prepared.');
    assert.equal(digest(fs.readFileSync(plan.tarball)), plan.sha256, 'The archive changed after inspection.');
    const manifestBefore = JSON.parse(Buffer.from(plan.before['package.json'], 'base64').toString('utf8'));
    const management = path.join(plan.profile, '.action-review');
    const packageDirectory = path.join(management, 'packages');
    for (const directory of [management, packageDirectory, path.join(management, 'backups')]) {
      if (fs.existsSync(directory)) assert(fs.lstatSync(directory).isDirectory() && !fs.lstatSync(directory).isSymbolicLink(), 'A plugin management directory must not be a symlink.');
      else fs.mkdirSync(directory, { mode: 0o700 });
    }
    const artifact = path.join(packageDirectory, plan.sha256 + '.tgz');
    const artifactCreated = !fs.existsSync(artifact);
    if (artifactCreated) fs.copyFileSync(plan.tarball, artifact);
    assert.equal(digest(fs.readFileSync(artifact)), plan.sha256);
    const backups = path.join(plan.profile, '.action-review/backups');
    fs.mkdirSync(backups, { recursive: true, mode: 0o700 });
    const backup = fs.mkdtempSync(path.join(backups, 'install-'));
    const modules = path.join(plan.profile, 'node_modules');
    const hadModules = fs.existsSync(modules);
    if (hadModules) {
      const cloned = spawnSync('/bin/cp', ['-cRp', modules, path.join(backup, 'node_modules')], { encoding: 'utf8' });
      if (cloned.status !== 0) {
        fs.rmSync(backup, { recursive: true, force: true });
        if (artifactCreated) fs.rmSync(artifact, { force: true });
        throw new Error('APFS clone backup is unavailable; no installation was attempted.');
      }
    }
    const record = { profile: plan.profile, before: plan.before, hadModules, artifact, sha256: plan.sha256, restored: false };
    fs.writeFileSync(path.join(backup, 'record.json'), JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
    try {
      const result = await runtime.operations.runProfilePnpm({ profile: path.basename(plan.profile), dir: plan.profile, installAnchor: runtime.anchor, cwd: plan.profile },
        ['add', artifact, '--offline', '--ignore-scripts', '--save-exact', '--config.auto-install-peers=false'], {
          execution: 'service', command: process.execPath, args: ['--expose-internals', runtime.pnpm],
          env: { ELECTRON_RUN_AS_NODE: '1' }, outputBytes: 16384, lockWaitMs: 1000,
          lookupTimeoutMs: 1000, idleTimeoutMs: 30000, activateNewBundles: true,
        });
      assert.equal(result.exitCode, 0, `Offline plugin installation failed; diagnostic: ${result.logPath}`);
      verifyClosed();
      const previous = plan.before['cordis.patch.yml'] === null ? '' : Buffer.from(plan.before['cordis.patch.yml'], 'base64').toString('utf8');
      const base = /^\s*(?:---\s*)?\[\]\s*$/.test(previous) ? '' : previous.trimEnd() + '\n';
      const override = `- id: auto-review\n  disabled: true\n- id: action-review\n  name: '${PACKAGE}'\n  disabled: false\n  config: ${JSON.stringify(plan.config)}\n`;
      await runtime.atomic.writeFileAtomic(path.join(plan.profile, 'cordis.patch.yml'), base + override, { mode: 0o600 });
      const loaded = runtime.boot.loadProfileDirectory('dsh', plan.profile, runtime.anchor);
      assert.deepEqual(loaded.skippedBundles, []);
      const rows = flattened(runtime.boot.composeEntries([loaded.layers.flatMap(layer => layer.patches), loaded.patches]));
      const own = rows.filter(row => row.id === 'action-review');
      assert.equal(own.length, 1); assert.equal(own[0].name, PACKAGE); assert.equal(own[0].disabled, false); assert.deepEqual(own[0].config, plan.config);
      assert(rows.filter(row => row.id === 'auto-review').every(row => row.disabled === true));
      const afterManifest = JSON.parse(fs.readFileSync(path.join(plan.profile, 'package.json'), 'utf8'));
      for (const [name, value] of Object.entries(manifestBefore.dependencies ?? {})) {
        if (name !== PACKAGE) assert.equal(afterManifest.dependencies[name], value, 'Another dependency changed.');
      }
      record.after = state(plan.profile);
      fs.writeFileSync(path.join(backup, 'record.json'), JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
      return { status: 'installed', profile: plan.profile, package: `${PACKAGE}@${plan.version}`, artifact, sha256: plan.sha256, backup, restart_required: true };
    } catch (error) {
      await restoreBackup(runtime, plan.profile, backup);
      if (artifactCreated) fs.rmSync(artifact, { force: true });
      throw error;
    }
  }, { waitMs: 1000 });
}

async function rollback(runtime, profile, backup, { verifyClosed = () => assertAppClosed(runtime) } = {}) {
  profile = fs.realpathSync(profile);
  backup = fs.realpathSync(backup);
  verifyClosed();
  return runtime.atomic.withFileLock(path.join(profile, 'package.json'), async () => {
    verifyClosed();
    const record = JSON.parse(fs.readFileSync(path.join(backup, 'record.json'), 'utf8'));
    assert(!record.restored && record.after, 'This backup does not describe an active successful installation.');
    assert(sameState(profile, record.after), 'The profile changed after installation; refusing to overwrite later changes.');
    await restoreBackup(runtime, profile, backup);
    return { status: 'restored', profile, backup };
  }, { waitMs: 1000 });
}

async function main() {
  const flags = process.argv.slice(2);
  const option = name => flags[flags.indexOf(name) + 1];
  assert(flags.includes('--app') && flags.includes('--profile'), 'Required: --app /absolute/App.app --profile /absolute/profile-directory');
  const app = path.resolve(option('--app'));
  if (!process.versions.electron) {
    const executable = path.join(app, 'Contents/MacOS', path.basename(app, '.app'));
    const run = spawnSync(executable, [__filename, ...flags], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit' });
    if (run.error) throw run.error;
    process.exitCode = run.status ?? 1;
    return;
  }
  const runtime = host(app);
  const profile = fs.realpathSync(option('--profile'));
  if (flags.includes('--rollback')) {
    assert(flags.includes('--apply'), 'Rollback requires --apply.');
    console.log(JSON.stringify(await rollback(runtime, profile, fs.realpathSync(option('--rollback'))), null, 2));
    return;
  }
  assert(flags.includes('--tarball') && flags.includes('--provider') && flags.includes('--model'), 'Required: --tarball /absolute/plugin.tgz --provider provider-id --model model-id --replace-auto');
  const plan = planInstall({ app, profile, tarball: option('--tarball'), provider: option('--provider'), model: option('--model'), replaceAuto: flags.includes('--replace-auto'), metrics: flags.includes('--metrics') }, runtime);
  if (!flags.includes('--apply')) {
    console.log(JSON.stringify({ status: 'preview', profile: plan.profile, package: `${PACKAGE}@${plan.version}`, sha256: plan.sha256, config: plan.config, changes: ['native package-manager install of local tarball with lockfile', 'disable auto-review component', 'enable action-review component', 'APFS clone backup before installation'], working_profile_changed: false }, null, 2));
    return;
  }
  console.log(JSON.stringify(await installPrepared(plan, runtime), null, 2));
}

module.exports = { host, assertAppClosed, planInstall, installPrepared, rollback, state };
if (require.main === module) main().catch(error => { console.error(error.stack ?? String(error)); process.exitCode = 1; });
