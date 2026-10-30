const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');

const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const app = option('--app');
const tarball = option('--tarball');
if (!app || !tarball) {
  process.stderr.write('Usage: node scripts/check-lifecycle.cjs --app /absolute/path/App.app --tarball /absolute/path/plugin.tgz\n');
  process.exit(2);
}
const appPath = path.resolve(app);
const archive = path.resolve(tarball);
if (!process.versions.electron) {
  const executable = path.join(appPath, 'Contents/MacOS', path.basename(appPath, '.app'));
  const run = spawnSync(executable, [__filename, '--app', appPath, '--tarball', archive], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit',
  });
  if (run.error) throw run.error;
  process.exit(run.status ?? 1);
}
const installation = path.join(appPath, 'Contents/Resources/app.asar/dsh');
const anchor = path.join(installation, 'package.json');
const load = createRequire(path.join(installation, 'node_modules/__action_review_lifecycle_check.cjs'));
const boot = load('@deepseek-ai/dsh-app-boot');
const { Session } = load('@deepseek-ai/dsh-session');
const { SessionProjectionRegistry } = load('@deepseek-ai/dsh-session-projection');
const { PermissionPresetService } = load('@deepseek-ai/dsh-permission-presets');
const { ApprovalService } = load('@deepseek-ai/dsh-user-approval');
const { SystemPrompt } = load('@deepseek-ai/dsh-system-prompt');
const { ToolRuntime, defineTool } = load('@deepseek-ai/dsh-tools');
const { createScope } = load('@deepseek-ai/dsh-scope');
const { createUserMessage } = load('@deepseek-ai/dsh-llm');
const tick = () => new Promise(setImmediate);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'action-review-lifecycle-'));

