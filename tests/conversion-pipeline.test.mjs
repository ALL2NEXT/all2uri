import assert from "node:assert/strict";
import test from "node:test";
import { convertSource, convertSources, convertSourcesAsync, convertText } from "../src/core/pipeline.ts";
import { buildLossyConversionLog } from "../src/core/lossy-conversion-log.ts";
import { detectNativeFormat, parseNativeValue } from "../src/core/parsers/native-parser.ts";
import { parseUriNode } from "../src/core/parsers/uri-parser.ts";
import { assessNodeTestReadiness } from "../src/node-test.ts";

const uuid = "11111111-1111-1111-1111-111111111111";

test("direct URI conversion records an origin and emits complete results", () => {
  const result = convertText(`vless://${uuid}@edge.example:443?security=tls#edge`, "source-a");
  assert.equal(result.stats.complete, 1);
  assert.equal(result.uris.length, 1);
  assert.equal(result.nodes[0].sources[0].sourceId, "source-a");
  assert.equal(result.nodes[0].sources[0].location, "fragment[0]/uri[0]");
});

test("positions distinguish repeated node indexes across fragments", () => {
  const result = convertText(
    `trojan://first@one.example:443#one\ntrojan://second@two.example:443#two`,
    "source-a",
  );
  assert.deepEqual(result.nodes.map(node => node.sources[0].location), [
    "fragment[0]/uri[0]",
    "fragment[1]/uri[0]",
  ]);
});

test("unrecognized URI parameters are retained, reported as lossy, and emitted by default", () => {
  const input = `vless://${uuid}@edge.example:443?security=tls&vendorOption=one#edge`;
  const result = convertText(input, "source-a");
  assert.equal(result.stats.lossy, 1);
  assert.equal(result.uris.length, 1);
  assert.equal(result.nodes.length, 1);
  assert.equal(result.encoded[0].status, "lossy");
  assert.equal(result.nodes[0].extensions.vendorOption, "one");
  assert.ok(result.diagnostics.some(item => item.code === "field_not_encoded" && item.field === "vendorOption"));
});

test("lossy conversion log includes omitted config with credentials redacted", () => {
  const result = convertText(
    `vless://${uuid}@edge.example:443?security=tls&vendorOption=one&password=password-secret&token=token-secret#edge`,
    "source-a",
  );
  const node = result.nodes[0];
  const reportNode = {
    ...node,
    extensions: {
      ...node.extensions,
      nested: {
        Authorization: "auth-secret",
        rawConfig: "private raw input",
        sourceUri: "https://user:secret@example.org/subscription",
        visibleOption: "kept",
      },
    },
  };
  const encoded = result.encoded.find((item) => item.node.id === node.id);
  const logEntry = {
    id: `${node.id}-0`,
    name: node.name,
    server: node.server,
    port: node.port,
    protocol: node.protocol,
    uri: result.uris[0],
    conversionStatus: encoded.status,
    conversionDiagnostics: encoded.diagnostics,
    node: reportNode,
  };
  const report = buildLossyConversionLog(
    [logEntry, { ...logEntry, id: "complete-node", conversionStatus: "complete" }],
    { scope: "filtered", generatedAt: "2026-01-01T00:00:00.000Z" },
  );
  const serialized = JSON.stringify(report);
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.summary.lossyNodeCount, 1);
  assert.deepEqual(report.summary.unencodedFields, ["password", "token", "vendorOption"]);
  assert.equal(report.nodes[0].outputUri, result.uris[0]);
  assert.equal(report.nodes[0].extensions.vendorOption, "one");
  assert.equal(report.nodes[0].extensions.password, "password-secret");
  assert.equal(report.nodes[0].extensions.token, "token-secret");
  assert.equal(report.nodes[0].extensions.nested.Authorization, "auth-secret");
  assert.equal(report.nodes[0].extensions.nested.rawConfig, "private raw input");
  assert.equal(
    report.nodes[0].extensions.nested.sourceUri,
    "https://user:secret@example.org/subscription",
  );
  assert.equal(report.nodes[0].extensions.nested.visibleOption, "kept");
  assert.equal(report.nodes[0].settings.uuid, uuid);
  assert.ok(report.nodes[0].diagnostics.some(item => item.compatibility === "unknown"));
  assert.deepEqual(report.nodes[0].sources, [{
    sourceId: "source-a",
    format: "uri",
    location: "fragment[0]/uri[0]",
  }]);
  assert.equal("raw" in report.nodes[0], false);
  assert.equal("uri" in report.nodes[0], false);
  assert.equal(serialized.includes(uuid), true);
  assert.equal(serialized.includes("password-secret"), true);
  assert.equal(serialized.includes("token-secret"), true);
  assert.equal(serialized.includes("auth-secret"), true);
  assert.equal(serialized.includes("private raw input"), true);
  assert.equal(serialized.includes("user:secret@example.org"), true);
});

