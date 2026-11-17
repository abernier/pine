// Takes the pictures of the desktop app that story-front.js shows: the real app (desktop/), on a
// pine home of its own with the scripted model server of pine's tests. An agent changes a project,
// and a letter arrives in a folder that another agent watches. Every change of the window while they
// work is one picture, so the film can play them at its own pace.
//
//   node reel/app-shots.mjs            -> reel/assets/front/0001.png ..., and shots.js that lists them
//   node reel/app-shots.mjs --keep     leaves the home and the folders it made, to look at them
//
// It needs a Mac with a screen, and desktop/ installed (`pnpm install` there). The home and the
// folders the app shows lie under /Users/Shared while it runs, so that the app writes them as
// ~/dev/flipper and ~/Documents/scans; they are removed at the end. Nothing here is real: the
// project, the letters and what the agents say about them are made up.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { _electron as electron } from "../node_modules/playwright-core/index.mjs";
import { startMock, textOf } from "../baseline/tests/mock.mjs";

const dir = import.meta.dirname;
const desktop = path.resolve(dir, "..", "desktop");
const out = path.join(dir, "assets", "front");
const keep = process.argv.includes("--keep");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const write = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };

// ---- the made-up world ----------------------------------------------------------------------------

const BASE = "/Users/Shared";
const made = [];
// Whatever ends this script, what it made under /Users/Shared goes with it.
process.on("exit", () => { if (!keep) for (const p of made) fs.rmSync(p, { recursive: true, force: true }); });
/** A folder under /Users/Shared that is this script's own: one that is there already is somebody's, and is left alone. */
function own(name) {
	const p = path.join(BASE, name);
	if (fs.existsSync(p)) throw new Error(`${p} exists already. This script makes and removes it; move it away first.`);
	fs.mkdirSync(p, { recursive: true });
	made.push(p);
	return p;
}
const home = own(".pine");
const scans = path.join(own("Documents"), "scans");
fs.mkdirSync(scans, { recursive: true });
const flipper = path.join(own("dev"), "flipper");

const SUBGHZ = `import { radio, type Reading } from "./radio.ts";

const STEP = 20_000;

/** Listen on one frequency. */
export function listen(hz: number, ms = 200) {
  return radio.listen(hz, { ms });
}

/** Whether something is sending there. */
export async function busy(hz: number) {
  return (await listen(hz)).dbm > -70;
}
`;
const SCAN = `/** The strongest signal in a band. */
export async function scan([lo, hi]: number[]) {
  const hits: Reading[] = [];
  for (let hz = lo; hz <= hi; hz += STEP) {
    hits.push(await listen(hz));
  }
  return hits.sort((a, b) => b.dbm - a.dbm)[0];
}
`;
write(path.join(flipper, "README.md"), "# flipper\n\nSmall tools for a Flipper Zero, driven over the gateway.\n\n- `listen(hz)`: the signal on one Sub-GHz frequency\n- `busy(hz)`: whether something is sending there\n\nRun the tests with `npm test`.\n");
write(path.join(flipper, "package.json"), '{ "name": "flipper", "type": "module", "scripts": { "test": "node --test" } }\n');
write(path.join(flipper, "src", "radio.ts"), "export type Reading = { hz: number; dbm: number };\n\n/** The remote in the room sends at 433.92 MHz. */\nexport const radio = {\n  async listen(hz: number, _opts: { ms: number }): Promise<Reading> {\n    return { hz, dbm: Math.abs(hz - 433_920_000) < 10_000 ? -41 : -96 };\n  },\n};\n");
write(path.join(flipper, "src", "subghz.ts"), SUBGHZ);
write(path.join(flipper, "src", "infrared.ts"), "export const learn = () => [];\nexport const replay = (_signal: number[]) => true;\n");
write(path.join(flipper, "src", "gpio.ts"), "export const temperature = (raw: number) => raw / 16;\n");
write(path.join(flipper, "test", "listen.test.ts"), 'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { busy, listen } from "../src/subghz.ts";\n\ntest("listen reports the frequency it tuned", async () => assert.equal((await listen(433_920_000)).hz, 433_920_000));\ntest("busy is true where the remote sends", async () => assert.equal(await busy(433_920_000), true));\n');
const git = (...args) => execFileSync("git", ["-C", flipper, "-c", "user.name=reel", "-c", "user.email=reel@example.invalid", "-c", "commit.gpgsign=false", ...args], { stdio: "ignore" });
git("init", "-q", "-b", "main");
git("add", ".");
git("commit", "-q", "-m", "first");