(async () => {
  let ctx;
  const scopes = [];
  try {
    const unpacked = path.join(temporary, 'unpacked');
    fs.mkdirSync(unpacked);
    const extracted = spawnSync('tar', ['-xzf', archive, '-C', unpacked], { encoding: 'utf8' });
    if (extracted.status !== 0) throw new Error(extracted.stderr || 'Could not unpack the test tarball.');
    const manifest = JSON.parse(fs.readFileSync(path.join(unpacked, 'package/package.json'), 'utf8'));
    assert.equal(manifest.name, 'dsh-action-review');
    assert.equal(boot.evaluatePluginCompatibility(manifest), undefined);
    const profile = path.join(temporary, 'profiles/check');
    const packageDirectory = path.join(profile, 'node_modules', manifest.name);
    fs.mkdirSync(path.dirname(packageDirectory), { recursive: true });
    fs.renameSync(path.join(unpacked, 'package'), packageDirectory);
    const profileManifest = { name: 'lifecycle-check-profile', private: true, dependencies: { [manifest.name]: 'file:' + archive }, dsh: { profile: { bundles: [manifest.name] } } };
    boot.writeProfileManifest(profile, profileManifest);
    const configPath = path.join(temporary, 'root.yml');
    fs.writeFileSync(configPath, '[]\n');
    const profileContext = { dir: profile, installAnchor: anchor, home: temporary, patchPath: path.join(profile, 'cordis.patch.yml'), overlays: [] };
    const loaded = boot.loadProfileDirectory('dsh', profile, anchor);
    const resolution = await boot.createRuntimeResolution({ installAnchor: anchor, profile: loaded, home: temporary });
    const sessions = [];
    let bodies = 0;
    let modelHold;
    let approvalHold;
    let verdict = 'allow';
    const modelCalls = [];
    const approvalCalls = [];
    ctx = await boot.boot('dsh', configPath, boot.readBundlePatches('dsh', profileContext, loaded), async root => {
      root.provide('profileContext', profileContext);
      await root.plugin(boot.PluginPackages, { resolution });
      await Promise.all([root.plugin(SystemPrompt, {}), root.plugin(ToolRuntime, {}), root.plugin(ApprovalService, { policy: 'ask' }), root.plugin(SessionProjectionRegistry, {})].map(service => service.await()));
      root.provide('shell', { sandboxMode: 'workspace-write' });
      root.provide('sessions', { list: () => sessions });
      await root.plugin(PermissionPresetService, {});
      root.provide('llm', { async *stream(options) {
        const request = JSON.parse(options.messages[0].content[0].text);
        modelCalls.push({ options, request });
        const held = modelHold;
        modelHold = undefined;
        if (held) await held.promise;
        const response = { protocol_version: 1, request_id: request.request_id, snapshot_id: request.action.snapshot_id, policy: request.policy, status: 'result', decision: verdict, reason: 'Synthetic lifecycle decision.', authority_refs: request.authority.map(item => item.id), evidence_refs: [] };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify(response) } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      } });
      root.on('approval/request', async request => { approvalCalls.push(request); return approvalHold ? approvalHold.promise : 'allowed-once'; });
    }, pathToFileURL(path.join(profile, 'package.json')).href);
    const entry = () => [...ctx.loader.entries()].find(row => row.options.id === 'action-review');
    const autoAvailable = () => ctx.permissionPresets.catalog().options.some(item => item.value === 'auto');
    const patches = () => boot.readBundlePatches('dsh', profileContext);
    const recompose = async () => {
      const result = await boot.recomposeProfile(ctx, patches(), 'dsh');
      assert.equal(result.restartReason, undefined);
      assert.deepEqual(result.warnings, []);
    };
    const register = id => {
      const session = Session.create(id);
      sessions.push(session);
      ctx.permissionPresets.pinInitialPermission(session);
      session.append('turn/start', { turn: 1 });
      session.append('step/start', { turn: 1, step: 1 });
      session.append('request/header', { header: { config: { provider: 'synthetic-provider', model: 'synthetic-model' } } });
      session.append('user/message', createUserMessage({ source: { kind: 'user', rpcId: 'synthetic-human' }, content: [{ type: 'text', text: 'Inspect this synthetic in-memory counter.' }] }), { surfaceOp: 'append' });
      const agent = { session };
      const scope = createScope(ctx, agent);
      agent.ctx = scope.ctx;
      scopes.push(scope);
      scope.ctx.get('tools').register(defineTool({ name: 'lifecycle_counter', description: 'Increment a synthetic in-memory counter without filesystem or external effects.', parameters: {}, output: { schema: { type: 'number' }, render: (_, value) => [{ type: 'text', text: String(value) }] }, execute: async () => ++bodies }));
      return agent;
    };
    const main = register('lifecycle-main');
    const baseline = register('lifecycle-explicit-full-access');
    ctx.permissionPresets.set(baseline.session, 'danger-full-access');
    let callId = 0;
    const call = () => main.ctx.get('tools').execute({ agent: main, name: 'lifecycle_counter', arguments: {}, callId: 'lifecycle-call-' + (++callId), signal: new AbortController().signal });
    const assertStopped = () => {
      assert.equal(autoAvailable(), false);
      assert.equal(ctx.permissionPresets.current(main.session), 'workspace-write');
      assert.equal(ctx.permissionPresets.current(baseline.session), 'danger-full-access');
    };
    assert(entry()?.fiber && entry().fiber.state === 2, 'The real Loader did not start the component.');
    assert.equal(autoAvailable(), true);
    ctx.permissionPresets.set(main.session, 'auto');
    await call();
    assert.equal(bodies, 1);
    const checks = ['tarball component activated through real boot, Loader and root Include'];

    modelHold = Promise.withResolvers();
    const lateModel = modelHold;
    const pendingModel = call();
    await tick();
    const modelSignal = modelCalls.at(-1).options.signal;
    await boot.reconcileProfilePatches(ctx, [...patches(), { id: 'action-review', disabled: true }], 'dsh');
    await pendingModel;
    lateModel.resolve();
    await tick();
    assert(modelSignal.aborted);
    assert.equal(bodies, 1);
    assert.equal(entry().options.disabled, true);
    assertStopped();
    checks.push('component disabled through public patch reconciliation cancels pending model and restores Workspace Write');

    await boot.reconcileProfilePatches(ctx, patches(), 'dsh', ['action-review']);
    assert(entry()?.fiber && entry().fiber.state === 2);
    assert.equal(autoAvailable(), true);
    ctx.permissionPresets.set(main.session, 'auto');
    await call();
    assert.equal(bodies, 2);
    checks.push('component re-enabled through the root Include runs correctly without a process restart');

    verdict = 'ask';
    approvalHold = Promise.withResolvers();
    const lateApproval = approvalHold;
    const pendingHuman = call();
    await tick();
    const humanSignal = approvalCalls.at(-1).signal;
    boot.writeProfileBundles(profile, boot.readProfileManifest('dsh', profile), []);
    await recompose();
    await pendingHuman;
    lateApproval.resolve('allowed-once');
    await tick();
    assert(humanSignal.aborted);
    assert.equal(bodies, 2);
    assert.equal(entry(), undefined);
    assertStopped();
    checks.push('upper plugin bundle disabled through manifest and public recomposition cancels pending approval; late consent cannot execute');

    approvalHold = undefined;
    verdict = 'allow';
    boot.writeProfileBundles(profile, boot.readProfileManifest('dsh', profile), [manifest.name]);
    await recompose();
    assert(entry()?.fiber && entry().fiber.state === 2);
    assert.equal(autoAvailable(), true);
    ctx.permissionPresets.set(main.session, 'auto');
    await call();
    assert.equal(bodies, 3);
    checks.push('upper plugin bundle re-enabled through public recomposition recreates the live Auto integration');

    const location = { binName: 'dsh', profileDir: profile, installAnchor: anchor };
    const before = boot.readProfilePlugins(location);
    const removed = boot.readProfileManifest('dsh', profile);
    delete removed.dependencies[manifest.name];
    boot.writeProfileManifest(profile, removed);
    const reconciled = boot.reconcileProfilePlugins({ ...location, before, preserveDisabled: true });
    assert(!reconciled.plugins.manifest.dsh.profile.bundles.includes(manifest.name));
    await recompose();
    fs.rmSync(packageDirectory, { recursive: true, force: true });
    assert.equal(entry(), undefined);
    assertStopped();
    assert.equal(boot.readProfilePlugins(location).dependencies.length, 0);
    checks.push('dependency removal with public plugin reconciliation and recomposition unloads the component before package cleanup');
    checks.push('every lifecycle transition preserves an explicitly selected Full access session and never silently broadens former Auto sessions');

    console.log(JSON.stringify({ status: 'passed', host: boot.getDshRuntimeVersion(), package: `${manifest.name}@${manifest.version}`, checks, synthetic_model_calls: modelCalls.length, synthetic_bodies: bodies, synthetic_approval_calls: approvalCalls.length, model_requests: 0, working_profile_changed: false, coverage: 'Real tarball, app boot, Loader/root Include and public component/bundle/dependency reconciliation. No UI or package-manager subprocess was used.' }, null, 2));
  } finally {
    for (const scope of scopes.reverse()) await scope.dispose();
    await ctx?.fiber.dispose();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error.stack ?? String(error));
  process.exitCode = 1;
});