test("unknown query values cannot override protocol credentials during encoding", () => {
  const result = convertText(`trojan://original-secret@edge.example:443?password=other-secret#edge`, "source-a");
  assert.equal(result.encoded[0].status, "lossy");
  assert.equal(new URL(result.uris[0]).username, "original-secret");
  assert.ok(result.diagnostics.some(item => item.code === "field_not_encoded" && item.field === "password"));
});

test("VLESS TCP header type and REALITY spiderX survive URI round-trip", () => {
  const input = `vless://${uuid}@edge.example:443?encryption=none&flow=xtls-rprx-vision&security=reality&sni=www.amazon.com&fp=chrome&pbk=test-public-key&sid=test-short-id&spx=%2F&type=tcp&headerType=none#edge`;
  const result = convertText(input, "source-a");
  assert.equal(result.encoded[0].status, "complete");
  const output = new URL(result.uris[0]);
  assert.equal(output.searchParams.get("headerType"), "none");
  assert.equal(output.searchParams.get("spx"), "/");
});

test("TLS, ECH and certificate pin fields survive URI parse and encode", () => {
  const input = `vless://${uuid}@edge.example:443?security=tls&echEnabled=true&echConfigList=abc&echQueryServerName=ech.example&pinSHA256=pin-value&minVersion=1.2&maxVersion=1.3#edge`;
  const result = convertText(input, "source-a");
  assert.equal(result.encoded[0].status, "complete");
  const output = new URL(result.uris[0]);
  assert.equal(output.searchParams.get("echEnabled"), "true");
  assert.equal(output.searchParams.get("echConfigList"), "abc");
  assert.equal(output.searchParams.get("echQueryServerName"), "ech.example");
  assert.equal(output.searchParams.get("pinSHA256"), "pin-value");
  assert.equal(output.searchParams.get("minVersion"), "1.2");
  assert.equal(output.searchParams.get("maxVersion"), "1.3");
});

test("VLESS compatibility defaults are classified by protocol and SNI round-trips", () => {
  const result = convertText(`proxies:\n  - type: vless\n    name: vless\n    server: edge.example\n    port: 443\n    uuid: ${uuid}\n    alterId: 0\n    cipher: auto\n    udp: true\n    servername: www.example.com`, "vless-compat");
  assert.equal(result.uris.length, 1);
  assert.equal(result.encoded[0].status, "complete");
  assert.equal(new URL(result.uris[0]).searchParams.get("sni"), "www.example.com");
  assert.equal(result.encoded[0].fieldCompatibility.find(item => item.field === "alterId").status, "not_applicable");
  assert.equal(result.encoded[0].fieldCompatibility.find(item => item.field === "cipher").status, "default_omitted");
  assert.equal(result.encoded[0].fieldCompatibility.find(item => item.field === "udp").status, "equivalent");
  const parsed = parseUriNode(result.uris[0], { sourceId: "roundtrip", format: "uri" });
  assert.equal(parsed.node.settings.servername, "www.example.com");
});

