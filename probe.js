/**
 * Import-resolution probe and opt-in self-check.
 *
 * A deliberately inert Host row whose whole purpose is to make a composition
 * prove — before any row that would displace the working shell, filesystem,
 * workspace, or picker stack is switched on — that a profile-installed bundle
 * can do two things:
 *
 * 1. resolve `@deepseek-ai/*` specifiers from the installation, and
 * 2. load every real module this bundle ships.
 *
 * Every real module is imported *statically* but never applied: their only side
 * effect lives inside `apply()`, so importing them proves the whole import graph
 * (including every shipped package they need) resolves without registering
 * anything. The registered `wslProbe` service is the evidence — it exists only
 * if the module loaded, which happens only if everything above it resolved.
 *
 * With `selfCheck: true` (off by default; the row's own config) the probe also
 * exercises the three providers end to end inside a running Harness — write and
 * read a file through `ctx.fs`, register a Linux Workspace through
 * `ctx.workspaceRegistry`, and list directories through `ctx.directoryPicker` —
 * and logs one JSON line with the result. That is how a wiring bug is caught
 * without a human clicking through the GUI.
 * @module @local/dsh-wsl-bridge/probe
 */
import { Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local';
import { ShellExecutor } from '@deepseek-ai/dsh-shell';
import BrowseDirectoryPicker from '@deepseek-ai/dsh-host-directory-picker-browse';
import { FsError, FileSystem } from '@deepseek-ai/dsh-fs';
import { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace';
import { buildWslenv, toLinuxPath } from './wsl.js';
import { mirrorToLinux } from './mirror.js';
import { shellQuote } from './guest.js';
import * as executor from './index.js';
import * as picker from './picker.js';
import * as fsProvider from './fs.js';
import * as workspaceProvider from './workspace.js';
import * as searchProvider from './search.js';

/** Cordis plugin name. */
const name = 'wsl-probe';
/** No service dependency: the probe must be loadable on its own. */
const inject = [];

/** Row configuration: the import pre-flight, plus an opt-in end-to-end self-check. */
const Config = z.object({
	selfCheck: z.boolean().default(false).description('Also exercise ctx.fs, ctx.workspaceRegistry, and ctx.directoryPicker once, and log the result.'),
	selfCheckRoot: z.string().default('/tmp').description('Guest directory the self-check creates its fixtures under.')
});

/**
 * Exercise the three providers the way a real session would.
 * @param scope - a context in which `fs`, `workspaceRegistry`, and `directoryPicker` are all active.
 * @param root - guest directory to build the fixture in.
 * @returns the observed result.
 */
async function selfCheck(scope, root) {
	const fixture = `${root.replace(/\/+$/u, '')}/dsh-wsl-selfcheck-${process.pid}`;
	const file = await scope.fs.resolve(`${fixture}/hello.txt`);
	const written = await scope.fs.writeText(file, 'hello from the wsl bridge self-check\n', { kind: 'createIfAbsent' }, undefined, undefined);
	const stat = await scope.fs.stat(file);
	const text = await scope.fs.readText(file);
	const listing = await scope.fs.listDir(await scope.fs.resolve(fixture));
	const workspace = await scope.workspaceRegistry.create(fixture, 'wsl-selfcheck');
	const resumed = await scope.workspaceRegistry.resolveByPath(fixture);
	const status = await workspace.status();
	const capability = scope.directoryPicker.capability();
	const guestRoot = await capability.list(root, undefined);
	const fixtureLevel = await capability.list(fixture, undefined);
	const nested = await capability.createDirectory(fixture, 'nested');
	const second = await scope.fs.resolve(`${fixture}/second.txt`);
	await scope.fs.writeText(second, 'hello again from the search self-check\n', { kind: 'createIfAbsent' }, undefined, undefined);
	const search = await searchCheck(scope, fixture);
	return {
		fixture,
		fs: {
			operation: written.operation,
			version: stat?.version,
			type: stat?.type,
			content: text.trim(),
			children: listing.map((entry) => entry.name),
			processPath: scope.fs.processPath(file)
		},
		registry: {
			path: workspace.path,
			id: String(workspace.id),
			resumedSameEntity: resumed !== undefined && String(resumed.id) === String(workspace.id),
			status,
			all: scope.workspaceRegistry.list().map((entry) => entry.path)
		},
		picker: {
			kind: capability.kind,
			home: guestRoot.home,
			rootEntries: guestRoot.entries.slice(0, 3).map((entry) => entry.path),
			fixtureEntries: fixtureLevel.entries.map((entry) => entry.path),
			crumbs: fixtureLevel.crumbs.map((crumb) => crumb.path),
			created: nested
		},
		search
	};
}

/**
 * Exercise both guest-native search tools through their registered definitions:
 * a captured context receives the `defineTool` objects, and each is executed and
 * rendered exactly as the model would receive it. Without a model this is the
 * strongest check available — argument schema, guest script, stream parser, and
 * model-facing text in one pass — so a `\` or a drive letter anywhere in the
 * result is caught at boot.
 * @param scope - the self-check scope, used to read every rendered path back.
 * @param fixture - the guest fixture directory the self-check created.
 * @returns the rendered text, the totals, and the round-trip verdicts.
 */
async function searchCheck(scope, fixture) {
	const registered = new Map();
	const captured = {
		tools: {
			register: (tool) => registered.set(tool.name, tool),
			get: () => undefined
		},
		systemPrompt: {
			section: () => {},
			getSectionOrder: () => 0
		},
		logger: { warn: () => {} },
		get: () => undefined
	};
	searchProvider.apply(captured, {
		distro: '',
		wslPath: '',
		timeoutMs: 30000,
		globMaxResults: 1,
		grepMaxMatches: 250,
		grepMaxLineBytes: 2000,
		searchMetaMaxBytes: 65536,
		rawOutputMaxBytes: 2e7
	});
	/* Display paths are relative to this, so the round trip below resolves them back. */
	const base = fixture.replace(/\/[^/]+$/u, '');
	const exec = { callId: 'self-check', agent: { session: { header: { cwd: base } } } };
	const globTool = registered.get('glob');
	const grepTool = registered.get('grep');
	const globValue = await globTool.execute({ pattern: '*.txt', path: fixture }, { ...exec, name: 'glob' });
	const grepValue = await grepTool.execute({ pattern: 'hello', path: fixture }, { ...exec, name: 'grep' });
	const globText = globTool.output.render({ pattern: '*.txt' }, globValue)[0].text;
	const grepText = grepTool.output.render({ pattern: 'hello' }, grepValue)[0].text;
	const windowsSpelling = (text) => text.includes('\\') || /[A-Za-z]:[\\/]/u.test(text) || text.includes('\\\\wsl');
	let roundTrip = true;
	for (const display of globValue.paths) {
		try {
			const absolute = display.startsWith('/') ? display : `${base}/${display}`;
			roundTrip = roundTrip && (await scope.fs.readText(await scope.fs.resolve(absolute))).length > 0;
		} catch {
			roundTrip = false;
		}
	}
	return {
		globText,
		globPaths: globValue.paths,
		globTotal: globValue.total,
		globLinuxOnly: !windowsSpelling(globText),
		globRoundTrip: roundTrip,
		grepText,
		grepMatches: grepValue.matches.length,
		grepTotal: grepValue.total,
		grepLinuxOnly: !windowsSpelling(grepText)
	};
}

/** The evidence service: its existence means every import in this module resolved. */
class WslProbe extends Service {
	constructor(ctx, config) {
		super(ctx, 'wslProbe');
		this.config = config;
	}
	/** Bindings and module exports the pre-flight established. */
	report() {
		return {
			cordisService: typeof Service,
			schemastery: typeof z?.object,
			localBashExecutor: typeof LocalBashExecutor,
			shellExecutor: typeof ShellExecutor,
			browseDirectoryPicker: typeof BrowseDirectoryPicker,
			wslHelper: typeof toLinuxPath === 'function' && typeof buildWslenv === 'function',
			executorApply: typeof executor.apply,
			pickerApply: typeof picker.apply,
			fsSeam: typeof FileSystem === 'function' && typeof FsError === 'function',
			fsApply: typeof fsProvider.apply,
			workspaceApply: typeof workspaceProvider.apply,
			workspaceRegistrySeam: typeof WorkspaceRegistry === 'function',
			workspaceSubclass: Object.getPrototypeOf(workspaceProvider.WslWorkspaceRegistry.prototype) === WorkspaceRegistry.prototype,
			searchApply: typeof searchProvider.apply,
			translation: toLinuxPath('\\\\wsl.localhost\\Ubuntu\\home\\you', 'Ubuntu'),
			mirrorTranslation: mirrorToLinux('D:\\home\\you'),
			quoting: shellQuote("a'b")
		};
	}
}

/** Register the probe service; the loader row's activation is the measurement. */
function apply(ctx, config) {
	new WslProbe(ctx, config);
	if (config?.selfCheck !== true) return;
	/* The result goes to stdout as well as the logger: an opt-in diagnostic is
	   read from a captured console, and the Harness logger has no level that is
	   guaranteed to reach a file. */
	const say = (line) => {
		ctx.logger.info(line);
		console.log(line);
	};
	say('wsl self-check: armed');
	ctx.inject(['fs', 'workspaceRegistry', 'directoryPicker'], (scope) => {
		say('wsl self-check: services acquired');
		void selfCheck(scope, config.selfCheckRoot)
			.then((result) => say(`wsl self-check: ${JSON.stringify(result)}`))
			.catch((error) => {
				ctx.logger.error(String(error));
				console.log(`wsl self-check failed: ${error?.stack ?? String(error)}`);
			});
	});
}

export { Config, apply, inject, name };
