// The app's main process. It owns three things the page must not: the daemon's token, the
// operating system (windows, menus, dialogs, notifications), and the child that is the daemon
// when this app had to start one. The page gets a narrow bridge (preload.ts) and nothing else.
import { app, BrowserWindow, dialog, ipcMain, Menu, type MenuItemConstructorOptions, nativeTheme, Notification, protocol, session, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildVoice, Listening, NOT_HERE } from "../../src/tui/voice.ts";
import { type Command, install, look, remove, said } from "./command.ts";
import { connect, findPine, type Launch, loginEnv, pineRoot, runPine, type Service, ServiceError } from "./service.ts";
import { LATEST, lookForUpdate, type Update } from "./updates.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, "..");
const DEV_URL = process.env.PINE_DESKTOP_DEV_URL || undefined;
/** Scheme and host of an address. (Node's own `origin` says "null" for a scheme of the app's own.) */
const originOf = (url: string) => {
	try {
		const u = new URL(url);
		return `${u.protocol}//${u.host}`;
	} catch {
		return "";
	}
};
const ORIGIN = DEV_URL ? originOf(DEV_URL) : "app://pine";
const isMac = process.platform === "darwin";
/** Tests only: the window opens behind the owner's windows and the app never takes the focus or a place in the Dock. */
const BACKGROUND = Boolean(process.env.PINE_DESKTOP_BACKGROUND);
if (BACKGROUND && isMac) app.setActivationPolicy("accessory");

// A second set of windows and data for tests and for trying things out beside the real app.
if (process.env.PINE_DESKTOP_DATA) app.setPath("userData", path.resolve(process.env.PINE_DESKTOP_DATA));
app.setName("Pine");

protocol.registerSchemesAsPrivileged([
	{ scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } },
	{ scheme: "pine-media", privileges: { standard: true, secure: true, stream: true, bypassCSP: false } },
]);

// ---- preferences of the app itself (not pine's settings: those are the daemon's) -----------------

interface Prefs {
	/** Another pine home than ~/.pine. */
	home?: string;
	/** A daemon this app started goes on when the app quits. */
	keepRunning: boolean;
	theme: "system" | "light" | "dark";
	notify: boolean;
	/** Whether GitHub is asked for a newer app when this one starts. */
	updates: boolean;
	/** `pine` for a terminal was looked after once (see firstCommand): a link the owner removed stays removed. */
	commandTried: boolean;
	bounds?: { x?: number; y?: number; width: number; height: number };
}

const prefsFile = () => path.join(app.getPath("userData"), "prefs.json");
let prefs: Prefs = { keepRunning: false, theme: "system", notify: true, updates: true, commandTried: false };

function loadPrefs(): void {
	try {
		const raw = JSON.parse(fs.readFileSync(prefsFile(), "utf8"));
		prefs = {
			home: typeof raw.home === "string" && raw.home ? raw.home : undefined,
			keepRunning: raw.keepRunning === true,
			theme: raw.theme === "light" || raw.theme === "dark" ? raw.theme : "system",
			notify: raw.notify !== false,
			updates: raw.updates !== false,
			commandTried: raw.commandTried === true,
			bounds: raw.bounds && Number(raw.bounds.width) > 300 && Number(raw.bounds.height) > 200 ? raw.bounds : undefined,
		};
	} catch {
		// first start
	}
	nativeTheme.themeSource = prefs.theme;
}

function savePrefs(): void {
	try {
		fs.mkdirSync(path.dirname(prefsFile()), { recursive: true });
		fs.writeFileSync(prefsFile(), `${JSON.stringify(prefs, null, 2)}\n`);
	} catch {
		// a preference that is not kept is not worth an error
	}
}

// ---- the daemon --------------------------------------------------------------------------------

type ServiceState = { status: "starting" } | { status: "ready"; mode: string; started: boolean; home: string; version?: string; from: string } | { status: "error"; kind: ServiceError["kind"]; message: string };

let win: BrowserWindow | undefined;
let service: Service | undefined;
let launch: Launch | undefined;
let state: ServiceState = { status: "starting" };
let stream: AbortController | undefined;
let quitting = false;
let listening: Listening | undefined;

const send = (channel: string, ...args: unknown[]) => {
	if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
};