test("VLESS non-default alterId and cipher remain explicit compatibility losses", () => {
  const result = convertText(`proxies:\n  - type: vless\n    server: edge.example\n    port: 443\n    uuid: ${uuid}\n    alterId: 4\n    cipher: aes-128-gcm`, "vless-non-default");
  assert.equal(result.encoded[0].status, "lossy");
  for (const field of ["alterId", "cipher"]) {
    assert.ok(result.diagnostics.some(item => item.field === field && item.compatibility === "not_representable"));
  }
});

test("VMess alterId and cipher are encoded and recover from the generated URI", () => {
  const result = convertText(`proxies:\n  - type: vmess\n    server: edge.example\n    port: 443\n    uuid: ${uuid}\n    alterId: 7\n    cipher: chacha20-poly1305`, "vmess-fields");
  assert.equal(result.encoded[0].status, "complete");
  const parsed = parseUriNode(result.uris[0], { sourceId: "roundtrip", format: "uri" });
  assert.equal(parsed.node.settings.alterId, 7);
  assert.equal(parsed.node.settings.cipher, "chacha20-poly1305");
});

test("VMess servername is serialized as SNI and survives URI parsing", () => {
  const result = convertText(`proxies:\n  - type: vmess\n    server: edge.example\n    port: 443\n    uuid: ${uuid}\n    tls: true\n    servername: www.example.com`, "vmess-sni");
  const parsed = parseUriNode(result.uris[0], { sourceId: "roundtrip", format: "uri" });
  assert.equal(result.encoded[0].status, "complete");
  assert.equal(parsed.node.settings.sni, "www.example.com");
});

test("VMess top-level ws-path is preserved in Base64 JSON and round-trips", () => {
  const result = convertText(`proxies:\n  - type: vmess\n    server: edge.example\n    port: 443\n    uuid: ${uuid}\n    network: ws\n    ws-path: /ws`, "vmess-ws-path");
  assert.equal(result.encoded[0].status, "complete");
  const parsed = parseUriNode(result.uris[0], { sourceId: "roundtrip", format: "uri" });
  assert.equal(parsed.node.settings.network, "ws");
  assert.equal(parsed.node.settings["ws-opts"].path, "/ws");
});

test("VMess ws-opts and ws_opts path aliases are consumed by the active transport", () => {
  for (const optionsKey of ["ws-opts", "ws_opts"]) {
    const result = convertText(`proxies:\n  - type: vmess\n    server: edge.example\n    port: 443\n    uuid: ${uuid}\n    network: ws\n    ${optionsKey}:\n      path: /nested`, `vmess-${optionsKey}`);
    assert.equal(result.encoded[0].status, "complete");
    const parsed = parseUriNode(result.uris[0], { sourceId: "roundtrip", format: "uri" });
    assert.equal(parsed.node.settings["ws-opts"].path, "/nested");
  }
});

test("conflicting VMess WebSocket paths prefer ws-opts.path and report the ignored value", () => {
  const result = convertText(`proxies:\n  - type: vmess\n    server: edge.example\n    port: 443\n    uuid: ${uuid}\n    network: ws\n    ws-path: /flat\n    ws-opts:\n      path: /nested`, "vmess-ws-conflict");
  assert.equal(result.encoded[0].status, "lossy");
  assert.equal(result.encoded[0].fieldCompatibility.find(item => item.field === "ws-path").status, "not_representable");
  const parsed = parseUriNode(result.uris[0], { sourceId: "roundtrip", format: "uri" });
  assert.equal(parsed.node.settings["ws-opts"].path, "/nested");
});

test("Trojan servername maps to sni and is recovered from the actual URI", () => {
  const result = convertText(`proxies:\n  - type: trojan\n    server: edge.example\n    port: 443\n    password: secret\n    server_name: www.example.com`, "trojan-sni");
  assert.equal(result.encoded[0].status, "complete");
  assert.equal(new URL(result.uris[0]).searchParams.get("sni"), "www.example.com");
  const parsed = parseUriNode(result.uris[0], { sourceId: "roundtrip", format: "uri" });
  assert.equal(parsed.node.settings.servername, "www.example.com");
});

