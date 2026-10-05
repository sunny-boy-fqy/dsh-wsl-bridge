/**
 * Cordis row that registers the guest-native `glob` and `grep` tools in place
 * of the shipped `@deepseek-ai/dsh-tool-fs-search` row (which the bundle patch
 * disables). Every rule that decides what the model reads — path spelling, the
 * guest scripts, the stream parsers, the renderers — lives in `./search-core.js`
 * so it can be exercised without a Harness runtime. This module owns only what
 * needs the runtime: the config schema, the optional spill handoff, and the two
 * `defineTool` registrations.
 * @module @local/dsh-wsl-bridge/search
 */
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { toLinuxPath } from './wsl.js';
import { guestRun } from './guest.js';
import {
	GLOB_MAX_RESULTS,
	GREP_MAX_LINE_BYTES,
	GREP_MAX_MATCHES,
	expandBraces,
	globMeta,
	globScript,
	groupMatches,
	grepMeta,
	grepScript,
	linuxDisplay,
	parseGlobRecords,
	parseGrepRecords,
	previewLine,
	renderGlob,
	renderGrep,
	resolveSearchTarget,
	validateInclude
} from './search-core.js';

/** Cordis plugin name. */
const name = 'wsl-search';
/** Tools-based plugin: the registry and the prompt, and no subprocess at all. */
const inject = ['tools', 'systemPrompt'];

const Config = z.object({
	distro: z.string().default('').description('WSL distribution to search in; empty uses the WSL default distribution.'),
	wslPath: z.string().default('').description('Absolute path of wsl.exe; empty resolves %SystemRoot%\\System32\\wsl.exe.'),
	timeoutMs: z.number().default(30000).description('Per-search deadline in milliseconds.'),
	globMaxResults: z.number().default(GLOB_MAX_RESULTS).description('Paths one glob call returns before the rest move to the spill file.'),
	grepMaxMatches: z.number().default(GREP_MAX_MATCHES).description('Matches one grep call returns before the rest move to the spill file.'),
	grepMaxLineBytes: z.number().default(GREP_MAX_LINE_BYTES).description('Byte bound on one matched-line preview.'),
	searchMetaMaxBytes: z.number().default(65536).description('Byte bound on one search card payload.'),
	rawOutputMaxBytes: z.number().default(2e7).description('Byte bound on one guest search run.')
});

/**
 * Save one complete result through the optional spill backend and return the
 * **Linux** spelling of its locator. The shipped row prints the locator verbatim
 * — a Windows path the model cannot `read` — so the locator is translated here
 * and dropped when no Linux spelling exists. A missing backend never fails a
 * search: the inline page is kept and only the recovery hint changes.
 * @param ctx - the plugin context; `spillStore` is read opportunistically.
 * @param exec - the tool execution supplying session, tool name, and call id.
 * @param suggestedName - the backend-sanitized filename hint.
 * @param content - the complete result to persist.
 * @param distro - the target distribution, for translating the locator.
 * @returns the Linux locator, or undefined when the result could not be saved.
 */
async function spillResult(ctx, exec, suggestedName, content, distro) {
	const sessionId = exec?.agent?.session?.header?.id;
	const spillStore = ctx.get('spillStore');
	if (sessionId === undefined || spillStore === undefined) {
		ctx.logger.warn(`wsl-search: no spill backend for ${exec?.name ?? 'search'}; complete result not saved`);
		return undefined;
	}
	try {
		const saved = await spillStore.saveText({
			owner: { sessionId },
			source: { kind: 'tool', toolName: exec.name, callId: exec.callId, label: 'result' },
			suggestedName,
			content
		});
		const locator = saved?.locator;
		if (typeof locator !== 'string' || locator.length === 0) return undefined;
		if (locator.startsWith('/')) return locator;
		return toLinuxPath(locator, distro);
	} catch (error) {
		ctx.logger.warn(`wsl-search: saveText failed for ${exec?.name ?? 'search'}: ${String(error)}`);
		return undefined;
	}
}

/**
 * The plugin body: register both guest-native search tools in this scope.
 * @param ctx - the Cordis context of the preset that mounts this row.
 * @param config - the row's resolved configuration.
 */