// ---- the model: pine's scripted one, told which script a message means ------------------------------

// (How full the context is, the mock says by the length of the request; a picture in it would count as a book.)
const mock = await startMock({ strip: /<pine-note>[\s\S]*?<\/pine-note>\s*/g, promptTokens: (body) => 9000 + 700 * (body.messages?.length ?? 0) });
const slow = { chunkDelayMs: 90 };
const TODO = "# TODO\n\n- [ ] Parking notice, City of Musterstadt: €25.00 by 30 Nov · ref OWi 2026/118204\n- [x] Car insurance, Nordlicht: €312.80, paid 2 Nov\n- [x] Chimney sweep: €68.40, paid 28 Oct\n";
mock.state.scripts.parking = [
	{ tools: [{ name: "read", args: { path: path.join(scans, "scan-0411.png") } }] },
	{ text: "A **parking notice** from the City of Musterstadt.\n\n- Amount due: **€25.00** by 30 November\n- Reference: OWi 2026/118204\n\nAdded to `TODO.md`." },
];
mock.state.scripts.water = [
	{ tools: [{ name: "read", args: { path: path.join(scans, "scan-0412.png") } }], delayMs: 500 },
	{ tools: [{ name: "edit", args: { path: "TODO.md", edits: [{ oldText: "# TODO\n\n", newText: "# TODO\n\n- [ ] Water statement, Stadtwerke Musterstadt: €219.41 by 26 Nov · ref WA-2026-104233\n" }] } }], delayMs: 700 },
	{ ...slow, delayMs: 600, text: "The **annual water statement** from Stadtwerke Musterstadt.\n\n- Amount due: **€219.41** by 26 November\n- IBAN: DE89 3704 0044 0532 0130 00\n- Reference: WA-2026-104233\n\nAdded to `TODO.md`." },
];
mock.state.scripts.scan = [
	{ tools: [{ name: "read", args: { path: "src/subghz.ts" } }], delayMs: 250 },
	{ tools: [{ name: "edit", args: { path: "src/subghz.ts", edits: [{ oldText: "ms = 200", newText: "ms = 100" }, { oldText: "/** Whether something is sending there. */", newText: `${SCAN}\n/** Whether something is sending there. */` }] } }] },
	{ tools: [{ name: "write", args: { path: "test/scan.test.ts", content: 'import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { scan } from "../src/subghz.ts";\n\ntest("scan finds the remote at 433.92 MHz", async () => assert.equal((await scan([433_000_000, 434_800_000])).hz, 433_920_000));\n' } }] },
	{ tools: [{ name: "edit", args: { path: "README.md", edits: [{ oldText: "- `busy(hz)`: whether something is sending there\n", newText: "- `busy(hz)`: whether something is sending there\n- `scan([lo, hi])`: the strongest signal in a band\n" }] } }] },
	{ tools: [{ name: "bash", args: { command: "node --test" } }], delayMs: 250 },
	{ chunkDelayMs: 60, delayMs: 250, text: "Added `scan([lo, hi])` to `src/subghz.ts`. It listens every 20 kHz across the band and returns the strongest reading. A new test covers it; all 3 tests pass." },
];
/** Which script a request is for, by what its last message says. The message itself stays as it came. */
const MEANS = [[/scan-0411/, "parking"], [/scan-0412/, "water"], [/^add a scan\(\)/, "scan"]];
const asked = [];
const proxy = http.createServer((req, res) => {
	const chunks = [];
	req.on("data", (c) => chunks.push(c));
	req.on("end", () => {
		let body = Buffer.concat(chunks);
		try {
			const json = JSON.parse(body.toString("utf8"));
			// A picture a tool read comes back as a message of its own; the script goes by what was asked before it.
			json.messages = (json.messages ?? []).filter((m) => !(m.role === "user" && /^Attached image\(s\) from tool result/.test(textOf(m.content))));
			body = Buffer.from(JSON.stringify(json));
			const last = [...json.messages].reverse().find((m) => m.role === "user");
			if (last) {
				const said = textOf(last.content).replace(/<pine-note>[\s\S]*?<\/pine-note>\s*/g, "");
				asked.push(said.slice(0, 300));
				const ref = MEANS.find(([re]) => re.test(said))?.[1];
				if (ref) {
					if (typeof last.content === "string") last.content += ` @@REF:${ref}@@`;
					else last.content.push({ type: "text", text: ` @@REF:${ref}@@` });
					body = Buffer.from(JSON.stringify(json));
				}
			}
		} catch {}
		const to = new URL(mock.baseUrl);
		const fwd = http.request({ host: to.hostname, port: to.port, path: req.url, method: req.method, headers: { ...req.headers, host: to.host, "content-length": body.length } }, (back) => {
			res.writeHead(back.statusCode ?? 502, back.headers);
			back.pipe(res);
		});
		fwd.on("error", () => res.destroy());
		fwd.end(body);
	});
});
await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
const modelUrl = `http://127.0.0.1:${proxy.address().port}${new URL(mock.baseUrl).pathname}`;

