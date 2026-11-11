#!/usr/bin/env bun
// @bun

// node_modules/create-alwith/src/cli.ts
import { readFile as readFile5 } from "fs/promises";

// node_modules/create-alwith/node_modules/@alwith/module-desktop-shell/build.js
import { copyFile, mkdir, readFile, writeFile } from "fs/promises";
import { extname, join, resolve, sep } from "path";

// node_modules/create-alwith/node_modules/@alwith/module-desktop-shell/config.js
function desktopWindow(app) {
  return {
    label: "main",
    title: app.productName,
    width: app.window.width,
    height: app.window.height,
    minWidth: app.window.minWidth,
    minHeight: app.window.minHeight,
    transparent: true,
    decorations: true,
    titleBarStyle: "Overlay",
    hiddenTitle: true
  };
}

// node_modules/create-alwith/node_modules/@alwith/module-desktop-shell/build.js
function validateConfig(value) {
  const c = value;
  if (!c || !/^[a-z][a-z0-9-]{0,213}$/.test(c.name ?? ""))
    throw Error("name must be a lowercase npm package name");
  if (typeof c.productName !== "string" || !c.productName.trim() || [...c.productName].some((character) => character < " " || character === "/" || character === "\\"))
    throw Error("productName must be a nonempty application name");
  if (!/^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z][A-Za-z0-9-]*){2,}$/.test(c.identifier ?? ""))
    throw Error("identifier must be an explicit reverse-DNS bundle ID");
  if (!/^\d+\.\d+\.\d+$/.test(c.version ?? ""))
    throw Error("version must have three numeric components");
  if (c.preset !== "chat")
    throw Error("Only the chat preset is available");
  if (!Array.isArray(c.languages) || !c.languages.length || c.languages.some((l) => !["en", "zh-CN"].includes(l)))
    throw Error("Supported languages are en and zh-CN");
  if (!Array.isArray(c.modules) || !["chat", "store"].every((m) => c.modules.includes(m)))
    throw Error("The chat preset requires chat and store");
  for (const key of ["width", "height", "minWidth", "minHeight"])
    if (!Number.isInteger(c.window?.[key]) || c.window[key] <= 0)
      throw Error(`window.${key} must be positive`);
  if (c.window.minWidth > c.window.width || c.window.minHeight > c.window.height)
    throw Error("Minimum window dimensions must not exceed initial dimensions");
  safePath("/app", c.icon);
  if (c.updates !== undefined) {
    if (!c.updates || typeof c.updates !== "object" || Array.isArray(c.updates))
      throw Error("updates must be an object with github and pubkey");
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_.-]{1,100}$/.test(c.updates.github ?? ""))
      throw Error("updates.github must be a GitHub repository as owner/repo");
    if (typeof c.updates.pubkey !== "string" || !/^[A-Za-z0-9+/]+=*$/.test(c.updates.pubkey.trim()) || c.updates.pubkey.trim().length < 64)
      throw Error("updates.pubkey must be the base64 public key written by the updater key generator");
  }
  return c;
}
function updaterEndpoint(github) {
  return `https://github.com/${github}/releases/latest/download/latest.json`;
}
function safePath(root, relative) {
  if (typeof relative !== "string" || !relative || relative.includes("\\") || relative.startsWith("/"))
    throw Error("Expected a relative project path");
  const path = resolve(root, relative);
  if (!path.startsWith(resolve(root) + sep))
    throw Error(`Path escapes the project: ${relative}`);
  return path;
}
var json = (value) => `${JSON.stringify(value, null, 2)}
`;
var html = (text) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
async function configureProject(root, options = {}) {
  const c = validateConfig(JSON.parse(await readFile(join(root, "alwith.app.json"), "utf8"))), manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  manifest.name = c.name;
  manifest.version = c.version;
  await writeFile(join(root, "package.json"), json(manifest));
  let cargo = await readFile(join(root, "src-tauri/Cargo.toml"), "utf8");
  cargo = cargo.replace(/(\[package\]\s*\nname = )[^\n]+/, `$1${JSON.stringify(c.name)}`).replace(/(\[package\][\s\S]*?\nversion = )[^\n]+/, `$1${JSON.stringify(c.version)}`).replace(/(\[\[bin\]\]\s*\nname = )[^\n]+/, `$1${JSON.stringify(c.name)}`);
  await writeFile(join(root, "src-tauri/Cargo.toml"), cargo);
  await writeFile(join(root, "index.html"), `<!doctype html>
<html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>${html(c.productName)}</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>
`);
  const iconName = `app-icon${extname(c.icon)}`;
  await mkdir(join(root, "public"), { recursive: true });
  await copyFile(safePath(root, c.icon), join(root, "public", iconName));
  await mkdir(join(root, "src/generated"), { recursive: true });
  await writeFile(join(root, "src/generated/app-icon.ts"), `// Generated from alwith.app.json.
export default ${JSON.stringify(`/${iconName}`)};
`);
  const config = {
    $schema: "https://schema.tauri.app/config/3.0.0-alpha.3",
    productName: c.productName,
    mainBinaryName: c.name,
    version: c.version,
    identifier: c.identifier,
    build: {
      frontendDist: "../dist",
      devUrl: "http://localhost:1420",
      beforeDevCommand: "bun run stage && bun run dev",
      beforeBuildCommand: "bun run stage && bun run build"
    },
    app: {
      windows: [desktopWindow(c)],
      security: {
        csp: null,
        assetProtocol: {
          enable: true,
          scope: ["$HOME/.codex/**", ...c.modules.includes("auth") ? ["$APPDATA/vibemon/**"] : []]
        }
      }
    },
    bundle: {
      active: true,
      category: "Productivity",
      targets: ["app", "dmg"],
      externalBin: ["binaries/alwith-runtime", "binaries/bun", "binaries/codex", "binaries/codex-code-mode-host"],
      resources: { "resources/adapter": "adapter", "resources/native": "native", "resources/licenses": "licenses" },
      icon: ["icons/32x32.png", "icons/128x128.png", "icons/128x128@2x.png", "icons/icon.icns", "icons/icon.ico"],
      macOS: { minimumSystemVersion: "26.6", entitlements: "./Entitlements.plist" }
    },
    ...c.updates ? {
      plugins: {
        updater: {
          pubkey: c.updates.pubkey.trim(),
          endpoints: [updaterEndpoint(c.updates.github)],
          requireSignedVersion: true
        }
      }
    } : {}
  };
  await writeFile(join(root, "src-tauri/tauri.conf.json"), json(config));
  if (options.icons !== false) {
    if (await Bun.spawn(["bun", "run", "tauri", "icon", c.icon, "-o", "src-tauri/icons"], {
      cwd: root,
      stdout: "inherit",
      stderr: "inherit"
    }).exited !== 0)
      throw Error("Icon generation failed");
  }
}
// node_modules/create-alwith/src/cli.ts
import { parseArgs } from "util";
import { createInterface } from "readline/promises";

