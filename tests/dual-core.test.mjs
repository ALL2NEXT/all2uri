import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { convertText } from "../src/core/pipeline.ts";
import { assessNodeTestReadiness } from "../src/node-test.ts";

const uuid = "11111111-1111-1111-1111-111111111111";
const xray = fileURLToPath(new URL("../src-tauri/resources/xray.exe", import.meta.url));
const hasXray = process.platform === "win32" && existsSync(xray);
const node = input => {
  const result = convertText(input, "dual-core-test");
  assert.equal(result.nodes.length, 1, JSON.stringify(result.diagnostics));
  return result.nodes[0];
};
const profile = input => assessNodeTestReadiness("url204", node(input));
const xrayConfig = (outbound, port = 19001) => ({
  log: { loglevel: "error" },
  inbounds: [{ tag: "test-in", listen: "127.0.0.1", port, protocol: "http", settings: {} }],
  outbounds: [outbound],
});

async function checkXray(outbound) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "all2uri-xray-check-"));
  try {
    const file = path.join(directory, "config.json");
    await writeFile(file, JSON.stringify(xrayConfig(outbound)));
    const result = spawnSync(xray, ["run", "-test", "-c", file], { encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${result.error ?? ""}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("ordinary nodes use sing-box and XHTTP / VLESS encryption use Xray", () => {
  const ordinary = profile(`vless://${uuid}@edge.example:443?security=tls`);
  assert.equal(ordinary.profile.core, "sing-box");
  const xhttp = profile(`vless://${uuid}@edge.example:443?type=xhttp&security=tls&path=%2Fx&host=cdn.example&mode=packet-up&extra=%7B%22scMaxEachPostBytes%22%3A1000000%7D`);
  assert.equal(xhttp.profile.core, "xray");
  assert.deepEqual(xhttp.profile.outbound.streamSettings.xhttpSettings, {
    path: "/x", host: "cdn.example", mode: "packet-up", scMaxEachPostBytes: 1000000,
  });
  const encrypted = profile(`vless://${uuid}@edge.example:443?encryption=mlkem768x25519plus.native.1rtt.test`);
  assert.equal(encrypted.profile.core, "xray");
  assert.equal(encrypted.profile.outbound.settings.vnext[0].users[0].encryption, "mlkem768x25519plus.native.1rtt.test");
  const hybrid = profile(`vless://${uuid}@edge.example:443?security=reality&pbk=public&support-x25519mlkem768=true`);
  assert.equal(hybrid.profile.core, "xray");
  const reality = profile(JSON.stringify({ proxies: [{ type: "vless", server: "edge.example", port: 443, uuid, "reality-opts": { "public-key": "public" } }] }));
  assert.equal(reality.profile.core, "sing-box");
  assert.deepEqual(reality.profile.outbound.tls.utls, { enabled: true, fingerprint: "chrome" });
  assert.equal(reality.profile.outbound.tls.reality.public_key, "public");
  const websocket = profile(`vless://${uuid}@edge.example:443?type=ws&path=%2Fsocket&ed=2048&eh=Sec-WebSocket-Protocol&encryption=mlkem768x25519plus.native.1rtt.test`);
  assert.equal(websocket.profile.outbound.streamSettings.wsSettings.path, "/socket?ed=2048");
});

test("XHTTP aliases and VMess native JSON retain their transport options", () => {
  const alias = profile(`vless://${uuid}@edge.example:443?type=splithttp&path=%2Fa&mode=stream-up`);
  assert.equal(alias.profile.outbound.streamSettings.xhttpSettings.path, "/a");
  assert.equal(alias.profile.outbound.streamSettings.xhttpSettings.mode, "stream-up");
  const vmess = profile(JSON.stringify({
    add: "edge.example", port: "443", id: uuid, net: "xhttp", tls: "none", path: "/legacy",
    xhttpOptions: { path: "/correct", mode: "stream-one", extra: { noSSEHeader: true } },
  }));
  assert.equal(vmess.profile.core, "xray");
  assert.deepEqual(vmess.profile.outbound.streamSettings.xhttpSettings, { path: "/correct", mode: "stream-one", noSSEHeader: true });
  assert.equal(vmess.profile.outbound.streamSettings.security, undefined);
  const native = profile(JSON.stringify({ outbounds: [{
    type: "vless", server: "edge.example", server_port: 443, uuid,
    transport: { type: "xhttp", path: "/native", mode: "stream-up" },
  }] }));
  assert.equal(native.profile.outbound.streamSettings.xhttpSettings.path, "/native");
  assert.equal(native.profile.outbound.streamSettings.xhttpSettings.type, undefined);
  const xrayNative = profile(JSON.stringify({
    protocol: "vless", settings: { vnext: [{ address: "edge.example", port: 443, users: [{ id: uuid, encryption: "none" }] }] },
    streamSettings: { network: "xhttp", xhttpSettings: { path: "/native" }, security: "reality",
      realitySettings: { publicKey: "public", serverName: "example.com", spiderX: "/probe", mldsa65Verify: "verify-key" } },
  }));
  assert.equal(xrayNative.profile.outbound.streamSettings.realitySettings.spiderX, "/probe");
  assert.equal(xrayNative.profile.outbound.streamSettings.realitySettings.mldsa65Verify, "verify-key");
});

test("unsupported special features are unavailable instead of silently dropped", () => {
  const cases = [
    [`vless://${uuid}@edge.example:443?type=xhttp&fragment=1`, /TLS.*fragment/],
    [`vless://${uuid}@edge.example:443?type=xhttp&security=tls&allowInsecure=1`, /证书/],
    [`vless://${uuid}@edge.example:443?type=xhttp&security=reality`, /REALITY 公钥/],
    [`vless://${uuid}@edge.example:443?type=xhttp&security=reality&pbk=key&support-x25519mlkem768=false`, /support-x25519mlkem768/],
    [`vless://${uuid}@edge.example:443?type=xhttp&xhttpOptions=%7B%22vendor%22%3A1%7D`, /XHTTP.*vendor/],
    ["wireguard://private@edge.example:51820?publickey=public&jc=3", /WireGuard/],
    ["masque://private@edge.example:443?profile=standard&public_key=public&ip=10.0.0.2", /Cloudflare/],
    ["masque://private@edge.example:443?profile=cloudflare&public_key=public&ip=10.0.0.2&mtu=1400", /mtu/],
  ];
  for (const [input, reason] of cases) {
    const result = profile(input);
    assert.equal(result.available, false, input);
    assert.match(result.reason, reason);
  }
});

test("bundled Xray accepts VLESS, VMess, Trojan XHTTP, encrypted VLESS, and WARP MASQUE configs", { skip: !hasXray }, async () => {
  const realityKey = Buffer.alloc(32, 5).toString("base64url");
  const reality = profile(`vless://${uuid}@edge.example:443?type=xhttp&security=reality&sni=example.com&pbk=${realityKey}&sid=abcd&path=%2Fx&support-x25519mlkem768=true`);
  await checkXray(reality.profile.outbound);
  const encryption = `mlkem768x25519plus.native.1rtt.${Buffer.alloc(32, 7).toString("base64url")}`;
  const encrypted = profile(`vless://${uuid}@edge.example:443?encryption=${encryption}`);
  await checkXray(encrypted.profile.outbound);
  const vmessPayload = Buffer.from(JSON.stringify({ add: "edge.example", port: 443, id: uuid, net: "xhttp", path: "/vmess", tls: "none" })).toString("base64");
  const vmess = profile(`vmess://${vmessPayload}`);
  await checkXray(vmess.profile.outbound);
  const trojan = profile("trojan://password@edge.example:443?type=xhttp&path=%2Ftrojan&security=tls");
  await checkXray(trojan.profile.outbound);
  const keys = generateKeyPairSync("ec", {
    namedCurve: "prime256v1", privateKeyEncoding: { type: "pkcs8", format: "der" },
    publicKeyEncoding: { type: "spki", format: "der" },
  });
  const masque = profile(`masque://${encodeURIComponent(keys.privateKey.toString("base64"))}@edge.example:443?profile=cloudflare&public_key=${encodeURIComponent(keys.publicKey.toString("base64"))}&ip=10.0.0.2`);
  assert.equal(masque.profile.core, "xray");
  await checkXray(masque.profile.outbound);
});

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitForPort(port, process) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (process.exitCode !== null) throw new Error(`Xray exited: ${process.exitCode}`);
    const connected = await new Promise(resolve => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
    });
    if (connected) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("Xray did not start");
}

test("XHTTP node carries an HTTP request through the actual bundled Xray", { skip: !hasXray, timeout: 20000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "all2uri-xray-live-"));
  const children = [];
  const target = http.createServer((_request, response) => response.end("xhttp-proxy-ok"));
  t.after(async () => {
    await Promise.all(children.map(child => new Promise(resolve => {
      if (child.exitCode !== null) return resolve();
      child.once("exit", resolve);
      child.kill();
    })));
    await new Promise(resolve => target.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise(resolve => target.listen(0, "127.0.0.1", resolve));
  const targetPort = target.address().port;
  const serverPort = await freePort();
  const proxyPort = await freePort();
  const serverConfig = {
    log: { loglevel: "debug" },
    inbounds: [{ listen: "127.0.0.1", port: serverPort, protocol: "vless", settings: { clients: [{ id: uuid }], decryption: "none" },
      streamSettings: { network: "xhttp", xhttpSettings: { path: "/test", mode: "stream-one" } } }],
    outbounds: [{ protocol: "freedom", settings: { finalRules: [{ action: "allow", ip: ["127.0.0.1/32"] }] } }],
  };
  const result = profile(`vless://${uuid}@127.0.0.1:${serverPort}?type=xhttp&path=%2Ftest&mode=stream-one`);
  assert.equal(result.profile.core, "xray");
  const serverFile = path.join(directory, "server.json");
  const clientFile = path.join(directory, "client.json");
  await writeFile(serverFile, JSON.stringify(serverConfig));
  await writeFile(clientFile, JSON.stringify(xrayConfig(result.profile.outbound, proxyPort)));
  const logs = [];
  for (const [file, port] of [[serverFile, serverPort], [clientFile, proxyPort]]) {
    const child = spawn(xray, ["run", "-c", file], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    child.stdout.on("data", data => logs.push(data.toString()));
    child.stderr.on("data", data => logs.push(data.toString()));
    children.push(child);
    await waitForPort(port, child);
  }
  const body = await new Promise((resolve, reject) => {
    const request = http.get({ hostname: "127.0.0.1", port: proxyPort, path: `http://127.0.0.1:${targetPort}/` }, response => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { text += chunk; });
      response.on("end", () => resolve(text));
    });
    request.setTimeout(5000, () => request.destroy(new Error("proxy request timed out")));
    request.on("error", error => reject(new Error(`${error.message}\n${logs.join("")}`)));
  });
  assert.equal(body, "xhttp-proxy-ok");
});