// ---- pine's home -------------------------------------------------------------------------------------

write(path.join(home, "models.json"), JSON.stringify({ providers: { local: { name: "Local", baseUrl: modelUrl, api: "openai-completions", apiKey: "sk-none", models: [{ id: "flashnext", name: "flashnext", contextWindow: 128000, maxTokens: 4096, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
write(path.join(home, "pine.json"), JSON.stringify({ http: { host: "127.0.0.1", port: 0 }, main: "main", defaults: { model: "local/flashnext", mode: "auto" }, security: { askAccess: false }, sources: { scans: { type: "folder", dir: scans } } }, null, 2));
for (const [id, description] of [["main", "Your main agent"], ["mrbanks", "Keeps the bills"], ["scout", "Reads your Slack"], ["watchdog", "Watches the house"]]) {
	write(path.join(home, "agents", id, "agent.json"), JSON.stringify({ description }));
	write(path.join(home, "agents", id, "workspace", "AGENTS.md"), `You are ${id}.\n`);
}
write(path.join(home, "agents", "mrbanks", "workspace", "TODO.md"), TODO);
write(path.join(home, "desktop-data", "prefs.json"), JSON.stringify({ theme: "dark", bounds: { width: 1040, height: 660 } }));

// ---- the app, and the pictures -----------------------------------------------------------------------

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
execFileSync(process.execPath, [path.join(desktop, "scripts", "build.mjs")], { stdio: "inherit" });
const app = await electron.launch({
	executablePath: path.join(desktop, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron"),
	colorScheme: "dark",
	args: [desktop],
	env: { ...process.env, PINE_HOME: home, PINE_DESKTOP_DATA: path.join(home, "desktop-data"), PINE_SKIP_DOWNLOADS: "1", PINE_DESKTOP_DEV_URL: "" },
});
const page = await app.firstWindow();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.message)));

const seqs = {}, boxes = {};
let count = 0;
/** One picture into a sequence, with when it was taken; a picture that shows nothing new is left out. */
async function frame(seq) {
	const s = (seqs[seq] ??= { frames: [], t0: Date.now(), last: "" });
	const png = await page.screenshot({ type: "png" });
	const sum = crypto.createHash("sha1").update(png).digest("hex");
	if (sum === s.last) return;
	s.last = sum;
	const name = `${String(++count).padStart(4, "0")}.png`;
	fs.writeFileSync(path.join(out, name), png);
	s.frames.push([name, Date.now() - s.t0]);
}
/** Pictures for as long as something takes, and a little after it. */
async function during(seq, doing, after = 500, before = async () => {}) {
	let over = false;
	const done = Promise.resolve(doing).finally(() => (over = true));
	while (!over) await before(), await frame(seq);
	await done;
	for (const until = Date.now() + after; Date.now() < until; ) await before(), await frame(seq);
}
/** The conversation scrolled to its end, as somebody does who watches an answer come. */
const toEnd = () => page.evaluate(() => { for (let e = document.querySelector(".column"); e; e = e.parentElement) if (e.scrollHeight > e.clientHeight + 4) e.scrollTop = e.scrollHeight; });
/** Where something is in the window, for the film's pointer. */
async function where(name, selector) {
	const b = await page.locator(selector).first().boundingBox();
	if (!b) throw new Error(`${selector} is not on screen`);
	boxes[name] = { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
}
/** A click the film shows: where it lands, and what the window does after it. */
async function tap(name, selector, after = 600) {
	await where(name, selector);
	await during(name, page.locator(selector).first().click(), after);
}
const sees = (selector, timeout = 30_000) => page.waitForSelector(selector, { timeout });
const idle = () => page.waitForFunction(() => !document.querySelector(".composer .btn-stop, .composer [title*='Stop']"), undefined, { timeout: 60_000 });
/** A message typed and sent, without pictures. */
async function send(text, doneWhen) {
	await page.fill(".composer textarea", text);
	await page.keyboard.press("Enter");
	await page.waitForFunction(doneWhen, undefined, { timeout: 60_000 });
	await sleep(600);
}
const menu = (command) => app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0].webContents.send("pine:menu", c), command);
const letter = (name, picture) => fs.copyFileSync(path.join(dir, "bill", picture), path.join(scans, name));

const bills = () => page.locator(".side-group", { hasText: "mrbanks" }).locator(".side-conv", { hasText: "main conversation" });
const said = (re) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector(".column")?.textContent ?? ""), re.source, { timeout: 60_000 });
try {
	await sees(".welcome h1");
	// mrbanks listens to the folder, in its main conversation. (A subscription lets one event through in ten
	// seconds unless it is told otherwise, and here two letters come one after the other.)
	await page.evaluate(([m, u, b]) => window.pine.call(m, u, b), ["POST", "/agents/mrbanks/subscribe", { source: "scans", throttle: "1s" }]);

	// 1. Code: a conversation in a project's folder, with what changes beside it.
	await menu(`folder:${flipper}`);
	await sees(".pick-title >> text=Which agent works in");
	await page.keyboard.press("Enter");
	await sees(".tab.on .name >> text=flipper");
	await page.click(".conv-head .btn[title*='workspace']");
	await page.click(".code .segmented button >> text=Changes");
	await sleep(500);
	await page.fill(".composer textarea", "add a scan() that finds the strongest signal in a band");
	await frame("code");
	await during("code", page.keyboard.press("Enter").then(() => said(/all 3 tests pass/)), 1500);
	await page.evaluate(() => document.activeElement?.blur?.());
	await sees(".code .frow >> text=subghz.ts");
	await sleep(400);
	await frame("code");
	await tap("file", ".code .frow >> text=subghz.ts", 700);
	await sees(".diff .add");
	await frame("file");

	// 2. A letter: the agent that keeps the bills, and the list it keeps.
	await bills().first().click();
	await sees(".welcome h1 >> text=mrbanks");
	// An earlier letter, so that the conversation and the list have something in them.
	letter("scan-0411.png", "parking-notice-page1.png");
	await said(/OWi 2026\/118204[\s\S]*Added to/);
	await sleep(800);
	// The panel beside the conversation, with the list the agent keeps open in it.
	if (!(await page.$(".code"))) await page.click(".conv-head .btn[title*='workspace']");
	await page.click(".code .segmented button >> text=Files");
	await page.click(".code .frow >> text=TODO.md");
	await sees(".editor .cm-content");
	await page.evaluate(() => document.activeElement?.blur?.());
	await toEnd();
	await sleep(700);

	// The letter that went through the scanner arrives: the agent reads it and adds it to the list.
	await frame("before");
	seqs.letter = { frames: [], t0: Date.now(), last: "" };
	letter("scan-0412.png", "water-bill-page1.png");
	await during("letter", said(/WA-2026-104233[\s\S]*Added to/), 1500, toEnd);
	await where("files", ".code .segmented button >> text=Files");

	const size = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
	const list = Object.fromEntries(Object.entries(seqs).map(([k, s]) => [k, s.frames.map(([f, t]) => [f, t - s.frames[0][1]])]));
	fs.writeFileSync(path.join(out, "shots.js"), `// Written by reel/app-shots.mjs: the pictures of the desktop app, in the order they were taken.\nconst SHOTS = ${JSON.stringify({ size, boxes, seqs: list })};\n`);
	console.log(`${count} pictures in ${out}`, size, Object.fromEntries(Object.entries(list).map(([k, v]) => [k, v.length])));
	if (errors.length) console.log("errors in the page:", errors);
} catch (e) {
	await page.screenshot({ path: path.join(out, "failed.png") }).catch(() => {});
	console.error(e);
	console.error("the model was asked:", asked.slice(-6));
	process.exitCode = 1;
} finally {
	await app.close().catch(() => {});
	await mock.close?.().catch(() => {});
	proxy.close();
	if (keep) console.log("kept:", made.join(", "));
}