function setState(next: ServiceState): void {
	state = next;
	send("pine:service", state);
}

async function startService(): Promise<void> {
	stream?.abort();
	setState({ status: "starting" });
	try {
		launch = await findPine(APP_ROOT, app.isPackaged ? process.resourcesPath : undefined);
		service = await connect(launch, { home: prefs.home ?? process.env.PINE_HOME, keep: prefs.keepRunning });
		setState({ status: "ready", mode: service.mode, started: service.started, home: service.home, version: service.version, from: launch.from });
		follow(service);
	} catch (e) {
		service = undefined;
		setState({ status: "error", kind: e instanceof ServiceError ? e.kind : "failed", message: e instanceof Error ? e.message : String(e) });
	}
}

/**
 * The daemon's live events, read here and handed to the page in small batches: a model that
 * writes fast sends a hundred events a second, and each as a message of its own would keep the
 * page busy with the post office.
 */
function follow(s: Service): void {
	const abort = (stream = new AbortController());
	let batch: unknown[] = [];
	let timer: NodeJS.Timeout | undefined;
	const flush = () => {
		timer = undefined;
		if (batch.length) send("pine:events", batch);
		batch = [];
	};
	const loop = async () => {
		let down = 0;
		while (!abort.signal.aborted) {
			try {
				const res = await fetch(`${s.base}/events/stream?topic=%23`, { headers: { authorization: `Bearer ${s.token}` }, signal: abort.signal });
				if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
				down = 0;
				send("pine:connection", true);
				let buf = "";
				const decoder = new TextDecoder();
				for await (const chunk of res.body as any) {
					buf += decoder.decode(chunk, { stream: true });
					for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
						const block = buf.slice(0, i);
						buf = buf.slice(i + 2);
						if (!block.startsWith("data: ")) continue;
						try {
							batch.push(JSON.parse(block.slice(6)));
							timer ??= setTimeout(flush, 24);
						} catch {
							// A malformed frame is skipped; the stream goes on.
						}
					}
				}
			} catch {
				// fall through to the retry
			}
			if (abort.signal.aborted) return;
			send("pine:connection", false);
			down++;
			// A daemon this app started and that is gone will not come back by waiting: start it again.
			if (down === 5 && s.started && !quitting) return void startService();
			await new Promise((r) => setTimeout(r, 1000));
		}
	};
	void loop();
}