test("UDP true is equivalent to URI defaults while explicit UDP false stays lossy", () => {
  const enabled = convertText(`proxies:\n  - type: ss\n    server: edge.example\n    port: 8388\n    cipher: aes-128-gcm\n    password: secret\n    udp: true`, "udp-enabled");
  assert.equal(enabled.encoded[0].status, "complete");
  assert.equal(enabled.encoded[0].fieldCompatibility.find(item => item.field === "udp").status, "equivalent");
  assert.equal(new URL(enabled.uris[0]).searchParams.has("udp"), false);

  const disabled = convertText(`proxies:\n  - type: ss\n    server: edge.example\n    port: 8388\n    cipher: aes-128-gcm\n    password: secret\n    udp: false`, "udp-disabled");
  assert.equal(disabled.encoded[0].status, "lossy");
  assert.ok(disabled.diagnostics.some(item => item.field === "udp" && item.compatibility === "not_representable"));
});

test("Clash mode=multi on TCP is not applicable, while XHTTP mode is encoded", () => {
  const tcp = convertText(`proxies:\n  - type: vless\n    server: edge.example\n    port: 443\n    uuid: ${uuid}\n    network: tcp\n    mode: multi`, "clash-mode");
  assert.equal(tcp.encoded[0].status, "complete");
  assert.equal(tcp.encoded[0].fieldCompatibility.find(item => item.field === "mode").status, "not_applicable");

  const xhttp = convertText(`proxies:\n  - type: vless\n    server: edge.example\n    port: 443\n    uuid: ${uuid}\n    network: xhttp\n    xhttp-opts:\n      path: /x\n      mode: stream-one`, "xhttp-mode");
  assert.equal(xhttp.encoded[0].status, "complete");
  const parsed = parseUriNode(xhttp.uris[0], { sourceId: "roundtrip", format: "uri" });
  assert.equal(parsed.node.settings["xhttp-opts"].mode, "stream-one");
});

test("Hysteria2 bandwidth fields remain diagnosed because the sharing URI omits them", () => {
  const result = convertText(`proxies:\n  - type: hysteria2\n    server: edge.example\n    port: 443\n    password: secret\n    up: 50\n    down: 50`, "hy2-bandwidth");
  assert.equal(result.encoded[0].status, "lossy");
  for (const field of ["up", "down"]) {
    assert.ok(result.diagnostics.some(item => item.field === field && item.compatibility === "not_representable"));
  }
  const output = new URL(result.uris[0]);
  assert.equal(output.searchParams.has("up"), false);
  assert.equal(output.searchParams.has("down"), false);
});

test("Hysteria2 uses standard ECH and insecure URI parameters and parses them back", () => {
  const result = convertText(`proxies:\n  - type: hysteria2\n    server: edge.example\n    port: 443\n    password: secret\n    sni: hy2.example\n    skip-cert-verify: true\n    ech-opts:\n      enabled: true\n      config: config-list`, "hy2-tls");
  const output = new URL(result.uris[0]);
  assert.equal(output.searchParams.get("sni"), "hy2.example");
  assert.equal(output.searchParams.get("insecure"), "1");
  assert.equal(output.searchParams.get("ech"), "config-list");
  assert.equal(output.searchParams.has("echConfigList"), false);
  const parsed = parseUriNode(result.uris[0], { sourceId: "roundtrip", format: "uri" });
  assert.equal(parsed.node.settings["ech-opts"].config, "config-list");
  assert.equal(parsed.node.settings["ech-opts"].enabled, true);
  assert.equal(parsed.node.settings["skip-cert-verify"], true);
});

