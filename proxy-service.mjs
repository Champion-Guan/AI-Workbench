import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { delimiter, join } from "node:path";
import { arch, homedir, platform, tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";

const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const DEFAULT_PROXY_PORT = 17890;

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, "base64").toString("utf8");
}

function yamlString(value) {
  return JSON.stringify(String(value ?? ""));
}

function decodeFragment(value) {
  if (!value) return "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function uniqueName(preferred, index, used) {
  const base = String(preferred || `image-relay-${index + 1}`).trim() || `image-relay-${index + 1}`;
  let name = base;
  let suffix = 2;
  while (used.has(name)) name = `${base}-${suffix++}`;
  used.add(name);
  return name;
}

function parseSsNode(line, index, used) {
  const source = line.trim();
  if (!/^ss:\/\//i.test(source)) return null;
  let url;
  try {
    url = new URL(source);
  } catch {
    return null;
  }

  let method = decodeFragment(url.username);
  let password = decodeFragment(url.password);
  let server = url.hostname;
  let port = Number(url.port || 0);
  if (!server || !port || !method || !password) {
    const encoded = source.slice(source.indexOf("://") + 3).split(/[?#]/, 1)[0];
    let decoded;
    try {
      decoded = decodeBase64Url(encoded);
    } catch {
      decoded = "";
    }
    const at = decoded.lastIndexOf("@");
    const credentials = at >= 0 ? decoded.slice(0, at) : "";
    const address = at >= 0 ? decoded.slice(at + 1) : decoded;
    const separator = credentials.indexOf(":");
    if (separator > 0) {
      method = method || credentials.slice(0, separator);
      password = password || credentials.slice(separator + 1);
    }
    const colon = address.lastIndexOf(":");
    if (colon > 0) {
      server = server || address.slice(0, colon);
      port = port || Number(address.slice(colon + 1));
    }
  }
  if (!server || !port || !method || !password) return null;

  const node = {
    name: uniqueName(decodeFragment(url.hash.slice(1)), index, used),
    type: "ss",
    server,
    port,
    cipher: method,
    password,
  };
  const plugin = url.searchParams.get("plugin");
  if (plugin) node.plugin = plugin;
  return node;
}

function parseHysteriaNode(line, index, used) {
  const source = line.trim().replace(/^hy2:\/\//i, "hysteria2://");
  if (!/^hysteria2:\/\//i.test(source)) return null;
  let url;
  try {
    url = new URL(source);
  } catch {
    return null;
  }
  const server = url.hostname;
  const port = Number(url.port || 0);
  const password = decodeFragment(url.username || url.password);
  if (!server || !port || !password) return null;

  const node = {
    name: uniqueName(decodeFragment(url.hash.slice(1)), index, used),
    type: "hysteria2",
    server,
    port,
    password,
  };
  const sni = url.searchParams.get("sni") || url.searchParams.get("peer");
  if (sni) node.sni = sni;
  if (["1", "true", "yes"].includes((url.searchParams.get("insecure") || "").toLowerCase())) {
    node["skip-cert-verify"] = true;
  }
  const obfs = url.searchParams.get("obfs");
  const obfsPassword = url.searchParams.get("obfs-password") || url.searchParams.get("obfs_password");
  if (obfs) {
    node.obfs = obfs;
    if (obfsPassword) node["obfs-password"] = obfsPassword;
  }
  const alpn = url.searchParams.getAll("alpn");
  if (alpn.length) node.alpn = alpn;
  return node;
}

function parseSubscriptionNodes(source) {
  let text = String(source || "").replace(/^\uFEFF/, "").trim();
  if (!text) return [];
  if (!/^proxies\s*:/m.test(text) && !/^[a-z][a-z\d+.-]*:\/\//im.test(text)) {
    try {
      const decoded = decodeBase64Url(text.replace(/\s+/g, ""));
      if (/[a-z][a-z\d+.-]*:\/\//i.test(decoded)) text = decoded;
    } catch {
      // Leave malformed/unsupported subscription data for the diagnostic below.
    }
  }

  if (/^proxies\s*:/m.test(text)) return null;
  const used = new Set();
  const nodes = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const clean = line.trim();
    if (!clean || clean.startsWith("#")) continue;
    const node = parseSsNode(clean, index, used) || parseHysteriaNode(clean, index, used);
    if (node) nodes.push(node);
  }
  return nodes;
}

function nodeYaml(node) {
  const lines = [
    `  - name: ${yamlString(node.name)}`,
    `    type: ${node.type}`,
    `    server: ${yamlString(node.server)}`,
    `    port: ${node.port}`,
  ];
  if (node.type === "ss") {
    lines.push(`    cipher: ${yamlString(node.cipher)}`);
    lines.push(`    password: ${yamlString(node.password)}`);
    if (node.plugin) lines.push(`    plugin: ${yamlString(node.plugin)}`);
  } else {
    lines.push(`    password: ${yamlString(node.password)}`);
    if (node.sni) lines.push(`    sni: ${yamlString(node.sni)}`);
    if (node["skip-cert-verify"]) lines.push("    skip-cert-verify: true");
    if (node.obfs) lines.push(`    obfs: ${yamlString(node.obfs)}`);
    if (node["obfs-password"]) lines.push(`    obfs-password: ${yamlString(node["obfs-password"])}`);
    if (node.alpn?.length) lines.push(`    alpn: ${JSON.stringify(node.alpn)}`);
  }
  return lines.join("\n");
}

function buildMihomoConfig(source, port) {
  const nodes = parseSubscriptionNodes(source);
  if (nodes === null) {
    // A complete Clash/Mihomo document can be supplied through a local file
    // or a private subscription URL. Only the listener settings are changed;
    // node credentials stay in the temporary runtime file.
    let config = String(source).replace(/^\uFEFF/, "");
    const replacements = [
      ["mixed-port", String(port)],
      ["port", "0"],
      ["socks-port", "0"],
      ["redir-port", "0"],
      ["tproxy-port", "0"],
      ["external-controller", '""'],
    ];
    for (const [key, value] of replacements) {
      const expression = new RegExp(`^${key}\\s*:[^\\n]*$`, "mi");
      if (expression.test(config)) config = config.replace(expression, `${key}: ${value}`);
      else config = `${key}: ${value}\n${config}`;
    }
    return config.endsWith("\n") ? config : `${config}\n`;
  }
  if (!nodes.length) throw new Error("未找到可用的 SS 或 Hysteria2 节点");
  const names = nodes.map((node) => node.name);
  return [
    `mixed-port: ${port}`,
    "allow-lan: false",
    "mode: rule",
    "log-level: warning",
    "ipv6: true",
    "proxies:",
    ...nodes.map(nodeYaml),
    "proxy-groups:",
    "  - name: IMAGE-RELAY",
    "    type: url-test",
    "    url: https://www.gstatic.com/generate_204",
    "    interval: 300",
    "    tolerance: 80",
    "    lazy: false",
    "    proxies:",
    ...names.map((name) => `      - ${yamlString(name)}`),
    "rules:",
    "  - MATCH,IMAGE-RELAY",
    "",
  ].join("\n");
}

async function readTextSource(sourceOverride) {
  if (sourceOverride && typeof sourceOverride === "object") {
    if (sourceOverride.kind === "text") {
      const text = String(sourceOverride.value || "");
      if (Buffer.byteLength(text) > MAX_SOURCE_BYTES) throw new Error("上传的代理配置超过本地代理允许的大小");
      return text;
    }
    if (sourceOverride.kind === "url") {
      const url = String(sourceOverride.value || "").trim();
      if (!/^https?:\/\//i.test(url)) throw new Error("代理订阅地址必须使用 http 或 https");
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`订阅地址返回 HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > MAX_SOURCE_BYTES) throw new Error("订阅配置超过本地代理允许的大小");
      return bytes.toString("utf8");
    }
  }
  const file = process.env.IMAGE_RELAY_MIHOMO_CONFIG_FILE?.trim();
  if (file) return readFile(file, "utf8");

  const subscriptionFile = process.env.IMAGE_RELAY_SUBSCRIPTION_FILE?.trim();
  if (subscriptionFile) return readFile(subscriptionFile, "utf8");

  const subscriptionUrl = process.env.IMAGE_RELAY_SUBSCRIPTION_URL?.trim();
  if (subscriptionUrl) {
    const response = await fetch(subscriptionUrl, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`订阅地址返回 HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_SOURCE_BYTES) throw new Error("订阅配置超过本地代理允许的大小");
    return bytes.toString("utf8");
  }

  const subStoreUrl = process.env.IMAGE_RELAY_SUBSTORE_API_URL?.trim();
  const subStoreName = process.env.IMAGE_RELAY_SUBSCRIPTION_NAME?.trim();
  if (subStoreUrl && subStoreName) {
    const base = subStoreUrl.replace(/\/+$/, "");
    const response = await fetch(`${base}/api/sub/${encodeURIComponent(subStoreName)}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Sub-Store 返回 HTTP ${response.status}`);
    const payload = await response.json();
    const content = payload?.data?.content;
    if (typeof content !== "string" || !content.trim()) throw new Error("Sub-Store 没有返回节点内容");
    if (Buffer.byteLength(content) > MAX_SOURCE_BYTES) throw new Error("Sub-Store 节点内容超过本地代理允许的大小");
    return content;
  }
  return null;
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function releaseAssetPattern() {
  const osName = platform();
  const cpu = arch();
  const targetOs = osName === "darwin" ? "darwin" : osName === "linux" ? "linux" : null;
  const targetCpu = cpu === "arm64" ? "arm64" : cpu === "x64" ? "amd64" : null;
  if (!targetOs || !targetCpu) return null;
  return new RegExp(`^mihomo-${targetOs}-${targetCpu}(?:-compatible)?-[^/]+\\.gz$`);
}

async function downloadMihomoBinary() {
  if (process.env.IMAGE_RELAY_MIHOMO_AUTO_DOWNLOAD === "false") return null;
  const pattern = releaseAssetPattern();
  if (!pattern) return null;
  const version = process.env.IMAGE_RELAY_MIHOMO_VERSION?.trim();
  const releaseUrl = version
    ? `https://api.github.com/repos/MetaCubeX/mihomo/releases/tags/${encodeURIComponent(version)}`
    : "https://api.github.com/repos/MetaCubeX/mihomo/releases/latest";
  const releaseResponse = await fetch(releaseUrl, {
    headers: { accept: "application/vnd.github+json", "user-agent": "guan-ai-workbench" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!releaseResponse.ok) throw new Error(`Mihomo 发布信息返回 HTTP ${releaseResponse.status}`);
  const release = await releaseResponse.json();
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const asset = assets.find((candidate) => pattern.test(candidate?.name || "")) ||
    assets.find((candidate) => {
      const name = candidate?.name || "";
      return name.startsWith(`mihomo-${platform()}-${arch()}`) && name.endsWith(".gz");
    });
  if (!asset?.browser_download_url || !asset.name) throw new Error("没有找到当前平台的 Mihomo 下载包");

  const cacheRoot = process.env.IMAGE_RELAY_MIHOMO_CACHE_DIR?.trim() || join(homedir(), ".cache", "guan-ai-workbench", "mihomo");
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  const cacheName = asset.name.replace(/\.gz$/, "");
  const binaryPath = join(cacheRoot, cacheName);
  if (await pathExists(binaryPath)) return binaryPath;

  const binaryResponse = await fetch(asset.browser_download_url, {
    headers: { accept: "application/octet-stream", "user-agent": "guan-ai-workbench" },
    redirect: "follow",
    signal: AbortSignal.timeout(120_000),
  });
  if (!binaryResponse.ok) throw new Error(`Mihomo 下载返回 HTTP ${binaryResponse.status}`);
  const compressed = Buffer.from(await binaryResponse.arrayBuffer());
  if (compressed.length > 100 * 1024 * 1024) throw new Error("Mihomo 下载包超过大小限制");
  const binary = gunzipSync(compressed);
  if (binary.length < 1024 * 1024) throw new Error("Mihomo 下载包内容无效");
  const temporaryPath = `${binaryPath}.partial-${process.pid}`;
  await writeFile(temporaryPath, binary, { mode: 0o700 });
  await chmod(temporaryPath, 0o700);
  await writeFile(binaryPath, binary, { mode: 0o700 });
  await rm(temporaryPath, { force: true });
  return binaryPath;
}

async function resolveMihomoBinary(projectRoot) {
  const candidates = [
    process.env.IMAGE_RELAY_MIHOMO_BIN?.trim(),
    join(projectRoot, "proxy-runtime", "mihomo"),
    join(projectRoot, "proxy-runtime", "mihomo-smart"),
    "/opt/homebrew/bin/mihomo",
    "/usr/local/bin/mihomo",
    "/Applications/Clash Party.app/Contents/Resources/sidecar/mihomo-smart",
    ...String(process.env.PATH || "").split(delimiter).map((directory) => join(directory, "mihomo")),
  ].filter(Boolean);
  for (const candidate of candidates) if (await pathExists(candidate)) return candidate;
  return downloadMihomoBinary();
}

function waitForPort(port, timeoutMs, child) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let timer;
    const attempt = () => {
      if (child.exitCode != null) {
        reject(new Error("内置 Mihomo 进程提前退出"));
        return;
      }
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() - startedAt >= timeoutMs) {
          clearTimeout(timer);
          reject(new Error("内置 Mihomo 代理端口启动超时"));
          return;
        }
        timer = setTimeout(attempt, 250);
      });
    };
    attempt();
  });
}

export async function startBuiltInImageProxy({ projectRoot, onProxyReady, sourceOverride } = {}) {
  const source = await readTextSource(sourceOverride);
  if (!source) return null;
  const binary = await resolveMihomoBinary(projectRoot);
  if (!binary) throw new Error("未找到 Mihomo。请设置 IMAGE_RELAY_MIHOMO_BIN，或将二进制放入 proxy-runtime/mihomo。");

  const port = Math.max(1024, Number(process.env.IMAGE_RELAY_PROXY_PORT || DEFAULT_PROXY_PORT));
  const runtimeDir = await mkdtemp(join(tmpdir(), "guan-image-relay-"));
  const configPath = join(runtimeDir, "config.yaml");
  const config = buildMihomoConfig(source, port);
  await writeFile(configPath, config, { encoding: "utf8", mode: 0o600 });

  const child = spawn(binary, ["-d", runtimeDir, "-f", configPath], {
    cwd: runtimeDir,
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env },
  });
  try {
    await waitForPort(port, 20_000, child);
  } catch (error) {
    child.kill("SIGTERM");
    await rm(runtimeDir, { recursive: true, force: true });
    throw error;
  }

  const proxyUrl = `http://127.0.0.1:${port}`;
  onProxyReady?.(proxyUrl);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    child.kill("SIGTERM");
    await rm(runtimeDir, { recursive: true, force: true });
  };
  return { proxyUrl, stop, pid: child.pid };
}
