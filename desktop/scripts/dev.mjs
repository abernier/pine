// Development: the page from Vite's server (it reloads as you edit), the main process built once.
//   pnpm run dev
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { createServer } from "vite";
import { buildMain } from "./build.mjs";

const root = path.resolve(import.meta.dirname, "..");
await buildMain();
const server = await createServer({ root, server: { port: 5173, strictPort: false } });
await server.listen();
const url = server.resolvedUrls.local[0];
const electron = createRequire(import.meta.url)("electron");
const child = spawn(electron, [root, ...process.argv.slice(2)], { stdio: "inherit", env: { ...process.env, PINE_DESKTOP_DEV_URL: url } });
child.on("close", async (code) => {
	await server.close();
	process.exit(code ?? 0);
});