test("disabled Hysteria2 ECH data is safely omitted without a lossy warning", () => {
  const result = convertText(`proxies:\n  - type: hysteria2\n    server: edge.example\n    port: 443\n    password: secret\n    ech-opts:\n      enabled: false\n      config: unused-config`, "hy2-ech-disabled");
  assert.equal(result.encoded[0].status, "complete");
  assert.equal(result.encoded[0].fieldCompatibility.find(item => item.field === "ech-opts.enabled").status, "default_omitted");
  assert.equal(result.encoded[0].fieldCompatibility.find(item => item.field === "ech-opts.config").status, "default_omitted");
  assert.equal(new URL(result.uris[0]).searchParams.has("ech"), false);
});

test("Hysteria2 ALPN is diagnosed because its sharing URI does not define an ALPN parameter", () => {
  const result = convertText(`proxies:\n  - type: hysteria2\n    server: edge.example\n    port: 443\n    password: secret\n    alpn:\n      - h3`, "hy2-alpn");
  assert.equal(result.encoded[0].status, "lossy");
  assert.ok(result.diagnostics.some(item => item.field === "alpn" && item.compatibility === "not_representable"));
  assert.equal(new URL(result.uris[0]).searchParams.has("alpn"), false);
});

test("Hysteria2 hop interval is retained as a loss because the URI has no interval parameter", () => {
  const result = convertText(`proxies:\n  - type: hysteria2\n    server: edge.example\n    port: 443\n    password: secret\n    hop-interval: 30`, "hy2-hop-interval");
  assert.equal(result.encoded[0].status, "lossy");
  assert.ok(result.diagnostics.some(item => item.field === "hop-interval" && item.compatibility === "not_representable"));
  assert.equal(new URL(result.uris[0]).searchParams.has("hopInterval"), false);
});

test("Shadowsocks dialer-proxy remains a diagnosed proxy-chain limitation", () => {
  const result = convertText(`proxies:\n  - type: ss\n    server: edge.example\n    port: 8388\n    cipher: aes-128-gcm\n    password: secret\n    dialer-proxy: relay`, "ss-chain");
  assert.equal(result.encoded[0].status, "lossy");
  assert.equal(result.nodes[0].settings["dialer-proxy"], "relay");
  assert.ok(result.diagnostics.some(item => item.field === "dialer-proxy" && /chain/.test(item.message)));
});

test("unknown vendor fields remain warnings and are included in the lossy field list", () => {
  const result = convertText(`proxies:\n  - type: trojan\n    server: edge.example\n    port: 443\n    password: secret\n    vendor-option: opaque`, "vendor-field");
  assert.equal(result.encoded[0].fieldCompatibility.find(item => item.field === "vendor-option").status, "unknown");
  assert.ok(result.diagnostics.some(item => item.field === "vendor-option" && item.compatibility === "unknown"));
});

test("gRPC transport service name survives URI generation and parse round-trip", () => {
  const result = convertText(`proxies:\n  - type: vless\n    server: edge.example\n    port: 443\n    uuid: ${uuid}\n    network: grpc\n    grpc-opts:\n      grpc-service-name: tunnel`, "grpc-roundtrip");
  assert.equal(result.encoded[0].status, "complete");
  assert.equal(new URL(result.uris[0]).searchParams.get("serviceName"), "tunnel");
  const parsed = parseUriNode(result.uris[0], { sourceId: "roundtrip", format: "uri" });
  assert.equal(parsed.node.settings["grpc-opts"]["grpc-service-name"], "tunnel");
});

test("synchronous and asynchronous conversion share field compatibility results", async () => {
  const source = { sourceId: "same-input", content: `proxies:\n  - type: vless\n    server: edge.example\n    port: 443\n    uuid: ${uuid}\n    alterId: 0\n    cipher: auto\n    udp: true` };
  const synchronous = convertSources([source]);
  const asynchronous = await convertSourcesAsync([source]);
  assert.deepEqual(asynchronous.uris, synchronous.uris);
  assert.deepEqual(asynchronous.encoded[0].fieldCompatibility, synchronous.encoded[0].fieldCompatibility);
  assert.equal(asynchronous.encoded[0].status, "complete");
});