// node_modules/create-alwith/src/generate.ts
import { cp as cp2, mkdir as mkdir3, readFile as readFile4, readdir, rm as rm2, writeFile as writeFile5 } from "fs/promises";
import { dirname, join as join5, resolve as resolve2, relative as relative2 } from "path";
import { createHash } from "crypto";

// node_modules/create-alwith/src/auth.ts
import { readFile as readFile2, writeFile as writeFile2, rm } from "fs/promises";
import { join as join2 } from "path";
function authMode(value) {
  if (value !== "alwith" && value !== "none")
    throw new Error("auth must be alwith or none");
  return value;
}
async function configureAuth(root, mode) {
  if (mode === "alwith")
    return;
  const edit = async (path, change) => {
    const file = join2(root, path);
    await writeFile2(file, change(await readFile2(file, "utf8")));
  };
  await rm(join2(root, "src/auth"), { recursive: true, force: true });
  for (const file of ["vibemon.html", "vibemon-bubble.html", "src/vibemon.tsx", "src/vibemon-bubble.tsx"])
    await rm(join2(root, file), { force: true });
  await edit("src/App.tsx", (source) => source.replace(/^import .* from "(?:@alwith\/module-auth[^"]*|\.\/auth\/pets)"\n/gm, "").replace(/^  const \[(region|petsReady),.*\n/gm, "").replace(/^    setRegion\("workspace"\)\n/gm, "").replace(/  useEffect\(\(\) => \{\n    let active = true[\s\S]*?\n  async function newChat/, "  async function newChat").replace('onPets={() => setRegion("leading")} petsReady={petsReady}', "").replace(/^        (leading=|region=|onRegionChange=).*\n/gm, "").replace(/^        trailing=\{petsReady && <PetLounge.*\n/m, ""));
  await edit("src/settings-window.tsx", (source) => source.replace(/^import .*initPlatformAuth.*\n/m, "").replace(/^void initPlatformAuth\(\)\n/m, ""));
  await edit("src/i18n.ts", (source) => source.replace(/^import .*vibemonLocales.*\n/m, "").replace(/^for \(const language.*vibemonLocales.*\n/m, ""));
  await edit("src/index.css", (source) => source.split(`
`).filter((line) => !line.includes("module-auth")).join(`
`));
  await edit("package.json", (source) => {
    const manifest = JSON.parse(source);
    for (const name of ["@alwith/module-auth", "@alwith/native-auth", "@alwith/native-kit", "@tauri-apps/plugin-http", "@tauri-apps/plugin-os", "@tauri-apps/plugin-log"])
      delete manifest.dependencies[name];
    return JSON.stringify(manifest, null, 2) + `
`;
  });
  await edit("src/main.tsx", (source) => source.replace(/^import .* from "\.\/auth\/.*"\n/gm, "").replace(/^void initPlatformAuth\(\)\n/m, "").replace(/    <AuthGate>\n      <App \/>\n    <\/AuthGate>/, "    <App />"));
  await edit("src/settings/page.tsx", (source) => source.replace(/^import \{ logoutPlatform, usePlatformAuth \}.*\n/m, "").replace(/^  const account = .*\n/m, "").replace(/  async function signOut\(\) \{[\s\S]*?\n  \}\n/, "").replace(/      <div className="desktop-shell-settings-row">\n        <div className="min-w-0">[\s\S]*?^      <\/div>\n/m, "").replace(/^import \{ useState \}.*\n/m, "").replace(/^import \{ LogOutIcon \}.*\n/m, "").replace(/^import \{ Alert, AlertDescription \}.*\n/m, "").replace(/^  const \[(error|busy),.*\n/gm, "").replace(/^      \{error &&.*\n/m, ""));
  await edit("src/layout/navigation.tsx", (source) => source.replace(/^import \{ logoutPlatform, usePlatformAuth \}.*\n/m, "").replace(/^  const email = .*\n/m, "").replace("PawPrintIcon, LogOutIcon, ", "").replace("onSelect, onSettings, onPets, petsReady }", "onSelect, onSettings }").replace(/^  (onPets|petsReady):.*\n/gm, "").replace(/^        <Button.*onClick=\{onPets\}.*\n/m, "").replace('email ?? t("settings")', 't("settings")').replace(/          <Button[^\n]*logoutPlatform[\s\S]*?<\/Button>\n/, ""));
  await edit("src-tauri/Cargo.toml", (source) => source.replace(/^(alwith-auth-client|alwith-native-client|tauri-plugin-http|tauri-plugin-os) = .*\n/gm, "").replace('features = ["protocol-asset"]', "features = []"));
  await edit("src-tauri/src/lib.rs", (source) => source.replace(/^        \.manage\(alwith_auth_client::pets::RuntimeAccess.*\n/m, "").replace(/\nfn pet_owner[\s\S]*$/, `
`).replace(/^        \.plugin\(tauri_plugin_(http|os)::init\(\)\)\n/gm, "").replace(/\.plugin\(alwith_module_store::tauri::init\(\)\)\n        \.plugin\(alwith_auth_client::tauri::init\(Some\([\s\S]*?\)\)\);/, ".plugin(alwith_module_store::tauri::init());"));
  await edit("src-tauri/capabilities/default.json", (source) => {
    const value = JSON.parse(source);
    value.windows = ["main", "settings"];
    value.description = "Chat window: Runtime relay, logs, opening links and local preferences";
    value.permissions = value.permissions.filter((permission) => typeof permission === "string" && permission !== "os:default" && !permission.startsWith("alwith-auth-client:"));
    return JSON.stringify(value, null, 2) + `
`;
  });
  await edit("scripts/stage.ts", (source) => source.replace(/^import .*stageNativeAuth.*\n/m, "").replace(/\n\/\/ 5\. The closed auth library[\s\S]*$/, `
`));
  await edit("vite.config.ts", (source) => source.replace(', "@alwith/module-auth"', "").replace(/^  build:.*\n/m, `  build: {rollupOptions: {input: {main: "index.html", settings: "settings.html"}}},
`));
}

// node_modules/create-alwith/src/lockfiles.ts
import { readFile as readFile3, writeFile as writeFile3 } from "fs/promises";
import { join as join3 } from "path";
async function configureLockfiles(root, previousName, name, version) {
  const bunPath = join3(root, "bun.lock");
  const bun = await readFile3(bunPath, "utf8");
  const rootName = /("workspaces"\s*:\s*\{\s*""\s*:\s*\{\s*"name"\s*:\s*)"[^"]+"/;
  if (!rootName.test(bun))
    throw new Error("Template Bun lockfile has no root workspace");
  await writeFile3(bunPath, bun.replace(rootName, (_, prefix) => prefix + JSON.stringify(name)));
  const cargoPath = join3(root, "src-tauri/Cargo.lock");
  const cargo = await readFile3(cargoPath, "utf8");
  const packages = cargo.split(/(?=^\[\[package\]\])/m);
  let changed = 0;
  const updated = packages.map((block) => {
    if (!block.startsWith("[[package]]") || !block.includes(`
name = ${JSON.stringify(previousName)}
`))
      return block;
    if (/^source\s*=/m.test(block))
      throw new Error("Template root package unexpectedly has a registry source");
    changed++;
    return block.replace(/^name = .*$/m, `name = ${JSON.stringify(name)}`).replace(/^version = .*$/m, `version = ${JSON.stringify(version)}`);
  });
  if (changed !== 1)
    throw new Error("Template Cargo lockfile must contain exactly one root package");
  const header = updated.shift();
  const rootIndex = updated.findIndex((block) => block.includes(`
name = ${JSON.stringify(name)}
`) && !/^source\s*=/m.test(block));
  const [rootPackage] = updated.splice(rootIndex, 1);
  const insertion = updated.findIndex((block) => (block.match(/^name = "([^"]+)"/m)?.[1] ?? "") >= name);
  updated.splice(insertion < 0 ? updated.length : insertion, 0, rootPackage);
  await writeFile3(cargoPath, header + updated.join(""));
}

// node_modules/create-alwith/src/updates.ts
import { generateKeyPairSync, randomBytes, scryptSync } from "crypto";
import { mkdir as mkdir2, writeFile as writeFile4 } from "fs/promises";
import { homedir } from "os";
import { join as join4 } from "path";
function githubRepository(value) {
  const text = typeof value === "string" ? value.trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "") : "";
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_.-]{1,100}$/.test(text))
    throw new Error("GitHub repository must be owner/repo");
  return text;
}
var KDF_OPSLIMIT = 1048576n;
var KDF_MEMLIMIT = 33554432n;
var u64le = (value) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(value);
  return b;
};
function generateUpdaterKeys(password = "") {
  if (Buffer.byteLength(password) > 1024)
    throw new Error("The key password cannot exceed 1024 bytes");
  const pair = generateKeyPairSync("ed25519");
  const seed = Buffer.from(pair.privateKey.export({ format: "jwk" }).d, "base64url");
  const pk = Buffer.from(pair.publicKey.export({ format: "jwk" }).x, "base64url");
  if (seed.length !== 32 || pk.length !== 32)
    throw new Error("Unexpected Ed25519 key size");
  const keynum = randomBytes(8), salt = randomBytes(32), sk = Buffer.concat([seed, pk]);
  const checksum = new Bun.CryptoHasher("blake2b256").update(Buffer.concat([Buffer.from("Ed"), keynum, sk])).digest();
  const material = Buffer.concat([keynum, sk, Buffer.from(checksum)]);
  const stream = scryptSync(password, salt, material.length, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  for (let i = 0;i < material.length; i++)
    material[i] ^= stream[i];
  const secret = Buffer.concat([Buffer.from("EdScB2"), salt, u64le(KDF_OPSLIMIT), u64le(KDF_MEMLIMIT), material]);
  const keyId = keynum.readBigUInt64LE().toString(16).toUpperCase().padStart(16, "0");
  const publicFile = `untrusted comment: minisign public key: ${keyId}
${Buffer.concat([Buffer.from("Ed"), keynum, pk]).toString("base64")}
`;
  const secretFile = `untrusted comment: rsign encrypted secret key
${secret.toString("base64")}
`;
  return { pubkey: Buffer.from(publicFile).toString("base64"), privateKey: Buffer.from(secretFile).toString("base64") };
}
function updaterKeyDirectory() {
  return join4(homedir(), ".tauri");
}
async function writeUpdaterKeys(directory, name, keys) {
  await mkdir2(directory, { recursive: true, mode: 448 });
  const path = join4(directory, `${name}.key`);
  try {
    await writeFile4(path, keys.privateKey, { flag: "wx", mode: 384 });
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error(`An updater key already exists at ${path}; move it away or pass --pubkey to reuse its public key`);
    throw error;
  }
  await writeFile4(`${path}.pub`, keys.pubkey, { flag: "w", mode: 420 });
  return path;
}

// node_modules/create-alwith/src/errors.ts
class GenerateError extends Error {
  code;
  constructor(code, message, options) {
    super(message, options);
    this.code = code;
    this.name = "GenerateError";
  }
}
function generationError(error) {
  if (error instanceof GenerateError)
    return error;
  if (error instanceof Error && error.name === "AbortError")
    return new GenerateError("CANCELLED", "Generation cancelled", { cause: error });
  return new GenerateError("GENERATION_FAILED", error instanceof Error ? error.message : String(error), { cause: error });
}
// node_modules/create-alwith/src/template.ts
import { cp } from "fs/promises";
import { relative } from "path";
var excluded = new Set(["node_modules", "target", "dist", ".git", ".cache", ".vite", ".DS_Store"]);
async function copyTemplate(source, destination) {
  await cp(source, destination, {
    recursive: true,
    filter: (path) => {
      const name = relative(source, path).replaceAll("\\", "/");
      return !name.split("/").some((part) => excluded.has(part)) && !["src-tauri/binaries", "src-tauri/resources", "src-tauri/gen"].some((dir) => name === dir || name.startsWith(`${dir}/`));
    }
  });
}

// node_modules/create-alwith/src/generate.ts
var packageRoot = resolve2(import.meta.dirname, "..");
async function generateProjectWithResult(options) {
  const progress = (phase) => {
    if (options.signal?.aborted)
      throw new GenerateError("CANCELLED", "Generation cancelled");
    options.onProgress?.(phase);
    if (options.signal?.aborted)
      throw new GenerateError("CANCELLED", "Generation cancelled");
  };
  progress("validate");
  const manifest = JSON.parse(await readFile4(join5(packageRoot, "package.json"), "utf8"));
  let config;
  let auth;
  let keys;
  let updates;
  try {
    const saved = options.configFile ? validateConfig(JSON.parse(await readFile4(options.configFile, "utf8"))) : undefined;
    if (saved && options.updates)
      throw new Error("configFile already supplies update settings");
    updates = saved?.updates;
    auth = authMode(saved ? saved.modules.includes("auth") ? "alwith" : "none" : options.auth ?? "alwith");
    if (options.updates) {
      const github = githubRepository(options.updates.github);
      if (options.updates.pubkey)
        updates = { github, pubkey: options.updates.pubkey.trim() };
      else {
        const directory = options.updates.keyDirectory ?? updaterKeyDirectory();
        if (await Bun.file(join5(directory, `${options.name}.key`)).exists())
          throw new Error(`An updater key already exists at ${join5(directory, `${options.name}.key`)}; move it away or pass its public key with --pubkey`);
        keys = { directory, pair: generateUpdaterKeys(options.updates.keyPassword ?? "") };
        updates = { github, pubkey: keys.pair.pubkey };
      }
    }
    config = validateConfig({ name: options.name, productName: options.productName, identifier: options.identifier, version: "0.1.0", icon: "assets/icon.svg", languages: ["en", "zh-CN"], window: { width: 1200, height: 800, minWidth: 900, minHeight: 600 }, preset: "chat", modules: auth === "alwith" ? ["chat", "auth", "store"] : ["chat", "store"], ...updates ? { updates } : {}, template: { name: "create-alwith", version: manifest.version } });
    if (saved)
      config = validateConfig({ ...saved, template: { name: "create-alwith", version: manifest.version } });
    if (!options.directory)
      throw new Error("An output directory is required");
  } catch (error) {
    throw new GenerateError("INVALID_INPUT", error instanceof Error ? error.message : String(error), { cause: error });
  }
  const output = resolve2(options.directory);
  let privateKey;
  await mkdir3(dirname(output), { recursive: true });
  try {
    await mkdir3(output);
  } catch (error) {
    if (error.code === "EEXIST")
      throw new GenerateError("DIRECTORY_EXISTS", `Output directory already exists: ${output}`, { cause: error });
    throw generationError(error);
  }
  try {
    progress("template");
    await copyTemplate(join5(packageRoot, "template"), output);
    if (options.configFile) {
      const icon = safePath(dirname(resolve2(options.configFile)), config.icon);
      const target = safePath(output, config.icon);
      await mkdir3(dirname(target), { recursive: true });
      await cp2(icon, target);
    }
    await cp2(join5(packageRoot, "alwith.app.schema.json"), join5(output, "alwith.app.schema.json"));
    const registry = JSON.parse(await readFile4(join5(packageRoot, "registry/built/manifest.json"), "utf8"));
    if (auth === "none")
      registry.items = registry.items.filter((item) => item.name !== "login");
    progress("registry");
    const blockSources = new Map;
    for (const item of registry.items) {
      const bytes = await readFile4(safePath(join5(packageRoot, "registry/built"), `${item.name}.json`));
      if (createHash("sha256").update(bytes).digest("hex") !== item.sha256)
        throw new GenerateError("SNAPSHOT_INVALID", `Registry snapshot integrity failed: ${item.name}`);
      const block = JSON.parse(bytes.toString());
      for (const file of block.files) {
        const destination = safePath(output, file.target);
        await mkdir3(dirname(destination), { recursive: true });
        await writeFile5(destination, file.content, { flag: "wx" });
        blockSources.set(file.target, `registry/${item.name}`);
      }
    }
    await configureAuth(output, auth);
    if (auth === "none") {
      await cp2(join5(packageRoot, "locks/none/bun.lock"), join5(output, "bun.lock"));
      await cp2(join5(packageRoot, "locks/none/src-tauri/Cargo.lock"), join5(output, "src-tauri/Cargo.lock"));
    }
    await writeFile5(join5(output, "alwith.app.json"), JSON.stringify({ $schema: "./alwith.app.schema.json", ...config }, null, 2) + `
`);
    progress("configure");
    if (keys)
      privateKey = await writeUpdaterKeys(keys.directory, config.name, keys.pair);
    const templateManifest = JSON.parse(await readFile4(join5(output, "package.json"), "utf8"));
    await configureProject(output, { icons: false });
    await configureLockfiles(output, templateManifest.name, config.name, config.version);
    const files = [];
    async function record(directory) {
      for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
        const path = join5(directory, entry.name);
        if (entry.isDirectory())
          await record(path);
        else {
          const name = relative2(output, path).replaceAll("\\", "/");
          const derived = ["index.html", "src-tauri/tauri.conf.json", "src/generated/app-icon.ts"].includes(name) || name.startsWith("public/app-icon.");
          files.push({ path: name, owner: derived ? "generator" : "user", source: derived ? "alwith.app.json" : blockSources.get(name) ?? (name === "alwith.app.json" ? "input" : "template"), sha256: createHash("sha256").update(await readFile4(path)).digest("hex") });
        }
      }
    }
    await record(output);
    await mkdir3(join5(output, ".alwith"));
    await writeFile5(join5(output, ".alwith/template.json"), JSON.stringify({ generator: manifest.name, version: manifest.version, preset: "chat", auth, updates: updates ? { github: updates.github } : null, bun: Bun.version, shadcn: "4.22.1", registry: registry.items, files, generatedFields: { "package.json": ["name", "version"], "src-tauri/Cargo.toml": ["package.name", "package.version", "bin.name"] } }, null, 2) + `
`);
    progress("complete");
    return { directory: output, ...updates ? { updates: { github: updates.github, ...privateKey ? { privateKey } : {} } } : {} };
  } catch (error) {
    await rm2(output, { recursive: true, force: true });
    if (privateKey)
      await rm2(privateKey, { force: true }).then(() => rm2(`${privateKey}.pub`, { force: true }));
    throw generationError(error);
  }
}

// node_modules/create-alwith/src/cli.ts
async function askHidden(question, signal) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return (await prompt.question(question, { signal })).trim();
    } finally {
      prompt.close();
    }
  }
  process.stdout.write(question);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off("data", onData);
      signal.removeEventListener("abort", onAbort);
      process.stdout.write(`
`);
      if (error)
        reject(error);
      else
        resolve(value);
    };
    const onAbort = () => finish(Object.assign(new Error("Generation cancelled"), { name: "AbortError" }));
    const onData = (chunk) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\x03")
          return onAbort();
        if (char === "\r" || char === `
`)
          return finish();
        if (char === "\x7F" || char === "\b")
          value = value.slice(0, -1);
        else if (char >= " ")
          value += char;
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    process.stdin.on("data", onData);
  });
}
var controller = new AbortController;
var cancel = () => controller.abort();
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);
var machine = Bun.argv.slice(2).includes("--json");
try {
  let parsed;
  try {
    parsed = parseArgs({ args: Bun.argv.slice(2), allowPositionals: true, options: {
      config: { type: "string" },
      directory: { type: "string" },
      name: { type: "string" },
      "product-name": { type: "string" },
      identifier: { type: "string" },
      auth: { type: "string" },
      preset: { type: "string" },
      yes: { type: "boolean" },
      github: { type: "string" },
      "key-password": { type: "string" },
      pubkey: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean" }
    } });
  } catch (error) {
    throw new GenerateError("INVALID_INPUT", error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  machine = values.json === true;
  if (values.help) {
    console.log(`bun create alwith <dir> --name my-app --product-name 'My App' --identifier com.example.myapp --preset chat --auth alwith|none [--github owner/repo [--key-password <password> | --pubkey <key>]] --yes [--json]
Use --config /path/to/alwith.app.json to recreate an existing brand in a new directory.
Omit arguments in an interactive terminal to be prompted. --directory is an alias for <dir>.
--github turns on signed auto update through that repository's GitHub Releases: a new updater key pair is written to ~/.tauri/<name>.key (never into the project) unless --pubkey reuses an existing public key.`);
  } else {
    if (positionals.length > 1 || positionals.length && values.directory)
      throw new GenerateError("INVALID_INPUT", "Provide one output directory, either positional or --directory");
    if (values.preset && values.preset !== "chat")
      throw new GenerateError("INVALID_INPUT", "Only the chat preset is available");
    const configFile = values.config;
    if (configFile && ["name", "product-name", "identifier", "auth", "preset", "github", "pubkey", "key-password"].some((key) => values[key] !== undefined))
      throw new GenerateError("INVALID_INPUT", "--config supplies brand and account settings; do not combine it with brand or account flags");
    const saved = configFile ? validateConfig(JSON.parse(await readFile5(configFile, "utf8"))) : undefined;
    const fields = {
      directory: values.directory ?? positionals[0],
      name: saved?.name ?? values.name,
      productName: saved?.productName ?? values["product-name"],
      identifier: saved?.identifier ?? values.identifier,
      auth: saved ? saved.modules.includes("auth") ? "alwith" : "none" : values.auth
    };
    if (!values.yes && !machine && process.stdin.isTTY && Object.values(fields).some((v) => !v)) {
      const prompt = createInterface({ input: process.stdin, output: process.stdout });
      try {
        for (const [key, question] of Object.entries({ directory: "Output directory", name: "Package name", productName: "Application name", identifier: "Bundle identifier (e.g. com.example.myapp)", auth: "ALwith account with pets, or bare chat (alwith/none)" })) {
          const field = key;
          if (!fields[field])
            fields[field] = (await prompt.question(`${question}: `, { signal: controller.signal })).trim();
        }
      } finally {
        prompt.close();
      }
    }
    if (Object.values(fields).some((v) => !v))
      throw new GenerateError("INVALID_INPUT", "Provide directory, --name, --product-name --identifier and --auth alwith|none. Use --help for an example.");
    const interactive = !values.yes && !machine && process.stdin.isTTY;
    let github = values.github;
    let keyPassword = values["key-password"];
    if (!saved && github === undefined && interactive) {
      const prompt = createInterface({ input: process.stdin, output: process.stdout });
      try {
        github = (await prompt.question("GitHub repository for releases and auto update (owner/repo, blank for none): ", { signal: controller.signal })).trim();
      } finally {
        prompt.close();
      }
    }
    if (github && !values.pubkey && keyPassword === undefined && interactive)
      keyPassword = await askHidden("Password for the new update signing key (blank for none): ", controller.signal);
    if (!github && (values.pubkey || keyPassword !== undefined))
      throw new GenerateError("INVALID_INPUT", "--pubkey and --key-password need --github");
    const result = await generateProjectWithResult({
      directory: fields.directory,
      name: fields.name,
      productName: fields.productName,
      identifier: fields.identifier,
      auth: fields.auth,
      ...github ? { updates: { github, pubkey: values.pubkey, keyPassword } } : {},
      configFile,
      signal: controller.signal,
      onProgress: (phase) => {
        if (machine)
          console.log(JSON.stringify({ type: "progress", phase }));
      }
    });
    const next = ["bun install", "bun run app-config", "bun run dev:tauri"];
    const updates = result.updates && [
      `Auto update publishes through https://github.com/${result.updates.github}/releases; the updater reads releases/latest/download/latest.json.`,
      ...result.updates.privateKey ? [
        `Updater private key: ${result.updates.privateKey} (kept outside the project; back it up, every future release must be signed with it).`,
        keyPassword ? "The key is protected by the password you entered." : "The key has no password; TAURI_SIGNING_PRIVATE_KEY_PASSWORD stays empty."
      ] : ["Releases are signed with the private key matching the public key you passed."],
      "Repository secrets for .github/workflows/release.yml: APPLE_CERTIFICATE, APPLE_CERTIFICATE_PASSWORD, APPLE_SIGNING_IDENTITY, APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID, TAURI_SIGNING_PRIVATE_KEY (the key file's contents), TAURI_SIGNING_PRIVATE_KEY_PASSWORD. Push a v<version> tag to release."
    ];
    console.log(machine ? JSON.stringify({ type: "result", ok: true, directory: result.directory, next, ...result.updates ? { updates: result.updates } : {} }) : `Created ${result.directory}.
In that directory, run:
${next.join(`
`)}${updates ? `

${updates.join(`
`)}` : ""}`);
  }
} catch (cause) {
  const error = generationError(cause);
  if (machine)
    console.log(JSON.stringify({ type: "result", ok: false, error: { code: error.code, message: error.message } }));
  else
    console.error(`${error.code}: ${error.message}`);
  process.exitCode = error.code === "CANCELLED" ? 130 : 1;
} finally {
  process.removeListener("SIGINT", cancel);
  process.removeListener("SIGTERM", cancel);
}