/** One call of the control API in the owner's name. The page never holds the token. */
async function call(method: string, url: string, body?: unknown): Promise<{ ok: boolean; status: number; data: any }> {
	if (!service) return { ok: false, status: 503, data: { error: "pine is not running yet" } };
	if ((method !== "GET" && method !== "POST") || typeof url !== "string" || !url.startsWith("/") || url.startsWith("//")) return { ok: false, status: 400, data: { error: "not a call of the control API" } };
	try {
		const res = await fetch(service.base + url, {
			method,
			headers: { authorization: `Bearer ${service.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
			body: body !== undefined ? JSON.stringify(body) : undefined,
		});
		const type = res.headers.get("content-type") ?? "";
		if (type.startsWith("application/json")) return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
		// A picture: bytes and their kind.
		return { ok: res.ok, status: res.status, data: { mime: type, base64: Buffer.from(await res.arrayBuffer()).toString("base64") } };
	} catch (e) {
		return { ok: false, status: 0, data: { error: `pine does not answer (${e instanceof Error ? e.message : e})` } };
	}
}

/** What the page may show straight from the daemon: pictures, videos and sounds. Nothing else is served this way. */
const MEDIA = [/^\/media\/tool\/[^/]+$/, /^\/tasks\/\d+\/images\/\d+$/, /^\/agents\/[^/]+\/image$/, /^\/agents\/[^/]+\/browser\/frame$/];

async function media(request: Request): Promise<Response> {
	const url = new URL(request.url);
	if (!service || request.method !== "GET" || !MEDIA.some((m) => m.test(url.pathname))) return new Response("not found", { status: 404 });
	try {
		const res = await fetch(service.base + url.pathname + url.search, { headers: { authorization: `Bearer ${service.token}` } });
		if (!res.ok) return new Response("not found", { status: 404 });
		const type = res.headers.get("content-type") ?? "application/octet-stream";
		// Only what is drawn or played. A page of HTML or a script under this name would be content from outside.
		if (!/^(image|video|audio)\//.test(type) || type.startsWith("image/svg")) return new Response("not shown", { status: 415 });
		return new Response(res.body, { status: 200, headers: { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" } });
	} catch {
		return new Response("not found", { status: 404 });
	}
}

// ---- the page ----------------------------------------------------------------------------------

const CSP = [
	"default-src 'none'",
	"script-src 'self'",
	// The editor writes its styles into the page as it goes.
	"style-src 'self' 'unsafe-inline'",
	// No address on the web: a picture an answer points at is fetched by the daemon, on a click.
	"img-src 'self' data: blob: pine-media:",
	"media-src 'self' blob: pine-media:",
	"font-src 'self' data:",
	"connect-src 'self'",
	"base-uri 'none'",
	"form-action 'none'",
	"frame-src 'none'",
	"object-src 'none'",
].join("; ");

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json", ".map": "application/json" };

function page(request: Request): Response {
	const dist = path.join(APP_ROOT, "dist");
	const url = new URL(request.url);
	const rel = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
	const file = path.normalize(path.join(dist, rel));
	if (!file.startsWith(dist + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return new Response("not found", { status: 404 });
	return new Response(fs.readFileSync(file), { headers: { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream", "content-security-policy": CSP, "x-content-type-options": "nosniff" } });
}

function fromPage(e: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean {
	const frame = e.senderFrame;
	return Boolean(win && frame && e.sender === win.webContents && frame === win.webContents.mainFrame && originOf(frame.url) === ORIGIN);
}

/** Only pages on the web open outside the app; a link in an answer never starts a program or opens a file. */
function openOutside(url: string): void {
	try {
		const u = new URL(url);
		if (u.protocol === "http:" || u.protocol === "https:") void shell.openExternal(u.href);
	} catch {
		// not an address
	}
}

function createWindow(): void {
	const b = prefs.bounds;
	win = new BrowserWindow({
		width: b?.width ?? 1280,
		height: b?.height ?? 820,
		x: b?.x,
		y: b?.y,
		// The side bar, a conversation and the panel beside it, each at its narrowest, fit into this.
		minWidth: 880,
		minHeight: 480,
		show: false,
		title: "Pine",
		titleBarStyle: isMac ? "hiddenInset" : "default",
		trafficLightPosition: { x: 16, y: 16 },
		vibrancy: isMac ? "sidebar" : undefined,
		visualEffectState: "followWindow",
		backgroundColor: isMac ? "#00000000" : nativeTheme.shouldUseDarkColors ? "#1b1e28" : "#fbfbf9",
		webPreferences: {
			preload: path.join(HERE, "preload.cjs"),
			contextIsolation: true,
			sandbox: true,
			nodeIntegration: false,
			webSecurity: true,
			spellcheck: true,
			navigateOnDragDrop: false,
		},
	});
	win.once("ready-to-show", () => (BACKGROUND ? win?.showInactive() : win?.show()));
	win.webContents.setWindowOpenHandler(({ url }) => (openOutside(url), { action: "deny" }));
	win.webContents.on("will-navigate", (e, url) => {
		// The page stays the page. (Reloading it during development is the one navigation there is.)
		if (originOf(url) !== ORIGIN) {
			e.preventDefault();
			openOutside(url);
		}
	});
	win.webContents.on("will-attach-webview", (e) => e.preventDefault());
	const keep = () => {
		if (!win || win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
		prefs.bounds = win.getBounds();
	};
	win.on("resize", keep);
	win.on("move", keep);
	win.on("close", savePrefs);
	win.on("focus", () => send("pine:focus", true));
	win.on("blur", () => send("pine:focus", false));
	win.on("enter-full-screen", () => send("pine:fullscreen", true));
	win.on("leave-full-screen", () => send("pine:fullscreen", false));
	win.on("closed", () => (win = undefined));
	void win.loadURL(DEV_URL ?? "app://pine/");
	if (process.env.PINE_DESKTOP_DEVTOOLS) win.webContents.openDevTools({ mode: "detach" });
}

function show(): void {
	if (!win) createWindow();
	else {
		if (win.isMinimized()) win.restore();
		if (BACKGROUND) win.showInactive();
		else {
			win.show();
			win.focus();
		}
	}
}

// ---- `pine` for a terminal -----------------------------------------------------------------------

/** What the packed app carries; a checkout has none of it. */
const RESOURCES = app.isPackaged ? process.resourcesPath : undefined;

const worded = (c: Command) => ({ ...c, text: said(c) });

/**
 * Once, the first time an app that carries pine is started from where it will stay: the link is
 * made where that takes no password. Where it takes one, nothing is asked out of nowhere; the
 * menu and Settings > App offer it. Not in a second set of data for tests and trying things out.
 */
async function firstCommand(): Promise<void> {
	if (prefs.commandTried || process.env.PINE_DESKTOP_DATA) return;
	const env = await loginEnv();
	const now = look(RESOURCES, env);
	if (now.state === "unavailable") return;
	prefs.commandTried = true;
	savePrefs();
	if (now.state === "none" && !now.password) await install(RESOURCES, env);
}

/** The menu's way to the same thing: asks before it sets the command up, and says what is so. */
async function commandFromMenu(): Promise<void> {
	const env = await loginEnv();
	let now = look(RESOURCES, env);
	if (now.state === "none") {
		const answer = await dialog.showMessageBox({ type: "question", message: "Use pine in a terminal too?", detail: said(now).replace(/^Not set up\. /, ""), buttons: ["Set Up", "Not Now"], defaultId: 0, cancelId: 1 });
		if (answer.response !== 0) return;
		now = await install(RESOURCES, env);
	}
	await dialog.showMessageBox({ type: "info", message: "pine in a terminal", detail: said(now) });
}

// ---- a newer app ---------------------------------------------------------------------------------

/**
 * Whom this app asks for the last release. An app from a checkout is no release and has no
 * version to compare: it asks nobody. PINE_DESKTOP_RELEASES is for tests, which name a stand-in
 * for GitHub (and with nothing in it, nobody is asked). Whatever answers there, the link the
 * owner gets leads to GitHub.
 */
const RELEASE_API = process.env.PINE_DESKTOP_RELEASES !== undefined ? process.env.PINE_DESKTOP_RELEASES || undefined : app.isPackaged ? LATEST : undefined;

/** The last answer that said something, for a page that is opened again. */
let known: Update | undefined;
/** The question of this start, asked once. */
let atStart: Promise<Update> | undefined;

async function askForUpdate(): Promise<Update> {
	const said = await lookForUpdate(app.getVersion(), process.arch, RELEASE_API);
	if (said.status !== "unknown") known = said;
	return said;
}

/**
 * What the page is told: with `again` (the menu, the settings) what GitHub says now, without it
 * what the start found. A start that got no answer asks again when the window is next opened.
 */
async function update(again?: boolean): Promise<Update | undefined> {
	if (!RELEASE_API) return undefined;
	if (again) return askForUpdate();
	if (prefs.updates) await (atStart ??= askForUpdate().then((said) => (said.status === "unknown" && (atStart = undefined), said)));
	return known;
}

// ---- menus -------------------------------------------------------------------------------------

/** A menu item that asks the page to do something: the page knows which conversation is in front. */
const item = (label: string, command: string, accelerator?: string, more: MenuItemConstructorOptions = {}): MenuItemConstructorOptions => ({ label, accelerator, click: () => (show(), send("pine:menu", command)), ...more });

function buildMenu(): void {
	const template: MenuItemConstructorOptions[] = [
		...(isMac
			? [
					{
						label: "Pine",
						submenu: [{ role: "about" as const }, ...(RELEASE_API ? [item("Check for Updates…", "updates")] : []), { type: "separator" as const }, item("Settings…", "settings", "Cmd+,"), ...(RESOURCES && fs.existsSync(path.join(RESOURCES, "bin", "pine")) ? [{ label: "pine in a Terminal…", click: () => void commandFromMenu() }] : []), { type: "separator" as const }, { role: "services" as const }, { type: "separator" as const }, { role: "hide" as const }, { role: "hideOthers" as const }, { role: "unhide" as const }, { type: "separator" as const }, { role: "quit" as const }],
					},
				]
			: []),
		{
			label: "File",
			submenu: [
				item("New Conversation", "new", "CmdOrCtrl+T"),
				item("New Conversation with…", "agent", "CmdOrCtrl+Shift+T"),
				item("Open Folder…", "open-folder", "CmdOrCtrl+O"),
				{ type: "separator" },
				item("Attach Files…", "attach", "CmdOrCtrl+Shift+A"),
				item("Save File", "save", "CmdOrCtrl+S"),
				item("Export Conversation…", "export", "CmdOrCtrl+Shift+E"),
				{ type: "separator" },
				item("Close Tab", "close", "CmdOrCtrl+W"),
				...(isMac ? [] : [{ type: "separator" as const }, item("Settings…", "settings", "Ctrl+,"), { role: "quit" as const }]),
			],
		},
		{ label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "pasteAndMatchStyle" }, { role: "selectAll" }, { type: "separator" }, item("Find in Conversation", "find", "CmdOrCtrl+F"), item("Copy Last Answer", "copy", "CmdOrCtrl+Shift+C"), ...(isMac ? [item("Dictate Message", "voice", "Ctrl+R")] : [])] },
		{
			label: "View",
			submenu: [
				item("Command Palette…", "palette", "CmdOrCtrl+K"),
				{ type: "separator" },
				item("Toggle Sidebar", "sidebar", "CmdOrCtrl+B"),
				item("Toggle Side Panel", "code", "CmdOrCtrl+Alt+B"),
				item("Agent", "code-agent", "CmdOrCtrl+Shift+I"),
				item("Files", "code-files", "CmdOrCtrl+Shift+F"),
				item("Changes", "code-changes", "CmdOrCtrl+Shift+G"),
				item("Browser", "code-browser", "CmdOrCtrl+Shift+B"),
				item("Events", "events", "CmdOrCtrl+Shift+L"),
				{ type: "separator" },
				{ role: "resetZoom" },
				{ role: "zoomIn" },
				{ role: "zoomOut" },
				{ type: "separator" },
				{ role: "togglefullscreen" },
				...(app.isPackaged ? [] : [{ type: "separator" as const }, { role: "reload" as const }, { role: "toggleDevTools" as const }]),
			],
		},
		{
			label: "Conversation",
			submenu: [
				item("Stop", "stop", "CmdOrCtrl+."),
				{ type: "separator" },
				item("Take Back Last Message", "undo", "CmdOrCtrl+Shift+Z"),
				item("Bring It Back", "redo", "CmdOrCtrl+Shift+Y"),
				item("Shorten (Compact)", "compact"),
				item("Start Over (Reset)…", "reset"),
				{ type: "separator" },
				item("Model…", "model", "CmdOrCtrl+Shift+M"),
				item("Reasoning…", "reasoning"),
				item("Mode…", "mode", "CmdOrCtrl+Shift+P"),
				item("Goal…", "goal"),
				{ type: "separator" },
				item("Pin", "pin"),
				item("Rename…", "rename"),
				{ type: "separator" },
				item("Next Tab", "next-tab", "Ctrl+Tab"),
				item("Previous Tab", "prev-tab", "Ctrl+Shift+Tab"),
				...Array.from({ length: 9 }, (_, i) => item(`Tab ${i + 1}`, `tab-${i + 1}`, `CmdOrCtrl+${i + 1}`, { visible: false, acceleratorWorksWhenHidden: true })),
			],
		},
		{ role: "windowMenu" },
		{ role: "help", submenu: [item("Keys and Commands", "help"), ...(RELEASE_API && !isMac ? [item("Check for Updates…", "updates")] : []), { label: "pine on GitHub", click: () => openOutside("https://github.com/pmndre/pine") }] },
	];
	Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- what the page may ask for -----------------------------------------------------------------

function handle<T extends unknown[]>(channel: string, fn: (...args: T) => unknown): void {
	ipcMain.handle(channel, (e, ...args) => {
		if (!fromPage(e)) throw new Error("not from the app's page");
		return fn(...(args as T));
	});
}

function wire(): void {
	handle("pine:state", () => ({ state, home: prefs.home ?? process.env.PINE_HOME, prefs: { ...prefs, bounds: undefined }, platform: process.platform, fullscreen: Boolean(win?.isFullScreen()), focused: Boolean(win?.isFocused()), updates: Boolean(RELEASE_API), versions: { app: app.getVersion(), electron: process.versions.electron } }));
	handle("pine:call", (method: string, url: string, body?: unknown) => call(method, url, body));
	handle("pine:retry", () => startService());
	handle("pine:update", (again?: boolean) => update(again === true));
	handle("pine:restart", async () => {
		// Only a daemon of this app's own is its to restart; another one is somebody's terminal.
		if (!service?.started) throw new Error("this pine was started somewhere else (a terminal, a service). Restart it there.");
		stream?.abort();
		await service.stop();
		await startService();
	});
	handle("pine:init", async () => {
		launch ??= await findPine(APP_ROOT, app.isPackaged ? process.resourcesPath : undefined);
		const args = ["init", ...(prefs.home ? [prefs.home] : []), "--yes"];
		return runPine(launch, args, (line) => send("pine:init-line", line), process.env.PINE_SKIP_DOWNLOADS ? { PINE_SKIP_DOWNLOADS: "1" } : {});
	});
	// The browser the web tools drive, fetched by the pine the app runs: each pine wants the build
	// of its own Playwright, and a home that was set up by another pine has an older one.
	handle("pine:browser", async () => {
		launch ??= await findPine(APP_ROOT, app.isPackaged ? process.resourcesPath : undefined);
		return runPine(launch, ["browser-install"], (line) => send("pine:init-line", line), process.env.PINE_SKIP_DOWNLOADS ? { PINE_SKIP_DOWNLOADS: "1" } : {});
	});
	handle("pine:command", async (action?: string) => {
		const env = await loginEnv();
		return worded(action === "install" ? await install(RESOURCES, env) : action === "remove" ? await remove(RESOURCES, env) : look(RESOURCES, env));
	});
	handle("pine:prefs", (change: Partial<Prefs>) => {
		if (change.theme === "system" || change.theme === "light" || change.theme === "dark") nativeTheme.themeSource = prefs.theme = change.theme;
		if (typeof change.notify === "boolean") prefs.notify = change.notify;
		if (typeof change.updates === "boolean") prefs.updates = change.updates;
		if (typeof change.keepRunning === "boolean") prefs.keepRunning = change.keepRunning;
		if ("home" in change) prefs.home = typeof change.home === "string" && change.home.trim() ? change.home.trim() : undefined;
		savePrefs();
		return { ...prefs, bounds: undefined };
	});
	handle("pine:pick-folder", async (title?: string) => {
		const r = await dialog.showOpenDialog(win!, { title: typeof title === "string" ? title.slice(0, 80) : "Choose a folder", properties: ["openDirectory", "createDirectory"] });
		return r.canceled ? undefined : r.filePaths[0];
	});
	handle("pine:save-text", async (name: string, text: string) => {
		const r = await dialog.showSaveDialog(win!, { defaultPath: path.join(app.getPath("documents"), path.basename(String(name))) });
		if (r.canceled || !r.filePath) return undefined;
		fs.writeFileSync(r.filePath, String(text));
		return r.filePath;
	});
	handle("pine:open", (url: string) => openOutside(String(url)));
	handle("pine:reveal", (file: string) => {
		// Shown in the Finder, never opened: opening would start whatever the file is.
		if (typeof file === "string" && path.isAbsolute(file) && fs.existsSync(file)) shell.showItemInFolder(file);
	});
	handle("pine:notify", (title: string, body: string, tab?: string) => {
		if (!prefs.notify || !Notification.isSupported() || win?.isFocused()) return;
		const n = new Notification({ title: String(title).slice(0, 80), body: String(body).slice(0, 160), silent: false });
		n.on("click", () => (show(), tab && send("pine:menu", `focus:${tab}`)));
		n.show();
	});
	handle("pine:badge", (count: number) => {
		if (isMac) app.dock?.setBadge(count > 0 ? String(count) : "");
		else app.setBadgeCount(Math.max(0, Number(count) || 0));
	});
	// Dictating a message. The words are recognised on this Mac by the helper the terminal UI
	// uses too (src/tui/voice.ts): nothing is sent anywhere, and what is heard is text for the
	// input and nothing more. The page puts it there; nothing here sends a message.
	handle("pine:voice-start", async (language?: string) => {
		listening?.cancel();
		listening = undefined;
		const lang = typeof language === "string" && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(language) ? language : undefined;
		let command: string[];
		if (process.env.PINE_DESKTOP_VOICE) command = [process.env.PINE_DESKTOP_VOICE]; // a stand-in, for tests
		else {
			if (!isMac) throw new Error(NOT_HERE);
			launch ??= await findPine(APP_ROOT, app.isPackaged ? process.resourcesPath : undefined);
			const source = path.join(pineRoot(launch) ?? "", "src", "tui", "voice.swift");
			if (!fs.existsSync(source)) throw new Error("this pine has no voice input: its helper's source was not found. Update pine.");
			command = [await buildVoice(path.join(app.getPath("userData"), "voice"), source)];
		}
		const mine: Listening = new Listening(command, lang, {
			ready: () => listening === mine && send("pine:voice", { type: "ready" }),
			partial: (text) => listening === mine && send("pine:voice", { type: "partial", text }),
			model: (state) => listening === mine && send("pine:voice", { type: "model", state }),
			done: (text, error) => {
				if (listening !== mine) return;
				listening = undefined;
				send("pine:voice", { type: "done", text, error });
			},
		});
		listening = mine;
	});
	handle("pine:voice-stop", (cancel?: boolean) => {
		if (cancel) (listening?.cancel(), (listening = undefined));
		else listening?.stop();
	});
	handle("pine:context-menu", (items: Array<{ id: string; label: string; enabled?: boolean; separator?: boolean; danger?: boolean }>) => {
		return new Promise<string | undefined>((resolve) => {
			let picked: string | undefined;
			const menu = Menu.buildFromTemplate(items.slice(0, 30).map((i) => (i.separator ? { type: "separator" as const } : { label: String(i.label).slice(0, 80), enabled: i.enabled !== false, click: () => (picked = String(i.id)) })));
			menu.popup({ window: win, callback: () => resolve(picked) });
		});
	});
}

// ---- life of the app ---------------------------------------------------------------------------

/** A folder the app was opened with (dropped on its icon, or `open -a Pine <folder>`): a conversation that works there. */
const pendingFolders: string[] = [];
let pageReady = false;
function openFolder(dir: string): void {
	try {
		if (!fs.statSync(dir).isDirectory()) return;
	} catch {
		return;
	}
	if (pageReady) (show(), send("pine:menu", `folder:${dir}`));
	else pendingFolders.push(dir);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
	app.on("second-instance", (_e, argv) => {
		show();
		const dir = argv.slice(1).find((a) => !a.startsWith("-") && path.isAbsolute(a));
		if (dir) openFolder(dir);
	});
	app.on("open-file", (e, file) => {
		e.preventDefault();
		openFolder(file);
	});
	app.on("web-contents-created", (_e, contents) => {
		// Nothing the page shows gets the camera, the microphone, the place or anything else of the system's.
		contents.session.setPermissionRequestHandler((_wc, _permission, done) => done(false));
	});
	void app.whenReady().then(() => {
		loadPrefs();
		protocol.handle("app", page);
		protocol.handle("pine-media", media);
		session.defaultSession.setPermissionRequestHandler((_wc, _permission, done) => done(false));
		wire();
		ipcMain.on("pine:ready", (e) => {
			if (!fromPage(e)) return;
			pageReady = true;
			send("pine:service", state);
			for (const dir of pendingFolders.splice(0)) send("pine:menu", `folder:${dir}`);
		});
		// From a checkout the program is Electron's, and so would be its icon in the Dock.
		if (isMac && !app.isPackaged) {
			try {
				app.dock?.setIcon(path.join(APP_ROOT, "assets", "icon.png"));
			} catch {
				// an icon is not worth failing over
			}
		}
		buildMenu();
		createWindow();
		void startService();
		void firstCommand();
		app.on("activate", show);
	});
	app.on("window-all-closed", () => {
		// On a Mac the app, and the daemon it started, stay when the window is closed.
		pageReady = false;
		if (!isMac) app.quit();
	});
	app.on("before-quit", (e) => {
		if (quitting) return;
		savePrefs();
		if (!service?.started || prefs.keepRunning) return;
		// The daemon this app started ends with it, as the terminal UI's does: its agents are stopped
		// and its database closed before the app is gone.
		e.preventDefault();
		quitting = true;
		stream?.abort();
		void service.stop().finally(() => app.quit());
	});
}