test("transport options unsupported by a protocol are reported as lossy", () => {
  const result = convertText(`socks5://user:pass@edge.example:1080?type=ws&path=%2Fsocket#edge`, "source-a");
  assert.equal(result.uris.length, 1);
  assert.equal(result.encoded[0].status, "lossy");
  assert.ok(result.diagnostics.some(item => item.code === "field_not_encoded" && item.field === "network"));
  assert.ok(result.diagnostics.some(item => item.code === "field_not_encoded" && item.field === "ws-opts"));
});

test("semantic deduplication ignores names and retains every source", () => {
  const result = convertSources([
    { sourceId: "first", content: `vless://${uuid}@edge.example:443?security=tls#one` },
    { sourceId: "second", content: `vless://${uuid}@edge.example:443?security=tls#two` },
  ]);
  assert.equal(result.stats.duplicates, 1);
  assert.equal(result.nodes.length, 1);
  assert.deepEqual(result.nodes[0].sources.map(source => source.sourceId), ["first", "second"]);
});

test("different unknown connection parameters are not merged", () => {
  const result = convertSources([
    { sourceId: "first", content: `vless://${uuid}@edge.example:443?vendorOption=one#same`, format: "uri" },
    { sourceId: "second", content: `vless://${uuid}@edge.example:443?vendorOption=two#same`, format: "uri" },
  ]);
  assert.equal(result.stats.duplicates, 0);
  assert.equal(result.uris.length, 2);
});

test("nested extension fields named name remain part of the semantic fingerprint", () => {
  const result = convertSources([
    { sourceId: "first", content: JSON.stringify({ proxies: [{ type: "trojan", server: "edge.example", port: 443, password: "secret", vendor: { name: "alpha" } }] }) },
    { sourceId: "second", content: JSON.stringify({ proxies: [{ type: "trojan", server: "edge.example", port: 443, password: "secret", vendor: { name: "beta" } }] }) },
  ]);
  assert.equal(result.stats.duplicates, 0);
  assert.equal(result.uris.length, 2);
});

test("TUIC nodes require both UUID and password", () => {
  const result = convertText(`tuic://${uuid}@edge.example:443#tuic`, "source-a");
  assert.equal(result.stats.invalid, 1);
  assert.equal(result.nodes.length, 1);
  assert.equal(result.nodes[0].protocol, "tuic");
  assert.equal(result.encoded[0].status, "invalid");
  assert.equal(result.uris.length, 0);
  assert.ok(result.diagnostics.some(item => item.code === "missing_credentials" && item.field === "password"));
});

test("node tests distinguish missing test prerequisites from network failures", () => {
  const node = convertText(`tuic://${uuid}@edge.example:443#tuic`, "source-a").nodes[0];
  assert.equal(assessNodeTestReadiness("tcping", node).available, true);
  assert.equal(assessNodeTestReadiness("entry", { ...node, port: 0 }).available, true);
  const proxyTest = assessNodeTestReadiness("url204", node);
  assert.equal(proxyTest.available, false);
  assert.match(proxyTest.reason, /TUIC|password/i);
  assert.equal(
    assessNodeTestReadiness("tcping", { ...node, server: "invalid host" }).available,
    false,
  );

  const masque = convertText(
    `masque://client-private-key@edge.example:443?profile=cloudflare&public_key=server-public-key&ip=10.0.0.2#masque`,
    "source-a",
  ).nodes[0];
  const unsupportedProxyTest = assessNodeTestReadiness("url204", masque);
  assert.equal(unsupportedProxyTest.available, false);
  assert.match(unsupportedProxyTest.reason, /MASQUE/);
});

test("node limits cap accumulated model nodes and report truncation", () => {
  const content = `proxies:\n  - type: trojan\n    name: a\n    server: a.example\n    port: 443\n    password: a\n  - type: trojan\n    name: b\n    server: b.example\n    port: 443\n    password: b`;
  const result = convertSource({ sourceId: "source-a", content }, { limits: { maxNodes: 1 } });
  assert.equal(result.stats.parsedNodes, 1);
  assert.equal(result.uris.length, 1);
  assert.ok(result.diagnostics.some(item => item.code === "node_limit"));
});

