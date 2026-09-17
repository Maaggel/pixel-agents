const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const daemonOnly = process.argv.includes('--daemon-only');

/**
 * Copy assets folder to dist/assets
 */
function copyAssets() {
	const srcDir = path.join(__dirname, 'webview-ui', 'public', 'assets');
	const dstDir = path.join(__dirname, 'dist', 'assets');

	if (fs.existsSync(srcDir)) {
		// Remove existing dist/assets if present
		if (fs.existsSync(dstDir)) {
			fs.rmSync(dstDir, { recursive: true });
		}

		// Copy recursively
		fs.cpSync(srcDir, dstDir, { recursive: true });
		console.log('✓ Copied assets/ → dist/assets/');
	} else {
		console.log('ℹ️  assets/ folder not found (optional)');
	}
}

/**
 * Bundle the standalone server into dist/standalone-server.cjs
 * so it can run from an installed VSIX without node_modules.
 */
async function bundleStandalone() {
	// Read BUILD_NUMBER from src/constants.ts to inject at build time
	const constSrc = fs.readFileSync(path.join(__dirname, 'src', 'constants.ts'), 'utf-8');
	const buildMatch = constSrc.match(/BUILD_NUMBER\s*=\s*(\d+)/);
	const buildNumber = buildMatch ? buildMatch[1] : '0';

	await esbuild.build({
		entryPoints: ['standalone/server.mjs'],
		bundle: true,
		format: 'cjs',
		minify: production,
		platform: 'node',
		outfile: 'dist/standalone-server.cjs',
		logLevel: 'silent',
		// Define import.meta.dirname for CJS output
		define: {
			'import.meta.dirname': '__dirname',
			'__INJECTED_BUILD_NUMBER__': JSON.stringify(buildNumber),
		},
	});
	console.log('✓ Bundled standalone/server.mjs → dist/standalone-server.cjs');
}

/**
 * Bundle the headless daemon into dist/pixel-agents-daemon.cjs.
 * 'vscode' is deliberately NOT external here — if any backend module
 * imports it, this build fails, which is the guard we want.
 * 'ws' IS bundled so the file is fully self-contained on Node 18/20
 * (Node 22+ uses the global WebSocket and never touches it).
 */
async function bundleDaemon() {
	await esbuild.build({
		entryPoints: ['src/daemon.ts'],
		bundle: true,
		format: 'cjs',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'node',
		outfile: 'dist/pixel-agents-daemon.cjs',
		logLevel: 'silent',
		banner: { js: '#!/usr/bin/env node' },
	});
	fs.chmodSync('dist/pixel-agents-daemon.cjs', 0o755);
	console.log('✓ Bundled src/daemon.ts → dist/pixel-agents-daemon.cjs');
}

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',

	setup(build) {
		build.onStart(() => {
			console.log('[watch] build started');
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				console.error(`    ${location.file}:${location.line}:${location.column}:`);
			});
			console.log('[watch] build finished');
		});
	},
};

async function main() {
	if (daemonOnly) {
		await bundleDaemon();
		return;
	}
	const ctx = await esbuild.context({
		entryPoints: [
			'src/extension.ts'
		],
		bundle: true,
		format: 'cjs',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'node',
		outfile: 'dist/extension.js',
		external: ['vscode', 'ws'],
		logLevel: 'silent',
		plugins: [
			/* add to the end of plugins array */
			esbuildProblemMatcherPlugin,
		],
	});
	if (watch) {
		await ctx.watch();
	} else {
		await ctx.rebuild();
		await ctx.dispose();
		// Bundle standalone server + daemon, copy assets after extension build
		await bundleStandalone();
		await bundleDaemon();
		copyAssets();
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