function apply(ctx, config) {
	const caps = {
		maxResults: config.globMaxResults,
		maxMatches: config.grepMaxMatches,
		maxLineBytes: config.grepMaxLineBytes,
		maxMetaBytes: config.searchMetaMaxBytes,
		maxOutputBytes: config.rawOutputMaxBytes,
		timeoutMs: config.timeoutMs
	};
	for (const [label, value] of [['globMaxResults', caps.maxResults], ['grepMaxMatches', caps.maxMatches], ['grepMaxLineBytes', caps.maxLineBytes], ['searchMetaMaxBytes', caps.maxMetaBytes], ['rawOutputMaxBytes', caps.maxOutputBytes]]) {
		if (!Number.isInteger(value) || value <= 0) throw new Error(`tool-fs-search: ${label} must be a positive integer`);
	}
	const options = { distro: config.distro, wslPath: config.wslPath, timeoutMs: caps.timeoutMs, maxOutputBytes: caps.maxOutputBytes };
	const cwdOf = (exec) => exec?.agent?.session?.header?.cwd;

	ctx.systemPrompt.section({
		name: 'tool:glob',
		order: ctx.systemPrompt.getSectionOrder('TOOL_GLOB'),
		text: ({ scope }) => ctx.tools.get('glob', scope) === undefined ? '' : 'Use the glob tool — not shell find — to discover files by path pattern.'
	});
	ctx.systemPrompt.section({
		name: 'tool:grep',
		order: ctx.systemPrompt.getSectionOrder('TOOL_GREP'),
		text: ({ scope }) => ctx.tools.get('grep', scope) === undefined ? ''
			: `Use the grep tool — not shell grep or rg — to search file contents.${ctx.tools.get('read', scope) === undefined ? '' : ' Use read on a matched file when you need surrounding context.'}`
	});

	ctx.tools.register(defineTool({
		name: 'glob',
		description: `Find files, not directories, whose paths match a glob pattern, including hidden and ignored files. Returns up to ${caps.maxResults} paths in modification-time order as Linux paths; a larger result reports where the complete list was saved.`,
		parameters: {
			pattern: {
				type: 'string',
				required: true,
				description: 'Glob pattern to match file paths against (e.g. "**/*.ts", "src/**/*.test.js"). A pattern with no "/" matches the basename at any depth, so "*" and "*.ts" both search the whole tree; include a separator to anchor the depth.'
			},
			path: {
				type: 'string',
				description: 'Directory to search in. Defaults to the session workspace; a relative path resolves against it.'
			}
		},
		timeoutMs: caps.timeoutMs,
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					root: { type: 'string', required: true },
					paths: { type: 'array', required: true, items: { type: 'string' } },
					total: { type: 'integer', required: true },
					locator: { type: 'string' }
				}
			},
			render: (_args, value) => [{ type: 'text', text: renderGlob(value.paths, value.total, value.locator) }],
			presentationMeta: (_args, value) => globMeta(value.paths, value.total, caps.maxMetaBytes)
		},
		async execute(args, exec) {
			const pattern = typeof args.pattern === 'string' ? args.pattern.trim() : '';
			if (pattern.length === 0) throw new Error('pattern must be a non-empty string');
			if (args.path !== undefined && (typeof args.path !== 'string' || args.path.trim().length === 0)) throw new Error('path must be a non-empty string when given');
			const cwd = cwdOf(exec);
			const root = resolveSearchTarget(cwd, args.path, config.distro);
			let run;
			try {
				run = await guestRun(options, globScript(root, pattern), exec?.signal);
			} catch (error) {
				throw new Error(`glob could not complete its guest search: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
			}
			if (run.code === 3) throw new Error(`glob search failed: ${root} is not a directory`);
			if (run.code !== 0) {
				const detail = run.stderr.toString('utf8').trim().split(/\r?\n/u).pop() ?? '';
				throw new Error(`glob search failed (exit ${run.code})${detail.length > 0 ? `: ${detail}` : ''}`);
			}
			const all = parseGlobRecords(run.stdout.toString('utf8')).map((record) => linuxDisplay(record.path, cwd));
			const page = all.slice(0, caps.maxResults);
			let locator;
			if (all.length > caps.maxResults) locator = await spillResult(ctx, exec, 'glob-results.txt', all.join('\n'), config.distro);
			return { root: args.path === undefined ? '.' : linuxDisplay(root, cwd), paths: page, total: all.length, ...locator === undefined ? {} : { locator } };
		},
		presentCall: (args) => ({
			card: 'generic',
			title: `Glob ${args.pattern}${args.path === undefined ? '' : ` in ${args.path}`}`,
			kind: 'search',
			rawInput: args.pattern
		})
	}));

	ctx.tools.register(defineTool({
		name: 'grep',
		description: `Search file contents with an extended regular expression. Returns matching lines with line numbers, grouped by file, as Linux paths. Returns up to ${caps.maxMatches} matches; a larger result reports where the complete match list was saved.`,
		parameters: {
			pattern: {
				type: 'string',
				required: true,
				description: 'Regular expression to search for (POSIX extended regular expression syntax).'
			},
			path: {
				type: 'string',
				description: 'File or directory to search. Defaults to the session workspace; a relative path resolves against it.'
			},
			include: {
				type: 'string',
				description: 'One glob filter for which files to search (e.g. "*.ts", "*.{js,jsx}"). Not a list; negation is not supported.'
			}
		},
		timeoutMs: caps.timeoutMs,
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					matches: {
						type: 'array',
						required: true,
						items: {
							type: 'object',
							additionalProperties: false,
							properties: {
								path: { type: 'string', required: true },
								lineNumber: { type: 'integer', required: true },
								line: { type: 'string', required: true }
							}
						}
					},
					total: { type: 'integer', required: true },
					locator: { type: 'string' }
				}
			},
			render: (_args, value) => [{ type: 'text', text: renderGrep(value.matches, value.total, value.locator) }],
			presentationMeta: (_args, value) => grepMeta(value.matches, value.total, caps.maxMetaBytes)
		},
		async execute(args, exec) {
			if (typeof args.pattern !== 'string' || args.pattern.length === 0) throw new Error('pattern must be a non-empty string');
			if (args.path !== undefined && (typeof args.path !== 'string' || args.path.trim().length === 0)) throw new Error('path must be a non-empty string when given');
			const include = validateInclude(args.include);
			const cwd = cwdOf(exec);
			const root = resolveSearchTarget(cwd, args.path, config.distro);
			const includes = include === undefined ? [] : expandBraces(include);
			let run;
			try {
				run = await guestRun(options, grepScript(root, args.pattern, includes), exec?.signal);
			} catch (error) {
				throw new Error(`grep could not complete its guest search: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
			}
			if (run.code === 1) return { matches: [], total: 0 };
			if (run.code !== 0) {
				const detail = run.stderr.toString('utf8').trim().split(/\r?\n/u).pop() ?? '';
				throw new Error(`grep search failed (exit ${run.code})${detail.length > 0 ? `: ${detail}` : ''}`);
			}
			const all = parseGrepRecords(run.stdout.toString('utf8')).map((match) => ({
				path: linuxDisplay(match.path, cwd),
				lineNumber: match.lineNumber,
				line: match.line
			}));
			const page = all.slice(0, caps.maxMatches).map((match) => ({ ...match, line: previewLine(match.line, caps.maxLineBytes) }));
			let locator;
			if (all.length > caps.maxMatches) {
				const previewed = all.map((match) => ({ ...match, line: previewLine(match.line, caps.maxLineBytes) }));
				const body = groupMatches(previewed).map((group) => `${group.path}\n${group.matches.map((match) => `Line ${match.lineNumber}: ${match.line}`).join('\n')}`).join('\n\n');
				locator = await spillResult(ctx, exec, 'grep-results.txt', `Found ${all.length} ${all.length === 1 ? 'match' : 'matches'}\n\n${body}`, config.distro);
			}
			return { matches: page, total: all.length, ...locator === undefined ? {} : { locator } };
		},
		presentCall: (args) => ({
			card: 'generic',
			title: `Grep ${args.pattern}${args.path === undefined ? '' : ` in ${args.path}`}${args.include === undefined ? '' : ` (${args.include})`}`,
			kind: 'search',
			rawInput: args.pattern
		})
	}));
}

export { Config, apply, inject, name };