test("native parser applies the node cap before materializing all models", () => {
  const value = {
    proxies: [
      { type: "trojan", name: "a", server: "a.example", port: 443, password: "a" },
      { type: "trojan", name: "b", server: "b.example", port: 443, password: "b" },
    ],
  };
  const result = convertSource({ sourceId: "source-a", content: JSON.stringify(value) }, { limits: { maxNodes: 1 } });
  assert.equal(result.stats.parsedNodes, 1);
  assert.equal(result.uris.length, 1);
  assert.ok(result.diagnostics.some(item => item.code === "node_limit"));
});

test("unsupported native candidates do not consume the valid node budget", () => {
  const value = {
    outbounds: [
      { type: "selector", server: "ignored.example", server_port: 443 },
      { type: "block", server: "ignored.example", server_port: 443 },
      { type: "urltest", server: "ignored.example", server_port: 443 },
      { type: "trojan", server: "valid.example", server_port: 443, password: "secret" },
    ],
  };
  const result = convertSource({ sourceId: "source-a", content: JSON.stringify(value) }, { limits: { maxNodes: 1 } });
  assert.equal(result.stats.parsedNodes, 1);
  assert.match(result.uris[0], /valid\.example/);
});

test("Xray outbounds are not labelled as sing-box", () => {
  const value = {
    outbounds: [{ protocol: "vless", settings: { vnext: [] } }],
  };
  assert.equal(detectNativeFormat(value), "xray-json");
});

test("sing-box parser builds a ProxyNode directly and retains native fields", () => {
  const outbound = {
    type: "vless",
    tag: "native-vless",
    server: "sing.example",
    server_port: 443,
    uuid,
    tls: { enabled: true, server_name: "sni.example" },
    transport: { type: "ws", path: "/socket", headers: { Host: "host.example" } },
    vendor_option: { mode: "custom", values: [1, 2, 3] },
  };
  const parsed = parseNativeValue({ outbounds: [outbound] }, { sourceId: "native", format: "auto" });
  assert.equal(parsed.nodes.length, 1);
  assert.equal(parsed.nodes[0].protocol, "vless");
  assert.equal(parsed.nodes[0].sources[0].format, "sing-box-json");
  assert.equal(parsed.nodes[0].sources[0].location, "outbounds[0]");
  assert.equal(parsed.nodes[0].settings.servername, "sni.example");
  assert.deepEqual(parsed.nodes[0].settings["ws-opts"], { path: "/socket", headers: { Host: "host.example" } });
  assert.deepEqual(parsed.nodes[0].settings.vendor_option, outbound.vendor_option);
  assert.equal(parsed.nodes[0].raw, outbound);
});

test("Xray and sing-box YAML configurations enter the native parser registry", () => {
  const xray = convertText(`outbounds:
  - protocol: vless
    tag: xray-yaml
    settings:
      vnext:
        - address: xray.example
          port: 443
          users:
            - id: ${uuid}
              encryption: none`, "xray-yaml");
  assert.equal(xray.uris.length, 1);
  assert.equal(xray.nodes[0].sources[0].format, "xray-yaml");

  const singBox = convertText(`outbounds:
  - type: vless
    tag: sing-box-yaml
    server: sing.example
    server_port: 443
    uuid: ${uuid}`, "sing-box-yaml");
  assert.equal(singBox.uris.length, 1);
  assert.equal(singBox.nodes[0].sources[0].format, "sing-box-yaml");
});

test("Xray native fields outside URI support remain attached and make output lossy", () => {
  const outbound = {
    protocol: "vless",
    tag: "native-xray",
    settings: {
      vnext: [{
        address: "xray.example",
        port: 443,
        users: [{ id: uuid, encryption: "none", flow: "xtls-rprx-vision", level: 0 }],
      }],
      vendor_settings: { feature: true },
    },
    streamSettings: {
      network: "tcp",
      security: "tls",
      tlsSettings: { serverName: "sni.example", vendorTlsMode: "strict" },
    },
    mux: { enabled: true },
  };
  const parsed = parseNativeValue({ outbounds: [outbound] }, { sourceId: "xray", format: "auto" });
  assert.equal(parsed.nodes.length, 1);
  assert.equal(parsed.nodes[0].sources[0].format, "xray-json");
  assert.equal(parsed.nodes[0].settings.uuid, uuid);
  assert.equal(parsed.nodes[0].settings.flow, "xtls-rprx-vision");
  assert.deepEqual(parsed.nodes[0].extensions["settings.vendor_settings"], outbound.settings.vendor_settings);
  assert.deepEqual(parsed.nodes[0].extensions["xray.mux"], outbound.mux);
  assert.equal(parsed.nodes[0].extensions["stream.tls.vendorTlsMode"], "strict");

  const conversion = convertSource({ sourceId: "xray", content: JSON.stringify({ outbounds: [outbound] }) });
  assert.equal(conversion.encoded[0].status, "lossy");
  assert.ok(conversion.diagnostics.some(item => item.code === "field_not_encoded" && item.field === "xray.mux"));
});

test("sing-box WireGuard peer settings and loss diagnostics stay peer-specific", () => {
  const value = {
    endpoints: [{
      type: "wireguard",
      tag: "wg",
      address: ["10.0.0.1/32"],
      private_key: "private",
      peers: [
        { address: "one.example", port: 51820, public_key: "peer-one", allowed_ips: ["0.0.0.0/0"], persistent_keepalive_interval: 15 },
        { address: "two.example", port: 51821, public_key: "peer-two", allowed_ips: ["10.0.0.0/8"], persistent_keepalive_interval: 30 },
      ],
    }],
  };
  const parsed = parseNativeValue(value, { sourceId: "wireguard", format: "auto" });
  assert.equal(parsed.nodes.length, 2);
  assert.deepEqual(parsed.nodes.map(node => [node.server, node.port, node.settings["persistent_keepalive_interval"]]), [
    ["one.example", 51820, 15],
    ["two.example", 51821, 30],
  ]);
  assert.deepEqual(parsed.nodes[0].extensions["peers[0].allowed_ips"], ["0.0.0.0/0"]);
  assert.equal(parsed.nodes[0].extensions["peers[1].allowed_ips"], undefined);
  assert.deepEqual(parsed.nodes[1].extensions["peers[1].allowed_ips"], ["10.0.0.0/8"]);
  assert.equal(parsed.nodes[1].extensions["peers[0].allowed_ips"], undefined);
});

test("one invalid source does not stop another source from converting", () => {
  const result = convertSources([
    { sourceId: "bad", content: "{broken" },
    { sourceId: "good", content: `trojan://secret@edge.example:443#ok` },
  ]);
  assert.equal(result.sourceStats.length, 2);
  assert.equal(result.sourceStats[0].errors, 1);
  assert.equal(result.sourceStats[1].outputNodes, 1);
  assert.equal(result.uris.length, 1);
});

test("cyclic YAML aliases are preserved as lossy data without crashing deduplication", () => {
  const content = `proxies:
  - &proxy
    type: trojan
    name: cyclic
    server: edge.example
    port: 443
    password: secret
    vendor: *proxy`;
  const result = convertText(content, "cyclic");
  assert.equal(result.uris.length, 1);
  assert.equal(result.encoded[0].status, "lossy");
  const report = buildLossyConversionLog(
    result.nodes.map((node, index) => ({
      id: `${node.id}-${index}`,
      name: node.name,
      server: node.server,
      port: node.port,
      protocol: node.protocol,
      uri: result.uris[index] ?? null,
      conversionStatus: result.encoded[index].status,
      conversionDiagnostics: result.encoded[index].diagnostics,
      node,
    })),
    { scope: "all" },
  );
  assert.doesNotThrow(() => JSON.stringify(report));
});
